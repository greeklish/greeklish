use std::collections::HashMap;

use serde_json::Value;
use sqlx::types::Json;
use sqlx::{PgPool, Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;
use crate::ranking::format_timestamp;
use crate::ws::messages::{CrawlSnapshot, CrawlSnapshotItem};

#[derive(Debug, Clone)]
pub struct InsertCrawlSnapshotItem<'a> {
    pub external_id: &'a str,
    pub title: &'a str,
    pub url: &'a str,
    pub score: f64,
    pub comments_count: Option<i32>,
    pub nsfw: Option<bool>,
    pub rank_position: i32,
    pub published_at: OffsetDateTime,
    pub crawled_at: OffsetDateTime,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct SnapshotIds {
    topic_id: Uuid,
    source_id: Uuid,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct SnapshotRow {
    id: Uuid,
    crawled_at: OffsetDateTime,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct SnapshotItemRow {
    snapshot_id: Uuid,
    external_id: String,
    title: String,
    url: String,
    score: f64,
    comments_count: Option<i32>,
    nsfw: Option<bool>,
    rank_position: i32,
    published_at: OffsetDateTime,
    crawled_at: OffsetDateTime,
    metadata: Option<Value>,
}

pub async fn insert_crawl_snapshot(
    pool: &PgPool,
    topic_slug: &str,
    source_slug: &str,
    crawled_at: OffsetDateTime,
    items: &[InsertCrawlSnapshotItem<'_>],
) -> Result<CrawlSnapshot, AppError> {
    let mut tx = pool.begin().await?;
    let snapshot = insert_crawl_snapshot_in_transaction(
        &mut tx,
        Uuid::now_v7(),
        topic_slug,
        source_slug,
        crawled_at,
        items,
    )
    .await?;
    tx.commit().await?;

    Ok(snapshot)
}

pub async fn insert_crawl_snapshot_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    snapshot_id: Uuid,
    topic_slug: &str,
    source_slug: &str,
    crawled_at: OffsetDateTime,
    items: &[InsertCrawlSnapshotItem<'_>],
) -> Result<CrawlSnapshot, AppError> {
    let ids = fetch_snapshot_ids(tx, topic_slug, source_slug).await?;
    let created_at = OffsetDateTime::now_utc();

    sqlx::query(
        r#"
        INSERT INTO crawl_snapshots (id, topic_id, source_id, crawled_at, item_count, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(snapshot_id)
    .bind(ids.topic_id)
    .bind(ids.source_id)
    .bind(crawled_at)
    .bind(
        i32::try_from(items.len())
            .map_err(|_| AppError::bad_request("snapshot item count must fit into i32"))?,
    )
    .bind(created_at)
    .execute(&mut **tx)
    .await?;

    for item in items {
        sqlx::query(
            r#"
            INSERT INTO crawl_snapshot_items (
                snapshot_id,
                rank_position,
                external_id,
                title,
                url,
                score,
                comments_count,
                nsfw,
                published_at,
                crawled_at,
                metadata
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            "#,
        )
        .bind(snapshot_id)
        .bind(item.rank_position)
        .bind(item.external_id)
        .bind(item.title)
        .bind(item.url)
        .bind(item.score)
        .bind(item.comments_count)
        .bind(item.nsfw)
        .bind(item.published_at)
        .bind(item.crawled_at)
        .bind(
            item.metadata
                .as_ref()
                .map(|metadata| Json(metadata.clone())),
        )
        .execute(&mut **tx)
        .await?;
    }

    Ok(CrawlSnapshot {
        id: snapshot_id.to_string(),
        crawled_at: format_timestamp(crawled_at)?,
        items: snapshot_items_to_payload(items)?,
    })
}

pub async fn crawl_snapshot_exists(
    tx: &mut Transaction<'_, Postgres>,
    snapshot_id: Uuid,
) -> Result<bool, AppError> {
    Ok(
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM crawl_snapshots WHERE id = $1)")
            .bind(snapshot_id)
            .fetch_one(&mut **tx)
            .await?,
    )
}

pub async fn fetch_crawl_snapshots_since(
    pool: &PgPool,
    topic_slug: &str,
    since: OffsetDateTime,
) -> Result<Vec<CrawlSnapshot>, AppError> {
    let rows = sqlx::query_as::<_, SnapshotRow>(
        r#"
        SELECT crawl_snapshots.id, crawl_snapshots.crawled_at
        FROM crawl_snapshots
        INNER JOIN topics ON topics.id = crawl_snapshots.topic_id
        WHERE topics.slug = $1
          AND crawl_snapshots.crawled_at >= $2
        ORDER BY crawl_snapshots.crawled_at ASC, crawl_snapshots.id ASC
        "#,
    )
    .bind(topic_slug)
    .bind(since)
    .fetch_all(pool)
    .await?;

    fetch_crawl_snapshots_for_rows(pool, rows).await
}

pub async fn fetch_latest_crawl_snapshot(
    pool: &PgPool,
    topic_slug: &str,
) -> Result<Option<CrawlSnapshot>, AppError> {
    let rows = sqlx::query_as::<_, SnapshotRow>(
        r#"
        SELECT crawl_snapshots.id, crawl_snapshots.crawled_at
        FROM crawl_snapshots
        INNER JOIN topics ON topics.id = crawl_snapshots.topic_id
        WHERE topics.slug = $1
        ORDER BY crawl_snapshots.crawled_at DESC, crawl_snapshots.id DESC
        LIMIT 1
        "#,
    )
    .bind(topic_slug)
    .fetch_all(pool)
    .await?;

    Ok(fetch_crawl_snapshots_for_rows(pool, rows)
        .await?
        .into_iter()
        .next())
}

async fn fetch_crawl_snapshots_for_rows(
    pool: &PgPool,
    rows: Vec<SnapshotRow>,
) -> Result<Vec<CrawlSnapshot>, AppError> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let snapshot_ids = rows.iter().map(|row| row.id).collect::<Vec<_>>();
    let item_rows = sqlx::query_as::<_, SnapshotItemRow>(
        r#"
        SELECT
            snapshot_id,
            external_id,
            title,
            url,
            score,
            comments_count,
            nsfw,
            rank_position,
            published_at,
            crawled_at,
            metadata
        FROM crawl_snapshot_items
        WHERE snapshot_id = ANY($1)
        ORDER BY snapshot_id, rank_position ASC
        "#,
    )
    .bind(&snapshot_ids)
    .fetch_all(pool)
    .await?;

    let mut items_by_snapshot = HashMap::<Uuid, Vec<SnapshotItemRow>>::new();
    for item in item_rows {
        items_by_snapshot
            .entry(item.snapshot_id)
            .or_default()
            .push(item);
    }

    rows.into_iter()
        .map(|snapshot| {
            let items = items_by_snapshot
                .remove(&snapshot.id)
                .unwrap_or_default()
                .into_iter()
                .map(crawl_snapshot_item_from_row)
                .collect::<Result<Vec<_>, AppError>>()?;

            Ok(CrawlSnapshot {
                id: snapshot.id.to_string(),
                crawled_at: format_timestamp(snapshot.crawled_at)?,
                items,
            })
        })
        .collect()
}

async fn fetch_snapshot_ids(
    tx: &mut Transaction<'_, Postgres>,
    topic_slug: &str,
    source_slug: &str,
) -> Result<SnapshotIds, AppError> {
    sqlx::query_as::<_, SnapshotIds>(
        r#"
        SELECT topics.id AS topic_id, sources.id AS source_id
        FROM topics
        INNER JOIN sources ON sources.slug = $2
        WHERE topics.slug = $1
        "#,
    )
    .bind(topic_slug)
    .bind(source_slug)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| {
        AppError::not_found(format!(
            "topic `{topic_slug}` or source `{source_slug}` does not exist"
        ))
    })
}

fn snapshot_items_to_payload(
    items: &[InsertCrawlSnapshotItem<'_>],
) -> Result<Vec<CrawlSnapshotItem>, AppError> {
    items
        .iter()
        .map(|item| {
            Ok(CrawlSnapshotItem {
                external_id: item.external_id.to_owned(),
                title: item.title.to_owned(),
                url: item.url.to_owned(),
                score: item.score,
                comments_count: item.comments_count,
                nsfw: item.nsfw,
                rank_position: item.rank_position,
                published_at: format_timestamp(item.published_at)?,
                crawled_at: format_timestamp(item.crawled_at)?,
                metadata: item.metadata.clone(),
            })
        })
        .collect()
}

fn crawl_snapshot_item_from_row(row: SnapshotItemRow) -> Result<CrawlSnapshotItem, AppError> {
    Ok(CrawlSnapshotItem {
        external_id: row.external_id,
        title: row.title,
        url: row.url,
        score: row.score,
        comments_count: row.comments_count,
        nsfw: row.nsfw,
        rank_position: row.rank_position,
        published_at: format_timestamp(row.published_at)?,
        crawled_at: format_timestamp(row.crawled_at)?,
        metadata: row.metadata,
    })
}
