use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SourceRecord {
    pub id: Uuid,
    pub slug: String,
    pub display_name: String,
    pub base_url: String,
    pub created_at: OffsetDateTime,
}

pub async fn upsert_source(
    pool: &PgPool,
    slug: &str,
    display_name: &str,
    base_url: &str,
) -> Result<SourceRecord, AppError> {
    let created_at = OffsetDateTime::now_utc();

    let record = sqlx::query_as::<_, SourceRecord>(
        r#"
        INSERT INTO sources (id, slug, display_name, base_url, created_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (slug) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            base_url = EXCLUDED.base_url
        RETURNING id, slug, display_name, base_url, created_at
        "#,
    )
    .bind(Uuid::now_v7())
    .bind(slug)
    .bind(display_name)
    .bind(base_url)
    .bind(created_at)
    .fetch_one(pool)
    .await?;

    Ok(record)
}
