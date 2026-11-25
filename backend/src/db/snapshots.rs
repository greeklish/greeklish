use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;

pub async fn insert_score_snapshot(
    tx: &mut Transaction<'_, Postgres>,
    item_id: Uuid,
    topic_id: Uuid,
    score: f64,
    recorded_at: OffsetDateTime,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO score_snapshots (item_id, topic_id, score, recorded_at)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(item_id)
    .bind(topic_id)
    .bind(score)
    .bind(recorded_at)
    .execute(&mut **tx)
    .await?;

    Ok(())
}
