use std::{env, fmt::Write, time::Duration};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Client, Url};
use time::OffsetDateTime;
use tokio::task::JoinHandle;
use web_push::{ContentEncoding, SubscriptionInfo, VapidSignatureBuilder, WebPushMessageBuilder};

use crate::{
    db::reply_notifications::{self as db, Delivery, DeliveryContent},
    error::AppError,
    state::AppState,
};

#[derive(Clone)]
pub struct PushConfig {
    private_key: String,
    pub public_key: String,
    subject: String,
}

impl std::fmt::Debug for PushConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PushConfig")
            .field("public_key", &self.public_key)
            .finish_non_exhaustive()
    }
}

impl PushConfig {
    pub fn from_env() -> Result<Option<Self>, AppError> {
        let Some(key) = env::var("WEB_PUSH_PRIVATE_KEY")
            .ok()
            .filter(|key| !key.trim().is_empty())
        else {
            return Ok(None);
        };
        let subject =
            env::var("WEB_PUSH_SUBJECT").unwrap_or_else(|_| "https://greeklish.gr/".to_owned());
        Self::from_values(key, subject).map(Some)
    }

    pub(crate) fn from_values(key: String, subject: String) -> Result<Self, AppError> {
        let url = Url::parse(&subject).map_err(|_| {
            AppError::config("WEB_PUSH_SUBJECT must be an HTTPS or mailto contact URI")
        })?;
        if !matches!(url.scheme(), "https" | "mailto")
            || (url.scheme() == "https" && url.host_str().is_none())
        {
            return Err(AppError::config(
                "WEB_PUSH_SUBJECT must be an HTTPS or mailto contact URI",
            ));
        }
        let builder = VapidSignatureBuilder::from_base64_no_sub(key.trim())
            .map_err(|_| AppError::config("WEB_PUSH_PRIVATE_KEY must be a valid URL-safe base64 P-256 private key without padding"))?;
        Ok(Self {
            private_key: key.trim().to_owned(),
            public_key: URL_SAFE_NO_PAD.encode(builder.get_public_key()),
            subject,
        })
    }
}

/// Only browser push services can receive server requests. Credentials, alternate ports,
/// redirects and arbitrary user-supplied hosts are never followed.
fn validate_endpoint(endpoint: &str) -> Result<(), AppError> {
    let invalid = || AppError::bad_request("Μη έγκυρη διεύθυνση υπηρεσίας ειδοποιήσεων.");
    if endpoint.len() > 4096 {
        return Err(invalid());
    }
    let url = Url::parse(endpoint).map_err(|_| invalid())?;
    let host = url.host_str().unwrap_or_default();
    let allowed = matches!(
        host,
        "fcm.googleapis.com" | "android.googleapis.com" | "web.push.apple.com"
    ) || host.ends_with(".push.apple.com")
        || host.ends_with(".push.services.mozilla.com")
        || host.ends_with(".notify.windows.com");
    if !allowed
        || url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(())
}

pub fn validate_subscription(endpoint: &str, p256dh: &str, auth: &str) -> Result<(), AppError> {
    validate_endpoint(endpoint)?;
    let invalid = || AppError::bad_request("Μη έγκυρα κλειδιά συνδρομής ειδοποιήσεων.");
    let public = URL_SAFE_NO_PAD.decode(p256dh).map_err(|_| invalid())?;
    if public.len() != 65
        || public[0] != 4
        || URL_SAFE_NO_PAD.decode(auth).map_err(|_| invalid())?.len() != 16
    {
        return Err(invalid());
    }
    // Validate the EC point too, before saving a subscription that could never be encrypted.
    let subscription = SubscriptionInfo::new(endpoint, p256dh, auth);
    let mut message = WebPushMessageBuilder::new(&subscription);
    message.set_payload(ContentEncoding::Aes128Gcm, b"validation");
    message.build().map_err(|_| invalid())?;
    Ok(())
}

/// The UI's fragment prefix, literal for the same reason the segments below are: a reply link that
/// survives a copy-paste out of the notification reads as words rather than escapes.
const COMMENTS_HASH_PREFIX: &str = "σχόλια";

/// Percent-encodes one fragment segment, mirroring `commentHash` in the UI: letters and digits of
/// any script stay literal, everything else is escaped per UTF-8 byte. That still covers the `/`
/// separator, ASCII punctuation, and the invisible characters — bidi overrides, zero-width joiners,
/// non-ASCII spaces — that would make a fragment ambiguous or let it misrepresent its target.
///
/// The one divergence from the UI is combining marks, which are escaped here and literal there;
/// both forms decode to the same text, and precomposed Greek and Cyrillic are unaffected.
fn encode_fragment_part(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());

    for character in value.chars() {
        let literal = if character.is_ascii() {
            character.is_ascii_alphanumeric() || "-_.~".contains(character)
        } else {
            character.is_alphanumeric()
        };

        if literal {
            encoded.push(character);
        } else {
            let mut buffer = [0u8; 4];
            for byte in character.encode_utf8(&mut buffer).as_bytes() {
                let _ = write!(encoded, "%{byte:02X}");
            }
        }
    }

    encoded
}

fn request(
    config: &PushConfig,
    client: &Client,
    delivery: &Delivery,
    content: &DeliveryContent,
) -> Result<reqwest::RequestBuilder, web_push::WebPushError> {
    let subscription = SubscriptionInfo::new(&content.endpoint, &content.p256dh, &content.auth);
    let mut signature = VapidSignatureBuilder::from_base64(&config.private_key, &subscription)?;
    signature.add_claim("sub", config.subject.as_str());
    let payload = serde_json::json!({
        "id": delivery.event_id.to_string(),
        "title": "Νέα απάντηση στο Greeklish.gr",
        "body": "Κάποιος απάντησε σε σχόλιό σου.",
        "url": format!("/#{COMMENTS_HASH_PREFIX}/{}/{}/{}", encode_fragment_part(&content.topic), encode_fragment_part(&content.external_id), content.reply_id),
    }).to_string();
    let mut builder = WebPushMessageBuilder::new(&subscription);
    builder.set_vapid_signature(signature.build()?);
    builder.set_payload(ContentEncoding::Aes128Gcm, payload.as_bytes());
    builder.set_ttl(86400);
    builder.set_topic(delivery.event_id.simple().to_string());
    let message = web_push::request_builder::build_request::<bytes::Bytes>(builder.build()?);
    let (parts, body) = message.into_parts();
    let mut request = client.post(parts.uri.to_string());
    for (name, value) in &parts.headers {
        request = request.header(name.as_str(), value.as_bytes());
    }
    Ok(request.body(body))
}

fn retry_delay(attempts: i32, retry_after: Option<u64>) -> Option<time::Duration> {
    if attempts >= 8 {
        return None;
    }
    let seconds = 60 * 2u64.pow(attempts.clamp(1, 7) as u32 - 1);
    Some(time::Duration::seconds(
        seconds.max(retry_after.unwrap_or(0)).min(3600) as i64,
    ))
}

async fn deliver(
    state: &AppState,
    config: &PushConfig,
    client: &Client,
    delivery: Delivery,
) -> Result<(), AppError> {
    let now = OffsetDateTime::now_utc();
    let Some(content) = db::delivery_content(state.db_pool(), &delivery, now).await? else {
        return db::finish_delivery(state.db_pool(), &delivery, "suppressed", now, None).await;
    };
    // Revalidate stored endpoints as well, so future imports cannot become an SSRF surface.
    if validate_endpoint(&content.endpoint).is_err() {
        return db::finish_delivery(state.db_pool(), &delivery, "invalid_endpoint", now, None)
            .await;
    }
    let request = match request(config, client, &delivery, &content) {
        Ok(request) => request,
        Err(_) => {
            return db::finish_delivery(state.db_pool(), &delivery, "invalid_keys", now, None)
                .await;
        }
    };
    let (outcome, retry) = match request.send().await {
        Ok(response) if response.status().is_success() => ("delivered", None),
        Ok(response) if matches!(response.status().as_u16(), 404 | 410) => {
            return db::expire_subscription(state.db_pool(), delivery.subscription_id).await;
        }
        Ok(response)
            if response.status().as_u16() == 429 || response.status().is_server_error() =>
        {
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok());
            ("service_retry", retry_delay(delivery.attempts, retry_after))
        }
        Ok(_) => ("service_rejected", None),
        Err(_) => ("network_retry", retry_delay(delivery.attempts, None)),
    };
    // Do not log endpoint capability URLs, key material or provider response bodies.
    db::finish_delivery(
        state.db_pool(),
        &delivery,
        outcome,
        OffsetDateTime::now_utc(),
        retry.map(|delay| OffsetDateTime::now_utc() + delay),
    )
    .await
}

pub fn spawn(state: AppState) -> JoinHandle<()> {
    tokio::spawn(async move {
        let Some(config) = state.config().push.clone() else {
            return;
        };
        let client = match Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .build()
        {
            Ok(client) => client,
            Err(_) => {
                tracing::error!("could not initialize Web Push HTTP client");
                return;
            }
        };
        let shutdown = state.shutdown_token();
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => break,
                _ = interval.tick() => {}
            }
            for _ in 0..25 {
                if shutdown.is_cancelled() {
                    break;
                }
                let delivery =
                    match db::claim_delivery(state.db_pool(), OffsetDateTime::now_utc()).await {
                        Ok(Some(delivery)) => delivery,
                        Ok(None) => break,
                        Err(error) => {
                            tracing::error!(error = %error, "failed to claim reply notification");
                            break;
                        }
                    };
                if let Err(error) = deliver(&state, &config, &client, delivery).await {
                    tracing::error!(error = %error, "failed to persist reply notification outcome");
                    break;
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricts_push_endpoints_to_browser_services() {
        for valid in [
            "https://fcm.googleapis.com/fcm/send/token",
            "https://updates.push.services.mozilla.com/wpush/v2/token",
            "https://web.push.apple.com/token",
            "https://region.push.apple.com/token",
            "https://wns.notify.windows.com/token",
        ] {
            assert!(validate_endpoint(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "http://fcm.googleapis.com/token",
            "https://127.0.0.1/token",
            "https://example.test/token",
            "https://fcm.googleapis.com.evil.test/token",
            "https://fcm.googleapis.com:444/token",
            "https://user@fcm.googleapis.com/token",
            "https://web.push.apple.com/token#fragment",
        ] {
            assert!(validate_endpoint(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn validates_key_material_and_keeps_it_out_of_debug() {
        let config = PushConfig::from_values(
            "IQ9Ur0ykXoHS9gzfYX0aBjy9lvdrjx_PFUXmie9YRcY".to_owned(),
            "https://greeklish.gr/".to_owned(),
        )
        .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.decode(&config.public_key).unwrap().len(),
            65
        );
        assert!(!format!("{config:?}").contains(&config.private_key));
        assert!(PushConfig::from_values("bad-key".into(), "https://greeklish.gr".into()).is_err());
        assert!(
            validate_subscription("https://fcm.googleapis.com/token", "bad-key", "bad-auth")
                .is_err()
        );
    }

    #[test]
    fn retry_backoff_and_comment_links_are_bounded() {
        assert_eq!(retry_delay(1, None), Some(time::Duration::seconds(60)));
        assert_eq!(
            retry_delay(2, Some(600)),
            Some(time::Duration::seconds(600))
        );
        assert_eq!(
            retry_delay(7, Some(u64::MAX)),
            Some(time::Duration::hours(1))
        );
        assert_eq!(retry_delay(8, None), None);
        assert_eq!(encode_fragment_part("a/b #?"), "a%2Fb%20%23%3F");
        // Letters and digits of any script survive; the separator, punctuation and the invisible
        // characters do not.
        assert_eq!(encode_fragment_part("άρθρο-7"), "άρθρο-7");
        assert_eq!(encode_fragment_part("новости"), "новости");
        assert_eq!(
            encode_fragment_part("Ασφάλεια\u{202e}gnp"),
            "Ασφάλεια%E2%80%AEgnp"
        );
        assert_eq!(
            encode_fragment_part("a\u{200b}b\u{a0}c"),
            "a%E2%80%8Bb%C2%A0c"
        );
    }

    #[test]
    fn constructs_encrypted_vapid_request_without_plaintext_comment_content() {
        let config = PushConfig::from_values(
            "IQ9Ur0ykXoHS9gzfYX0aBjy9lvdrjx_PFUXmie9YRcY".to_owned(),
            "https://greeklish.gr/".to_owned(),
        )
        .unwrap();
        let (key, auth) = ece::generate_keypair_and_auth_secret().unwrap();
        let components = key.raw_components().unwrap();
        let content = DeliveryContent {
            endpoint: "https://fcm.googleapis.com/fcm/send/test-only".into(),
            p256dh: URL_SAFE_NO_PAD.encode(components.public_key()),
            auth: URL_SAFE_NO_PAD.encode(auth),
            topic: "test".into(),
            external_id: "one".into(),
            reply_id: uuid::Uuid::now_v7(),
        };
        validate_subscription(&content.endpoint, &content.p256dh, &content.auth).unwrap();
        let delivery = Delivery {
            event_id: uuid::Uuid::now_v7(),
            subscription_id: uuid::Uuid::now_v7(),
            attempts: 1,
            lease_until: OffsetDateTime::now_utc(),
        };
        let request = request(&config, &Client::new(), &delivery, &content)
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(request.headers()["content-encoding"], "aes128gcm");
        assert_eq!(request.headers()["ttl"], "86400");
        assert_eq!(
            request.headers()["topic"],
            delivery.event_id.simple().to_string()
        );
        assert!(
            request.headers()["authorization"]
                .to_str()
                .unwrap()
                .starts_with("vapid t=")
        );
        let body = request.body().unwrap().as_bytes().unwrap();
        assert!(body.len() > 100);
        let decrypted = ece::decrypt(&components, &auth, body).unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&decrypted).unwrap();
        assert_eq!(payload["id"], delivery.event_id.to_string());
        assert_eq!(payload["body"], "Κάποιος απάντησε σε σχόλιό σου.");
        assert_eq!(
            payload["url"],
            format!("/#{COMMENTS_HASH_PREFIX}/test/one/{}", content.reply_id)
        );
        assert_ne!(body, decrypted);
    }
}
