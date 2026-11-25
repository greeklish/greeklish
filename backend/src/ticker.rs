use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use tracing::{debug, warn};

use crate::db::{items, topic_runs};
use crate::error::AppError;
use crate::ranking::{self, RankedTopicItem};
use crate::state::AppState;
use crate::ws::messages::{RankedItem, RankingStrategy, ServerMessage};

#[derive(Debug, Clone)]
pub struct RankedTopicSnapshot {
    pub topic_id: uuid::Uuid,
    pub topic_slug: String,
    pub topic_display_name: String,
    pub strategy: RankingStrategy,
    pub items: Vec<RankedTopicItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RerankTrigger {
    Ticker,
    Manual,
    Ingest,
}

impl RankedTopicSnapshot {
    pub fn payload_items(&self) -> Vec<RankedItem> {
        self.items.iter().map(|item| item.payload.clone()).collect()
    }

    pub fn as_server_message(&self) -> ServerMessage {
        ServerMessage::TopicSnapshot {
            topic: self.topic_slug.clone(),
            display_name: self.topic_display_name.clone(),
            strategy: self.strategy,
            items: self.payload_items(),
            as_of: timestamp_millis(),
        }
    }
}

pub fn spawn(state: AppState) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(state.config().ticker_interval);
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let shutdown_token = state.shutdown_token();
        let rerank_notifier = state.rerank_notifier();

        loop {
            tokio::select! {
                _ = shutdown_token.cancelled() => break,
                _ = interval.tick() => {
                    for topic_slug in state.active_topics() {
                        if let Err(error) =
                            rerank_topic_if_needed(&state, &topic_slug, RerankTrigger::Ticker).await
                        {
                            warn!(topic_slug = %topic_slug, error = %error, "ticker rerank failed");
                        }
                    }
                }
                _ = rerank_notifier.notified() => {
                    let manual_topics = state.drain_pending_reranks();
                    let manual_topic_set: std::collections::HashSet<String> =
                        manual_topics.iter().cloned().collect();

                    for topic_slug in manual_topics {
                        if let Err(error) =
                            rerank_topic_if_needed(&state, &topic_slug, RerankTrigger::Manual).await
                        {
                            warn!(topic_slug = %topic_slug, error = %error, "manual rerank failed");
                        }
                    }

                    for topic_slug in state.drain_pending_ingest_reranks() {
                        if manual_topic_set.contains(&topic_slug) {
                            continue;
                        }

                        if let Err(error) =
                            rerank_topic_if_needed(&state, &topic_slug, RerankTrigger::Ingest).await
                        {
                            warn!(topic_slug = %topic_slug, error = %error, "ingest rerank failed");
                        }
                    }
                }
            }
        }
    })
}

pub async fn load_snapshot(
    state: &AppState,
    topic_slug: &str,
) -> Result<Option<RankedTopicSnapshot>, AppError> {
    let Some((topic, candidates)) =
        items::fetch_topic_snapshot_data(state.db_pool(), topic_slug).await?
    else {
        return Ok(None);
    };

    let ranked_items = ranking::rank_topic(&topic, candidates, time::OffsetDateTime::now_utc())?;

    Ok(Some(RankedTopicSnapshot {
        topic_id: topic.id,
        topic_slug: topic.slug,
        topic_display_name: topic.display_name,
        strategy: topic.ranking_strategy,
        items: ranked_items,
    }))
}

pub async fn rerank_topic_if_needed(
    state: &AppState,
    topic_slug: &str,
    trigger: RerankTrigger,
) -> Result<(), AppError> {
    let Some(snapshot) = load_snapshot(state, topic_slug).await? else {
        state.clear_last_snapshot(topic_slug);
        return Ok(());
    };

    let payload_items = snapshot.payload_items();
    topic_runs::record_topic_run(
        state.db_pool(),
        snapshot.topic_id,
        &snapshot.items,
        match trigger {
            RerankTrigger::Ticker => topic_runs::TopicRunTrigger::Ticker,
            RerankTrigger::Manual => topic_runs::TopicRunTrigger::Manual,
            RerankTrigger::Ingest => topic_runs::TopicRunTrigger::Ingest,
        },
    )
    .await?;

    let subscriber_count = state.topic_subscriber_count(topic_slug);
    if subscriber_count == 0 {
        return Ok(());
    }

    let should_broadcast = state
        .last_snapshot(topic_slug)
        .map(|previous| previous != payload_items)
        .unwrap_or(true);

    if should_broadcast {
        let notified = state.broadcast(topic_slug, snapshot.as_server_message());
        state.store_last_snapshot(topic_slug, payload_items);
        debug!(topic_slug = %topic_slug, notified_clients = notified, "broadcasted topic snapshot");
    }

    Ok(())
}

pub(crate) fn timestamp_millis() -> u64 {
    let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    u64::try_from(now).unwrap_or_default()
}
