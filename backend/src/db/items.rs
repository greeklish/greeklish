use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::db::item_observations;
use crate::db::snapshots;
use crate::db::topics::TopicRecord;
use crate::error::AppError;
use crate::ws::messages::RankingStrategy;

#[derive(Debug, Clone)]
pub struct IngestTopicItemParams<'a> {
    pub topic_slug: &'a str,
    pub source_slug: &'a str,
    pub external_id: &'a str,
    pub title: &'a str,
    pub url: &'a str,
    pub score: f64,
    pub published_at: OffsetDateTime,
    pub crawled_at: OffsetDateTime,
    pub recorded_at: OffsetDateTime,
    pub external_rank: Option<i32>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct IngestTopicItemResult {
    pub topic_id: Uuid,
    pub item_id: Uuid,
    pub source_id: Uuid,
    pub ranking_strategy: RankingStrategy,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TopicItemCandidate {
    pub item_id: Uuid,
    pub title: String,
    pub url: String,
    pub source_slug: String,
    pub external_id: String,
    pub current_score: f64,
    pub metadata: Option<Value>,
    pub published_at: OffsetDateTime,
    pub crawled_at: OffsetDateTime,
    pub external_rank: Option<i32>,
}

#[derive(Debug, sqlx::FromRow)]
struct TopicItemIds {
    topic_id: Uuid,
    source_id: Uuid,
    ranking_strategy: RankingStrategy,
}

#[derive(Debug, sqlx::FromRow)]
struct ItemUpsertRow {
    id: Uuid,
}

#[derive(Debug, sqlx::FromRow)]
struct ExistingItemRow {
    title: String,
    url: String,
    metadata: Option<Value>,
}

pub async fn ingest_topic_item(
    pool: &PgPool,
    params: IngestTopicItemParams<'_>,
) -> Result<IngestTopicItemResult, AppError> {
    let mut tx = pool.begin().await?;
    let result = ingest_topic_item_in_transaction(&mut tx, params).await?;
    tx.commit().await?;

    Ok(result)
}

pub async fn ingest_topic_item_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    params: IngestTopicItemParams<'_>,
) -> Result<IngestTopicItemResult, AppError> {
    let ids = sqlx::query_as::<_, TopicItemIds>(
        r#"
        SELECT
            topics.id AS topic_id,
            sources.id AS source_id,
            topics.ranking_strategy
        FROM topics
        INNER JOIN sources ON sources.slug = $2
        WHERE topics.slug = $1
        "#,
    )
    .bind(params.topic_slug)
    .bind(params.source_slug)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| {
        AppError::not_found(format!(
            "topic `{}` or source `{}` does not exist",
            params.topic_slug, params.source_slug
        ))
    })?;

    let existing_item = sqlx::query_as::<_, ExistingItemRow>(
        r#"
        SELECT title, url, metadata
        FROM items
        WHERE source_id = $1 AND external_id = $2
        "#,
    )
    .bind(ids.source_id)
    .bind(params.external_id)
    .fetch_optional(&mut **tx)
    .await?;

    let should_record_observation = existing_item.as_ref().is_none_or(|item| {
        item.title != params.title || item.url != params.url || item.metadata != params.metadata
    });

    let item = sqlx::query_as::<_, ItemUpsertRow>(
        r#"
        INSERT INTO items (
            id,
            source_id,
            external_id,
            title,
            url,
            metadata,
            published_at,
            crawled_at,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (source_id, external_id) DO UPDATE
        SET title = EXCLUDED.title,
            url = EXCLUDED.url,
            metadata = EXCLUDED.metadata,
            published_at = EXCLUDED.published_at,
            crawled_at = EXCLUDED.crawled_at,
            updated_at = EXCLUDED.updated_at
        RETURNING id
        "#,
    )
    .bind(Uuid::now_v7())
    .bind(ids.source_id)
    .bind(params.external_id)
    .bind(params.title)
    .bind(params.url)
    .bind(params.metadata.clone())
    .bind(params.published_at)
    .bind(params.crawled_at)
    .bind(params.recorded_at)
    .fetch_one(&mut **tx)
    .await?;

    if should_record_observation {
        item_observations::insert_item_observation(
            tx,
            item.id,
            params.title,
            params.url,
            params.metadata.as_ref(),
            params.recorded_at,
        )
        .await?;
    }

    sqlx::query(
        r#"
        INSERT INTO topic_items (
            topic_id,
            item_id,
            current_score,
            external_rank,
            rank_position,
            added_at
        )
        VALUES ($1, $2, $3, $4, NULL, $5)
        ON CONFLICT (topic_id, item_id) DO UPDATE
        SET current_score = EXCLUDED.current_score,
            external_rank = EXCLUDED.external_rank
        "#,
    )
    .bind(ids.topic_id)
    .bind(item.id)
    .bind(params.score)
    .bind(params.external_rank)
    .bind(params.recorded_at)
    .execute(&mut **tx)
    .await?;

    snapshots::insert_score_snapshot(tx, item.id, ids.topic_id, params.score, params.recorded_at)
        .await?;

    Ok(IngestTopicItemResult {
        topic_id: ids.topic_id,
        item_id: item.id,
        source_id: ids.source_id,
        ranking_strategy: ids.ranking_strategy,
    })
}

pub async fn fetch_topic_snapshot_data(
    pool: &PgPool,
    topic_slug: &str,
) -> Result<Option<(TopicRecord, Vec<TopicItemCandidate>)>, AppError> {
    let topic = sqlx::query_as::<_, TopicRecord>(
        r#"
        SELECT
            id,
            slug,
            display_name,
            ranking_strategy,
            feed_size,
            hot_gravity,
            created_at
        FROM topics
        WHERE slug = $1
        "#,
    )
    .bind(topic_slug)
    .fetch_optional(pool)
    .await?;

    let Some(topic) = topic else {
        return Ok(None);
    };

    let items = sqlx::query_as::<_, TopicItemCandidate>(
        r#"
        SELECT
            items.id AS item_id,
            items.title,
            items.url,
            sources.slug AS source_slug,
            items.external_id,
            topic_items.current_score,
            items.metadata,
            items.published_at,
            items.crawled_at,
            topic_items.external_rank
        FROM topic_items
        INNER JOIN items ON items.id = topic_items.item_id
        INNER JOIN sources ON sources.id = items.source_id
        WHERE topic_items.topic_id = $1
        "#,
    )
    .bind(topic.id)
    .fetch_all(pool)
    .await?;

    Ok(Some((topic, items)))
}
