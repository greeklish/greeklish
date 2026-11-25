use std::collections::HashSet;

use serde_json::{Map, Value};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;
use crate::ws::messages::{
    HistoryChangeType, HistoryRunTrigger, RankingRunChange, TopicHistoryEntry,
};

const DEFAULT_HISTORY_LIMIT: usize = 250;
const MAX_HISTORY_LIMIT: usize = 1000;

#[derive(Debug, Clone, sqlx::FromRow)]
struct RankingHistoryRow {
    item_id: Uuid,
    run_id: Uuid,
    run_trigger: String,
    event_type: String,
    old_rank: Option<i32>,
    new_rank: Option<i32>,
    old_score: Option<f64>,
    new_score: Option<f64>,
    recorded_at: OffsetDateTime,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct ObservationHistoryRow {
    item_id: Uuid,
    previous_recorded_at: Option<OffsetDateTime>,
    title: String,
    previous_title: Option<String>,
    url: String,
    previous_url: Option<String>,
    metadata: Option<Value>,
    previous_metadata: Option<Value>,
    recorded_at: OffsetDateTime,
}

#[derive(Debug, Clone)]
struct TimelineEvent {
    recorded_at: OffsetDateTime,
    event: TopicHistoryEntry,
}

pub fn normalize_history_limit(limit: Option<u32>) -> Result<usize, AppError> {
    let limit = limit
        .map(usize::try_from)
        .transpose()
        .map_err(|_| AppError::bad_request("history limit must fit into usize"))?
        .unwrap_or(DEFAULT_HISTORY_LIMIT);

    if limit == 0 {
        return Err(AppError::bad_request(
            "history limit must be greater than zero",
        ));
    }

    Ok(limit.min(MAX_HISTORY_LIMIT))
}

pub async fn fetch_topic_history_events(
    pool: &PgPool,
    topic_id: Uuid,
    change_types: &HashSet<HistoryChangeType>,
    lookback_hours: u32,
    limit: usize,
) -> Result<Vec<TopicHistoryEntry>, AppError> {
    let cutoff = OffsetDateTime::now_utc() - time::Duration::hours(i64::from(lookback_hours));
    let query_limit = i64::try_from(limit.saturating_mul(20))
        .map_err(|_| AppError::bad_request("history limit overflow"))?;
    let mut timeline = Vec::new();

    if change_types.contains(&HistoryChangeType::Ranking) {
        timeline.extend(fetch_ranking_events(pool, topic_id, cutoff, query_limit).await?);
    }

    if change_types.contains(&HistoryChangeType::Title)
        || change_types.contains(&HistoryChangeType::Url)
        || change_types.contains(&HistoryChangeType::Metadata)
    {
        timeline.extend(
            fetch_observation_events(pool, topic_id, cutoff, query_limit, change_types).await?,
        );
    }

    timeline.sort_by(|left, right| {
        right
            .recorded_at
            .cmp(&left.recorded_at)
            .then_with(|| left.event_order().cmp(&right.event_order()))
    });

    if timeline.len() > limit {
        timeline.truncate(limit);
    }

    Ok(timeline.into_iter().map(|entry| entry.event).collect())
}

impl TimelineEvent {
    fn event_order(&self) -> u8 {
        match self.event {
            TopicHistoryEntry::RankingRun { .. } => 0,
            TopicHistoryEntry::Title { .. } => 1,
            TopicHistoryEntry::Url { .. } => 2,
            TopicHistoryEntry::Metadata { .. } => 3,
        }
    }
}

async fn fetch_ranking_events(
    pool: &PgPool,
    topic_id: Uuid,
    cutoff: OffsetDateTime,
    limit: i64,
) -> Result<Vec<TimelineEvent>, AppError> {
    let rows = sqlx::query_as::<_, RankingHistoryRow>(
        r#"
        SELECT
            topic_item_events.item_id,
            topic_item_events.run_id,
            topic_runs.trigger AS run_trigger,
            topic_item_events.event_type,
            topic_item_events.old_rank,
            topic_item_events.new_rank,
            topic_item_events.old_score,
            topic_item_events.new_score,
            topic_item_events.recorded_at
        FROM topic_item_events
        INNER JOIN topic_runs ON topic_runs.id = topic_item_events.run_id
        WHERE topic_item_events.topic_id = $1
          AND topic_item_events.recorded_at >= $2
        ORDER BY topic_item_events.recorded_at DESC, topic_item_events.run_id, topic_item_events.item_id
        LIMIT $3
        "#,
    )
    .bind(topic_id)
    .bind(cutoff)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut grouped = Vec::<(
        Uuid,
        HistoryRunTrigger,
        OffsetDateTime,
        Vec<RankingRunChange>,
    )>::new();

    for row in rows {
        let run_trigger = parse_history_run_trigger(&row.run_trigger)?;
        let change = parse_ranking_change(&row)?;

        if let Some((run_id, _, _, changes)) = grouped.last_mut() {
            if *run_id == row.run_id {
                changes.push(change);
                continue;
            }
        }

        grouped.push((row.run_id, run_trigger, row.recorded_at, vec![change]));
    }

    grouped
        .into_iter()
        .map(|(run_id, run_trigger, recorded_at, changes)| {
            Ok(TimelineEvent {
                recorded_at,
                event: TopicHistoryEntry::RankingRun {
                    run_id: run_id.to_string(),
                    run_trigger,
                    recorded_at_ms: timestamp_millis(recorded_at)?,
                    changes,
                },
            })
        })
        .collect()
}

async fn fetch_observation_events(
    pool: &PgPool,
    topic_id: Uuid,
    cutoff: OffsetDateTime,
    limit: i64,
    change_types: &HashSet<HistoryChangeType>,
) -> Result<Vec<TimelineEvent>, AppError> {
    let rows = sqlx::query_as::<_, ObservationHistoryRow>(
        r#"
        SELECT
            observations.item_id,
            observations.previous_recorded_at,
            observations.title,
            observations.previous_title,
            observations.url,
            observations.previous_url,
            observations.metadata,
            observations.previous_metadata,
            observations.recorded_at
        FROM (
            SELECT
                item_observations.item_id,
                LAG(item_observations.recorded_at) OVER (
                    PARTITION BY item_observations.item_id
                    ORDER BY item_observations.recorded_at
                ) AS previous_recorded_at,
                item_observations.title,
                LAG(item_observations.title) OVER (
                    PARTITION BY item_observations.item_id
                    ORDER BY item_observations.recorded_at
                ) AS previous_title,
                item_observations.url,
                LAG(item_observations.url) OVER (
                    PARTITION BY item_observations.item_id
                    ORDER BY item_observations.recorded_at
                ) AS previous_url,
                item_observations.metadata,
                LAG(item_observations.metadata) OVER (
                    PARTITION BY item_observations.item_id
                    ORDER BY item_observations.recorded_at
                ) AS previous_metadata,
                item_observations.recorded_at
            FROM item_observations
            INNER JOIN topic_items ON topic_items.item_id = item_observations.item_id
            WHERE topic_items.topic_id = $1
        ) AS observations
        WHERE observations.recorded_at >= $2
        ORDER BY observations.recorded_at DESC, observations.item_id
        LIMIT $3
        "#,
    )
    .bind(topic_id)
    .bind(cutoff)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut timeline = Vec::new();

    for row in rows {
        let has_previous_observation = row.previous_recorded_at.is_some();

        if change_types.contains(&HistoryChangeType::Title)
            && has_previous_observation
            && row.previous_title != Some(row.title.clone())
        {
            timeline.push(TimelineEvent {
                recorded_at: row.recorded_at,
                event: TopicHistoryEntry::Title {
                    item_id: row.item_id.to_string(),
                    old_title: row.previous_title.clone(),
                    new_title: row.title.clone(),
                    recorded_at_ms: timestamp_millis(row.recorded_at)?,
                },
            });
        }

        if change_types.contains(&HistoryChangeType::Url)
            && has_previous_observation
            && row.previous_url != Some(row.url.clone())
        {
            timeline.push(TimelineEvent {
                recorded_at: row.recorded_at,
                event: TopicHistoryEntry::Url {
                    item_id: row.item_id.to_string(),
                    old_url: row.previous_url.clone(),
                    new_url: row.url.clone(),
                    recorded_at_ms: timestamp_millis(row.recorded_at)?,
                },
            });
        }

        if change_types.contains(&HistoryChangeType::Metadata)
            && has_previous_observation
            && row.previous_metadata != row.metadata
        {
            let (changed_keys, old_metadata, new_metadata) =
                diff_metadata(row.previous_metadata.as_ref(), row.metadata.as_ref());
            timeline.push(TimelineEvent {
                recorded_at: row.recorded_at,
                event: TopicHistoryEntry::Metadata {
                    item_id: row.item_id.to_string(),
                    changed_keys,
                    old_metadata,
                    new_metadata,
                    recorded_at_ms: timestamp_millis(row.recorded_at)?,
                },
            });
        }
    }

    Ok(timeline)
}

fn parse_history_run_trigger(value: &str) -> Result<HistoryRunTrigger, AppError> {
    match value {
        "ticker" => Ok(HistoryRunTrigger::Ticker),
        "manual" => Ok(HistoryRunTrigger::Manual),
        "ingest" => Ok(HistoryRunTrigger::Ingest),
        _ => Err(AppError::bad_request(format!(
            "unknown topic run trigger `{value}`"
        ))),
    }
}

fn parse_ranking_change(row: &RankingHistoryRow) -> Result<RankingRunChange, AppError> {
    match row.event_type.as_str() {
        "added" => Ok(RankingRunChange::Added {
            item_id: row.item_id.to_string(),
            new_rank: row
                .new_rank
                .ok_or_else(|| AppError::bad_request("added event missing new_rank"))?,
            new_score: row
                .new_score
                .ok_or_else(|| AppError::bad_request("added event missing new_score"))?,
        }),
        "removed" => Ok(RankingRunChange::Removed {
            item_id: row.item_id.to_string(),
            old_rank: row
                .old_rank
                .ok_or_else(|| AppError::bad_request("removed event missing old_rank"))?,
            old_score: row
                .old_score
                .ok_or_else(|| AppError::bad_request("removed event missing old_score"))?,
        }),
        "rank_changed" => Ok(RankingRunChange::RankChanged {
            item_id: row.item_id.to_string(),
            old_rank: row
                .old_rank
                .ok_or_else(|| AppError::bad_request("rank_changed event missing old_rank"))?,
            new_rank: row
                .new_rank
                .ok_or_else(|| AppError::bad_request("rank_changed event missing new_rank"))?,
            old_score: row
                .old_score
                .ok_or_else(|| AppError::bad_request("rank_changed event missing old_score"))?,
            new_score: row
                .new_score
                .ok_or_else(|| AppError::bad_request("rank_changed event missing new_score"))?,
        }),
        _ => Err(AppError::bad_request(format!(
            "unknown ranking change kind `{}`",
            row.event_type
        ))),
    }
}

fn diff_metadata(
    previous: Option<&Value>,
    current: Option<&Value>,
) -> (Vec<String>, Option<Value>, Option<Value>) {
    match (previous, current) {
        (Some(Value::Object(previous)), Some(Value::Object(current))) => {
            diff_metadata_objects(previous, current)
        }
        (Some(Value::Object(previous)), None) => diff_metadata_objects(previous, &Map::new()),
        (None, Some(Value::Object(current))) => diff_metadata_objects(&Map::new(), current),
        _ => (
            vec!["$value".to_owned()],
            previous.cloned(),
            current.cloned(),
        ),
    }
}

fn diff_metadata_objects(
    previous: &Map<String, Value>,
    current: &Map<String, Value>,
) -> (Vec<String>, Option<Value>, Option<Value>) {
    let mut changed_keys = Vec::new();
    let mut old_values = Map::new();
    let mut new_values = Map::new();
    let mut seen = HashSet::new();

    for key in previous.keys().chain(current.keys()) {
        if !seen.insert(key.clone()) {
            continue;
        }

        let old_value = previous.get(key);
        let new_value = current.get(key);
        if old_value == new_value {
            continue;
        }

        changed_keys.push(key.clone());
        if let Some(old_value) = old_value {
            old_values.insert(key.clone(), old_value.clone());
        }
        if let Some(new_value) = new_value {
            new_values.insert(key.clone(), new_value.clone());
        }
    }

    changed_keys.sort();

    (
        changed_keys,
        (!old_values.is_empty()).then_some(Value::Object(old_values)),
        (!new_values.is_empty()).then_some(Value::Object(new_values)),
    )
}

fn timestamp_millis(value: OffsetDateTime) -> Result<u64, AppError> {
    let millis = value.unix_timestamp_nanos() / 1_000_000;
    u64::try_from(millis)
        .map_err(|_| AppError::bad_request("timestamp must be non-negative and fit into u64"))
}
