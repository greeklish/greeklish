use crate::error::AppError;
use serde::Serialize;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, sqlx::FromRow, Serialize)]
pub struct Suggestion {
    pub id: Uuid,
    pub author_id: Uuid,
    pub url: String,
    pub name: Option<String>,
    pub explanation: Option<String>,
    pub email: Option<String>,
    pub status: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

pub async fn pending_count(pool: &PgPool) -> Result<i64, AppError> {
    Ok(
        sqlx::query_scalar("SELECT count(*) FROM feed_suggestions WHERE status = 'pending'")
            .fetch_one(pool)
            .await?,
    )
}

pub async fn list(
    pool: &PgPool,
    status: Option<&str>,
    before: Option<(OffsetDateTime, Uuid)>,
    limit: i64,
) -> Result<Vec<Suggestion>, AppError> {
    let (at, id) = before
        .map(|(at, id)| (Some(at), Some(id)))
        .unwrap_or_default();
    Ok(sqlx::query_as("SELECT id, author_id, url, name, explanation, CASE WHEN resolved_at < now() - interval '90 days' THEN NULL ELSE email END AS email, status, created_at, updated_at FROM feed_suggestions WHERE ($1::text IS NULL OR status = $1) AND ($2::timestamptz IS NULL OR (created_at,id) < ($2,$3)) ORDER BY created_at DESC,id DESC LIMIT $4")
        .bind(status).bind(at).bind(id).bind(limit).fetch_all(pool).await?)
}

pub async fn prune(
    pool: &PgPool,
    now: OffsetDateTime,
    ip_cutoff: OffsetDateTime,
) -> Result<(), AppError> {
    sqlx::query("UPDATE feed_suggestions SET email = CASE WHEN resolved_at < $1 THEN NULL ELSE email END, author_ip_hash = CASE WHEN created_at < $2 THEN NULL ELSE author_ip_hash END WHERE (email IS NOT NULL AND resolved_at < $1) OR (author_ip_hash IS NOT NULL AND created_at < $2)")
        .bind(now - time::Duration::days(90)).bind(ip_cutoff).execute(pool).await?;
    Ok(())
}
