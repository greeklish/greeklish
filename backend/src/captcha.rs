use hmac::{Hmac, Mac};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use ts_rs::TS;

use crate::config::CommentsConfig;
use crate::error::AppError;

type HmacSha256 = Hmac<Sha256>;

const ALGORITHM: &str = "SHA-256";
const SALT_RANDOM_BYTES: usize = 16;

/// A proof-of-work challenge in the Altcha wire format.
///
/// Keeping the Altcha shape means the official self-hosted widget stays a drop-in replacement for
/// our own solver without a protocol change on either side.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "bindings/ws.ts")]
pub struct CaptchaChallenge {
    pub algorithm: String,
    pub challenge: String,
    pub salt: String,
    pub maxnumber: u64,
    pub signature: String,
}

/// A solved challenge, as submitted with a comment.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "bindings/ws.ts")]
pub struct CaptchaSolution {
    pub algorithm: String,
    pub challenge: String,
    pub salt: String,
    pub number: u64,
    pub signature: String,
}

/// Issues a fresh challenge.
///
/// The secret number is never sent. The browser recovers it by brute force, which is what makes
/// this a proof of work; `maxnumber` sets how much work that is.
pub fn issue(config: &CommentsConfig, now: OffsetDateTime) -> CaptchaChallenge {
    let mut random_bytes = [0u8; SALT_RANDOM_BYTES];
    rand::rng().fill(&mut random_bytes);

    let expires = now.unix_timestamp() + config.captcha_ttl.as_secs() as i64;
    let salt = format!("{}?expires={}", hex_encode(&random_bytes), expires);
    let secret_number = rand::rng().random_range(0..config.captcha_max_number);
    let challenge = challenge_digest(&salt, secret_number);
    let signature = sign(&config.captcha_hmac_key, &challenge);

    CaptchaChallenge {
        algorithm: ALGORITHM.to_owned(),
        challenge,
        salt,
        maxnumber: config.captcha_max_number,
        signature,
    }
}

/// Verifies a solution without touching shared state.
///
/// Checks run cheapest-first and, crucially, the signature and expiry are validated **before** the
/// SHA-256 recomputation. That ordering stops an unauthenticated caller from making the server
/// grind hashes over input it chose.
///
/// Replay prevention is the caller's job: a verified challenge must be recorded as spent exactly
/// once, after every other check on the request has passed.
pub fn verify(
    config: &CommentsConfig,
    solution: &CaptchaSolution,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    if solution.algorithm != ALGORITHM {
        return Err(AppError::bad_request(
            "Ο έλεγχος ασφαλείας απέτυχε. Δοκίμασε ξανά.",
        ));
    }

    verify_signature(
        &config.captcha_hmac_key,
        &solution.challenge,
        &solution.signature,
    )?;

    let expires = parse_expires(&solution.salt)?;
    if now.unix_timestamp() > expires {
        return Err(AppError::bad_request(
            "Ο έλεγχος ασφαλείας έληξε. Δοκίμασε ξανά.",
        ));
    }

    if solution.number > config.captcha_max_number {
        return Err(AppError::bad_request(
            "Ο έλεγχος ασφαλείας απέτυχε. Δοκίμασε ξανά.",
        ));
    }

    let expected = challenge_digest(&solution.salt, solution.number);
    if !constant_time_eq(expected.as_bytes(), solution.challenge.as_bytes()) {
        return Err(AppError::bad_request(
            "Ο έλεγχος ασφαλείας απέτυχε. Δοκίμασε ξανά.",
        ));
    }

    Ok(())
}

fn challenge_digest(salt: &str, number: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(number.to_string().as_bytes());

    hex_encode(&hasher.finalize())
}

fn sign(key: &str, challenge: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(key.as_bytes()).expect("hmac-sha256 accepts any key length");
    mac.update(challenge.as_bytes());

    hex_encode(&mac.finalize().into_bytes())
}

fn verify_signature(key: &str, challenge: &str, signature: &str) -> Result<(), AppError> {
    let expected = sign(key, challenge);

    if constant_time_eq(expected.as_bytes(), signature.as_bytes()) {
        return Ok(());
    }

    Err(AppError::bad_request(
        "Ο έλεγχος ασφαλείας απέτυχε. Δοκίμασε ξανά.",
    ))
}

fn parse_expires(salt: &str) -> Result<i64, AppError> {
    salt.split_once("?expires=")
        .and_then(|(_, expires)| expires.split('&').next())
        .and_then(|expires| expires.parse::<i64>().ok())
        .ok_or_else(|| AppError::bad_request("Ο έλεγχος ασφαλείας απέτυχε. Δοκίμασε ξανά."))
}

/// Compares two byte strings without an early return on the first difference.
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }

    let mut difference = 0u8;
    for (left_byte, right_byte) in left.iter().zip(right.iter()) {
        difference |= left_byte ^ right_byte;
    }

    difference == 0
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);

    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }

    encoded
}

/// Shared fixture for tests in other modules that need a populated `CommentsConfig`.
#[cfg(test)]
pub mod tests_support {
    use std::time::Duration;

    use crate::config::CommentsConfig;

    pub fn sample_config() -> CommentsConfig {
        CommentsConfig {
            ip_pepper: "pepper-pepper-pepper-pepper-pepper".to_owned(),
            captcha_hmac_key: "captcha-key-captcha-key-captcha-key".to_owned(),
            moderator_password_hash: String::new(),
            moderation_allowed_origins: vec!["https://greeklish.gr".to_owned()],
            auto_approve_threshold: 5,
            max_length: 1000,
            max_pending_per_author: 3,
            captcha_max_number: 2_000,
            captcha_ttl: Duration::from_secs(300),
            moderator_session_ttl: Duration::from_secs(28_800),
            ip_retention_days: 90,
            per_ip_burst_interval: Duration::from_secs(30),
            per_ip_hourly_limit: 10,
            per_ip_daily_limit: 25,
            per_author_burst_interval: Duration::from_secs(20),
            per_author_hourly_limit: 15,
            per_author_item_daily_limit: 5,
            captcha_hourly_limit: 30,
            login_attempt_limit: 5,
            login_attempt_window: Duration::from_secs(900),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::sample_config as test_config;
    use super::*;

    /// Mirrors what the browser worker does.
    fn solve(challenge: &CaptchaChallenge) -> CaptchaSolution {
        let number = (0..=challenge.maxnumber)
            .find(|candidate| challenge_digest(&challenge.salt, *candidate) == challenge.challenge)
            .expect("a solution exists below maxnumber");

        CaptchaSolution {
            algorithm: challenge.algorithm.clone(),
            challenge: challenge.challenge.clone(),
            salt: challenge.salt.clone(),
            number,
            signature: challenge.signature.clone(),
        }
    }

    #[test]
    fn a_solved_challenge_verifies() {
        let config = test_config();
        let now = OffsetDateTime::now_utc();
        let challenge = issue(&config, now);

        assert!(verify(&config, &solve(&challenge), now).is_ok());
    }

    #[test]
    fn a_wrong_number_is_rejected() {
        let config = test_config();
        let now = OffsetDateTime::now_utc();
        let challenge = issue(&config, now);
        let mut solution = solve(&challenge);
        solution.number = solution.number.wrapping_add(1);

        assert!(verify(&config, &solution, now).is_err());
    }

    #[test]
    fn a_tampered_signature_is_rejected() {
        let config = test_config();
        let now = OffsetDateTime::now_utc();
        let challenge = issue(&config, now);
        let mut solution = solve(&challenge);
        solution.signature = "0".repeat(64);

        assert!(verify(&config, &solution, now).is_err());
    }

    #[test]
    fn a_challenge_from_another_key_is_rejected() {
        let config = test_config();
        let mut other = test_config();
        other.captcha_hmac_key = "different-key-different-key-diff!!".to_owned();

        let now = OffsetDateTime::now_utc();
        let challenge = issue(&other, now);

        assert!(verify(&config, &solve(&challenge), now).is_err());
    }

    #[test]
    fn an_expired_challenge_is_rejected() {
        let config = test_config();
        let now = OffsetDateTime::now_utc();
        let challenge = issue(&config, now);
        let later = now + time::Duration::seconds(301);

        assert!(verify(&config, &solve(&challenge), later).is_err());
    }

    #[test]
    fn a_salt_without_an_expiry_is_rejected() {
        let config = test_config();
        let now = OffsetDateTime::now_utc();
        let mut solution = solve(&issue(&config, now));
        solution.salt = "deadbeef".to_owned();

        assert!(verify(&config, &solution, now).is_err());
    }

    #[test]
    fn issued_challenges_are_distinct() {
        let config = test_config();
        let now = OffsetDateTime::now_utc();

        let first = issue(&config, now);
        let second = issue(&config, now);

        assert_ne!(first.salt, second.salt);
        assert_ne!(first.challenge, second.challenge);
    }
}
