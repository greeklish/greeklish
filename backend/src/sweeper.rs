use time::OffsetDateTime;
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use tracing::{debug, warn};

use crate::db::maintenance;
use crate::state::AppState;

/// How often the retention pass runs, independent of the in-memory sweep cadence.
const RETENTION_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3_600);

/// Periodically reclaims the in-memory maps backing rate limiting, captcha replay prevention and
/// moderator sessions.
///
/// `DashMap` offers no TTL or size eviction, so every one of those maps would otherwise grow for
/// the lifetime of the process. Modelled on `ticker::spawn`, including its cancellation handling.
pub fn spawn(state: AppState) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(state.config().sweeper_interval);
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let shutdown_token = state.shutdown_token();
        let mut retention_interval = tokio::time::interval(RETENTION_INTERVAL);
        retention_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                _ = shutdown_token.cancelled() => break,
                _ = interval.tick() => {
                    let report = state.prune_ephemeral_state();

                    if !report.is_empty() {
                        debug!(
                            rate_hits_dropped = report.rate_hits_dropped,
                            captchas_dropped = report.captchas_dropped,
                            sessions_dropped = report.sessions_dropped,
                            lockouts_dropped = report.lockouts_dropped,
                            "pruned ephemeral comment state"
                        );
                    }
                }
                _ = retention_interval.tick() => {
                    run_retention_pass(&state).await;
                }
            }
        }
    })
}

/// Erases address hashes that have passed the configured retention window.
///
/// Runs on the backend itself rather than waiting for an operator to call the maintenance route,
/// because the retention promise in `ui/TOS.md` is time-based and must not depend on a manual step.
async fn run_retention_pass(state: &AppState) {
    let Some(config) = state.comments_config() else {
        return;
    };

    let now = OffsetDateTime::now_utc();
    let cutoff = now - time::Duration::days(config.ip_retention_days);

    if let Err(error) = crate::db::feed_suggestions::prune(state.db_pool(), now, cutoff).await {
        warn!(error = %error, "feed suggestion retention pass failed");
    }

    if let Err(error) = crate::db::reply_notifications::prune(state.db_pool(), now).await {
        warn!(error = %error, "reply notification retention pass failed");
    }

    match maintenance::erase_expired_comment_ip_hashes(state.db_pool(), cutoff, now).await {
        Ok(result) => {
            if result.ip_hashes_erased > 0 || result.expired_blocks_deleted > 0 {
                debug!(
                    ip_hashes_erased = result.ip_hashes_erased,
                    expired_blocks_deleted = result.expired_blocks_deleted,
                    cutoff = %result.cutoff,
                    "applied comment data retention"
                );
            }
        }
        Err(error) => warn!(error = %error, "comment retention pass failed"),
    }
}
