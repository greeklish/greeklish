use axum::http::{HeaderMap, header};

use crate::config::CommentsConfig;
use crate::error::AppError;
use crate::ratelimit::{RateDecision, RateKey, RateRule};
use crate::state::AppState;

/// Rejects anything that is not a JSON request body.
///
/// Part of the CSRF defence: a cross-origin HTML form cannot set this content type, so requiring
/// it blocks the simplest forgery shape before `Origin` is even considered.
pub fn require_json_content_type(headers: &HeaderMap) -> Result<(), AppError> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();

    let is_json = content_type
        .split(';')
        .next()
        .map(|essence| essence.trim().eq_ignore_ascii_case("application/json"))
        .unwrap_or(false);

    if is_json {
        return Ok(());
    }

    Err(AppError::bad_request(
        "requests must use content-type: application/json",
    ))
}

/// Requires the request to originate from a configured origin.
///
/// Together with `SameSite=Strict` on the session cookie and the JSON content-type requirement,
/// this is the whole CSRF story — the project has no CORS layer and the UI is same-origin.
pub fn require_allowed_origin(
    config: &CommentsConfig,
    headers: &HeaderMap,
) -> Result<(), AppError> {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        // Same-origin navigations and non-browser clients may omit Origin entirely. The cookie's
        // SameSite=Strict already prevents a cross-site browser request from carrying credentials.
        return Ok(());
    };

    let origin = origin.trim().trim_end_matches('/');

    if config
        .moderation_allowed_origins
        .iter()
        .any(|allowed| allowed == origin)
    {
        return Ok(());
    }

    Err(AppError::forbidden("origin not allowed"))
}

/// Charges one hit against a rate counter, converting a rejection into a 429 with `Retry-After`.
pub fn enforce_rate_limit(
    state: &AppState,
    key: RateKey,
    rules: &[RateRule],
    message: &str,
) -> Result<(), AppError> {
    match state.check_rate(key, rules) {
        RateDecision::Allowed => Ok(()),
        RateDecision::Limited { retry_after } => {
            Err(AppError::too_many_requests(message, retry_after))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with_origins(origins: &[&str]) -> CommentsConfig {
        let mut config = crate::captcha::tests_support::sample_config();
        config.moderation_allowed_origins =
            origins.iter().map(|origin| (*origin).to_owned()).collect();

        config
    }

    #[test]
    fn accepts_json_with_a_charset() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "content-type",
            "application/json; charset=utf-8".parse().unwrap(),
        );

        assert!(require_json_content_type(&headers).is_ok());
    }

    #[test]
    fn rejects_form_encoded_bodies() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "content-type",
            "application/x-www-form-urlencoded".parse().unwrap(),
        );

        assert!(require_json_content_type(&headers).is_err());
        assert!(require_json_content_type(&HeaderMap::new()).is_err());
    }

    #[test]
    fn accepts_a_listed_origin_and_rejects_others() {
        let config = config_with_origins(&["https://greeklish.gr"]);

        let mut allowed = HeaderMap::new();
        allowed.insert("origin", "https://greeklish.gr".parse().unwrap());
        assert!(require_allowed_origin(&config, &allowed).is_ok());

        let mut foreign = HeaderMap::new();
        foreign.insert("origin", "https://evil.example".parse().unwrap());
        assert!(require_allowed_origin(&config, &foreign).is_err());
    }

    #[test]
    fn a_missing_origin_is_allowed() {
        let config = config_with_origins(&["https://greeklish.gr"]);

        assert!(require_allowed_origin(&config, &HeaderMap::new()).is_ok());
    }
}
