use std::time::Duration;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    api::{
        comments,
        guards::{enforce_rate_limit, require_allowed_origin, require_json_content_type},
        moderation,
    },
    db::{guest_comments::TrustState, reply_notifications as db},
    error::AppError,
    ratelimit::{RateKey, RateRule, RateScope},
    state::AppState,
};

async fn author(state: &AppState, headers: &HeaderMap, writing: bool) -> Result<Uuid, AppError> {
    let config = state.require_comments_config()?;
    require_allowed_origin(config, headers)?;
    if writing {
        require_json_content_type(headers)?;
    }
    let author = comments::resolve_author(state, headers)
        .await?
        .ok_or_else(|| {
            AppError::unauthorized(
                "Η ταυτότητα σχολιασμού δεν είναι διαθέσιμη σε αυτόν τον περιηγητή.",
            )
        })?;
    if author.trust_state == TrustState::Banned.as_str() {
        return Err(AppError::forbidden("Οι ειδοποιήσεις δεν είναι διαθέσιμες."));
    }
    enforce_rate_limit(
        state,
        RateKey::new(
            if writing {
                RateScope::PushSettingsAuthor
            } else {
                RateScope::ReplyInboxAuthor
            },
            author.id.to_string(),
        ),
        &[RateRule::new(
            if writing { 60 } else { 120 },
            Duration::from_secs(60),
        )],
        "Πάρα πολλά αιτήματα. Δοκίμασε σε λίγο.",
    )?;
    Ok(author.id)
}

#[derive(Deserialize)]
pub struct InboxQuery {
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Serialize)]
pub struct Reply {
    pub id: Uuid,
    pub reply_id: Uuid,
    pub parent_id: Uuid,
    pub topic: String,
    pub external_id: String,
    pub item_title: String,
    pub item_url: String,
    pub author_display_name: String,
    pub body: String,
    pub created_at: String,
    pub unread: bool,
}

#[derive(Serialize)]
pub struct Inbox {
    pub replies: Vec<Reply>,
    pub unread_count: i64,
    pub next_cursor: Option<String>,
}

pub async fn inbox(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<InboxQuery>,
) -> Result<Json<Inbox>, AppError> {
    let author_id = author(&state, &headers, false).await?;
    let limit = query.limit.unwrap_or(30).clamp(1, 100);
    let before = moderation::parse_cursor(query.cursor.as_deref())?;
    let mut events = db::list_replies(state.db_pool(), author_id, before, limit + 1).await?;
    let next_cursor =
        moderation::next_cursor(&mut events, limit, |event| (event.created_at, event.id))?;
    let replies = events
        .into_iter()
        .map(|event| {
            Ok(Reply {
                id: event.id,
                reply_id: event.reply_id,
                parent_id: event.parent_id,
                topic: event.topic,
                external_id: event.external_id,
                item_title: event.item_title,
                item_url: event.item_url,
                author_display_name: event.author_display_name,
                body: event.body,
                created_at: event
                    .created_at
                    .format(&Rfc3339)
                    .map_err(|e| AppError::config(e.to_string()))?,
                unread: event.read_at.is_none(),
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    Ok(Json(Inbox {
        replies,
        next_cursor,
        unread_count: db::unread_count(state.db_pool(), author_id).await?,
    }))
}

pub async fn read_reply(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let author_id = author(&state, &headers, true).await?;
    db::mark_read(
        state.db_pool(),
        author_id,
        Some(id),
        OffsetDateTime::now_utc(),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn read_all(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, AppError> {
    let author_id = author(&state, &headers, true).await?;
    db::mark_read(state.db_pool(), author_id, None, OffsetDateTime::now_utc()).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct PushConfiguration {
    pub enabled: bool,
    pub public_key: Option<String>,
}

pub async fn push_config(
    State(state): State<AppState>,
) -> Result<Json<PushConfiguration>, AppError> {
    state.require_comments_config()?;
    Ok(Json(PushConfiguration {
        enabled: state.config().push.is_some(),
        public_key: state
            .config()
            .push
            .as_ref()
            .map(|config| config.public_key.clone()),
    }))
}

#[derive(Deserialize)]
pub struct PushKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Deserialize)]
pub struct Subscription {
    pub endpoint: String,
    pub keys: PushKeys,
}

#[derive(Serialize)]
pub struct RegisteredSubscription {
    pub id: Uuid,
    pub watched_comment_ids: Vec<Uuid>,
}

pub async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Subscription>,
) -> Result<Json<RegisteredSubscription>, AppError> {
    let author_id = author(&state, &headers, true).await?;
    if state.config().push.is_none() {
        return Err(AppError::not_found("push notifications disabled"));
    }
    crate::push::validate_subscription(&input.endpoint, &input.keys.p256dh, &input.keys.auth)?;
    let id = db::register_subscription(
        state.db_pool(),
        author_id,
        &input.endpoint,
        &input.keys.p256dh,
        &input.keys.auth,
        OffsetDateTime::now_utc(),
    )
    .await?;
    let watched_comment_ids = db::watched_comments(state.db_pool(), author_id, id).await?;
    Ok(Json(RegisteredSubscription {
        id,
        watched_comment_ids,
    }))
}

pub async fn subscription(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<RegisteredSubscription>, AppError> {
    let author_id = author(&state, &headers, false).await?;
    Ok(Json(RegisteredSubscription {
        id,
        watched_comment_ids: db::watched_comments(state.db_pool(), author_id, id).await?,
    }))
}

pub async fn unsubscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, AppError> {
    let author_id = author(&state, &headers, true).await?;
    db::delete_subscription(state.db_pool(), author_id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn watch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, comment_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, AppError> {
    let author_id = author(&state, &headers, true).await?;
    if state.config().push.is_none() {
        return Err(AppError::not_found("push notifications disabled"));
    }
    db::set_watch(
        state.db_pool(),
        author_id,
        id,
        comment_id,
        true,
        OffsetDateTime::now_utc(),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn unwatch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, comment_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, AppError> {
    let author_id = author(&state, &headers, true).await?;
    db::set_watch(
        state.db_pool(),
        author_id,
        id,
        comment_id,
        false,
        OffsetDateTime::now_utc(),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
