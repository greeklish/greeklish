pub mod crawl_snapshots;
pub mod feed_suggestions;
pub mod guest_comments;
pub mod item_observations;
pub mod items;
pub mod maintenance;
pub mod reply_notifications;
pub mod snapshots;
pub mod sources;
pub mod topic_history;
pub mod topic_runs;
pub mod topics;

use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

use crate::error::AppError;

pub async fn connect(database_url: &str) -> Result<PgPool, AppError> {
    PgPoolOptions::new()
        .max_connections(10)
        .connect(database_url)
        .await
        .map_err(AppError::from)
}

pub async fn run_migrations(pool: &PgPool) -> Result<(), AppError> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}

pub async fn database_reachable(pool: &PgPool) -> bool {
    sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(pool)
        .await
        .is_ok()
}
