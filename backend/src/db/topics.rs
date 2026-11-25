use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;
use crate::ws::messages::RankingStrategy;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TopicRecord {
    pub id: Uuid,
    pub slug: String,
    pub display_name: String,
    pub ranking_strategy: RankingStrategy,
    pub feed_size: i32,
    pub hot_gravity: Option<f64>,
    pub created_at: OffsetDateTime,
}

pub async fn upsert_topic(
    pool: &PgPool,
    slug: &str,
    display_name: &str,
    ranking_strategy: RankingStrategy,
    feed_size: i32,
    hot_gravity: Option<f64>,
) -> Result<TopicRecord, AppError> {
    let created_at = OffsetDateTime::now_utc();

    let record = sqlx::query_as::<_, TopicRecord>(
        r#"
        INSERT INTO topics (
            id,
            slug,
            display_name,
            ranking_strategy,
            feed_size,
            hot_gravity,
            created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (slug) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            ranking_strategy = EXCLUDED.ranking_strategy,
            feed_size = EXCLUDED.feed_size,
            hot_gravity = EXCLUDED.hot_gravity
        RETURNING
            id,
            slug,
            display_name,
            ranking_strategy,
            feed_size,
            hot_gravity,
            created_at
        "#,
    )
    .bind(Uuid::now_v7())
    .bind(slug)
    .bind(display_name)
    .bind(ranking_strategy)
    .bind(feed_size)
    .bind(hot_gravity)
    .bind(created_at)
    .fetch_one(pool)
    .await?;

    Ok(record)
}

pub async fn get_topic_by_slug(pool: &PgPool, slug: &str) -> Result<Option<TopicRecord>, AppError> {
    let record = sqlx::query_as::<_, TopicRecord>(
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
    .bind(slug)
    .fetch_optional(pool)
    .await?;

    Ok(record)
}
