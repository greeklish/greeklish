use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use rand::Rng;
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// Length of every opaque bearer token this service mints.
pub const TOKEN_BYTES: usize = 32;

/// Mints an opaque, unguessable token.
///
/// Used for guest author tokens and moderator session tokens. Deliberately **not**
/// `Uuid::now_v7()`: v7 is time-ordered and therefore partly predictable, which is fine for a
/// database key and unacceptable for a secret.
pub fn generate_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rng().fill(&mut bytes);

    URL_SAFE_NO_PAD.encode(bytes)
}

/// Hashes a bearer token for storage. Only the digest is ever persisted or kept in memory.
pub fn hash_token(token: &str) -> [u8; 32] {
    let digest = Sha256::digest(token.as_bytes());
    let mut output = [0u8; 32];
    output.copy_from_slice(&digest);

    output
}

/// Hashes normalized comment text, for duplicate detection.
pub fn hash_body(body: &str) -> Vec<u8> {
    Sha256::digest(body.as_bytes()).to_vec()
}

/// Derives a pseudonymous, per-deployment identifier for a client address.
///
/// Keyed with a server-held pepper so the output cannot be reversed by hashing the IPv4 space, and
/// so it is useless if lifted from a database backup without the pepper.
pub fn hash_ip(pepper: &str, ip: &str) -> Vec<u8> {
    let mut mac =
        HmacSha256::new_from_slice(pepper.as_bytes()).expect("hmac-sha256 accepts any key length");
    mac.update(ip.as_bytes());

    mac.finalize().into_bytes().to_vec()
}

/// Renders the leading bytes of a hash as hex, for moderator-facing correlation of a burst.
///
/// This is shown in the moderation queue so bursts from one source are recognizable. It is never
/// reversible to an address, and the full hash is never exposed.
pub fn short_hex(bytes: &[u8], length: usize) -> String {
    use std::fmt::Write;

    let mut encoded = String::with_capacity(length * 2);
    for byte in bytes.iter().take(length) {
        let _ = write!(encoded, "{byte:02x}");
    }

    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_unique_and_url_safe() {
        let first = generate_token();
        let second = generate_token();

        assert_ne!(first, second);
        assert!(!first.contains('+') && !first.contains('/') && !first.contains('='));
        assert!(first.len() >= 42, "32 bytes of base64url is 43 characters");
    }

    #[test]
    fn token_hashing_is_stable_and_distinct() {
        let token = generate_token();

        assert_eq!(hash_token(&token), hash_token(&token));
        assert_ne!(hash_token(&token), hash_token(&generate_token()));
    }

    #[test]
    fn ip_hashing_depends_on_the_pepper() {
        let first = hash_ip("pepper-one-pepper-one-pepper-one!", "203.0.113.9");
        let second = hash_ip("pepper-two-pepper-two-pepper-two!", "203.0.113.9");

        assert_ne!(first, second, "a rotated pepper must not reproduce hashes");
        assert_eq!(
            first,
            hash_ip("pepper-one-pepper-one-pepper-one!", "203.0.113.9")
        );
    }

    #[test]
    fn short_hex_truncates() {
        let bytes = vec![0xab, 0xcd, 0xef, 0x01];

        assert_eq!(short_hex(&bytes, 2), "abcd");
        assert_eq!(short_hex(&bytes, 99), "abcdef01");
    }
}
