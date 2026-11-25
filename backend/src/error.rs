use std::time::Duration;

use axum::Json;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    Config(String),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{message}")]
    TooManyRequests {
        message: String,
        retry_after_secs: u64,
        retry_scope: Option<&'static str>,
    },
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
    #[error("{0}")]
    WebSocket(String),
}

#[derive(Debug, Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_scope: Option<&'static str>,
}

impl AppError {
    pub fn config(message: impl Into<String>) -> Self {
        Self::Config(message.into())
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::BadRequest(message.into())
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::Unauthorized(message.into())
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::Forbidden(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict(message.into())
    }

    pub fn too_many_requests(message: impl Into<String>, retry_after: Duration) -> Self {
        Self::TooManyRequests {
            message: message.into(),
            // Round up: a sub-second wait still has to read as at least one second.
            retry_after_secs: retry_after
                .as_secs()
                .saturating_add(u64::from(retry_after.subsec_nanos() > 0))
                .max(1),
            retry_scope: None,
        }
    }

    pub fn for_item(self) -> Self {
        match self {
            Self::TooManyRequests {
                message,
                retry_after_secs,
                ..
            } => Self::TooManyRequests {
                message,
                retry_after_secs,
                retry_scope: Some("item"),
            },
            other => other,
        }
    }

    fn code(&self) -> &'static str {
        match self {
            Self::Config(_) => "config_error",
            Self::BadRequest(_) => "bad_request",
            Self::Unauthorized(_) => "unauthorized",
            Self::Forbidden(_) => "forbidden",
            Self::NotFound(_) => "not_found",
            Self::Conflict(_) => "conflict",
            Self::TooManyRequests { .. } => "rate_limited",
            Self::Io(_) => "io_error",
            Self::Sqlx(_) => "database_error",
            Self::Migration(_) => "migration_error",
            Self::Serde(_) => "serialization_error",
            Self::WebSocket(_) => "websocket_error",
        }
    }

    fn status_code(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::TooManyRequests { .. } => StatusCode::TOO_MANY_REQUESTS,
            Self::Config(_)
            | Self::Io(_)
            | Self::Sqlx(_)
            | Self::Migration(_)
            | Self::Serde(_)
            | Self::WebSocket(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        let retry_after_secs = match &self {
            Self::TooManyRequests {
                retry_after_secs, ..
            } => Some(*retry_after_secs),
            _ => None,
        };

        let body = ErrorBody {
            code: self.code(),
            message: self.to_string(),
            retry_after_secs,
            retry_scope: match &self {
                Self::TooManyRequests { retry_scope, .. } => *retry_scope,
                _ => None,
            },
        };

        let mut response = (status, Json(body)).into_response();

        if let Some(seconds) = retry_after_secs
            && let Ok(value) = HeaderValue::from_str(&seconds.to_string())
        {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }

        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_header_rounds_up_without_truncating_long_waits() {
        for (duration, expected) in [
            (Duration::from_millis(1200), "2"),
            (Duration::from_secs(86400), "86400"),
        ] {
            let response = AppError::too_many_requests("wait", duration).into_response();
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(response.headers()[header::RETRY_AFTER], expected);
        }
    }
}
