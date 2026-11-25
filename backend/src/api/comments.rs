use std::net::SocketAddr;
use std::time::Duration;

use axum::Json;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use unicode_normalization::UnicodeNormalization;

use crate::api::guards::{enforce_rate_limit, require_allowed_origin, require_json_content_type};
use crate::api::internal::validate_slug;
use crate::api::moderation;
use crate::captcha::{self, CaptchaChallenge, CaptchaSolution};
use crate::config::CommentsConfig;
use crate::crypto;
use crate::db::guest_comments::{
    self, AuthorRecord, CommentRecord, CommentStatus, InsertCommentParams, InsertEventParams,
    ModerationAction, ModerationActor, TrustState,
};
use crate::error::AppError;
use crate::net;
use crate::ratelimit::{RateKey, RateRule, RateScope};
use crate::state::AppState;
use crate::ws::messages::{GuestComment, ServerMessage};

/// Header carrying the guest's opaque author token.
pub const GUEST_TOKEN_HEADER: &str = "x-guest-token";

const DEFAULT_DISPLAY_NAME: &str = "Επισκέπτης";
const MAX_DISPLAY_NAME_CHARS: usize = 24;
const MIN_BODY_CHARS: usize = 2;
const MAX_REPEATED_CHARS: usize = 10;
const DUPLICATE_WINDOW: Duration = Duration::from_secs(86_400);
const RECENT_REJECTION_WINDOW: Duration = Duration::from_secs(7 * 86_400);
const AUTO_APPROVE_BURST_WINDOW: Duration = Duration::from_secs(3_600);
const MAX_AUTO_APPROVE_BURST: i64 = 5;

const HOUR: Duration = Duration::from_secs(3_600);
const DAY: Duration = Duration::from_secs(86_400);

#[derive(Debug, Deserialize)]
pub struct CreateCommentRequest {
    pub topic: String,
    pub external_id: String,
    pub body: String,
    pub display_name: Option<String>,
    pub captcha: CaptchaSolution,
    pub reply_to_comment_id: Option<uuid::Uuid>,
}

#[derive(Debug, Serialize)]
pub struct CreateCommentResponse {
    pub comment: GuestComment,
    pub guest_comment_count: u32,
    /// Returned exactly once, on an author's first ever comment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_token: Option<String>,
    pub next_comment_in_secs: u64,
}

#[derive(Debug, Serialize)]
pub struct ListCommentsResponse {
    pub topic: String,
    pub external_id: String,
    pub guest_comment_count: u32,
    pub comments: Vec<GuestComment>,
    pub item_title: String,
    pub item_url: String,
}

#[derive(Debug, Serialize)]
pub struct CommentCountsResponse {
    pub topic: String,
    pub counts: HashMap<String, i64>,
}

#[derive(Debug, Deserialize)]
pub struct DiscussionsQuery {
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct Discussion {
    pub topic: String,
    pub topic_display_name: String,
    pub external_id: String,
    pub item_title: String,
    pub item_url: String,
    pub guest_comment_count: i64,
    pub last_comment_at: String,
}

#[derive(Debug, Serialize)]
pub struct DiscussionsResponse {
    pub discussions: Vec<Discussion>,
    pub next_cursor: Option<String>,
}

pub async fn list_discussions(
    State(state): State<AppState>,
    Query(query): Query<DiscussionsQuery>,
) -> Result<Json<DiscussionsResponse>, AppError> {
    state.require_comments_config()?;
    let limit = query.limit.unwrap_or(30).clamp(1, 100);
    let before = moderation::parse_cursor(query.cursor.as_deref())?;
    let mut entries = guest_comments::list_discussions(state.db_pool(), before, limit + 1).await?;
    let next_cursor = moderation::next_cursor(&mut entries, limit, |entry| {
        (entry.last_comment_at, entry.latest_comment_id)
    })?;
    let discussions = entries
        .into_iter()
        .map(|entry| {
            Ok(Discussion {
                topic: entry.topic,
                topic_display_name: entry.topic_display_name,
                external_id: entry.external_id,
                item_title: entry.item_title,
                item_url: entry.item_url,
                guest_comment_count: entry.guest_comment_count,
                last_comment_at: entry
                    .last_comment_at
                    .format(&Rfc3339)
                    .map_err(|error| AppError::config(error.to_string()))?,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    Ok(Json(DiscussionsResponse {
        discussions,
        next_cursor,
    }))
}

pub async fn get_captcha_challenge(
    State(state): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
) -> Result<Json<CaptchaChallenge>, AppError> {
    let config = state.require_comments_config()?;
    let client_ip = net::resolve_client_ip(&headers).unwrap_or_else(|| peer_addr.ip());

    enforce_rate_limit(
        &state,
        RateKey::new(RateScope::CaptchaIp, net::rate_limit_subject(client_ip)),
        &[RateRule::new(config.captcha_hourly_limit, HOUR)],
        "Πάρα πολλά αιτήματα. Δοκίμασε αργότερα.",
    )?;

    Ok(Json(captcha::issue(config, OffsetDateTime::now_utc())))
}

pub async fn list_item_comments(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((topic_slug, external_id)): Path<(String, String)>,
) -> Result<Json<ListCommentsResponse>, AppError> {
    state.require_comments_config()?;

    let topic_slug = validate_slug(&topic_slug)?;
    let item = guest_comments::resolve_item(state.db_pool(), &topic_slug, &external_id)
        .await?
        .ok_or_else(|| AppError::not_found("unknown item"))?;

    let viewer = resolve_author(&state, &headers).await?;
    let viewer_id = viewer.as_ref().map(|author| author.id);

    let records =
        guest_comments::list_comments_for_item(state.db_pool(), item.item_id, viewer_id).await?;

    let guest_comment_count = records
        .iter()
        .filter(|record| record.status == CommentStatus::Approved.as_str())
        .count();

    let comments = records
        .into_iter()
        .map(|record| payload_from_record(&record, viewer_id))
        .collect::<Result<Vec<_>, AppError>>()?;

    Ok(Json(ListCommentsResponse {
        topic: topic_slug,
        external_id: item.external_id,
        item_title: item.item_title,
        item_url: item.item_url,
        guest_comment_count: u32::try_from(guest_comment_count).unwrap_or(u32::MAX),
        comments,
    }))
}

pub async fn list_topic_comment_counts(
    State(state): State<AppState>,
    Path(topic_slug): Path<String>,
) -> Result<Json<CommentCountsResponse>, AppError> {
    state.require_comments_config()?;

    let topic_slug = validate_slug(&topic_slug)?;
    let counts = guest_comments::count_approved_by_topic(state.db_pool(), &topic_slug).await?;

    Ok(Json(CommentCountsResponse {
        topic: topic_slug,
        counts: counts.into_iter().collect(),
    }))
}

pub async fn create_comment(
    State(state): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    Json(payload): Json<CreateCommentRequest>,
) -> Result<(StatusCode, Json<CreateCommentResponse>), AppError> {
    let config = state.require_comments_config()?;

    // Cheapest rejections first; the captcha grind and the database come last.
    require_json_content_type(&headers)?;
    require_allowed_origin(config, &headers)?;

    let topic_slug = validate_slug(&payload.topic)?;
    let body = normalize_body(&payload.body, config)?;
    let display_name = normalize_display_name(payload.display_name.as_deref())?;

    let client_ip = net::resolve_client_ip(&headers).unwrap_or_else(|| peer_addr.ip());
    let ip_subject = net::rate_limit_subject(client_ip);
    let ip_hash = crypto::hash_ip(&config.ip_pepper, &ip_subject);

    let now = OffsetDateTime::now_utc();

    if guest_comments::is_ip_blocked(state.db_pool(), &ip_hash, now).await? {
        return Err(AppError::forbidden(
            "Δεν είναι δυνατή η δημοσίευση σχολίων από αυτή τη σύνδεση.",
        ));
    }

    // Attempt protection is separate from the successful-posting quota.
    enforce_rate_limit(
        &state,
        RateKey::new(RateScope::CommentAttemptIp, ip_subject.clone()),
        &[RateRule::new(30, Duration::from_secs(60))],
        "Έγιναν πολλές προσπάθειες. Το πρόχειρό σου διατηρείται.",
    )?;
    let is_moderator = net::cookie_value(&headers, moderation::SESSION_COOKIE)
        .is_some_and(|token| state.touch_moderator_session(&token));
    let cooldown = if is_moderator {
        Duration::from_secs(2)
    } else {
        config
            .per_author_burst_interval
            .max(config.per_ip_burst_interval)
    };
    let ip_rules = [
        RateRule::new(1, config.per_ip_burst_interval),
        RateRule::new(config.per_ip_hourly_limit, HOUR),
        RateRule::new(config.per_ip_daily_limit, DAY),
    ];
    let ip_limit_message =
        "Συμπληρώθηκε προσωρινά το όριο σχολίων αυτής της σύνδεσης. Το πρόχειρό σου διατηρείται.";
    let ip_permit = if is_moderator {
        None
    } else {
        Some(state.reserve_comment_rate(
            RateKey::new(RateScope::CommentIp, ip_subject.clone()),
            &ip_rules,
            ip_limit_message,
        )?)
    };

    captcha::verify(config, &payload.captcha, now)?;
    let captcha_permit = state.reserve_captcha(&payload.captcha.challenge)?;

    let item = guest_comments::resolve_item(state.db_pool(), &topic_slug, &payload.external_id)
        .await?
        .ok_or_else(|| AppError::not_found("unknown item"))?;

    let existing_author = resolve_author(&state, &headers).await?;
    let mut tx = state.db_pool().begin().await?;

    let (author, author_token) = match existing_author {
        Some(author) => {
            let author = guest_comments::touch_author(&mut tx, author.id, now).await?;
            (author, None)
        }
        None => {
            let token = crypto::generate_token();
            let author =
                guest_comments::insert_author(&mut tx, &crypto::hash_token(&token), now).await?;
            (author, Some(token))
        }
    };

    if author.trust()? == TrustState::Banned {
        return Err(AppError::forbidden(
            "Δεν είναι δυνατή η δημοσίευση σχολίων.",
        ));
    }

    let author_rules = if is_moderator {
        vec![RateRule::new(1, cooldown)]
    } else {
        vec![
            RateRule::new(1, config.per_author_burst_interval),
            RateRule::new(config.per_author_hourly_limit, HOUR),
        ]
    };
    let author_permit = state.reserve_comment_rate(
        RateKey::new(RateScope::CommentAuthor, author.id.to_string()),
        &author_rules,
        "Χρειάζεται μια παύση πριν από το επόμενο σχόλιο. Το πρόχειρό σου διατηρείται.",
    )?;

    if !is_moderator {
        if let Some(release_at) = guest_comments::author_item_quota_release(
            &mut *tx,
            author.id,
            item.item_id,
            now - DAY,
            config.per_author_item_daily_limit.max(1) as i64,
        )
        .await?
        {
            return Err(AppError::too_many_requests(
                "Συμπληρώθηκε το ημερήσιο όριο για αυτό το άρθρο. Μπορείς να σχολιάσεις σε άλλο άρθρο.",
                (release_at + DAY - now).try_into().unwrap_or(Duration::from_secs(1)),
            ).for_item());
        }
    }

    let body_hash = crypto::hash_body(&body);

    if guest_comments::has_duplicate_body(&mut *tx, author.id, &body_hash, now - DUPLICATE_WINDOW)
        .await?
    {
        return Err(AppError::conflict("Έχεις στείλει ήδη το ίδιο σχόλιο."));
    }

    if !is_moderator
        && guest_comments::count_pending_for_author(&mut *tx, author.id).await?
            >= config.max_pending_per_author
    {
        return Err(AppError::conflict(
            "Έχεις ήδη σχόλια σε αναμονή έγκρισης. Περίμενε να ελεγχθούν.",
        ));
    }

    let decision = decide_auto_approval(&mut tx, config, &author, &body, now).await?;

    let record = guest_comments::insert_comment(
        &mut tx,
        InsertCommentParams {
            item_id: item.item_id,
            topic_id: item.topic_id,
            author_id: author.id,
            author_display_name: &display_name,
            body: &body,
            body_hash: &body_hash,
            status: decision.status,
            auto_approved: decision.auto_approved,
            hold_reason: decision.hold_reason,
            author_ip_hash: Some(&ip_hash),
            created_at: now,
            reply_to_comment_id: payload.reply_to_comment_id,
        },
    )
    .await?;

    guest_comments::insert_moderation_event(
        &mut tx,
        InsertEventParams {
            comment_id: Some(record.id),
            author_id: Some(author.id),
            action: if decision.auto_approved {
                ModerationAction::AutoApproved
            } else {
                ModerationAction::Held
            },
            actor: ModerationActor::System,
            reason: decision.hold_reason,
            author_approved_count: Some(author.approved_count),
            recorded_at: now,
        },
    )
    .await?;

    tx.commit().await?;
    if let Some(permit) = ip_permit {
        permit.commit();
    }
    author_permit.commit();

    // Only now is the challenge burnt: an earlier failure must not cost the guest a valid one.
    captcha_permit.commit();

    let guest_comment_count =
        guest_comments::count_approved_for_item(state.db_pool(), item.item_id).await?;
    let guest_comment_count = u32::try_from(guest_comment_count).unwrap_or(u32::MAX);

    let comment = payload_from_record(&record, Some(author.id))?;

    // Approved comments are pushed to every reader of the topic. A pending comment is never
    // broadcast: it exists only in the response to its own author.
    if decision.status.is_public() {
        let mut broadcast_copy = comment.clone();
        broadcast_copy.own = false;

        state.broadcast(
            &topic_slug,
            ServerMessage::GuestCommentCreated {
                topic: topic_slug.clone(),
                external_id: item.external_id.clone(),
                guest_comment_count,
                comment: broadcast_copy,
            },
        );
    } else {
        moderation::broadcast_queue_depth(&state).await;
    }

    Ok((
        StatusCode::CREATED,
        Json(CreateCommentResponse {
            comment,
            guest_comment_count,
            author_token,
            next_comment_in_secs: cooldown.as_secs(),
        }),
    ))
}

/// Outcome of the auto-approval evaluation.
struct AutoApprovalDecision {
    status: CommentStatus,
    auto_approved: bool,
    hold_reason: Option<&'static str>,
}

/// Decides whether a comment publishes immediately.
///
/// All five guards must pass. The first one that fails becomes `hold_reason`, which the moderation
/// queue shows so the operator can see why a trusted author was still held.
async fn decide_auto_approval(
    connection: &mut sqlx::PgConnection,
    config: &CommentsConfig,
    author: &AuthorRecord,
    body: &str,
    now: OffsetDateTime,
) -> Result<AutoApprovalDecision, AppError> {
    let held = |reason: &'static str| AutoApprovalDecision {
        status: CommentStatus::Pending,
        auto_approved: false,
        hold_reason: Some(reason),
    };

    if author.trust()? != TrustState::Normal {
        return Ok(held("trust_revoked"));
    }

    if author.approved_count < config.auto_approve_threshold {
        return Ok(held("below_threshold"));
    }

    if contains_link(body) {
        return Ok(held("contains_link"));
    }

    if guest_comments::has_recent_rejection(
        &mut *connection,
        author.id,
        now - RECENT_REJECTION_WINDOW,
    )
    .await?
    {
        return Ok(held("recent_rejection"));
    }

    if guest_comments::count_recent_auto_approved(
        &mut *connection,
        author.id,
        now - AUTO_APPROVE_BURST_WINDOW,
    )
    .await?
        >= MAX_AUTO_APPROVE_BURST
    {
        return Ok(held("auto_burst"));
    }

    Ok(AutoApprovalDecision {
        status: CommentStatus::Approved,
        auto_approved: true,
        hold_reason: None,
    })
}

/// Looks up the author behind an `X-Guest-Token` header.
///
/// An unknown or malformed token is treated as "no token" so the response never reveals whether a
/// token exists.
pub(crate) async fn resolve_author(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<AuthorRecord>, AppError> {
    let Some(token) = headers
        .get(GUEST_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|token| !token.is_empty() && token.len() <= 128)
    else {
        return Ok(None);
    };

    guest_comments::find_author_by_token_hash(state.db_pool(), &crypto::hash_token(token)).await
}

fn payload_from_record(
    record: &CommentRecord,
    viewer_id: Option<uuid::Uuid>,
) -> Result<GuestComment, AppError> {
    Ok(GuestComment {
        id: record.id.to_string(),
        author_display_name: record.author_display_name.clone(),
        body: record.body.clone(),
        created_at: record
            .created_at
            .format(&Rfc3339)
            .map_err(|error| AppError::config(format!("failed to format timestamp: {error}")))?,
        status: record.status.clone(),
        auto_approved: record.auto_approved,
        own: viewer_id.is_some_and(|id| id == record.author_id),
        reply_to_comment_id: record.reply_to_comment_id.map(|id| id.to_string()),
    })
}

/// Normalizes and validates a comment body.
///
/// NFC first, so a decomposed and a composed spelling of the same Greek word hash alike and count
/// the same number of characters. Character counts use `chars().count()` to agree with Postgres
/// `char_length`.
fn normalize_body(input: &str, config: &CommentsConfig) -> Result<String, AppError> {
    let normalized: String = input.trim().nfc().collect();

    if normalized.chars().any(is_forbidden_char) {
        return Err(AppError::bad_request(
            "Το σχόλιο περιέχει μη επιτρεπτούς χαρακτήρες.",
        ));
    }

    let collapsed = collapse_blank_lines(&normalized);
    let length = collapsed.chars().count();

    if length < MIN_BODY_CHARS {
        return Err(AppError::bad_request("Το σχόλιο είναι πολύ σύντομο."));
    }

    if length > config.max_length {
        return Err(AppError::bad_request(format!(
            "Το σχόλιο ξεπερνά τους {} χαρακτήρες.",
            config.max_length
        )));
    }

    if has_long_run(&collapsed) {
        return Err(AppError::bad_request(
            "Το σχόλιο περιέχει πολλούς επαναλαμβανόμενους χαρακτήρες.",
        ));
    }

    Ok(collapsed)
}

fn normalize_display_name(input: Option<&str>) -> Result<String, AppError> {
    let Some(raw) = input.map(str::trim).filter(|name| !name.is_empty()) else {
        return Ok(DEFAULT_DISPLAY_NAME.to_owned());
    };

    let normalized: String = raw.nfc().collect();

    if normalized
        .chars()
        .any(|character| character.is_control() || is_zero_width(character) || character == '\n')
    {
        return Err(AppError::bad_request(
            "Το όνομα περιέχει μη επιτρεπτούς χαρακτήρες.",
        ));
    }

    if normalized.chars().count() > MAX_DISPLAY_NAME_CHARS {
        return Err(AppError::bad_request(format!(
            "Το όνομα ξεπερνά τους {MAX_DISPLAY_NAME_CHARS} χαρακτήρες."
        )));
    }

    Ok(normalized)
}

fn is_forbidden_char(character: char) -> bool {
    if character == '\n' {
        return false;
    }

    character.is_control() || is_zero_width(character)
}

fn is_zero_width(character: char) -> bool {
    matches!(character, '\u{200b}'..='\u{200d}' | '\u{feff}' | '\u{2060}')
}

/// Collapses runs of more than two newlines down to exactly two.
fn collapse_blank_lines(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut newlines = 0;

    for character in input.chars() {
        if character == '\n' {
            newlines += 1;
            if newlines <= 2 {
                output.push(character);
            }

            continue;
        }

        newlines = 0;
        output.push(character);
    }

    output
}

fn has_long_run(input: &str) -> bool {
    let mut previous = None;
    let mut run = 0;

    for character in input.chars() {
        if Some(character) == previous {
            run += 1;
            if run > MAX_REPEATED_CHARS {
                return true;
            }
        } else {
            previous = Some(character);
            run = 1;
        }
    }

    false
}

/// Detects anything link-shaped, which holds a comment for review even from a trusted author.
fn contains_link(body: &str) -> bool {
    let lowered = body.to_lowercase();

    if lowered.contains("http://") || lowered.contains("https://") || lowered.contains("www.") {
        return true;
    }

    // A bare `label.tld/` is still a link in practice.
    lowered.split_whitespace().any(|token| {
        let Some((host, _)) = token.split_once('/') else {
            return false;
        };

        host.split('.').count() >= 2
            && host
                .rsplit('.')
                .next()
                .is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> CommentsConfig {
        crate::captcha::tests_support::sample_config()
    }

    #[test]
    fn trims_and_normalizes_a_body() {
        let normalized = normalize_body("  καλημέρα  ", &config()).unwrap();

        assert_eq!(normalized, "καλημέρα");
    }

    /// Builds text of an exact character length that does not trip the repeated-character guard.
    fn greek_text(chars: usize) -> String {
        "αβγδε ".chars().cycle().take(chars).collect()
    }

    #[test]
    fn rejects_bodies_that_are_too_short_or_too_long() {
        assert!(normalize_body("a", &config()).is_err());
        assert!(normalize_body(&greek_text(1001), &config()).is_err());
        assert!(normalize_body(&greek_text(1000), &config()).is_ok());
    }

    #[test]
    fn counts_characters_not_bytes() {
        // 1000 Greek characters is 2000 bytes; a byte-based limit would wrongly reject this.
        let text = greek_text(1000);

        assert_eq!(text.chars().count(), 1000);
        assert!(text.len() > 1000, "the test text must be multi-byte");
        assert!(normalize_body(&text, &config()).is_ok());
    }

    #[test]
    fn rejects_control_and_zero_width_characters() {
        assert!(normalize_body("καλ\u{0}ημέρα", &config()).is_err());
        assert!(normalize_body("καλη\u{200b}μέρα", &config()).is_err());
        assert!(normalize_body("καλημέρα\nκαι σε σένα", &config()).is_ok());
    }

    #[test]
    fn collapses_long_blank_runs() {
        let normalized = normalize_body("ένα\n\n\n\n\nδύο", &config()).unwrap();

        assert_eq!(normalized, "ένα\n\nδύο");
    }

    #[test]
    fn rejects_character_spam() {
        assert!(normalize_body(&format!("ωραία{}", "!".repeat(20)), &config()).is_err());
        assert!(normalize_body("ωραία!!!", &config()).is_ok());
    }

    #[test]
    fn display_name_defaults_and_clamps() {
        assert_eq!(normalize_display_name(None).unwrap(), DEFAULT_DISPLAY_NAME);
        assert_eq!(
            normalize_display_name(Some("   ")).unwrap(),
            DEFAULT_DISPLAY_NAME
        );
        assert_eq!(normalize_display_name(Some(" Νίκος ")).unwrap(), "Νίκος");
        assert!(normalize_display_name(Some(&"ν".repeat(25))).is_err());
    }

    #[test]
    fn detects_links_in_several_shapes() {
        assert!(contains_link("δες εδώ http://example.com"));
        assert!(contains_link("δες εδώ HTTPS://Example.com"));
        assert!(contains_link("www.example.com"));
        assert!(contains_link("example.com/path"));
    }

    #[test]
    fn plain_text_is_not_a_link() {
        assert!(!contains_link("καλημέρα σε όλους"));
        assert!(!contains_link("το 3.14 είναι π"));
        assert!(!contains_link("και/ή"));
    }
}
