mod api;
mod captcha;
mod config;
mod crypto;
mod db;
mod error;
mod net;
mod push;
mod ranking;
mod ratelimit;
mod state;
mod sweeper;
mod ticker;
mod ws;

use std::net::SocketAddr;

use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::config::{Config, RuntimeEnvironment};
use crate::error::AppError;
use crate::state::AppState;

#[tokio::main]
async fn main() -> Result<(), AppError> {
    dotenvy::dotenv().ok();

    let config = Config::from_env()?;
    init_tracing(&config)?;

    let db_pool = db::connect(&config.database_url).await?;
    db::run_migrations(&db_pool).await?;

    let state = AppState::new(config.clone(), db_pool);
    let ticker_handle = ticker::spawn(state.clone());
    let sweeper_handle = sweeper::spawn(state.clone());
    let push_handle = push::spawn(state.clone());

    if config.comments.is_none() {
        info!("guest comments are disabled; comment routes will return 404");
    }

    let app = api::router(state.clone()).layer(TraceLayer::new_for_http());
    let address = SocketAddr::new(config.bind_address, config.port);
    let listener = TcpListener::bind(address).await?;

    info!(address = %address, "backend listening");

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(state.clone()))
    .await?;

    let _ = ticker_handle.await;
    let _ = sweeper_handle.await;
    let _ = push_handle.await;

    Ok(())
}

fn init_tracing(config: &Config) -> Result<(), AppError> {
    let env_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("backend=debug,info"));

    match config.environment {
        RuntimeEnvironment::Development => {
            tracing_subscriber::fmt()
                .with_env_filter(env_filter)
                .pretty()
                .try_init()
                .map_err(|error| {
                    AppError::config(format!("failed to initialize tracing: {error}"))
                })?;
        }
        RuntimeEnvironment::Production => {
            tracing_subscriber::fmt()
                .with_env_filter(env_filter)
                .json()
                .try_init()
                .map_err(|error| {
                    AppError::config(format!("failed to initialize tracing: {error}"))
                })?;
        }
    }

    Ok(())
}

async fn shutdown_signal(state: AppState) {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(error = %error, "failed to install ctrl-c handler");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::error!(error = %error, "failed to install terminate handler");
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }

    info!("shutdown requested");
    state.begin_shutdown().await;
}

#[cfg(test)]
mod comment_regression_tests;

#[cfg(test)]
mod reply_regression_tests;

#[cfg(test)]
mod suggestion_regression_tests;
