use serde_json::Value;
use sqlx::{Postgres, Transaction, types::Json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;

pub async fn insert_item_observation(
    tx: &mut Transaction<'_, Postgres>,
    item_id: Uuid,
    title: &str,
    url: &str,
    metadata: Option<&Value>,
    recorded_at: OffsetDateTime,
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO item_observations (item_id, title, url, metadata, recorded_at)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(item_id)
    .bind(title)
    .bind(url)
    .bind(metadata.cloned().map(Json))
    .bind(recorded_at)
    .execute(&mut **tx)
    .await?;

    Ok(())
}
