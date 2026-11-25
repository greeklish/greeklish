use std::env;
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use crate::error::AppError;

const MIN_SECRET_LENGTH: usize = 32;
const MAX_IP_RETENTION_DAYS: i64 = 90;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeEnvironment {
    Development,
    Production,
}

/// Configuration for the guest commenting feature.
///
/// The feature is opt-in: it stays disabled until all three secrets are present. Setting only some
/// of them is a startup error rather than a silent half-configured state.
#[derive(Debug, Clone)]
pub struct CommentsConfig {
    pub ip_pepper: String,
    pub captcha_hmac_key: String,
    pub moderator_password_hash: String,
    pub moderation_allowed_origins: Vec<String>,
    pub auto_approve_threshold: i32,
    pub max_length: usize,
    pub max_pending_per_author: i64,
    pub captcha_max_number: u64,
    pub captcha_ttl: Duration,
    pub moderator_session_ttl: Duration,
    pub ip_retention_days: i64,
    pub per_ip_burst_interval: Duration,
    pub per_ip_hourly_limit: usize,
    pub per_ip_daily_limit: usize,
    pub per_author_burst_interval: Duration,
    pub per_author_hourly_limit: usize,
    pub per_author_item_daily_limit: usize,
    pub captcha_hourly_limit: usize,
    pub login_attempt_limit: usize,
    pub login_attempt_window: Duration,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub internal_api_token: String,
    pub bind_address: IpAddr,
    pub ws_ping_interval: Duration,
    pub ws_timeout: Duration,
    pub ticker_interval: Duration,
    pub default_feed_size: i32,
    pub hot_gravity: f64,
    pub environment: RuntimeEnvironment,
    pub port: u16,
    pub required_client_version: Option<String>,
    pub sweeper_interval: Duration,
    pub comments: Option<CommentsConfig>,
    pub push: Option<crate::push::PushConfig>,
}

impl Config {
    pub fn from_env() -> Result<Self, AppError> {
        let database_url = required_var("DATABASE_URL")?;
        let internal_api_token = required_var("INTERNAL_API_TOKEN")?;
        let bind_address = parse_with_default("BIND_ADDRESS", IpAddr::V4(Ipv4Addr::UNSPECIFIED))?;

        let ws_ping_interval =
            Duration::from_secs(parse_with_default("WS_PING_INTERVAL_SECS", 30)?);
        let ws_timeout = Duration::from_secs(parse_with_default("WS_TIMEOUT_SECS", 60)?);
        let ticker_interval = Duration::from_secs(parse_with_default("TICKER_INTERVAL_SECS", 30)?);
        let default_feed_size = parse_with_default("DEFAULT_FEED_SIZE", 20)?;
        let hot_gravity = parse_with_default("HOT_GRAVITY", 1.8)?;
        let port = parse_with_default("PORT", 3000)?;
        let required_client_version = optional_non_empty_var("REQUIRED_CLIENT_VERSION")?;
        let environment =
            parse_environment(env::var("RUST_ENV").unwrap_or_else(|_| "development".to_owned()))?;
        let sweeper_interval =
            Duration::from_secs(parse_with_default("SWEEPER_INTERVAL_SECS", 60)?);
        let comments = CommentsConfig::from_env()?;
        let push = crate::push::PushConfig::from_env()?;
        if push.is_some() && comments.is_none() {
            return Err(AppError::config(
                "Web Push requires guest comments to be configured",
            ));
        }

        if default_feed_size <= 0 {
            return Err(AppError::config(
                "DEFAULT_FEED_SIZE must be a positive integer".to_owned(),
            ));
        }

        if hot_gravity <= 0.0 {
            return Err(AppError::config(
                "HOT_GRAVITY must be greater than zero".to_owned(),
            ));
        }

        if ws_timeout <= ws_ping_interval {
            return Err(AppError::config(
                "WS_TIMEOUT_SECS must be greater than WS_PING_INTERVAL_SECS".to_owned(),
            ));
        }

        Ok(Self {
            database_url,
            internal_api_token,
            bind_address,
            ws_ping_interval,
            ws_timeout,
            ticker_interval,
            default_feed_size,
            hot_gravity,
            environment,
            port,
            required_client_version,
            sweeper_interval,
            comments,
            push,
        })
    }
}

impl CommentsConfig {
    fn from_env() -> Result<Option<Self>, AppError> {
        let ip_pepper = optional_non_empty_var("COMMENT_IP_PEPPER")?;
        let captcha_hmac_key = optional_non_empty_var("CAPTCHA_HMAC_KEY")?;
        let moderator_password_hash = optional_non_empty_var("MODERATOR_PASSWORD_ARGON2_HASH")?;

        let configured = [
            ip_pepper.is_some(),
            captcha_hmac_key.is_some(),
            moderator_password_hash.is_some(),
        ];

        if configured.iter().all(|present| !present) {
            return Ok(None);
        }

        if configured.iter().any(|present| !present) {
            return Err(AppError::config(
                "guest comments need COMMENT_IP_PEPPER, CAPTCHA_HMAC_KEY and \
                 MODERATOR_PASSWORD_ARGON2_HASH set together"
                    .to_owned(),
            ));
        }

        let ip_pepper = ip_pepper.expect("checked above");
        let captcha_hmac_key = captcha_hmac_key.expect("checked above");
        let moderator_password_hash = moderator_password_hash.expect("checked above");

        if ip_pepper.len() < MIN_SECRET_LENGTH {
            return Err(AppError::config(format!(
                "COMMENT_IP_PEPPER must be at least {MIN_SECRET_LENGTH} characters"
            )));
        }

        if captcha_hmac_key.len() < MIN_SECRET_LENGTH {
            return Err(AppError::config(format!(
                "CAPTCHA_HMAC_KEY must be at least {MIN_SECRET_LENGTH} characters"
            )));
        }

        let moderation_allowed_origins = parse_origin_list(
            env::var("MODERATION_ALLOWED_ORIGINS")
                .unwrap_or_else(|_| "https://greeklish.gr".to_owned()),
        )?;

        let auto_approve_threshold = parse_with_default("COMMENT_AUTO_APPROVE_THRESHOLD", 5i32)?;
        let max_length = parse_with_default("COMMENT_MAX_LENGTH", 1000usize)?;
        let max_pending_per_author = parse_with_default("COMMENT_MAX_PENDING_PER_AUTHOR", 3i64)?;
        let captcha_max_number = parse_with_default("CAPTCHA_MAX_NUMBER", 150_000u64)?;
        let captcha_ttl = Duration::from_secs(parse_with_default("CAPTCHA_TTL_SECS", 300)?);
        let moderator_session_ttl =
            Duration::from_secs(parse_with_default("MODERATOR_SESSION_TTL_SECS", 28_800)?);
        let ip_retention_days = parse_with_default("COMMENT_IP_RETENTION_DAYS", 90i64)?;

        if auto_approve_threshold <= 0 {
            return Err(AppError::config(
                "COMMENT_AUTO_APPROVE_THRESHOLD must be a positive integer".to_owned(),
            ));
        }

        if !(2..=4000).contains(&max_length) {
            return Err(AppError::config(
                "COMMENT_MAX_LENGTH must be between 2 and 4000".to_owned(),
            ));
        }

        if max_pending_per_author <= 0 {
            return Err(AppError::config(
                "COMMENT_MAX_PENDING_PER_AUTHOR must be a positive integer".to_owned(),
            ));
        }

        if captcha_max_number < 1_000 {
            return Err(AppError::config(
                "CAPTCHA_MAX_NUMBER must be at least 1000".to_owned(),
            ));
        }

        if captcha_ttl.is_zero() {
            return Err(AppError::config(
                "CAPTCHA_TTL_SECS must be greater than zero".to_owned(),
            ));
        }

        if moderator_session_ttl.is_zero() {
            return Err(AppError::config(
                "MODERATOR_SESSION_TTL_SECS must be greater than zero".to_owned(),
            ));
        }

        // ui/TOS.md commits to retaining technical data for at most 90 days. This ceiling is a
        // published commitment, not a tuning knob.
        if !(1..=MAX_IP_RETENTION_DAYS).contains(&ip_retention_days) {
            return Err(AppError::config(format!(
                "COMMENT_IP_RETENTION_DAYS must be between 1 and {MAX_IP_RETENTION_DAYS}"
            )));
        }

        if moderation_allowed_origins.is_empty() {
            return Err(AppError::config(
                "MODERATION_ALLOWED_ORIGINS must list at least one origin".to_owned(),
            ));
        }

        Ok(Some(Self {
            ip_pepper,
            captcha_hmac_key,
            moderator_password_hash,
            moderation_allowed_origins,
            auto_approve_threshold,
            max_length,
            max_pending_per_author,
            captcha_max_number,
            captcha_ttl,
            moderator_session_ttl,
            ip_retention_days,
            per_ip_burst_interval: Duration::from_secs(parse_with_default(
                "COMMENT_PER_IP_BURST_SECS",
                2,
            )?),
            per_ip_hourly_limit: parse_with_default("COMMENT_PER_IP_HOURLY_LIMIT", 120usize)?,
            per_ip_daily_limit: parse_with_default("COMMENT_PER_IP_DAILY_LIMIT", 500usize)?,
            per_author_burst_interval: Duration::from_secs(parse_with_default(
                "COMMENT_PER_AUTHOR_BURST_SECS",
                10,
            )?),
            per_author_hourly_limit: parse_with_default(
                "COMMENT_PER_AUTHOR_HOURLY_LIMIT",
                30usize,
            )?,
            per_author_item_daily_limit: parse_with_default(
                "COMMENT_PER_AUTHOR_ITEM_DAILY_LIMIT",
                30usize,
            )?,
            captcha_hourly_limit: parse_with_default("CAPTCHA_PER_IP_HOURLY_LIMIT", 240usize)?,
            login_attempt_limit: parse_with_default("MODERATOR_LOGIN_ATTEMPT_LIMIT", 5usize)?,
            login_attempt_window: Duration::from_secs(parse_with_default(
                "MODERATOR_LOGIN_ATTEMPT_WINDOW_SECS",
                900,
            )?),
        }))
    }
}

fn parse_origin_list(value: String) -> Result<Vec<String>, AppError> {
    let origins: Vec<String> = value
        .split(',')
        .map(|origin| origin.trim().trim_end_matches('/').to_owned())
        .filter(|origin| !origin.is_empty())
        .collect();

    for origin in &origins {
        if !origin.starts_with("http://") && !origin.starts_with("https://") {
            return Err(AppError::config(format!(
                "MODERATION_ALLOWED_ORIGINS entries must include a scheme, got `{origin}`"
            )));
        }
    }

    Ok(origins)
}

fn required_var(key: &str) -> Result<String, AppError> {
    env::var(key)
        .map_err(|_| AppError::config(format!("missing required environment variable {key}")))
}

fn optional_non_empty_var(key: &str) -> Result<Option<String>, AppError> {
    match env::var(key) {
        Ok(value) => {
            let trimmed = value.trim();
            Ok((!trimmed.is_empty()).then(|| trimmed.to_owned()))
        }
        Err(env::VarError::NotPresent) => Ok(None),
        Err(error) => Err(AppError::config(format!("invalid {key}: {error}"))),
    }
}

fn parse_with_default<T>(key: &str, default: T) -> Result<T, AppError>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    match env::var(key) {
        Ok(value) => value
            .parse::<T>()
            .map_err(|error| AppError::config(format!("invalid {key}: {error}"))),
        Err(env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(AppError::config(format!("invalid {key}: {error}"))),
    }
}

fn parse_environment(value: String) -> Result<RuntimeEnvironment, AppError> {
    match value.as_str() {
        "development" => Ok(RuntimeEnvironment::Development),
        "production" => Ok(RuntimeEnvironment::Production),
        _ => Err(AppError::config(
            "RUST_ENV must be either development or production".to_owned(),
        )),
    }
}
