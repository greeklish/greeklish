use sqlx::{Executor, PgPool};
use time::OffsetDateTime;

use crate::error::AppError;

const VACUUM_TABLES: [&str; 6] = [
    "crawl_snapshot_items",
    "crawl_snapshots",
    "score_snapshots",
    "item_observations",
    "topic_item_events",
    "topic_runs",
];

#[derive(Debug, Clone)]
pub struct HistoryCleanupResult {
    pub cutoff: OffsetDateTime,
    pub crawl_snapshots_deleted: i64,
    pub crawl_snapshot_items_deleted: i64,
    pub score_snapshots_deleted: i64,
    pub item_observations_deleted: i64,
    pub topic_item_events_deleted: i64,
    pub topic_runs_deleted: i64,
    pub vacuumed_tables: Vec<&'static str>,
}

pub async fn clean_history(
    pool: &PgPool,
    cutoff: OffsetDateTime,
    vacuum: bool,
) -> Result<HistoryCleanupResult, AppError> {
    let (crawl_snapshot_items_deleted, crawl_snapshots_deleted) =
        delete_crawl_snapshots_older_than(pool, cutoff).await?;
    let topic_item_events_deleted = delete_older_than(pool, "topic_item_events", cutoff).await?;
    let topic_runs_deleted = delete_older_than(pool, "topic_runs", cutoff).await?;
    let score_snapshots_deleted = delete_older_than(pool, "score_snapshots", cutoff).await?;
    let item_observations_deleted = delete_older_than(pool, "item_observations", cutoff).await?;

    let vacuumed_tables = if vacuum {
        vacuum_history_tables(pool).await?
    } else {
        Vec::new()
    };

    Ok(HistoryCleanupResult {
        cutoff,
        crawl_snapshots_deleted,
        crawl_snapshot_items_deleted,
        score_snapshots_deleted,
        item_observations_deleted,
        topic_item_events_deleted,
        topic_runs_deleted,
        vacuumed_tables,
    })
}

async fn delete_crawl_snapshots_older_than(
    pool: &PgPool,
    cutoff: OffsetDateTime,
) -> Result<(i64, i64), AppError> {
    let deleted_items = sqlx::query(
        r#"
        DELETE FROM crawl_snapshot_items
        WHERE snapshot_id IN (
            SELECT id
            FROM crawl_snapshots
            WHERE crawled_at < $1
        )
        "#,
    )
    .bind(cutoff)
    .execute(pool)
    .await?;

    let deleted_snapshots = sqlx::query("DELETE FROM crawl_snapshots WHERE crawled_at < $1")
        .bind(cutoff)
        .execute(pool)
        .await?;

    Ok((
        rows_affected_to_i64(deleted_items.rows_affected()),
        rows_affected_to_i64(deleted_snapshots.rows_affected()),
    ))
}

async fn delete_older_than(
    pool: &PgPool,
    table: &'static str,
    cutoff: OffsetDateTime,
) -> Result<i64, AppError> {
    let result = sqlx::query(&format!("DELETE FROM {table} WHERE recorded_at < $1"))
        .bind(cutoff)
        .execute(pool)
        .await?;

    Ok(rows_affected_to_i64(result.rows_affected()))
}

async fn vacuum_history_tables(pool: &PgPool) -> Result<Vec<&'static str>, AppError> {
    let mut vacuumed_tables = Vec::with_capacity(VACUUM_TABLES.len());

    for table in VACUUM_TABLES {
        let sql = format!("VACUUM (FULL, ANALYZE) {table}");
        pool.execute(sql.as_str()).await?;
        vacuumed_tables.push(table);
    }

    Ok(vacuumed_tables)
}

/// Erases the pseudonymous address hash from comments past the retention window.
///
/// Deliberately a dedicated statement rather than an entry in `VACUUM_TABLES` or the generic
/// `delete_older_than` loop: those delete whole rows by `recorded_at`, which would destroy comment
/// bodies. Comment text is editorial content and is kept; only the technical identifier expires.
///
/// `ui/TOS.md` section 5 commits to retaining technical data for at most 90 days, which is why the
/// configured window is capped rather than free-form.
pub async fn erase_expired_comment_ip_hashes(
    pool: &PgPool,
    cutoff: OffsetDateTime,
    now: OffsetDateTime,
) -> Result<CommentRetentionResult, AppError> {
    let erased = sqlx::query(
        r#"
        UPDATE guest_comments
        SET author_ip_hash = NULL,
            updated_at = $2
        WHERE author_ip_hash IS NOT NULL
          AND created_at < $1
        "#,
    )
    .bind(cutoff)
    .bind(now)
    .execute(pool)
    .await?;

    let blocks = sqlx::query(
        r#"
        DELETE FROM guest_comment_ip_blocks
        WHERE expires_at IS NOT NULL
          AND expires_at < $1
        "#,
    )
    .bind(now)
    .execute(pool)
    .await?;

    Ok(CommentRetentionResult {
        cutoff,
        ip_hashes_erased: rows_affected_to_i64(erased.rows_affected()),
        expired_blocks_deleted: rows_affected_to_i64(blocks.rows_affected()),
    })
}

#[derive(Debug, Clone)]
pub struct CommentRetentionResult {
    pub cutoff: OffsetDateTime,
    pub ip_hashes_erased: i64,
    pub expired_blocks_deleted: i64,
}

fn rows_affected_to_i64(rows_affected: u64) -> i64 {
    rows_affected.try_into().unwrap_or(i64::MAX)
}
