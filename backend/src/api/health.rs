use axum::Json;
use axum::extract::State;
use serde::Serialize;

use crate::db;
use crate::error::AppError;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct DatabaseHealth {
    pub reachable: bool,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub uptime_seconds: u64,
    pub database: DatabaseHealth,
}

pub async fn get_health(State(state): State<AppState>) -> Result<Json<HealthResponse>, AppError> {
    let reachable = db::database_reachable(state.db_pool()).await;
    let status = if reachable { "ok" } else { "unreachable" };

    Ok(Json(HealthResponse {
        uptime_seconds: state.uptime().as_secs(),
        database: DatabaseHealth {
            reachable,
            status: status.to_owned(),
        },
    }))
}
