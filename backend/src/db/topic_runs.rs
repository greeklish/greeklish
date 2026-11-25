use std::collections::{HashMap, HashSet};

use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;
use crate::ranking::RankedTopicItem;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TopicRunTrigger {
    Ticker,
    Manual,
    Ingest,
}

impl TopicRunTrigger {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ticker => "ticker",
            Self::Manual => "manual",
            Self::Ingest => "ingest",
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct PreviousRankRow {
    item_id: Uuid,
    rank_position: i32,
    current_score: f64,
}

#[derive(Debug, Clone)]
struct PreviousRankState {
    rank_position: i32,
    score: f64,
}

#[derive(Debug, Clone)]
struct TopicItemEventRow {
    item_id: Uuid,
    event_type: &'static str,
    old_rank: Option<i32>,
    new_rank: Option<i32>,
    old_score: Option<f64>,
    new_score: Option<f64>,
}

pub async fn record_topic_run(
    pool: &PgPool,
    topic_id: Uuid,
    ranked_items: &[RankedTopicItem],
    trigger: TopicRunTrigger,
) -> Result<(), AppError> {
    let recorded_at = OffsetDateTime::now_utc();
    let mut tx = pool.begin().await?;

    let previous_rows = sqlx::query_as::<_, PreviousRankRow>(
        r#"
        SELECT item_id, rank_position, current_score
        FROM topic_items
        WHERE topic_id = $1 AND rank_position IS NOT NULL
        "#,
    )
    .bind(topic_id)
    .fetch_all(&mut *tx)
    .await?;

    let previous_by_item: HashMap<Uuid, PreviousRankState> = previous_rows
        .into_iter()
        .map(|row| {
            (
                row.item_id,
                PreviousRankState {
                    rank_position: row.rank_position,
                    score: row.current_score,
                },
            )
        })
        .collect();

    let current_item_ids: HashSet<Uuid> = ranked_items.iter().map(|item| item.item_id).collect();
    let mut events = Vec::new();

    for item in ranked_items {
        match previous_by_item.get(&item.item_id) {
            None => events.push(TopicItemEventRow {
                item_id: item.item_id,
                event_type: "added",
                old_rank: None,
                new_rank: Some(item.payload.rank_position),
                old_score: None,
                new_score: Some(item.payload.score),
            }),
            Some(previous) if previous.rank_position != item.payload.rank_position => {
                events.push(TopicItemEventRow {
                    item_id: item.item_id,
                    event_type: "rank_changed",
                    old_rank: Some(previous.rank_position),
                    new_rank: Some(item.payload.rank_position),
                    old_score: Some(previous.score),
                    new_score: Some(item.payload.score),
                });
            }
            Some(_) => {}
        }
    }

    for (item_id, previous) in &previous_by_item {
        if !current_item_ids.contains(item_id) {
            events.push(TopicItemEventRow {
                item_id: *item_id,
                event_type: "removed",
                old_rank: Some(previous.rank_position),
                new_rank: None,
                old_score: Some(previous.score),
                new_score: None,
            });
        }
    }

    let should_insert_run = trigger == TopicRunTrigger::Manual || !events.is_empty();
    let run_id = if should_insert_run {
        let run_id = Uuid::now_v7();
        sqlx::query(
            r#"
            INSERT INTO topic_runs (
                id,
                topic_id,
                trigger,
                item_count,
                change_count,
                recorded_at
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(run_id)
        .bind(topic_id)
        .bind(trigger.as_str())
        .bind(
            i32::try_from(ranked_items.len())
                .map_err(|_| AppError::bad_request("ranked item count must fit into i32"))?,
        )
        .bind(
            i32::try_from(events.len())
                .map_err(|_| AppError::bad_request("topic event count must fit into i32"))?,
        )
        .bind(recorded_at)
        .execute(&mut *tx)
        .await?;

        Some(run_id)
    } else {
        None
    };

    if let Some(run_id) = run_id {
        for event in &events {
            sqlx::query(
                r#"
                INSERT INTO topic_item_events (
                    topic_id,
                    item_id,
                    run_id,
                    event_type,
                    old_rank,
                    new_rank,
                    old_score,
                    new_score,
                    recorded_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                "#,
            )
            .bind(topic_id)
            .bind(event.item_id)
            .bind(run_id)
            .bind(event.event_type)
            .bind(event.old_rank)
            .bind(event.new_rank)
            .bind(event.old_score)
            .bind(event.new_score)
            .bind(recorded_at)
            .execute(&mut *tx)
            .await?;
        }
    }

    sqlx::query(
        r#"
        UPDATE topic_items
        SET rank_position = NULL
        WHERE topic_id = $1
        "#,
    )
    .bind(topic_id)
    .execute(&mut *tx)
    .await?;

    for item in ranked_items {
        sqlx::query(
            r#"
            UPDATE topic_items
            SET rank_position = $3
            WHERE topic_id = $1 AND item_id = $2
            "#,
        )
        .bind(topic_id)
        .bind(item.item_id)
        .bind(item.payload.rank_position)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}
