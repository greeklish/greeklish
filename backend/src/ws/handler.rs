use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Instant;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{Mutex, mpsc};
use tracing::{info, warn};
use uuid::Uuid;

use crate::db::{crawl_snapshots, topic_history, topics};
use crate::error::AppError;
use crate::net;
use crate::state::{AppState, ConnectionCommand, MODERATION_CHANNEL};
use crate::ticker;
use crate::ws::messages::{ClientMessage, HistoryChangeType, ServerMessage};

const MAX_WS_MESSAGE_SIZE: usize = 64 * 1024;
const MAX_TOPICS_PER_MESSAGE: usize = 20;
const CRAWL_SNAPSHOT_HISTORY_DAYS: i64 = 2;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    let client_ip = net::resolve_client_ip(&headers).unwrap_or_else(|| peer_addr.ip());

    // `/ws` is same-origin, so the browser sends the moderator cookie on the upgrade request.
    // Reading it here is what keeps the session token `HttpOnly`: it never has to be echoed back
    // through a `ClientMessage` field where JavaScript could see it.
    let is_moderator = net::cookie_value(&headers, crate::api::moderation::SESSION_COOKIE)
        .is_some_and(|token| state.touch_moderator_session(&token));

    ws.max_message_size(MAX_WS_MESSAGE_SIZE)
        .on_upgrade(move |socket| handle_socket(state, socket, client_ip, is_moderator))
}

async fn handle_socket(state: AppState, socket: WebSocket, client_ip: IpAddr, is_moderator: bool) {
    let connection_id = Uuid::now_v7();
    let (mut writer, mut reader) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<ConnectionCommand>();

    state.register_connection(connection_id, client_ip, tx.clone());
    info!(connection_id = %connection_id, client_ip = %client_ip, "websocket connection opened");

    let last_seen = Arc::new(Mutex::new(Instant::now()));
    let shutdown_token = state.shutdown_token();

    let writer_handle = tokio::spawn(async move {
        while let Some(command) = rx.recv().await {
            let send_result = match command {
                ConnectionCommand::Message(message) => match serialize_message(message) {
                    Ok(payload) => writer
                        .send(Message::Text(payload.into()))
                        .await
                        .map_err(|error| AppError::WebSocket(error.to_string())),
                    Err(error) => Err(error),
                },
                ConnectionCommand::Ping => writer
                    .send(Message::Ping(Bytes::from_static(b"heartbeat")))
                    .await
                    .map_err(|error| AppError::WebSocket(error.to_string())),
                ConnectionCommand::Close { code, reason } => writer
                    .send(Message::Close(Some(CloseFrame {
                        code: code.into(),
                        reason: reason.into(),
                    })))
                    .await
                    .map_err(|error| AppError::WebSocket(error.to_string())),
            };

            if let Err(error) = send_result {
                warn!(error = %error, "websocket send failed");
                break;
            }
        }
    });

    let heartbeat_tx = tx.clone();
    let heartbeat_state = state.clone();
    let heartbeat_last_seen = Arc::clone(&last_seen);
    let heartbeat_shutdown = shutdown_token.clone();
    let heartbeat_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(heartbeat_state.config().ws_ping_interval);
        loop {
            tokio::select! {
                _ = heartbeat_shutdown.cancelled() => break,
                _ = interval.tick() => {
                    let elapsed = heartbeat_last_seen.lock().await.elapsed();
                    if elapsed > heartbeat_state.config().ws_timeout {
                        let _ = heartbeat_tx.send(ConnectionCommand::Close {
                            code: 1008,
                            reason: "websocket heartbeat timeout".to_owned(),
                        });
                        break;
                    }

                    if heartbeat_tx.send(ConnectionCommand::Ping).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut subscriptions = HashSet::new();

    loop {
        tokio::select! {
            _ = shutdown_token.cancelled() => break,
            message = reader.next() => {
                match message {
                    Some(Ok(frame)) => {
                        let continue_loop = match handle_frame(
                            &state,
                            &tx,
                            &mut subscriptions,
                            connection_id,
                            frame,
                            &last_seen,
                            is_moderator,
                        ).await {
                            Ok(continue_loop) => continue_loop,
                            Err(error) => {
                                let _ = tx.send(ConnectionCommand::Message(ServerMessage::Error {
                                    code: "invalid_message".to_owned(),
                                    message: error.to_string(),
                                }));
                                true
                            }
                        };

                        if !continue_loop {
                            break;
                        }
                    }
                    Some(Err(error)) => {
                        warn!(connection_id = %connection_id, error = %error, "websocket receive failed");
                        break;
                    }
                    None => break,
                }
            }
        }
    }

    heartbeat_handle.abort();
    state.unsubscribe_from_topics(&subscriptions, connection_id);
    state.remove_connection(connection_id);
    let _ = tx.send(ConnectionCommand::Close {
        code: 1000,
        reason: "connection closed".to_owned(),
    });
    drop(tx);
    let _ = writer_handle.await;

    info!(connection_id = %connection_id, client_ip = %client_ip, "websocket connection closed");
}

async fn handle_frame(
    state: &AppState,
    tx: &mpsc::UnboundedSender<ConnectionCommand>,
    subscriptions: &mut HashSet<String>,
    connection_id: Uuid,
    frame: Message,
    last_seen: &Arc<Mutex<Instant>>,
    is_moderator: bool,
) -> Result<bool, AppError> {
    match frame {
        Message::Text(text) => {
            *last_seen.lock().await = Instant::now();
            let message = serde_json::from_str::<ClientMessage>(&text)?;
            handle_client_message(
                state,
                tx,
                subscriptions,
                connection_id,
                message,
                is_moderator,
            )
            .await?;
            Ok(true)
        }
        Message::Pong(_) | Message::Ping(_) => {
            *last_seen.lock().await = Instant::now();
            Ok(true)
        }
        Message::Close(_) => Ok(false),
        Message::Binary(_) => {
            let _ = tx.send(ConnectionCommand::Message(ServerMessage::Error {
                code: "unsupported_frame".to_owned(),
                message: "binary websocket frames are not supported".to_owned(),
            }));
            Ok(true)
        }
    }
}

async fn handle_client_message(
    state: &AppState,
    tx: &mpsc::UnboundedSender<ConnectionCommand>,
    subscriptions: &mut HashSet<String>,
    connection_id: Uuid,
    message: ClientMessage,
    is_moderator: bool,
) -> Result<(), AppError> {
    match message {
        ClientMessage::ClientHello { app_version } => {
            send_client_reload_if_needed(state, tx, app_version);
        }
        ClientMessage::Subscribe { topics } => {
            if !validate_topic_batch(tx, &topics, "invalid_subscribe_request") {
                return Ok(());
            }

            for topic in topics {
                if !is_valid_slug(&topic) {
                    send_error(
                        tx,
                        "invalid_topic_slug",
                        "topic slugs must be lowercase ASCII letters, digits, or hyphens",
                    );
                    continue;
                }

                state.subscribe(&topic, connection_id);
                subscriptions.insert(topic.clone());

                match ticker::load_snapshot(state, &topic).await? {
                    Some(snapshot) => {
                        let _ = tx.send(ConnectionCommand::Message(snapshot.as_server_message()));
                    }
                    None => {
                        send_error(
                            tx,
                            "unknown_topic",
                            &format!("unknown topic slug `{topic}`"),
                        );
                        state.unsubscribe(&topic, connection_id);
                        subscriptions.remove(&topic);
                    }
                }
            }
        }
        ClientMessage::Unsubscribe { topics } => {
            if !validate_topic_batch(tx, &topics, "invalid_unsubscribe_request") {
                return Ok(());
            }

            for topic in topics {
                if !is_valid_slug(&topic) {
                    send_error(
                        tx,
                        "invalid_topic_slug",
                        "topic slugs must be lowercase ASCII letters, digits, or hyphens",
                    );
                    continue;
                }

                state.unsubscribe(&topic, connection_id);
                subscriptions.remove(&topic);
            }
        }
        ClientMessage::TopicHistory {
            topic,
            lookback_hours,
            change_types,
            limit,
            include_current_items,
        } => {
            if !is_valid_slug(&topic) {
                send_error(
                    tx,
                    "invalid_topic_slug",
                    "topic slugs must be lowercase ASCII letters, digits, or hyphens",
                );
                return Ok(());
            }

            if lookback_hours == 0 || lookback_hours > 24 {
                send_error(
                    tx,
                    "invalid_history_request",
                    "lookback_hours must be between 1 and 24",
                );
                return Ok(());
            }

            let change_types: HashSet<HistoryChangeType> = change_types.into_iter().collect();
            if change_types.is_empty() {
                send_error(
                    tx,
                    "invalid_history_request",
                    "change_types must contain at least one change class",
                );
                return Ok(());
            }

            let limit = match topic_history::normalize_history_limit(limit) {
                Ok(limit) => limit,
                Err(error) => {
                    send_error(tx, "invalid_history_request", &error.to_string());
                    return Ok(());
                }
            };

            match ticker::load_snapshot(state, &topic).await? {
                Some(snapshot) => {
                    let events = topic_history::fetch_topic_history_events(
                        state.db_pool(),
                        snapshot.topic_id,
                        &change_types,
                        lookback_hours,
                        limit,
                    )
                    .await?;

                    let _ = tx.send(ConnectionCommand::Message(ServerMessage::TopicHistory {
                        topic,
                        display_name: snapshot.topic_display_name.clone(),
                        strategy: snapshot.strategy,
                        current_items: include_current_items
                            .unwrap_or(false)
                            .then(|| snapshot.payload_items()),
                        events,
                        lookback_hours,
                        as_of: crate::ticker::timestamp_millis(),
                    }));
                }
                None => {
                    send_error(
                        tx,
                        "unknown_topic",
                        &format!("unknown topic slug `{topic}`"),
                    );
                }
            }
        }
        ClientMessage::CrawlSnapshots { topic, since_ms } => {
            if !is_valid_slug(&topic) {
                send_error(
                    tx,
                    "invalid_topic_slug",
                    "topic slugs must be lowercase ASCII letters, digits, or hyphens",
                );
                return Ok(());
            }

            let since = clamp_crawl_snapshot_since(offset_datetime_from_millis(since_ms)?);

            let Some(topic_record) = topics::get_topic_by_slug(state.db_pool(), &topic).await?
            else {
                send_error(
                    tx,
                    "unknown_topic",
                    &format!("unknown topic slug `{topic}`"),
                );
                return Ok(());
            };
            let snapshots =
                crawl_snapshots::fetch_crawl_snapshots_since(state.db_pool(), &topic, since)
                    .await?;
            let _ = tx.send(ConnectionCommand::Message(ServerMessage::CrawlSnapshots {
                topic,
                display_name: topic_record.display_name,
                snapshots,
                as_of: crate::ticker::timestamp_millis(),
            }));
        }
        ClientMessage::LatestCrawlSnapshot { topic } => {
            if !is_valid_slug(&topic) {
                send_error(
                    tx,
                    "invalid_topic_slug",
                    "topic slugs must be lowercase ASCII letters, digits, or hyphens",
                );
                return Ok(());
            }

            let Some(topic_record) = topics::get_topic_by_slug(state.db_pool(), &topic).await?
            else {
                send_error(
                    tx,
                    "unknown_topic",
                    &format!("unknown topic slug `{topic}`"),
                );
                return Ok(());
            };

            match crawl_snapshots::fetch_latest_crawl_snapshot(state.db_pool(), &topic).await? {
                Some(snapshot) => {
                    let _ = tx.send(ConnectionCommand::Message(ServerMessage::CrawlSnapshot {
                        topic,
                        display_name: topic_record.display_name,
                        snapshot,
                    }));
                }
                None => {
                    send_error(
                        tx,
                        "no_crawl_snapshots",
                        &format!("topic `{topic}` has no crawl snapshots"),
                    );
                }
            }
        }
        ClientMessage::SubscribeModeration => {
            if !is_moderator {
                send_error(
                    tx,
                    "unauthorized",
                    "moderator session required for this subscription",
                );
                return Ok(());
            }

            state.subscribe(MODERATION_CHANNEL, connection_id);
            subscriptions.insert(MODERATION_CHANNEL.to_owned());

            let pending = crate::db::guest_comments::status_counts(state.db_pool())
                .await
                .map(|counts| counts.pending)
                .unwrap_or_default();

            let _ = tx.send(ConnectionCommand::Message(
                ServerMessage::ModerationQueueChanged {
                    pending: u32::try_from(pending).unwrap_or(u32::MAX),
                    as_of: ticker::timestamp_millis(),
                },
            ));
        }
        ClientMessage::UnsubscribeModeration => {
            state.unsubscribe(MODERATION_CHANNEL, connection_id);
            subscriptions.remove(MODERATION_CHANNEL);
        }
        ClientMessage::ConnectionStats => {
            let _ = tx.send(ConnectionCommand::Message(ServerMessage::Error {
                code: "forbidden".to_owned(),
                message: "Connection statistics require the authenticated moderator API."
                    .to_owned(),
            }));
        }
    }

    Ok(())
}

fn send_client_reload_if_needed(
    state: &AppState,
    tx: &mpsc::UnboundedSender<ConnectionCommand>,
    app_version: Option<String>,
) {
    let Some(required_version) = &state.config().required_client_version else {
        return;
    };

    let current_version = app_version
        .map(|version| version.trim().to_owned())
        .filter(|version| !version.is_empty());

    if current_version.as_deref() == Some(required_version.as_str()) {
        return;
    }

    let _ = tx.send(ConnectionCommand::Message(ServerMessage::ClientReload {
        current_version,
        required_version: required_version.clone(),
        reason: "client_version_mismatch".to_owned(),
    }));
}

fn offset_datetime_from_millis(value: u64) -> Result<time::OffsetDateTime, AppError> {
    let seconds =
        i64::try_from(value / 1000).map_err(|_| AppError::bad_request("since_ms is too large"))?;
    let milliseconds =
        i64::try_from(value % 1000).map_err(|_| AppError::bad_request("since_ms is too large"))?;

    time::OffsetDateTime::from_unix_timestamp(seconds)
        .map(|timestamp| timestamp + time::Duration::milliseconds(milliseconds))
        .map_err(|error| AppError::bad_request(format!("invalid since_ms: {error}")))
}

fn serialize_message(message: ServerMessage) -> Result<String, AppError> {
    serde_json::to_string(&message).map_err(AppError::from)
}

fn send_error(tx: &mpsc::UnboundedSender<ConnectionCommand>, code: &str, message: &str) {
    let _ = tx.send(ConnectionCommand::Message(ServerMessage::Error {
        code: code.to_owned(),
        message: message.to_owned(),
    }));
}

fn validate_topic_batch(
    tx: &mpsc::UnboundedSender<ConnectionCommand>,
    topics: &[String],
    error_code: &str,
) -> bool {
    if topics.len() <= MAX_TOPICS_PER_MESSAGE {
        return true;
    }

    send_error(
        tx,
        error_code,
        &format!("topic list must contain at most {MAX_TOPICS_PER_MESSAGE} topics"),
    );
    false
}

fn clamp_crawl_snapshot_since(since: time::OffsetDateTime) -> time::OffsetDateTime {
    let minimum_since =
        time::OffsetDateTime::now_utc() - time::Duration::days(CRAWL_SNAPSHOT_HISTORY_DAYS);
    since.max(minimum_since)
}

fn is_valid_slug(input: &str) -> bool {
    !input.is_empty()
        && input
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[cfg(test)]
mod private_statistics_tests {
    use super::*;
    #[tokio::test]
    async fn suggestion_regression_websockets_never_return_connection_statistics() {
        let state = crate::comment_regression_tests::state(
            sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://localhost/unused")
                .unwrap(),
        );
        for is_moderator in [false, true] {
            let (tx, mut rx) = mpsc::unbounded_channel();
            handle_client_message(
                &state,
                &tx,
                &mut HashSet::new(),
                Uuid::now_v7(),
                ClientMessage::ConnectionStats,
                is_moderator,
            )
            .await
            .unwrap();
            assert!(
                matches!(rx.recv().await, Some(ConnectionCommand::Message(ServerMessage::Error { code, .. })) if code == "forbidden")
            );
        }
    }
}
