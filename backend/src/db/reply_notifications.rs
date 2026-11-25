use sqlx::{PgPool, Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;

/// Record one recipient event and enqueue only subscriptions that already watch the parent.
/// Called inside the transaction that makes a reply public, so a crash cannot lose delivery.
pub async fn record_reply(
    tx: &mut Transaction<'_, Postgres>,
    reply_id: Uuid,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    let event = sqlx::query_scalar::<_, Uuid>(
        "WITH eligible AS (
           UPDATE guest_comments reply SET reply_notification_recorded = true
           FROM guest_comments parent
           WHERE reply.id = $2 AND parent.id = reply.reply_to_comment_id
             AND reply.status = 'approved' AND parent.status = 'approved'
             AND parent.author_id <> reply.author_id AND NOT reply.reply_notification_recorded
           RETURNING reply.id, parent.author_id
         )
         INSERT INTO guest_reply_events (id, reply_id, recipient_id, created_at)
         SELECT $1, eligible.id, eligible.author_id, $3 FROM eligible
         ON CONFLICT (reply_id) DO NOTHING RETURNING id",
    )
    .bind(Uuid::now_v7())
    .bind(reply_id)
    .bind(now)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(event_id) = event {
        sqlx::query(
            "INSERT INTO guest_push_deliveries (event_id, subscription_id, next_attempt_at)
             SELECT $1, watches.subscription_id, $2
             FROM guest_reply_events events
             JOIN guest_comments reply ON reply.id = events.reply_id
             JOIN guest_reply_watches watches ON watches.comment_id = reply.reply_to_comment_id
             JOIN guest_push_subscriptions subscriptions ON subscriptions.id = watches.subscription_id
             WHERE events.id = $1 AND subscriptions.author_id = events.recipient_id
             ON CONFLICT DO NOTHING"
        ).bind(event_id).bind(now).execute(&mut **tx).await?;
    }
    Ok(())
}

#[derive(Debug, sqlx::FromRow)]
pub struct ReplyEvent {
    pub id: Uuid,
    pub reply_id: Uuid,
    pub parent_id: Uuid,
    pub created_at: OffsetDateTime,
    pub read_at: Option<OffsetDateTime>,
    pub topic: String,
    pub external_id: String,
    pub item_title: String,
    pub item_url: String,
    pub author_display_name: String,
    pub body: String,
}

pub async fn list_replies(
    pool: &PgPool,
    author_id: Uuid,
    before: Option<(OffsetDateTime, Uuid)>,
    limit: i64,
) -> Result<Vec<ReplyEvent>, AppError> {
    Ok(sqlx::query_as(
        "SELECT events.id, reply.id AS reply_id, parent.id AS parent_id,
                events.created_at, events.read_at, topics.slug AS topic,
                items.external_id, items.title AS item_title, items.url AS item_url,
                reply.author_display_name, reply.body
         FROM guest_reply_events events
         JOIN guest_comments reply ON reply.id = events.reply_id AND reply.status = 'approved'
         JOIN guest_comments parent ON parent.id = reply.reply_to_comment_id AND parent.status = 'approved'
         JOIN topics ON topics.id = reply.topic_id
         JOIN items ON items.id = reply.item_id
         WHERE events.recipient_id = $1
           AND ($2::timestamptz IS NULL OR (events.created_at, events.id) < ($2, $3::uuid))
         ORDER BY events.created_at DESC, events.id DESC LIMIT $4"
    ).bind(author_id).bind(before.map(|v| v.0)).bind(before.map(|v| v.1)).bind(limit).fetch_all(pool).await?)
}

pub async fn unread_count(pool: &PgPool, author_id: Uuid) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT count(*) FROM guest_reply_events events
         JOIN guest_comments reply ON reply.id = events.reply_id AND reply.status = 'approved'
         JOIN guest_comments parent ON parent.id = reply.reply_to_comment_id AND parent.status = 'approved'
         WHERE events.recipient_id = $1 AND events.read_at IS NULL"
    ).bind(author_id).fetch_one(pool).await?)
}

pub async fn mark_read(
    pool: &PgPool,
    author_id: Uuid,
    event_id: Option<Uuid>,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE guest_reply_events SET read_at = COALESCE(read_at, $3)
                 WHERE recipient_id = $1 AND ($2::uuid IS NULL OR id = $2)",
    )
    .bind(author_id)
    .bind(event_id)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Endpoint uniqueness never permits one guest identity to take over another's subscription.
pub async fn register_subscription(
    pool: &PgPool,
    author_id: Uuid,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    now: OffsetDateTime,
) -> Result<Uuid, AppError> {
    let mut tx = pool.begin().await?;
    // Serialize the per-author limit, including registrations from multiple browser tabs.
    sqlx::query("SELECT id FROM guest_authors WHERE id = $1 FOR UPDATE")
        .bind(author_id)
        .execute(&mut *tx)
        .await?;
    let existing: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT id, author_id FROM guest_push_subscriptions WHERE endpoint = $1 FOR UPDATE",
    )
    .bind(endpoint)
    .fetch_optional(&mut *tx)
    .await?;
    let id = if let Some((id, owner)) = existing {
        if owner != author_id {
            return Err(AppError::conflict(
                "Η συνδρομή ανήκει σε άλλη ταυτότητα περιηγητή. Απενεργοποίησε και ενεργοποίησε ξανά τις ειδοποιήσεις.",
            ));
        }
        sqlx::query("UPDATE guest_push_subscriptions SET p256dh = $2, auth = $3, updated_at = $4 WHERE id = $1")
            .bind(id).bind(p256dh).bind(auth).bind(now).execute(&mut *tx).await?;
        id
    } else {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM guest_push_subscriptions WHERE author_id = $1",
        )
        .bind(author_id)
        .fetch_one(&mut *tx)
        .await?;
        if count >= 10 {
            return Err(AppError::bad_request(
                "Έχεις φτάσει το όριο συσκευών για ειδοποιήσεις.",
            ));
        }
        let id = Uuid::now_v7();
        let inserted = sqlx::query("INSERT INTO guest_push_subscriptions(id, author_id, endpoint, p256dh, auth, created_at, updated_at)
                                   VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (endpoint) DO NOTHING")
            .bind(id).bind(author_id).bind(endpoint).bind(p256dh).bind(auth).bind(now).execute(&mut *tx).await?;
        if inserted.rows_affected() == 0 {
            return Err(AppError::conflict("Η συνδρομή άλλαξε. Δοκίμασε ξανά."));
        }
        id
    };
    tx.commit().await?;
    Ok(id)
}

pub async fn watched_comments(
    pool: &PgPool,
    author_id: Uuid,
    subscription_id: Uuid,
) -> Result<Vec<Uuid>, AppError> {
    let owned = sqlx::query_scalar::<_, Uuid>(
        "UPDATE guest_push_subscriptions SET updated_at = $3 WHERE id = $1 AND author_id = $2 RETURNING id",
    )
    .bind(subscription_id)
    .bind(author_id)
    .bind(OffsetDateTime::now_utc())
    .fetch_optional(pool)
    .await?;
    if owned.is_none() {
        return Err(AppError::not_found("unknown subscription"));
    }
    Ok(sqlx::query_scalar("SELECT comment_id FROM guest_reply_watches WHERE subscription_id = $1 ORDER BY created_at DESC")
        .bind(subscription_id).fetch_all(pool).await?)
}

pub async fn set_watch(
    pool: &PgPool,
    author_id: Uuid,
    subscription_id: Uuid,
    comment_id: Uuid,
    enabled: bool,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    let owned = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM guest_push_subscriptions WHERE id = $1 AND author_id = $2 FOR UPDATE",
    )
    .bind(subscription_id)
    .bind(author_id)
    .fetch_optional(&mut *tx)
    .await?;
    if owned.is_none() {
        return Err(AppError::not_found("unknown subscription"));
    }
    if enabled {
        let own_comment: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM guest_comments WHERE id = $1 AND author_id = $2 AND status IN ('pending','approved'))")
            .bind(comment_id).bind(author_id).fetch_one(&mut *tx).await?;
        if !own_comment {
            return Err(AppError::not_found("unknown comment"));
        }
        sqlx::query("INSERT INTO guest_reply_watches(subscription_id, comment_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING")
            .bind(subscription_id).bind(comment_id).bind(now).execute(&mut *tx).await?;
    } else {
        sqlx::query(
            "DELETE FROM guest_reply_watches WHERE subscription_id = $1 AND comment_id = $2",
        )
        .bind(subscription_id)
        .bind(comment_id)
        .execute(&mut *tx)
        .await?;
        // Unsubscribing also cancels queued deliveries, including if the user re-enables later.
        sqlx::query("UPDATE guest_push_deliveries delivery SET finished_at = $3, outcome = 'unwatched'
                     FROM guest_reply_events events JOIN guest_comments reply ON reply.id = events.reply_id
                     WHERE delivery.event_id = events.id AND delivery.subscription_id = $1
                       AND reply.reply_to_comment_id = $2 AND delivery.finished_at IS NULL")
            .bind(subscription_id).bind(comment_id).bind(now).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn delete_subscription(
    pool: &PgPool,
    author_id: Uuid,
    subscription_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM guest_push_subscriptions WHERE id = $1 AND author_id = $2")
        .bind(subscription_id)
        .bind(author_id)
        .execute(pool)
        .await?;
    Ok(())
}

#[derive(Debug, sqlx::FromRow)]
pub struct Delivery {
    pub event_id: Uuid,
    pub subscription_id: Uuid,
    pub attempts: i32,
    pub lease_until: OffsetDateTime,
}

#[derive(sqlx::FromRow)]
pub struct DeliveryContent {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub topic: String,
    pub external_id: String,
    pub reply_id: Uuid,
}

/// A lease survives a process crash. SKIP LOCKED also makes multiple workers safe.
pub async fn claim_delivery(
    pool: &PgPool,
    now: OffsetDateTime,
) -> Result<Option<Delivery>, AppError> {
    Ok(sqlx::query_as(
        "WITH due AS (
           SELECT event_id, subscription_id FROM guest_push_deliveries
           WHERE finished_at IS NULL AND next_attempt_at <= $1
           ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE guest_push_deliveries delivery SET attempts = attempts + 1, next_attempt_at = $2
         FROM due WHERE delivery.event_id = due.event_id AND delivery.subscription_id = due.subscription_id
         RETURNING delivery.event_id, delivery.subscription_id, delivery.attempts, delivery.next_attempt_at AS lease_until"
    ).bind(now).bind(now + time::Duration::minutes(2)).fetch_optional(pool).await?)
}

/// Recheck moderation, ownership and the watch immediately before every send/retry.
pub async fn delivery_content(
    pool: &PgPool,
    delivery: &Delivery,
    now: OffsetDateTime,
) -> Result<Option<DeliveryContent>, AppError> {
    Ok(sqlx::query_as(
        "SELECT subscriptions.endpoint, subscriptions.p256dh, subscriptions.auth,
                topics.slug AS topic, items.external_id, reply.id AS reply_id
         FROM guest_push_deliveries delivery
         JOIN guest_reply_events events ON events.id = delivery.event_id
         JOIN guest_comments reply ON reply.id = events.reply_id AND reply.status = 'approved'
         JOIN guest_comments parent ON parent.id = reply.reply_to_comment_id AND parent.status = 'approved'
         JOIN guest_push_subscriptions subscriptions ON subscriptions.id = delivery.subscription_id
         JOIN guest_reply_watches watches ON watches.subscription_id = subscriptions.id AND watches.comment_id = parent.id
         JOIN guest_authors recipient ON recipient.id = events.recipient_id AND recipient.trust_state <> 'banned'
         JOIN topics ON topics.id = reply.topic_id JOIN items ON items.id = reply.item_id
         WHERE delivery.event_id = $1 AND delivery.subscription_id = $2 AND delivery.finished_at IS NULL
           AND delivery.next_attempt_at = $3 AND subscriptions.author_id = events.recipient_id
           AND parent.author_id = events.recipient_id AND reply.author_id <> events.recipient_id
           AND events.created_at > $4 AND events.read_at IS NULL"
    ).bind(delivery.event_id).bind(delivery.subscription_id).bind(delivery.lease_until)
     .bind(now - time::Duration::days(1)).fetch_optional(pool).await?)
}

pub async fn finish_delivery(
    pool: &PgPool,
    delivery: &Delivery,
    outcome: &str,
    now: OffsetDateTime,
    retry_at: Option<OffsetDateTime>,
) -> Result<(), AppError> {
    sqlx::query("UPDATE guest_push_deliveries SET outcome = $4, finished_at = $5, next_attempt_at = COALESCE($6, next_attempt_at)
                 WHERE event_id = $1 AND subscription_id = $2 AND next_attempt_at = $3 AND finished_at IS NULL")
        .bind(delivery.event_id).bind(delivery.subscription_id).bind(delivery.lease_until).bind(outcome)
        .bind(if retry_at.is_some() { None } else { Some(now) }).bind(retry_at).execute(pool).await?;
    Ok(())
}

pub async fn expire_subscription(pool: &PgPool, subscription_id: Uuid) -> Result<(), AppError> {
    sqlx::query("DELETE FROM guest_push_subscriptions WHERE id = $1")
        .bind(subscription_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Inbox entries and unused push registrations expire after 90 days. Keep the boolean on each
/// comment so restoring an old reply cannot recreate an already-pruned notification.
pub async fn prune(pool: &PgPool, now: OffsetDateTime) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM guest_push_deliveries WHERE finished_at < $1")
        .bind(now - time::Duration::days(7))
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM guest_reply_events WHERE created_at < $1")
        .bind(now - time::Duration::days(90))
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM guest_push_subscriptions WHERE updated_at < $1")
        .bind(now - time::Duration::days(90))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
