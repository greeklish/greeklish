use std::net::SocketAddr;
use std::time::{Duration, Instant};

use argon2::password_hash::PasswordHash;
use argon2::{Argon2, PasswordVerifier};
use axum::Json;
use axum::extract::{ConnectInfo, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::api::guards::{enforce_rate_limit, require_allowed_origin, require_json_content_type};
use crate::crypto;
use crate::db::guest_comments::{
    self, CommentStatus, LogEntry, ModerationAction, QueueEntry, TrustState,
};
use crate::error::AppError;
use crate::net;
use crate::ratelimit::{RateKey, RateRule, RateScope};
use crate::state::AppState;
use crate::ticker;
use crate::ws::messages::{GuestComment, ServerMessage};

/// Name of the moderator session cookie.
///
/// The `__Host-` prefix forces `Secure` and `Path=/` and forbids `Domain`, so the cookie cannot be
/// set by a subdomain or over plain HTTP. Browsers treat `http://localhost` as a secure context,
/// so this works unchanged in development.
pub const SESSION_COOKIE: &str = "__Host-gl_mod";

/// Minimum wall-clock time any login attempt takes.
///
/// Makes "wrong password", "rate limited" and "no hash configured" indistinguishable by timing.
const LOGIN_RESPONSE_FLOOR: Duration = Duration::from_millis(300);

const DEFAULT_PAGE_SIZE: i64 = 50;
const MAX_PAGE_SIZE: i64 = 200;

/// Length of the IP-hash prefix shown to the moderator.
///
/// Enough to recognize a burst from one source, never enough to recover an address.
const IP_HASH_PREFIX_BYTES: usize = 4;

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct CreateSessionResponse {
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
pub struct StatsResponse {
    pub pending_suggestions: i64,
    pub pending: i64,
    pub approved: i64,
    pub rejected: i64,
    pub spam: i64,
    pub hidden: i64,
    pub auto_approved: i64,
}

pub async fn connection_stats(State(state): State<AppState>) -> Json<ServerMessage> {
    Json(ServerMessage::ConnectionStats {
        unique_client_ips: state.connected_client_ips(),
        websocket_connections: state.connected_clients(),
        as_of: crate::ticker::timestamp_millis(),
    })
}

#[derive(Debug, Serialize)]
pub struct QueueItem {
    pub id: String,
    pub body: String,
    pub author_id: String,
    pub author_display_name: String,
    pub author_approved_count: i32,
    pub author_trust_state: String,
    pub author_fingerprint: Option<String>,
    pub status: String,
    pub auto_approved: bool,
    pub hold_reason: Option<String>,
    pub created_at: String,
    pub topic: String,
    pub topic_display_name: String,
    pub external_id: String,
    pub item_title: String,
    pub item_url: String,
}

#[derive(Debug, Serialize)]
pub struct QueueResponse {
    pub comments: Vec<QueueItem>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LogItem {
    pub id: String,
    pub comment_id: Option<String>,
    pub author_id: Option<String>,
    pub action: String,
    pub actor: String,
    pub reason: Option<String>,
    pub author_approved_count: Option<i32>,
    pub recorded_at: String,
    pub body: Option<String>,
    pub author_display_name: Option<String>,
    pub status: Option<String>,
    pub topic: Option<String>,
    pub external_id: Option<String>,
    pub item_title: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LogResponse {
    pub events: Vec<LogItem>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct QueueQuery {
    #[serde(flatten)]
    pub filters: guest_comments::ModerationFilters,
    pub status: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct LogQuery {
    #[serde(flatten)]
    pub filters: guest_comments::ModerationFilters,
    pub action: Option<String>,
    pub actor: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct DecisionRequest {
    pub action: String,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DecisionResponse {
    pub id: String,
    pub status: String,
    pub guest_comment_count: u32,
}

#[derive(Debug, Deserialize)]
pub struct TrustRequest {
    pub action: String,
}

/// Rejects any request without a live moderator session.
///
/// Mirrors `internal::require_internal_token` in shape. Every failure returns the same generic
/// message: wrong password, expired session, missing cookie and lockout must be indistinguishable.
pub async fn require_moderator(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if state.comments_config().is_none() {
        return AppError::not_found("comments are not enabled on this deployment").into_response();
    }

    let authorized = net::cookie_value(request.headers(), SESSION_COOKIE)
        .is_some_and(|token| state.touch_moderator_session(&token));

    if !authorized {
        return AppError::unauthorized("moderator session required").into_response();
    }

    next.run(request).await
}

pub async fn create_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    Json(payload): Json<CreateSessionRequest>,
) -> Result<Response, AppError> {
    let started = Instant::now();
    let result = attempt_login(&state, &headers, peer_addr, &payload).await;

    // Hold every outcome to the same floor before answering.
    let elapsed = started.elapsed();
    if elapsed < LOGIN_RESPONSE_FLOOR {
        tokio::time::sleep(LOGIN_RESPONSE_FLOOR - elapsed).await;
    }

    result
}

async fn attempt_login(
    state: &AppState,
    headers: &HeaderMap,
    peer_addr: SocketAddr,
    payload: &CreateSessionRequest,
) -> Result<Response, AppError> {
    let config = state.require_comments_config()?;

    require_json_content_type(headers)?;
    require_allowed_origin(config, headers)?;

    let client_ip = net::resolve_client_ip(headers).unwrap_or_else(|| peer_addr.ip());
    let subject = net::rate_limit_subject(client_ip);

    if let Some(remaining) = state.moderator_login_lockout(&subject) {
        return Err(AppError::too_many_requests(
            "Πάρα πολλές προσπάθειες. Δοκίμασε αργότερα.",
            remaining,
        ));
    }

    enforce_rate_limit(
        state,
        RateKey::new(RateScope::ModeratorLoginIp, subject.clone()),
        &[RateRule::new(
            config.login_attempt_limit,
            config.login_attempt_window,
        )],
        "Πάρα πολλές προσπάθειες. Δοκίμασε αργότερα.",
    )?;

    let parsed = PasswordHash::new(&config.moderator_password_hash).map_err(|_| {
        AppError::config("MODERATOR_PASSWORD_ARGON2_HASH is not a valid PHC string")
    })?;

    let verified = Argon2::default()
        .verify_password(payload.password.as_bytes(), &parsed)
        .is_ok();

    if !verified {
        state.record_moderator_login_failure(&subject);
        return Err(AppError::unauthorized("Λάθος κωδικός."));
    }

    state.clear_moderator_login_failures(&subject);

    let token = state.create_moderator_session();
    let expires_at = OffsetDateTime::now_utc() + config.moderator_session_ttl;
    let max_age = config.moderator_session_ttl.as_secs();

    let cookie = format!(
        "{SESSION_COOKIE}={token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age={max_age}"
    );

    let body = Json(CreateSessionResponse {
        expires_at: format_timestamp(expires_at)?,
    });

    let mut response = (StatusCode::CREATED, body).into_response();
    set_cookie(&mut response, &cookie)?;

    Ok(response)
}

pub async fn delete_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    state.require_comments_config()?;

    if let Some(token) = net::cookie_value(&headers, SESSION_COOKIE) {
        state.revoke_moderator_session(&token);
    }

    let cookie = format!("{SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0");

    let mut response = StatusCode::NO_CONTENT.into_response();
    set_cookie(&mut response, &cookie)?;

    Ok(response)
}

pub async fn get_stats(State(state): State<AppState>) -> Result<Json<StatsResponse>, AppError> {
    let counts = guest_comments::status_counts(state.db_pool()).await?;

    Ok(Json(StatsResponse {
        pending_suggestions: crate::db::feed_suggestions::pending_count(state.db_pool()).await?,
        pending: counts.pending,
        approved: counts.approved,
        rejected: counts.rejected,
        spam: counts.spam,
        hidden: counts.hidden,
        auto_approved: counts.auto_approved,
    }))
}

pub async fn list_feeds(
    State(state): State<AppState>,
) -> Result<Json<Vec<guest_comments::ModerationFeed>>, AppError> {
    Ok(Json(
        guest_comments::moderation_feeds(state.db_pool()).await?,
    ))
}

pub async fn list_queue(
    State(state): State<AppState>,
    Query(query): Query<QueueQuery>,
) -> Result<Json<QueueResponse>, AppError> {
    let statuses: Vec<&str> = match query.status.as_deref() {
        None | Some("pending") => vec!["pending"],
        Some("approved") => vec!["approved"],
        Some("rejected") => vec!["rejected"],
        Some("spam") => vec!["spam"],
        Some("hidden") => vec!["hidden"],
        Some("all") => vec!["pending", "approved", "rejected", "spam", "hidden"],
        Some(other) => {
            return Err(AppError::bad_request(format!(
                "unknown status filter `{other}`"
            )));
        }
    };

    query.filters.validate()?;
    let limit = clamp_limit(query.limit);
    let before = parse_cursor(query.cursor.as_deref())?;
    let mut entries = guest_comments::list_queue(
        state.db_pool(),
        &statuses,
        before,
        &query.filters,
        limit + 1,
    )
    .await?;

    let next_cursor = next_cursor(&mut entries, limit, |entry| (entry.created_at, entry.id))?;
    let comments = entries
        .into_iter()
        .map(queue_item)
        .collect::<Result<Vec<_>, AppError>>()?;

    Ok(Json(QueueResponse {
        comments,
        next_cursor,
    }))
}

pub async fn list_log(
    State(state): State<AppState>,
    Query(query): Query<LogQuery>,
) -> Result<Json<LogResponse>, AppError> {
    let actions: Option<Vec<String>> = match query.action.as_deref() {
        None | Some("") | Some("all") => None,
        Some(list) => {
            let parsed = list
                .split(',')
                .map(|action| {
                    ModerationAction::from_str(action.trim()).map(|a| a.as_str().to_owned())
                })
                .collect::<Result<Vec<_>, AppError>>()?;

            Some(parsed)
        }
    };

    let actor = match query.actor.as_deref() {
        None | Some("") | Some("all") => None,
        Some("system") => Some("system"),
        Some("moderator") => Some("moderator"),
        Some(other) => {
            return Err(AppError::bad_request(format!(
                "unknown actor filter `{other}`"
            )));
        }
    };

    query.filters.validate()?;
    let limit = clamp_limit(query.limit);
    let before = parse_cursor(query.cursor.as_deref())?;
    let mut entries = guest_comments::list_log(
        state.db_pool(),
        actions.as_deref(),
        actor,
        before,
        &query.filters,
        limit + 1,
    )
    .await?;

    let next_cursor = next_cursor(&mut entries, limit, |entry| (entry.recorded_at, entry.id))?;
    let events = entries
        .into_iter()
        .map(log_item)
        .collect::<Result<Vec<_>, AppError>>()?;

    Ok(Json(LogResponse {
        events,
        next_cursor,
    }))
}

pub async fn decide_comment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(comment_id): Path<Uuid>,
    Json(payload): Json<DecisionRequest>,
) -> Result<Json<DecisionResponse>, AppError> {
    let config = state.require_comments_config()?;
    require_json_content_type(&headers)?;
    require_allowed_origin(config, &headers)?;

    let (status, action) = match payload.action.as_str() {
        "approve" => (CommentStatus::Approved, ModerationAction::Approved),
        "reject" => (CommentStatus::Rejected, ModerationAction::Rejected),
        "spam" => (CommentStatus::Spam, ModerationAction::MarkedSpam),
        "hide" => (CommentStatus::Hidden, ModerationAction::Hidden),
        "restore" => (CommentStatus::Pending, ModerationAction::Restored),
        other => {
            return Err(AppError::bad_request(format!(
                "unknown moderation action `{other}`"
            )));
        }
    };

    let reason = payload
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| !reason.is_empty());

    if reason.is_some_and(|reason| reason.chars().count() > 200) {
        return Err(AppError::bad_request(
            "reason must be at most 200 characters",
        ));
    }

    let now = OffsetDateTime::now_utc();
    let outcome =
        guest_comments::apply_decision(state.db_pool(), comment_id, status, action, reason, now)
            .await?;

    let guest_comment_count = u32::try_from(outcome.guest_comment_count).unwrap_or(u32::MAX);

    // A comment becoming public for the first time is pushed to readers; one losing visibility is
    // retracted. Everything else is a no-op on the public side.
    if outcome.new_status.is_public() && !outcome.previous_status.is_public() {
        state.broadcast(
            &outcome.topic_slug,
            ServerMessage::GuestCommentCreated {
                topic: outcome.topic_slug.clone(),
                external_id: outcome.external_id.clone(),
                guest_comment_count,
                comment: GuestComment {
                    id: outcome.comment_id.to_string(),
                    author_display_name: outcome.author_display_name.clone(),
                    body: outcome.body.clone(),
                    created_at: format_timestamp(outcome.created_at)?,
                    status: outcome.new_status.as_str().to_owned(),
                    auto_approved: false,
                    own: false,
                    reply_to_comment_id: outcome.reply_to_comment_id.map(|id| id.to_string()),
                },
            },
        );
    } else if outcome.previous_status.is_public() && !outcome.new_status.is_public() {
        state.broadcast(
            &outcome.topic_slug,
            ServerMessage::GuestCommentRemoved {
                topic: outcome.topic_slug.clone(),
                external_id: outcome.external_id.clone(),
                comment_id: outcome.comment_id.to_string(),
                guest_comment_count,
            },
        );
    }

    broadcast_queue_depth(&state).await;

    Ok(Json(DecisionResponse {
        id: outcome.comment_id.to_string(),
        status: outcome.new_status.as_str().to_owned(),
        guest_comment_count,
    }))
}

pub async fn set_author_trust(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(author_id): Path<Uuid>,
    Json(payload): Json<TrustRequest>,
) -> Result<StatusCode, AppError> {
    let config = state.require_comments_config()?;
    require_json_content_type(&headers)?;
    require_allowed_origin(config, &headers)?;

    let (trust_state, action) = match payload.action.as_str() {
        "revoke" => (TrustState::Revoked, ModerationAction::AuthorTrustRevoked),
        "restore" => (TrustState::Normal, ModerationAction::AuthorTrustRestored),
        "ban" => (TrustState::Banned, ModerationAction::AuthorBanned),
        "unban" => (TrustState::Normal, ModerationAction::AuthorUnbanned),
        other => {
            return Err(AppError::bad_request(format!(
                "unknown trust action `{other}`"
            )));
        }
    };

    guest_comments::set_author_trust(
        state.db_pool(),
        author_id,
        trust_state,
        action,
        OffsetDateTime::now_utc(),
    )
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

fn queue_item(entry: QueueEntry) -> Result<QueueItem, AppError> {
    Ok(QueueItem {
        id: entry.id.to_string(),
        body: entry.body,
        author_id: entry.author_id.to_string(),
        author_display_name: entry.author_display_name,
        author_approved_count: entry.author_approved_count,
        author_trust_state: entry.author_trust_state,
        author_fingerprint: entry
            .author_ip_hash
            .as_deref()
            .map(|hash| crypto::short_hex(hash, IP_HASH_PREFIX_BYTES)),
        status: entry.status,
        auto_approved: entry.auto_approved,
        hold_reason: entry.hold_reason,
        created_at: format_timestamp(entry.created_at)?,
        topic: entry.topic_slug,
        topic_display_name: entry.topic_display_name,
        external_id: entry.external_id,
        item_title: entry.item_title,
        item_url: entry.item_url,
    })
}

fn log_item(entry: LogEntry) -> Result<LogItem, AppError> {
    Ok(LogItem {
        id: entry.id.to_string(),
        comment_id: entry.comment_id.map(|id| id.to_string()),
        author_id: entry.author_id.map(|id| id.to_string()),
        action: entry.action,
        actor: entry.actor,
        reason: entry.reason,
        author_approved_count: entry.author_approved_count,
        recorded_at: format_timestamp(entry.recorded_at)?,
        body: entry.body,
        author_display_name: entry.author_display_name,
        status: entry.status,
        topic: entry.topic_slug,
        external_id: entry.external_id,
        item_title: entry.item_title,
    })
}

fn clamp_limit(requested: Option<i64>) -> i64 {
    requested
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE)
}

/// Include the UUID to avoid skipping records with identical timestamps.
pub(super) fn parse_cursor(
    cursor: Option<&str>,
) -> Result<Option<(OffsetDateTime, Uuid)>, AppError> {
    let Some(cursor) = cursor.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let (timestamp, id) = cursor
        .split_once('|')
        .unwrap_or((cursor, "00000000-0000-0000-0000-000000000000"));
    let timestamp = OffsetDateTime::parse(timestamp, &Rfc3339)
        .map_err(|_| AppError::bad_request("invalid cursor timestamp"))?;
    let id = Uuid::parse_str(id).map_err(|_| AppError::bad_request("invalid cursor id"))?;
    Ok(Some((timestamp, id)))
}

pub(super) fn next_cursor<T>(
    entries: &mut Vec<T>,
    limit: i64,
    key: impl Fn(&T) -> (OffsetDateTime, Uuid),
) -> Result<Option<String>, AppError> {
    if entries.len() as i64 <= limit {
        return Ok(None);
    }
    entries.truncate(limit as usize);
    entries
        .last()
        .map(|entry| {
            let (timestamp, id) = key(entry);
            Ok(format!("{}|{}", format_timestamp(timestamp)?, id))
        })
        .transpose()
}

fn format_timestamp(value: OffsetDateTime) -> Result<String, AppError> {
    value
        .format(&Rfc3339)
        .map_err(|error| AppError::config(format!("failed to format timestamp: {error}")))
}

fn set_cookie(response: &mut Response, cookie: &str) -> Result<(), AppError> {
    let value = HeaderValue::from_str(cookie)
        .map_err(|_| AppError::config("failed to build session cookie"))?;
    response.headers_mut().insert(header::SET_COOKIE, value);

    Ok(())
}

/// Notifies subscribed moderator connections that the queue depth changed.
pub async fn broadcast_queue_depth(state: &AppState) {
    let Ok(counts) = guest_comments::status_counts(state.db_pool()).await else {
        return;
    };

    state.broadcast(
        crate::state::MODERATION_CHANNEL,
        ServerMessage::ModerationQueueChanged {
            pending: u32::try_from(counts.pending).unwrap_or(u32::MAX),
            as_of: ticker::timestamp_millis(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn query_decodes_combined_filters() {
        let id = Uuid::now_v7();
        let uri = format!("/?status=all&topic=test&author_id={id}&author=Same&q=needle&limit=1")
            .parse()
            .unwrap();
        let Query(query) = Query::<QueueQuery>::try_from_uri(&uri).unwrap();
        assert_eq!(query.filters.author_id, Some(id));
        assert_eq!(query.filters.topic.as_deref(), Some("test"));
        assert_eq!(query.filters.q.as_deref(), Some("needle"));
        assert_eq!(query.limit, Some(1));
        query.filters.validate().unwrap();
    }

    #[test]
    fn cursor_is_stable_when_timestamps_are_identical() {
        let time = OffsetDateTime::now_utc();
        let id = Uuid::now_v7();
        let mut entries = vec![(time, id), (time, Uuid::now_v7())];
        let cursor = next_cursor(&mut entries, 1, |entry| *entry)
            .unwrap()
            .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(parse_cursor(Some(&cursor)).unwrap(), Some((time, id)));
        assert!(
            next_cursor(&mut entries, 1, |entry| *entry)
                .unwrap()
                .is_none()
        );
        assert!(parse_cursor(Some("bad|cursor")).is_err());
    }
}
