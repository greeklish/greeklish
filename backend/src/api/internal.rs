use std::net::SocketAddr;

use axum::Json;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{StatusCode, header::HeaderName};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use crate::db::{crawl_snapshots, items, maintenance, sources, topics};
use crate::error::AppError;
use crate::state::AppState;
use crate::ws::messages::RankingStrategy;

const INTERNAL_TOKEN_HEADER: HeaderName = HeaderName::from_static("x-internal-token");

#[derive(Debug, Deserialize)]
pub struct UpsertSourceRequest {
    pub display_name: String,
    pub base_url: String,
}

#[derive(Debug, Deserialize)]
pub struct UpsertTopicRequest {
    pub display_name: String,
    pub ranking_strategy: RankingStrategy,
    pub feed_size: Option<i32>,
    pub hot_gravity: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct UpsertTopicItemRequest {
    pub title: String,
    pub url: String,
    pub score: f64,
    #[serde(with = "time::serde::rfc3339")]
    pub published_at: OffsetDateTime,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub crawled_at: Option<OffsetDateTime>,
    pub rank: Option<i32>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct CreateCrawlSnapshotRequest {
    pub source_slug: String,
    #[serde(with = "time::serde::rfc3339")]
    pub crawled_at: OffsetDateTime,
    pub items: Vec<CreateCrawlSnapshotItemRequest>,
}

#[derive(Debug, Deserialize)]
pub struct CreateCrawlSnapshotItemRequest {
    pub external_id: String,
    pub title: String,
    pub url: String,
    pub score: f64,
    pub comments_count: Option<i32>,
    pub nsfw: Option<bool>,
    pub rank: i32,
    #[serde(with = "time::serde::rfc3339")]
    pub published_at: OffsetDateTime,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct IngestCrawlPassRequest {
    pub crawl_id: uuid::Uuid,
    pub source_slug: String,
    #[serde(with = "time::serde::rfc3339")]
    pub crawled_at: OffsetDateTime,
    pub items: Vec<IngestCrawlPassItemRequest>,
}

#[derive(Debug, Deserialize)]
pub struct IngestCrawlPassItemRequest {
    pub external_id: String,
    pub title: String,
    pub url: String,
    pub score: f64,
    pub comments_count: Option<i32>,
    pub nsfw: Option<bool>,
    pub rank: i32,
    #[serde(with = "time::serde::rfc3339")]
    pub published_at: OffsetDateTime,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct PruneHistoryRequest {
    pub older_than_days: i64,
    #[serde(default = "default_vacuum")]
    pub vacuum: bool,
}

#[derive(Debug, Serialize)]
pub struct UpsertSourceResponse {
    pub id: String,
    pub slug: String,
    pub display_name: String,
    pub base_url: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct UpsertTopicResponse {
    pub id: String,
    pub slug: String,
    pub display_name: String,
    pub ranking_strategy: RankingStrategy,
    pub feed_size: i32,
    pub hot_gravity: Option<f64>,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct UpsertTopicItemResponse {
    pub topic_id: String,
    pub item_id: String,
    pub source_id: String,
    pub external_id: String,
    pub recorded_at: String,
}

#[derive(Debug, Serialize)]
pub struct RerankResponse {
    pub topic: String,
    pub queued: bool,
}

#[derive(Debug, Serialize)]
pub struct CreateCrawlSnapshotResponse {
    pub id: String,
    pub topic: String,
    pub item_count: usize,
    pub crawled_at: String,
}

#[derive(Debug, Serialize)]
pub struct IngestCrawlPassResponse {
    pub crawl_id: String,
    pub topic: String,
    pub item_count: usize,
    pub external_ids: Vec<String>,
    pub crawled_at: String,
    pub already_ingested: bool,
}

#[derive(Debug, Serialize)]
pub struct PruneHistoryResponse {
    pub cutoff: String,
    pub vacuumed_tables: Vec<&'static str>,
    pub deleted: PruneHistoryDeletedCounts,
}

#[derive(Debug, Serialize)]
pub struct PruneHistoryDeletedCounts {
    pub crawl_snapshots: i64,
    pub crawl_snapshot_items: i64,
    pub score_snapshots: i64,
    pub item_observations: i64,
    pub topic_item_events: i64,
    pub topic_runs: i64,
}

fn default_vacuum() -> bool {
    true
}

pub async fn require_internal_token(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let actual_token = request
        .headers()
        .get(INTERNAL_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok());

    if actual_token != Some(state.config().internal_api_token.as_str()) {
        return AppError::unauthorized("missing or invalid X-Internal-Token").into_response();
    }

    next.run(request).await
}

pub async fn prune_history(
    State(state): State<AppState>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    Json(payload): Json<PruneHistoryRequest>,
) -> Result<(StatusCode, Json<PruneHistoryResponse>), AppError> {
    if !peer_addr.ip().is_loopback() {
        return Err(AppError::forbidden(
            "maintenance cleanup can only be called from localhost",
        ));
    }

    if payload.older_than_days <= 0 {
        return Err(AppError::bad_request("older_than_days must be positive"));
    }

    let cutoff = OffsetDateTime::now_utc() - Duration::days(payload.older_than_days);
    let result = maintenance::clean_history(state.db_pool(), cutoff, payload.vacuum).await?;

    Ok((
        StatusCode::OK,
        Json(PruneHistoryResponse {
            cutoff: crate::ranking::format_timestamp(result.cutoff)?,
            vacuumed_tables: result.vacuumed_tables,
            deleted: PruneHistoryDeletedCounts {
                crawl_snapshots: result.crawl_snapshots_deleted,
                crawl_snapshot_items: result.crawl_snapshot_items_deleted,
                score_snapshots: result.score_snapshots_deleted,
                item_observations: result.item_observations_deleted,
                topic_item_events: result.topic_item_events_deleted,
                topic_runs: result.topic_runs_deleted,
            },
        }),
    ))
}

pub async fn upsert_source(
    State(state): State<AppState>,
    Path(source_slug): Path<String>,
    Json(payload): Json<UpsertSourceRequest>,
) -> Result<(StatusCode, Json<UpsertSourceResponse>), AppError> {
    let source_slug = validate_slug(&source_slug)?;
    let record = sources::upsert_source(
        state.db_pool(),
        &source_slug,
        &payload.display_name,
        &payload.base_url,
    )
    .await?;

    Ok((
        StatusCode::OK,
        Json(UpsertSourceResponse {
            id: record.id.to_string(),
            slug: record.slug,
            display_name: record.display_name,
            base_url: record.base_url,
            created_at: crate::ranking::format_timestamp(record.created_at)?,
        }),
    ))
}

pub async fn upsert_topic(
    State(state): State<AppState>,
    Path(topic_slug): Path<String>,
    Json(payload): Json<UpsertTopicRequest>,
) -> Result<(StatusCode, Json<UpsertTopicResponse>), AppError> {
    let topic_slug = validate_slug(&topic_slug)?;

    let feed_size = payload
        .feed_size
        .unwrap_or(state.config().default_feed_size);
    if feed_size <= 0 {
        return Err(AppError::bad_request("feed_size must be positive"));
    }

    let hot_gravity = match payload.ranking_strategy {
        RankingStrategy::Hot => Some(payload.hot_gravity.unwrap_or(state.config().hot_gravity)),
        _ => None,
    };

    if let Some(gravity) = hot_gravity {
        if gravity <= 0.0 {
            return Err(AppError::bad_request(
                "hot_gravity must be greater than zero",
            ));
        }
    }

    let record = topics::upsert_topic(
        state.db_pool(),
        &topic_slug,
        &payload.display_name,
        payload.ranking_strategy,
        feed_size,
        hot_gravity,
    )
    .await?;

    Ok((
        StatusCode::OK,
        Json(UpsertTopicResponse {
            id: record.id.to_string(),
            slug: record.slug,
            display_name: record.display_name,
            ranking_strategy: record.ranking_strategy,
            feed_size: record.feed_size,
            hot_gravity: record.hot_gravity,
            created_at: crate::ranking::format_timestamp(record.created_at)?,
        }),
    ))
}

pub async fn upsert_topic_item(
    State(state): State<AppState>,
    Path((topic_slug, source_slug, external_id)): Path<(String, String, String)>,
    Json(payload): Json<UpsertTopicItemRequest>,
) -> Result<(StatusCode, Json<UpsertTopicItemResponse>), AppError> {
    let topic_slug = validate_slug(&topic_slug)?;
    let source_slug = validate_slug(&source_slug)?;

    if let Some(rank) = payload.rank {
        if rank <= 0 {
            return Err(AppError::bad_request("rank must be a positive integer"));
        }
    }

    let recorded_at = OffsetDateTime::now_utc();
    let crawled_at = payload.crawled_at.unwrap_or(recorded_at);

    let result = items::ingest_topic_item(
        state.db_pool(),
        items::IngestTopicItemParams {
            topic_slug: &topic_slug,
            source_slug: &source_slug,
            external_id: &external_id,
            title: &payload.title,
            url: &payload.url,
            score: payload.score,
            published_at: payload.published_at,
            crawled_at,
            recorded_at,
            external_rank: payload.rank,
            metadata: payload.metadata.clone(),
        },
    )
    .await?;

    if result.ranking_strategy == RankingStrategy::External {
        state.queue_ingest_rerank(topic_slug.clone());
    }

    tracing::debug!(
        topic_slug = %topic_slug,
        source_slug = %source_slug,
        external_id = %external_id,
        "ingestion transaction committed"
    );

    Ok((
        StatusCode::OK,
        Json(UpsertTopicItemResponse {
            topic_id: result.topic_id.to_string(),
            item_id: result.item_id.to_string(),
            source_id: result.source_id.to_string(),
            external_id,
            recorded_at: crate::ranking::format_timestamp(recorded_at)?,
        }),
    ))
}

pub async fn rerank_topic(
    State(state): State<AppState>,
    Path(topic_slug): Path<String>,
) -> Result<(StatusCode, Json<RerankResponse>), AppError> {
    let topic_slug = validate_slug(&topic_slug)?;

    if topics::get_topic_by_slug(state.db_pool(), &topic_slug)
        .await?
        .is_none()
    {
        return Err(AppError::not_found(format!(
            "unknown topic slug `{topic_slug}`"
        )));
    }

    state.queue_rerank(topic_slug.clone());

    Ok((
        StatusCode::ACCEPTED,
        Json(RerankResponse {
            topic: topic_slug,
            queued: true,
        }),
    ))
}

pub async fn create_crawl_snapshot(
    State(state): State<AppState>,
    Path(topic_slug): Path<String>,
    Json(payload): Json<CreateCrawlSnapshotRequest>,
) -> Result<(StatusCode, Json<CreateCrawlSnapshotResponse>), AppError> {
    let topic_slug = validate_slug(&topic_slug)?;
    let source_slug = validate_slug(&payload.source_slug)?;

    for item in &payload.items {
        if item.rank <= 0 {
            return Err(AppError::bad_request("snapshot item rank must be positive"));
        }

        if item.comments_count.is_some_and(|count| count < 0) {
            return Err(AppError::bad_request(
                "snapshot item comments_count must not be negative",
            ));
        }
    }

    let items = payload
        .items
        .iter()
        .map(|item| crawl_snapshots::InsertCrawlSnapshotItem {
            external_id: &item.external_id,
            title: &item.title,
            url: &item.url,
            score: item.score,
            comments_count: item.comments_count,
            nsfw: item.nsfw,
            rank_position: item.rank,
            published_at: item.published_at,
            crawled_at: payload.crawled_at,
            metadata: item.metadata.clone(),
        })
        .collect::<Vec<_>>();

    let snapshot = crawl_snapshots::insert_crawl_snapshot(
        state.db_pool(),
        &topic_slug,
        &source_slug,
        payload.crawled_at,
        &items,
    )
    .await?;
    let topic_record = topics::get_topic_by_slug(state.db_pool(), &topic_slug)
        .await?
        .ok_or_else(|| AppError::not_found(format!("unknown topic slug `{topic_slug}`")))?;

    state.broadcast(
        &topic_slug,
        crate::ws::messages::ServerMessage::CrawlSnapshot {
            topic: topic_slug.clone(),
            display_name: topic_record.display_name,
            snapshot: snapshot.clone(),
        },
    );

    Ok((
        StatusCode::CREATED,
        Json(CreateCrawlSnapshotResponse {
            id: snapshot.id,
            topic: topic_slug,
            item_count: snapshot.items.len(),
            crawled_at: snapshot.crawled_at,
        }),
    ))
}

pub async fn ingest_crawl_pass(
    State(state): State<AppState>,
    Path(topic_slug): Path<String>,
    Json(payload): Json<IngestCrawlPassRequest>,
) -> Result<(StatusCode, Json<IngestCrawlPassResponse>), AppError> {
    let topic_slug = validate_slug(&topic_slug)?;
    let source_slug = validate_slug(&payload.source_slug)?;

    for item in &payload.items {
        if item.external_id.is_empty() {
            return Err(AppError::bad_request(
                "crawl pass item external_id must not be empty",
            ));
        }
        if item.rank <= 0 {
            return Err(AppError::bad_request(
                "crawl pass item rank must be positive",
            ));
        }
        if item.comments_count.is_some_and(|count| count < 0) {
            return Err(AppError::bad_request(
                "crawl pass item comments_count must not be negative",
            ));
        }
    }

    let external_ids = payload
        .items
        .iter()
        .map(|item| item.external_id.clone())
        .collect::<Vec<_>>();
    let mut tx = state.db_pool().begin().await?;

    if crawl_snapshots::crawl_snapshot_exists(&mut tx, payload.crawl_id).await? {
        return Ok((
            StatusCode::OK,
            Json(IngestCrawlPassResponse {
                crawl_id: payload.crawl_id.to_string(),
                topic: topic_slug,
                item_count: payload.items.len(),
                external_ids,
                crawled_at: crate::ranking::format_timestamp(payload.crawled_at)?,
                already_ingested: true,
            }),
        ));
    }

    let recorded_at = OffsetDateTime::now_utc();
    let mut ranking_strategy = None;
    for item in &payload.items {
        let result = items::ingest_topic_item_in_transaction(
            &mut tx,
            items::IngestTopicItemParams {
                topic_slug: &topic_slug,
                source_slug: &source_slug,
                external_id: &item.external_id,
                title: &item.title,
                url: &item.url,
                score: item.score,
                published_at: item.published_at,
                crawled_at: payload.crawled_at,
                recorded_at,
                external_rank: Some(item.rank),
                metadata: item.metadata.clone(),
            },
        )
        .await?;
        ranking_strategy = Some(result.ranking_strategy);
    }

    let snapshot_items = payload
        .items
        .iter()
        .map(|item| crawl_snapshots::InsertCrawlSnapshotItem {
            external_id: &item.external_id,
            title: &item.title,
            url: &item.url,
            score: item.score,
            comments_count: item.comments_count,
            nsfw: item.nsfw,
            rank_position: item.rank,
            published_at: item.published_at,
            crawled_at: payload.crawled_at,
            metadata: item.metadata.clone(),
        })
        .collect::<Vec<_>>();
    let snapshot = crawl_snapshots::insert_crawl_snapshot_in_transaction(
        &mut tx,
        payload.crawl_id,
        &topic_slug,
        &source_slug,
        payload.crawled_at,
        &snapshot_items,
    )
    .await?;
    tx.commit().await?;

    if ranking_strategy == Some(RankingStrategy::External) {
        state.queue_ingest_rerank(topic_slug.clone());
    }

    let topic_record = topics::get_topic_by_slug(state.db_pool(), &topic_slug)
        .await?
        .ok_or_else(|| AppError::not_found(format!("unknown topic slug `{topic_slug}`")))?;
    state.broadcast(
        &topic_slug,
        crate::ws::messages::ServerMessage::CrawlSnapshot {
            topic: topic_slug.clone(),
            display_name: topic_record.display_name,
            snapshot,
        },
    );

    Ok((
        StatusCode::CREATED,
        Json(IngestCrawlPassResponse {
            crawl_id: payload.crawl_id.to_string(),
            topic: topic_slug,
            item_count: payload.items.len(),
            external_ids,
            crawled_at: crate::ranking::format_timestamp(payload.crawled_at)?,
            already_ingested: false,
        }),
    ))
}

pub fn validate_slug(input: &str) -> Result<String, AppError> {
    if input.is_empty() {
        return Err(AppError::bad_request("slug must not be empty"));
    }

    let valid = input
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');

    if !valid {
        return Err(AppError::bad_request(
            "slug must contain only lowercase ASCII letters, digits, or hyphens",
        ));
    }

    Ok(input.to_owned())
}
