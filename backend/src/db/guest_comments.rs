use sqlx::{Executor, PgPool, Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;

/// Lifecycle of a guest comment.
///
/// Stored as `text` with a `CHECK` constraint rather than a Postgres enum, following
/// `TopicRunTrigger`: the one native enum in this schema needed an awkward `DO $$` block and
/// `ALTER TYPE ... ADD VALUE` is painful to migrate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommentStatus {
    Pending,
    Approved,
    Rejected,
    Spam,
    Hidden,
}

impl CommentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::Spam => "spam",
            Self::Hidden => "hidden",
        }
    }

    pub fn from_str(value: &str) -> Result<Self, AppError> {
        match value {
            "pending" => Ok(Self::Pending),
            "approved" => Ok(Self::Approved),
            "rejected" => Ok(Self::Rejected),
            "spam" => Ok(Self::Spam),
            "hidden" => Ok(Self::Hidden),
            other => Err(AppError::bad_request(format!(
                "unknown comment status `{other}`"
            ))),
        }
    }

    /// Whether a comment in this state is shown to everyone.
    pub fn is_public(self) -> bool {
        matches!(self, Self::Approved)
    }
}

/// Trust standing of a guest author.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustState {
    Normal,
    Revoked,
    Banned,
}

impl TrustState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Revoked => "revoked",
            Self::Banned => "banned",
        }
    }

    pub fn from_str(value: &str) -> Result<Self, AppError> {
        match value {
            "normal" => Ok(Self::Normal),
            "revoked" => Ok(Self::Revoked),
            "banned" => Ok(Self::Banned),
            other => Err(AppError::bad_request(format!(
                "unknown trust state `{other}`"
            ))),
        }
    }
}

/// An entry in the append-only moderation log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModerationAction {
    Submitted,
    Held,
    AutoApproved,
    Approved,
    Rejected,
    MarkedSpam,
    Hidden,
    Restored,
    AuthorTrustRevoked,
    AuthorTrustRestored,
    AuthorBanned,
    AuthorUnbanned,
    IpBlocked,
    IpUnblocked,
}

impl ModerationAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Submitted => "submitted",
            Self::Held => "held",
            Self::AutoApproved => "auto_approved",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::MarkedSpam => "marked_spam",
            Self::Hidden => "hidden",
            Self::Restored => "restored",
            Self::AuthorTrustRevoked => "author_trust_revoked",
            Self::AuthorTrustRestored => "author_trust_restored",
            Self::AuthorBanned => "author_banned",
            Self::AuthorUnbanned => "author_unbanned",
            Self::IpBlocked => "ip_blocked",
            Self::IpUnblocked => "ip_unblocked",
        }
    }

    pub fn from_str(value: &str) -> Result<Self, AppError> {
        match value {
            "submitted" => Ok(Self::Submitted),
            "held" => Ok(Self::Held),
            "auto_approved" => Ok(Self::AutoApproved),
            "approved" => Ok(Self::Approved),
            "rejected" => Ok(Self::Rejected),
            "marked_spam" => Ok(Self::MarkedSpam),
            "hidden" => Ok(Self::Hidden),
            "restored" => Ok(Self::Restored),
            "author_trust_revoked" => Ok(Self::AuthorTrustRevoked),
            "author_trust_restored" => Ok(Self::AuthorTrustRestored),
            "author_banned" => Ok(Self::AuthorBanned),
            "author_unbanned" => Ok(Self::AuthorUnbanned),
            "ip_blocked" => Ok(Self::IpBlocked),
            "ip_unblocked" => Ok(Self::IpUnblocked),
            other => Err(AppError::bad_request(format!(
                "unknown moderation action `{other}`"
            ))),
        }
    }
}

/// Who performed an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModerationActor {
    System,
    Moderator,
}

impl ModerationActor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Moderator => "moderator",
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ItemReference {
    pub topic_id: Uuid,
    pub item_id: Uuid,
    pub external_id: String,
    pub item_title: String,
    pub item_url: String,
}

#[derive(Debug, sqlx::FromRow)]
pub struct DiscussionEntry {
    pub latest_comment_id: Uuid,
    pub last_comment_at: OffsetDateTime,
    pub topic: String,
    pub topic_display_name: String,
    pub external_id: String,
    pub item_title: String,
    pub item_url: String,
    pub guest_comment_count: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AuthorRecord {
    pub id: Uuid,
    pub approved_count: i32,
    pub trust_state: String,
}

impl AuthorRecord {
    pub fn trust(&self) -> Result<TrustState, AppError> {
        TrustState::from_str(&self.trust_state)
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CommentRecord {
    pub id: Uuid,
    pub author_id: Uuid,
    pub author_display_name: String,
    pub body: String,
    pub status: String,
    pub auto_approved: bool,
    pub created_at: OffsetDateTime,
    pub reply_to_comment_id: Option<Uuid>,
}

/// A queue row: the comment plus enough item context to judge it.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct QueueEntry {
    pub id: Uuid,
    pub body: String,
    pub author_id: Uuid,
    pub author_display_name: String,
    pub author_approved_count: i32,
    pub author_trust_state: String,
    pub status: String,
    pub auto_approved: bool,
    pub hold_reason: Option<String>,
    pub author_ip_hash: Option<Vec<u8>>,
    pub created_at: OffsetDateTime,
    pub topic_slug: String,
    pub topic_display_name: String,
    pub external_id: String,
    pub item_title: String,
    pub item_url: String,
}

/// A moderation-log row, joined to whatever context still exists.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct LogEntry {
    pub id: Uuid,
    pub comment_id: Option<Uuid>,
    pub author_id: Option<Uuid>,
    pub action: String,
    pub actor: String,
    pub reason: Option<String>,
    pub author_approved_count: Option<i32>,
    pub recorded_at: OffsetDateTime,
    pub body: Option<String>,
    pub author_display_name: Option<String>,
    pub status: Option<String>,
    pub topic_slug: Option<String>,
    pub external_id: Option<String>,
    pub item_title: Option<String>,
}

#[derive(Debug, Clone, Default, sqlx::FromRow)]
pub struct StatusCounts {
    pub pending: i64,
    pub approved: i64,
    pub rejected: i64,
    pub spam: i64,
    pub hidden: i64,
    pub auto_approved: i64,
}

#[derive(Debug, Clone)]
pub struct InsertCommentParams<'a> {
    pub item_id: Uuid,
    pub topic_id: Uuid,
    pub author_id: Uuid,
    pub author_display_name: &'a str,
    pub body: &'a str,
    pub body_hash: &'a [u8],
    pub status: CommentStatus,
    pub auto_approved: bool,
    pub hold_reason: Option<&'a str>,
    pub author_ip_hash: Option<&'a [u8]>,
    pub created_at: OffsetDateTime,
    pub reply_to_comment_id: Option<Uuid>,
}

#[derive(Debug, Clone)]
pub struct InsertEventParams<'a> {
    pub comment_id: Option<Uuid>,
    pub author_id: Option<Uuid>,
    pub action: ModerationAction,
    pub actor: ModerationActor,
    pub reason: Option<&'a str>,
    pub author_approved_count: Option<i32>,
    pub recorded_at: OffsetDateTime,
}

/// Resolves a `(topic_slug, external_id)` pair to the ids a comment needs.
///
/// The frontend addresses items by this pair because `CrawlSnapshotItem` carries no source slug,
/// and each feed panel is bound to exactly one topic.
pub async fn resolve_item(
    pool: &PgPool,
    topic_slug: &str,
    external_id: &str,
) -> Result<Option<ItemReference>, AppError> {
    let record = sqlx::query_as::<_, ItemReference>(
        r#"
        SELECT topics.id AS topic_id,
               items.id AS item_id,
               items.external_id,
               items.title AS item_title,
               items.url AS item_url
        FROM topics
        JOIN topic_items ON topic_items.topic_id = topics.id
        JOIN items ON items.id = topic_items.item_id
        WHERE topics.slug = $1
          AND items.external_id = $2
        LIMIT 1
        "#,
    )
    .bind(topic_slug)
    .bind(external_id)
    .fetch_optional(pool)
    .await?;

    if record.is_some() {
        return Ok(record);
    }

    // A shared discussion remains addressable after the article leaves the current feed.
    Ok(sqlx::query_as::<_, ItemReference>(
        "SELECT DISTINCT topics.id AS topic_id, items.id AS item_id, items.external_id,
                items.title AS item_title, items.url AS item_url
         FROM guest_comments
         JOIN topics ON topics.id = guest_comments.topic_id
         JOIN items ON items.id = guest_comments.item_id
         WHERE topics.slug = $1 AND items.external_id = $2 LIMIT 1",
    )
    .bind(topic_slug)
    .bind(external_id)
    .fetch_optional(pool)
    .await?)
}

pub async fn find_author_by_token_hash(
    pool: &PgPool,
    token_hash: &[u8],
) -> Result<Option<AuthorRecord>, AppError> {
    let record = sqlx::query_as::<_, AuthorRecord>(
        r#"
        SELECT id, approved_count, trust_state
        FROM guest_authors
        WHERE token_hash = $1
        "#,
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await?;

    Ok(record)
}

pub async fn insert_author(
    tx: &mut Transaction<'_, Postgres>,
    token_hash: &[u8],
    now: OffsetDateTime,
) -> Result<AuthorRecord, AppError> {
    let record = sqlx::query_as::<_, AuthorRecord>(
        r#"
        INSERT INTO guest_authors (
            id, token_hash, approved_count, rejected_count, trust_state,
            created_at, updated_at, last_seen_at
        )
        VALUES ($1, $2, 0, 0, 'normal', $3, $3, $3)
        RETURNING id, approved_count, trust_state
        "#,
    )
    .bind(Uuid::now_v7())
    .bind(token_hash)
    .bind(now)
    .fetch_one(&mut **tx)
    .await?;

    Ok(record)
}

pub async fn touch_author(
    tx: &mut Transaction<'_, Postgres>,
    author_id: Uuid,
    now: OffsetDateTime,
) -> Result<AuthorRecord, AppError> {
    let author = sqlx::query_as::<_, AuthorRecord>(
        r#"
        UPDATE guest_authors
        SET last_seen_at = $2,
            updated_at = $2
        WHERE id = $1
        RETURNING id, approved_count, trust_state
        "#,
    )
    .bind(author_id)
    .bind(now)
    .fetch_one(&mut **tx)
    .await?;

    Ok(author)
}

pub async fn count_pending_for_author<'a>(
    pool: impl Executor<'a, Database = Postgres>,
    author_id: Uuid,
) -> Result<i64, AppError> {
    let count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*)
        FROM guest_comments
        WHERE author_id = $1
          AND status = 'pending'
        "#,
    )
    .bind(author_id)
    .fetch_one(pool)
    .await?;

    Ok(count)
}

/// Whether the author had a comment rejected or marked as spam since `since`.
pub async fn has_recent_rejection<'a>(
    pool: impl Executor<'a, Database = Postgres>,
    author_id: Uuid,
    since: OffsetDateTime,
) -> Result<bool, AppError> {
    let exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM guest_comments
            WHERE author_id = $1
              AND status IN ('rejected', 'spam')
              AND coalesce(decided_at, created_at) >= $2
        )
        "#,
    )
    .bind(author_id)
    .bind(since)
    .fetch_one(pool)
    .await?;

    Ok(exists)
}

pub async fn count_recent_auto_approved<'a>(
    pool: impl Executor<'a, Database = Postgres>,
    author_id: Uuid,
    since: OffsetDateTime,
) -> Result<i64, AppError> {
    let count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*)
        FROM guest_comments
        WHERE author_id = $1
          AND auto_approved = true
          AND created_at >= $2
        "#,
    )
    .bind(author_id)
    .bind(since)
    .fetch_one(pool)
    .await?;

    Ok(count)
}

pub async fn has_duplicate_body<'a>(
    pool: impl Executor<'a, Database = Postgres>,
    author_id: Uuid,
    body_hash: &[u8],
    since: OffsetDateTime,
) -> Result<bool, AppError> {
    let exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM guest_comments
            WHERE author_id = $1
              AND body_hash = $2
              AND created_at >= $3
        )
        "#,
    )
    .bind(author_id)
    .bind(body_hash)
    .bind(since)
    .fetch_one(pool)
    .await?;

    Ok(exists)
}

pub async fn author_item_quota_release<'a>(
    pool: impl Executor<'a, Database = Postgres>,
    author_id: Uuid,
    item_id: Uuid,
    since: OffsetDateTime,
    limit: i64,
) -> Result<Option<OffsetDateTime>, AppError> {
    Ok(sqlx::query_scalar::<_, OffsetDateTime>(
        "SELECT created_at FROM guest_comments WHERE author_id = $1 AND item_id = $2 AND created_at >= $3 ORDER BY created_at DESC OFFSET $4 LIMIT 1"
    ).bind(author_id).bind(item_id).bind(since).bind(limit - 1).fetch_optional(pool).await?)
}

pub async fn is_ip_blocked(
    pool: &PgPool,
    ip_hash: &[u8],
    now: OffsetDateTime,
) -> Result<bool, AppError> {
    let exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM guest_comment_ip_blocks
            WHERE ip_hash = $1
              AND (expires_at IS NULL OR expires_at > $2)
        )
        "#,
    )
    .bind(ip_hash)
    .bind(now)
    .fetch_one(pool)
    .await?;

    Ok(exists)
}

pub async fn insert_comment(
    tx: &mut Transaction<'_, Postgres>,
    params: InsertCommentParams<'_>,
) -> Result<CommentRecord, AppError> {
    if let Some(parent) = params.reply_to_comment_id {
        let valid = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM guest_comments WHERE id = $1 AND item_id = $2 AND topic_id = $3 AND status = 'approved' FOR SHARE"
        ).bind(parent).bind(params.item_id).bind(params.topic_id).fetch_optional(&mut **tx).await?;
        if valid.is_none() {
            return Err(AppError::bad_request(
                "Το σχόλιο στο οποίο απαντάς δεν είναι πλέον διαθέσιμο.",
            ));
        }
    }
    let record = sqlx::query_as::<_, CommentRecord>(
        r#"
        INSERT INTO guest_comments (
            id, item_id, topic_id, author_id, author_display_name, body, body_hash,
            status, auto_approved, hold_reason, author_ip_hash,
            created_at, decided_at, updated_at, reply_to_comment_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $12, $14)
        RETURNING id, author_id, author_display_name, body, status, auto_approved, created_at, reply_to_comment_id
        "#,
    )
    .bind(Uuid::now_v7())
    .bind(params.item_id)
    .bind(params.topic_id)
    .bind(params.author_id)
    .bind(params.author_display_name)
    .bind(params.body)
    .bind(params.body_hash)
    .bind(params.status.as_str())
    .bind(params.auto_approved)
    .bind(params.hold_reason)
    .bind(params.author_ip_hash)
    .bind(params.created_at)
    .bind(params.status.is_public().then_some(params.created_at))
    .bind(params.reply_to_comment_id)
    .fetch_one(&mut **tx)
    .await?;

    if params.status.is_public() {
        super::reply_notifications::record_reply(tx, record.id, params.created_at).await?;
    }
    Ok(record)
}

/// Appends one moderation event. Event rows are never updated or deleted.
pub async fn insert_moderation_event(
    tx: &mut Transaction<'_, Postgres>,
    params: InsertEventParams<'_>,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO guest_comment_moderation_events (
            id, comment_id, author_id, action, actor, reason, author_approved_count, recorded_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        "#,
    )
    .bind(Uuid::now_v7())
    .bind(params.comment_id)
    .bind(params.author_id)
    .bind(params.action.as_str())
    .bind(params.actor.as_str())
    .bind(params.reason)
    .bind(params.author_approved_count)
    .bind(params.recorded_at)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

/// Comments visible to one caller: everything approved, plus that caller's own pending comments.
///
/// `viewer_author_id` of `None` binds SQL `NULL`, and `author_id = NULL` is never true, so an
/// anonymous caller sees only approved rows without a second query path.
pub async fn list_comments_for_item(
    pool: &PgPool,
    item_id: Uuid,
    viewer_author_id: Option<Uuid>,
) -> Result<Vec<CommentRecord>, AppError> {
    let records = sqlx::query_as::<_, CommentRecord>(
        r#"
        SELECT id, author_id, author_display_name, body, status, auto_approved, created_at, reply_to_comment_id
        FROM guest_comments
        WHERE item_id = $1
          AND (
              status = 'approved'
              OR (status = 'pending' AND author_id = $2)
          )
        ORDER BY created_at ASC
        LIMIT 500
        "#,
    )
    .bind(item_id)
    .bind(viewer_author_id)
    .fetch_all(pool)
    .await?;

    Ok(records)
}

pub async fn count_approved_for_item(pool: &PgPool, item_id: Uuid) -> Result<i64, AppError> {
    let count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*)
        FROM guest_comments
        WHERE item_id = $1
          AND status = 'approved'
        "#,
    )
    .bind(item_id)
    .fetch_one(pool)
    .await?;

    Ok(count)
}

/// Approved comment counts for every item in a topic, for the feed badges.
pub async fn count_approved_by_topic(
    pool: &PgPool,
    topic_slug: &str,
) -> Result<Vec<(String, i64)>, AppError> {
    let rows = sqlx::query_as::<_, (String, i64)>(
        r#"
        SELECT items.external_id, count(*) AS comment_count
        FROM guest_comments
        JOIN items ON items.id = guest_comments.item_id
        JOIN topics ON topics.id = guest_comments.topic_id
        WHERE topics.slug = $1
          AND guest_comments.status = 'approved'
        GROUP BY items.external_id
        "#,
    )
    .bind(topic_slug)
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

/// Public discussions, including items that have left the current feed snapshots.
pub async fn list_discussions(
    pool: &PgPool,
    before: Option<(OffsetDateTime, Uuid)>,
    limit: i64,
) -> Result<Vec<DiscussionEntry>, AppError> {
    Ok(sqlx::query_as::<_, DiscussionEntry>(
        r#"
        WITH ranked_comments AS (
            SELECT id, topic_id, item_id, created_at,
                   count(*) OVER (PARTITION BY topic_id, item_id) AS guest_comment_count,
                   row_number() OVER (
                       PARTITION BY topic_id, item_id ORDER BY created_at DESC, id DESC
                   ) AS position
            FROM guest_comments
            WHERE status = 'approved'
        )
        SELECT c.id AS latest_comment_id, c.created_at AS last_comment_at,
               topics.slug AS topic, topics.display_name AS topic_display_name,
               items.external_id, items.title AS item_title, items.url AS item_url,
               c.guest_comment_count
        FROM ranked_comments c
        JOIN topics ON topics.id = c.topic_id
        JOIN items ON items.id = c.item_id
        WHERE c.position = 1
          AND ($1::timestamptz IS NULL OR (c.created_at, c.id) < ($1, $2::uuid))
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $3
        "#,
    )
    .bind(before.map(|(timestamp, _)| timestamp))
    .bind(before.map(|(_, id)| id))
    .bind(limit)
    .fetch_all(pool)
    .await?)
}

pub async fn get_queue_entry<'a>(
    pool: impl Executor<'a, Database = Postgres>,
    comment_id: Uuid,
) -> Result<Option<QueueEntry>, AppError> {
    let record = sqlx::query_as::<_, QueueEntry>(
        r#"
        SELECT guest_comments.id,
               guest_comments.body,
               guest_comments.author_id,
               guest_comments.author_display_name,
               guest_authors.approved_count AS author_approved_count,
               guest_authors.trust_state AS author_trust_state,
               guest_comments.status,
               guest_comments.auto_approved,
               guest_comments.hold_reason,
               guest_comments.author_ip_hash,
               guest_comments.created_at,
               topics.slug AS topic_slug,
               topics.display_name AS topic_display_name,
               items.external_id,
               items.title AS item_title,
               items.url AS item_url
        FROM guest_comments
        JOIN guest_authors ON guest_authors.id = guest_comments.author_id
        JOIN topics ON topics.id = guest_comments.topic_id
        JOIN items ON items.id = guest_comments.item_id
        WHERE guest_comments.id = $1
        "#,
    )
    .bind(comment_id)
    .fetch_optional(pool)
    .await?;

    Ok(record)
}

#[derive(Debug, Default, serde::Deserialize)]
pub struct ModerationFilters {
    pub topic: Option<String>,
    pub author_id: Option<Uuid>,
    pub author: Option<String>,
    pub q: Option<String>,
}

impl ModerationFilters {
    pub fn validate(&self) -> Result<(), AppError> {
        if let Some(topic) = &self.topic {
            crate::api::internal::validate_slug(topic)?;
        }
        if self
            .author
            .as_ref()
            .is_some_and(|s| s.chars().count() > 100)
            || self.q.as_ref().is_some_and(|s| s.chars().count() > 200)
        {
            return Err(AppError::bad_request("filter text is too long"));
        }
        Ok(())
    }
}

#[derive(Debug, sqlx::FromRow, serde::Serialize)]
pub struct ModerationFeed {
    pub slug: String,
    pub display_name: String,
}

pub async fn moderation_feeds(pool: &PgPool) -> Result<Vec<ModerationFeed>, AppError> {
    Ok(
        sqlx::query_as("SELECT slug, display_name FROM topics ORDER BY display_name, slug")
            .fetch_all(pool)
            .await?,
    )
}

/// Moderation queue, newest first, keyset-paged on `created_at`.
pub async fn list_queue(
    pool: &PgPool,
    statuses: &[&str],
    before: Option<(OffsetDateTime, Uuid)>,
    filters: &ModerationFilters,
    limit: i64,
) -> Result<Vec<QueueEntry>, AppError> {
    let owned_statuses: Vec<String> = statuses.iter().map(|status| (*status).to_owned()).collect();

    let records = sqlx::query_as::<_, QueueEntry>(
        r#"
        SELECT guest_comments.id,
               guest_comments.body,
               guest_comments.author_id,
               guest_comments.author_display_name,
               guest_authors.approved_count AS author_approved_count,
               guest_authors.trust_state AS author_trust_state,
               guest_comments.status,
               guest_comments.auto_approved,
               guest_comments.hold_reason,
               guest_comments.author_ip_hash,
               guest_comments.created_at,
               topics.slug AS topic_slug,
               topics.display_name AS topic_display_name,
               items.external_id,
               items.title AS item_title,
               items.url AS item_url
        FROM guest_comments
        JOIN guest_authors ON guest_authors.id = guest_comments.author_id
        JOIN topics ON topics.id = guest_comments.topic_id
        JOIN items ON items.id = guest_comments.item_id
        WHERE guest_comments.status = ANY($1)
          AND ($2::timestamptz IS NULL OR (guest_comments.created_at, guest_comments.id) < ($2, $4::uuid))
          AND ($5::text IS NULL OR topics.slug = $5)
          AND ($6::uuid IS NULL OR guest_comments.author_id = $6)
          AND ($7::text IS NULL OR strpos(lower(guest_comments.author_display_name), lower($7)) > 0)
          AND ($8::text IS NULL OR strpos(lower(guest_comments.body), lower($8)) > 0 OR strpos(lower(items.title), lower($8)) > 0)
        ORDER BY guest_comments.created_at DESC, guest_comments.id DESC
        LIMIT $3
        "#,
    )
    .bind(&owned_statuses)
    .bind(before.map(|v| v.0))
    .bind(limit)
    .bind(before.map(|v| v.1))
    .bind(filters.topic.as_deref())
    .bind(filters.author_id)
    .bind(filters.author.as_deref())
    .bind(filters.q.as_deref())
    .fetch_all(pool)
    .await?;

    Ok(records)
}

/// Moderation history, newest first, keyset-paged on `recorded_at`.
///
/// Left joins throughout: an event must stay readable even after its comment row is gone.
pub async fn list_log(
    pool: &PgPool,
    actions: Option<&[String]>,
    actor: Option<&str>,
    before: Option<(OffsetDateTime, Uuid)>,
    filters: &ModerationFilters,
    limit: i64,
) -> Result<Vec<LogEntry>, AppError> {
    let records = sqlx::query_as::<_, LogEntry>(
        r#"
        SELECT events.id,
               events.comment_id,
               events.author_id,
               events.action,
               events.actor,
               events.reason,
               events.author_approved_count,
               events.recorded_at,
               guest_comments.body,
               guest_comments.author_display_name,
               guest_comments.status,
               topics.slug AS topic_slug,
               items.external_id,
               items.title AS item_title
        FROM guest_comment_moderation_events AS events
        LEFT JOIN guest_comments ON guest_comments.id = events.comment_id
        LEFT JOIN topics ON topics.id = guest_comments.topic_id
        LEFT JOIN items ON items.id = guest_comments.item_id
        WHERE ($1::text[] IS NULL OR events.action = ANY($1))
          AND ($2::text IS NULL OR events.actor = $2)
          AND ($3::timestamptz IS NULL OR (events.recorded_at, events.id) < ($3, $5::uuid))
          AND ($6::text IS NULL OR topics.slug = $6)
          AND ($7::uuid IS NULL OR events.author_id = $7)
          AND ($8::text IS NULL OR strpos(lower(guest_comments.author_display_name), lower($8)) > 0)
          AND ($9::text IS NULL OR strpos(lower(guest_comments.body), lower($9)) > 0 OR strpos(lower(items.title), lower($9)) > 0)
        ORDER BY events.recorded_at DESC, events.id DESC
        LIMIT $4
        "#,
    )
    .bind(actions)
    .bind(actor)
    .bind(before.map(|v| v.0))
    .bind(limit)
    .bind(before.map(|v| v.1))
    .bind(filters.topic.as_deref())
    .bind(filters.author_id)
    .bind(filters.author.as_deref())
    .bind(filters.q.as_deref())
    .fetch_all(pool)
    .await?;

    Ok(records)
}

pub async fn status_counts(pool: &PgPool) -> Result<StatusCounts, AppError> {
    let counts = sqlx::query_as::<_, StatusCounts>(
        r#"
        SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
               count(*) FILTER (WHERE status = 'approved') AS approved,
               count(*) FILTER (WHERE status = 'rejected') AS rejected,
               count(*) FILTER (WHERE status = 'spam') AS spam,
               count(*) FILTER (WHERE status = 'hidden') AS hidden,
               count(*) FILTER (WHERE auto_approved = true) AS auto_approved
        FROM guest_comments
        "#,
    )
    .fetch_one(pool)
    .await?;

    Ok(counts)
}

/// The result of a moderator decision, carrying what the caller needs to broadcast.
#[derive(Debug, Clone)]
pub struct DecisionOutcome {
    pub comment_id: Uuid,
    pub topic_slug: String,
    pub external_id: String,
    pub previous_status: CommentStatus,
    pub new_status: CommentStatus,
    pub author_display_name: String,
    pub body: String,
    pub created_at: OffsetDateTime,
    pub guest_comment_count: i64,
    pub reply_to_comment_id: Option<Uuid>,
}

/// Applies a moderator decision atomically: status, author counters and the log event.
///
/// `approved_count` is only incremented when a human approves a comment that was not already
/// public. Auto-approvals deliberately do not raise it, otherwise the trust threshold would be
/// self-reinforcing and an author could never drift back under review.
pub async fn apply_decision(
    pool: &PgPool,
    comment_id: Uuid,
    new_status: CommentStatus,
    action: ModerationAction,
    reason: Option<&str>,
    now: OffsetDateTime,
) -> Result<DecisionOutcome, AppError> {
    let mut tx = pool.begin().await?;
    // Serialize decisions on one comment before reading its previous status.
    let locked =
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM guest_comments WHERE id = $1 FOR UPDATE")
            .bind(comment_id)
            .fetch_optional(&mut *tx)
            .await?;
    if locked.is_none() {
        return Err(AppError::not_found("unknown comment"));
    }
    let entry = get_queue_entry(&mut *tx, comment_id)
        .await?
        .ok_or_else(|| AppError::not_found("unknown comment"))?;

    let previous_status = CommentStatus::from_str(&entry.status)?;
    let item_id = item_id_for_comment(&mut *tx, comment_id).await?;

    sqlx::query(
        r#"
        UPDATE guest_comments
        SET status = $2,
            decided_at = $3,
            updated_at = $3
        WHERE id = $1
        "#,
    )
    .bind(comment_id)
    .bind(new_status.as_str())
    .bind(now)
    .execute(&mut *tx)
    .await?;

    let promoted_by_hand = new_status == CommentStatus::Approved && !previous_status.is_public();
    let demoted = previous_status.is_public() && !new_status.is_public();

    if promoted_by_hand {
        sqlx::query(
            r#"
            UPDATE guest_authors
            SET approved_count = approved_count + 1,
                updated_at = $2
            WHERE id = $1
            "#,
        )
        .bind(entry.author_id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }

    if matches!(new_status, CommentStatus::Rejected | CommentStatus::Spam) {
        sqlx::query(
            r#"
            UPDATE guest_authors
            SET rejected_count = rejected_count + 1,
                approved_count = GREATEST(approved_count - $3, 0),
                updated_at = $2
            WHERE id = $1
            "#,
        )
        .bind(entry.author_id)
        .bind(now)
        .bind(i32::from(demoted))
        .execute(&mut *tx)
        .await?;
    }

    let author_approved_count = sqlx::query_scalar::<_, i32>(
        r#"
        SELECT approved_count
        FROM guest_authors
        WHERE id = $1
        "#,
    )
    .bind(entry.author_id)
    .fetch_one(&mut *tx)
    .await?;

    insert_moderation_event(
        &mut tx,
        InsertEventParams {
            comment_id: Some(comment_id),
            author_id: Some(entry.author_id),
            action,
            actor: ModerationActor::Moderator,
            reason,
            author_approved_count: Some(author_approved_count),
            recorded_at: now,
        },
    )
    .await?;

    let reply_to_comment_id = sqlx::query_scalar::<_, Option<Uuid>>(
        "SELECT reply_to_comment_id FROM guest_comments WHERE id = $1",
    )
    .bind(comment_id)
    .fetch_one(&mut *tx)
    .await?;
    if new_status.is_public() {
        super::reply_notifications::record_reply(&mut tx, comment_id, now).await?;
    }
    tx.commit().await?;

    let guest_comment_count = count_approved_for_item(pool, item_id).await?;

    Ok(DecisionOutcome {
        reply_to_comment_id,
        comment_id,
        topic_slug: entry.topic_slug,
        external_id: entry.external_id,
        previous_status,
        new_status,
        author_display_name: entry.author_display_name,
        body: entry.body,
        created_at: entry.created_at,
        guest_comment_count,
    })
}

pub async fn item_id_for_comment<'a>(
    pool: impl Executor<'a, Database = Postgres>,
    comment_id: Uuid,
) -> Result<Uuid, AppError> {
    let item_id = sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT item_id
        FROM guest_comments
        WHERE id = $1
        "#,
    )
    .bind(comment_id)
    .fetch_one(pool)
    .await?;

    Ok(item_id)
}

/// Changes an author's trust standing and logs it.
pub async fn set_author_trust(
    pool: &PgPool,
    author_id: Uuid,
    trust_state: TrustState,
    action: ModerationAction,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    let updated = sqlx::query(
        r#"
        UPDATE guest_authors
        SET trust_state = $2,
            updated_at = $3
        WHERE id = $1
        "#,
    )
    .bind(author_id)
    .bind(trust_state.as_str())
    .bind(now)
    .execute(&mut *tx)
    .await?;

    if updated.rows_affected() == 0 {
        return Err(AppError::not_found("unknown author"));
    }

    let author_approved_count = sqlx::query_scalar::<_, i32>(
        r#"
        SELECT approved_count
        FROM guest_authors
        WHERE id = $1
        "#,
    )
    .bind(author_id)
    .fetch_one(&mut *tx)
    .await?;

    insert_moderation_event(
        &mut tx,
        InsertEventParams {
            comment_id: None,
            author_id: Some(author_id),
            action,
            actor: ModerationActor::Moderator,
            reason: None,
            author_approved_count: Some(author_approved_count),
            recorded_at: now,
        },
    )
    .await?;

    tx.commit().await?;

    Ok(())
}
