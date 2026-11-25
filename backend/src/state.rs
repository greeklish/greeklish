use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use dashmap::{DashMap, DashSet};
use sqlx::PgPool;
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::config::{CommentsConfig, Config};
use crate::crypto;
use crate::error::AppError;
use crate::ratelimit::{LockoutState, RateDecision, RateKey, RateRule};
use crate::ws::messages::{RankedItem, ServerMessage};

/// Registry key that moderator connections subscribe to.
///
/// Deliberately not a valid topic slug (slugs are lowercase ASCII, digits and hyphens only), so it
/// can never collide with a real topic arriving from a client.
pub const MODERATION_CHANNEL: &str = "__moderation";

/// An authenticated moderator session, held in memory only.
#[derive(Debug, Clone, Copy)]
pub struct ModeratorSession {
    pub created_at: Instant,
    pub last_seen_at: Instant,
}

/// Counts what one sweeper pass reclaimed, for debug logging.
#[derive(Debug, Default, Clone, Copy)]
pub struct PruneReport {
    pub rate_hits_dropped: usize,
    pub captchas_dropped: usize,
    pub sessions_dropped: usize,
    pub lockouts_dropped: usize,
}

impl PruneReport {
    pub fn is_empty(&self) -> bool {
        self.rate_hits_dropped == 0
            && self.captchas_dropped == 0
            && self.sessions_dropped == 0
            && self.lockouts_dropped == 0
    }
}

/// Longest window any rate rule uses, and therefore how long a hit can stay relevant.
const RATE_WINDOW_MAX_AGE: Duration = Duration::from_secs(86_400);

/// Hard ceiling on one moderator session, regardless of activity.
const MAX_MODERATOR_SESSION_AGE: Duration = Duration::from_secs(7 * 86_400);

#[derive(Debug, Clone)]
pub enum ConnectionCommand {
    Message(ServerMessage),
    Ping,
    Close { code: u16, reason: String },
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

/// A reserved posting slot is refunded on every early return, including cancelled requests.
pub struct CommentRatePermit {
    state: AppState,
    key: RateKey,
    hit: Instant,
    committed: bool,
}

/// A challenge is reserved atomically across every public submission endpoint.
pub struct CaptchaPermit {
    state: AppState,
    challenge: String,
    reserved_at: Instant,
    committed: bool,
}

impl CaptchaPermit {
    pub fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for CaptchaPermit {
    fn drop(&mut self) {
        if !self.committed {
            self.state
                .inner
                .spent_captchas
                .remove_if(&self.challenge, |_, at| *at == self.reserved_at);
        }
    }
}

impl CommentRatePermit {
    pub fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for CommentRatePermit {
    fn drop(&mut self) {
        if !self.committed {
            if let Some(mut hits) = self.state.inner.rate_windows.get_mut(&self.key) {
                if let Some(index) = hits.iter().position(|hit| *hit == self.hit) {
                    hits.remove(index);
                }
            }
        }
    }
}

struct AppStateInner {
    config: Config,
    db_pool: PgPool,
    started_at: Instant,
    connected_clients: AtomicUsize,
    connections: DashMap<Uuid, mpsc::UnboundedSender<ConnectionCommand>>,
    connection_client_ips: DashMap<Uuid, IpAddr>,
    topic_subscribers: DashMap<String, Arc<DashSet<Uuid>>>,
    last_snapshots: DashMap<String, Vec<RankedItem>>,
    pending_reranks: DashSet<String>,
    pending_ingest_reranks: DashSet<String>,
    rerank_notify: Arc<Notify>,
    shutdown: CancellationToken,
    rate_windows: DashMap<RateKey, Vec<Instant>>,
    spent_captchas: DashMap<String, Instant>,
    moderator_sessions: DashMap<[u8; 32], ModeratorSession>,
    moderator_login_lockouts: DashMap<String, LockoutState>,
}

impl AppState {
    pub fn new(config: Config, db_pool: PgPool) -> Self {
        Self {
            inner: Arc::new(AppStateInner {
                config,
                db_pool,
                started_at: Instant::now(),
                connected_clients: AtomicUsize::new(0),
                connections: DashMap::new(),
                connection_client_ips: DashMap::new(),
                topic_subscribers: DashMap::new(),
                last_snapshots: DashMap::new(),
                pending_reranks: DashSet::new(),
                pending_ingest_reranks: DashSet::new(),
                rerank_notify: Arc::new(Notify::new()),
                shutdown: CancellationToken::new(),
                rate_windows: DashMap::new(),
                spent_captchas: DashMap::new(),
                moderator_sessions: DashMap::new(),
                moderator_login_lockouts: DashMap::new(),
            }),
        }
    }

    pub fn config(&self) -> &Config {
        &self.inner.config
    }

    pub fn db_pool(&self) -> &PgPool {
        &self.inner.db_pool
    }

    pub fn uptime(&self) -> Duration {
        self.inner.started_at.elapsed()
    }

    pub fn connected_clients(&self) -> usize {
        self.inner.connected_clients.load(Ordering::Relaxed)
    }

    pub fn connected_client_ips(&self) -> usize {
        self.inner
            .connection_client_ips
            .iter()
            .map(|entry| *entry.value())
            .collect::<HashSet<_>>()
            .len()
    }

    pub fn shutdown_token(&self) -> CancellationToken {
        self.inner.shutdown.clone()
    }

    pub fn rerank_notifier(&self) -> Arc<Notify> {
        Arc::clone(&self.inner.rerank_notify)
    }

    pub fn register_connection(
        &self,
        connection_id: Uuid,
        client_ip: IpAddr,
        sender: mpsc::UnboundedSender<ConnectionCommand>,
    ) {
        self.inner.connections.insert(connection_id, sender);
        self.inner
            .connection_client_ips
            .insert(connection_id, client_ip);
        self.inner.connected_clients.fetch_add(1, Ordering::Relaxed);
    }

    pub fn remove_connection(&self, connection_id: Uuid) {
        if self.inner.connections.remove(&connection_id).is_some() {
            self.inner.connection_client_ips.remove(&connection_id);
            self.inner.connected_clients.fetch_sub(1, Ordering::Relaxed);
        }
    }

    pub fn subscribe(&self, topic_slug: &str, connection_id: Uuid) {
        let subscribers = self
            .inner
            .topic_subscribers
            .entry(topic_slug.to_owned())
            .or_insert_with(|| Arc::new(DashSet::new()))
            .clone();
        subscribers.insert(connection_id);
    }

    pub fn unsubscribe(&self, topic_slug: &str, connection_id: Uuid) {
        if let Some(subscribers) = self.inner.topic_subscribers.get(topic_slug) {
            subscribers.remove(&connection_id);
            if subscribers.is_empty() {
                drop(subscribers);
                self.inner.topic_subscribers.remove(topic_slug);
            }
        }
    }

    pub fn unsubscribe_from_topics(&self, topics: &HashSet<String>, connection_id: Uuid) {
        for topic in topics {
            self.unsubscribe(topic, connection_id);
        }
    }

    pub fn active_topics(&self) -> Vec<String> {
        self.inner
            .topic_subscribers
            .iter()
            .filter_map(|entry| {
                if entry.value().is_empty() {
                    None
                } else {
                    Some(entry.key().clone())
                }
            })
            .collect()
    }

    pub fn topic_subscriber_count(&self, topic_slug: &str) -> usize {
        self.inner
            .topic_subscribers
            .get(topic_slug)
            .map(|subscribers| subscribers.len())
            .unwrap_or(0)
    }

    pub fn queue_rerank(&self, topic_slug: String) {
        self.inner.pending_reranks.insert(topic_slug);
        self.inner.rerank_notify.notify_one();
    }

    pub fn queue_ingest_rerank(&self, topic_slug: String) {
        self.inner.pending_ingest_reranks.insert(topic_slug);
        self.inner.rerank_notify.notify_one();
    }

    pub fn drain_pending_reranks(&self) -> Vec<String> {
        let topics: Vec<String> = self
            .inner
            .pending_reranks
            .iter()
            .map(|entry| entry.key().clone())
            .collect();

        for topic in &topics {
            self.inner.pending_reranks.remove(topic);
        }

        topics
    }

    pub fn drain_pending_ingest_reranks(&self) -> Vec<String> {
        let topics: Vec<String> = self
            .inner
            .pending_ingest_reranks
            .iter()
            .map(|entry| entry.key().clone())
            .collect();

        for topic in &topics {
            self.inner.pending_ingest_reranks.remove(topic);
        }

        topics
    }

    pub fn last_snapshot(&self, topic_slug: &str) -> Option<Vec<RankedItem>> {
        self.inner
            .last_snapshots
            .get(topic_slug)
            .map(|snapshot| snapshot.clone())
    }

    pub fn store_last_snapshot(&self, topic_slug: &str, items: Vec<RankedItem>) {
        self.inner
            .last_snapshots
            .insert(topic_slug.to_owned(), items);
    }

    pub fn clear_last_snapshot(&self, topic_slug: &str) {
        self.inner.last_snapshots.remove(topic_slug);
    }

    pub fn broadcast(&self, topic_slug: &str, message: ServerMessage) -> usize {
        let Some(subscribers) = self.inner.topic_subscribers.get(topic_slug) else {
            return 0;
        };

        let subscriber_ids: Vec<Uuid> = subscribers.iter().map(|entry| *entry.key()).collect();
        drop(subscribers);

        let mut delivered = 0;
        let mut stale_connections = Vec::new();

        for connection_id in subscriber_ids {
            match self.inner.connections.get(&connection_id) {
                Some(sender) => {
                    if sender
                        .send(ConnectionCommand::Message(message.clone()))
                        .is_ok()
                    {
                        delivered += 1;
                    } else {
                        stale_connections.push(connection_id);
                    }
                }
                None => stale_connections.push(connection_id),
            }
        }

        if !stale_connections.is_empty() {
            for connection_id in stale_connections {
                self.unsubscribe(topic_slug, connection_id);
            }
        }

        delivered
    }

    pub fn comments_config(&self) -> Option<&CommentsConfig> {
        self.inner.config.comments.as_ref()
    }

    /// Returns the comment configuration or a 404, so every comment route degrades cleanly on a
    /// deployment that has not opted into the feature.
    pub fn require_comments_config(&self) -> Result<&CommentsConfig, AppError> {
        self.comments_config()
            .ok_or_else(|| AppError::not_found("comments are not enabled on this deployment"))
    }

    /// Charges one hit against a counter, recording it only when every rule allows it.
    pub fn check_rate(&self, key: RateKey, rules: &[RateRule]) -> RateDecision {
        let mut hits = self.inner.rate_windows.entry(key).or_default();
        let now = Instant::now();

        crate::ratelimit::evaluate(hits.value_mut(), rules, now)
    }

    pub fn reserve_comment_rate(
        &self,
        key: RateKey,
        rules: &[RateRule],
        message: &str,
    ) -> Result<CommentRatePermit, AppError> {
        let mut hits = self.inner.rate_windows.entry(key.clone()).or_default();
        let now = Instant::now();
        match crate::ratelimit::evaluate(hits.value_mut(), rules, now) {
            RateDecision::Allowed => Ok(CommentRatePermit {
                state: self.clone(),
                key,
                hit: now,
                committed: false,
            }),
            RateDecision::Limited { retry_after } => {
                Err(AppError::too_many_requests(message, retry_after))
            }
        }
    }

    /// Call after signature/expiry verification. Failed requests refund their reservation.
    pub fn reserve_captcha(&self, challenge: &str) -> Result<CaptchaPermit, AppError> {
        let reserved_at = Instant::now();
        match self.inner.spent_captchas.entry(challenge.to_owned()) {
            dashmap::mapref::entry::Entry::Occupied(_) => Err(AppError::bad_request(
                "Ο έλεγχος ασφαλείας χρησιμοποιήθηκε ήδη. Δοκίμασε ξανά.",
            )),
            dashmap::mapref::entry::Entry::Vacant(entry) => {
                entry.insert(reserved_at);
                Ok(CaptchaPermit {
                    state: self.clone(),
                    challenge: challenge.to_owned(),
                    reserved_at,
                    committed: false,
                })
            }
        }
    }

    /// Stores a new moderator session and returns the plaintext token for the `Set-Cookie` header.
    pub fn create_moderator_session(&self) -> String {
        let token = crypto::generate_token();
        let now = Instant::now();

        self.inner.moderator_sessions.insert(
            crypto::hash_token(&token),
            ModeratorSession {
                created_at: now,
                last_seen_at: now,
            },
        );

        token
    }

    /// Validates a session token and slides its expiry forward.
    pub fn touch_moderator_session(&self, token: &str) -> bool {
        let Some(config) = self.comments_config() else {
            return false;
        };

        let digest = crypto::hash_token(token);
        let now = Instant::now();

        let Some(mut session) = self.inner.moderator_sessions.get_mut(&digest) else {
            return false;
        };

        let idle_expired = now.duration_since(session.last_seen_at) > config.moderator_session_ttl;
        // An absolute cap as well as the sliding one: continuous activity must not keep one
        // session alive indefinitely.
        let too_old = now.duration_since(session.created_at) > MAX_MODERATOR_SESSION_AGE;

        if idle_expired || too_old {
            drop(session);
            self.inner.moderator_sessions.remove(&digest);
            return false;
        }

        session.last_seen_at = now;

        true
    }

    pub fn revoke_moderator_session(&self, token: &str) {
        self.inner
            .moderator_sessions
            .remove(&crypto::hash_token(token));
    }

    /// How much longer this subject must wait before another login attempt is accepted.
    pub fn moderator_login_lockout(&self, subject: &str) -> Option<Duration> {
        self.inner
            .moderator_login_lockouts
            .get(subject)
            .and_then(|state| state.remaining_lockout(Instant::now()))
    }

    pub fn record_moderator_login_failure(&self, subject: &str) {
        let Some(config) = self.comments_config() else {
            return;
        };

        let now = Instant::now();

        self.inner
            .moderator_login_lockouts
            .entry(subject.to_owned())
            .and_modify(|state| {
                state.record_failure(now, config.login_attempt_limit, config.login_attempt_window)
            })
            .or_insert_with(|| LockoutState::first_failure(now));
    }

    pub fn clear_moderator_login_failures(&self, subject: &str) {
        self.inner.moderator_login_lockouts.remove(subject);
    }

    /// Drops expired entries from every unbounded in-memory map.
    ///
    /// `DashMap` has no TTL or size eviction, so without this the maps grow for the lifetime of the
    /// process. Driven by `sweeper::spawn`.
    pub fn prune_ephemeral_state(&self) -> PruneReport {
        let now = Instant::now();
        let Some(config) = self.comments_config() else {
            return PruneReport::default();
        };

        let mut report = PruneReport::default();

        self.inner.rate_windows.retain(|_, hits| {
            let before = hits.len();
            hits.retain(|hit| now.duration_since(*hit) < RATE_WINDOW_MAX_AGE);
            report.rate_hits_dropped += before - hits.len();

            !hits.is_empty()
        });

        self.inner.spent_captchas.retain(|_, spent_at| {
            let keep = now.duration_since(*spent_at) < config.captcha_ttl;
            if !keep {
                report.captchas_dropped += 1;
            }

            keep
        });

        self.inner.moderator_sessions.retain(|_, session| {
            let keep = now.duration_since(session.last_seen_at) <= config.moderator_session_ttl
                && now.duration_since(session.created_at) <= MAX_MODERATOR_SESSION_AGE;
            if !keep {
                report.sessions_dropped += 1;
            }

            keep
        });

        self.inner.moderator_login_lockouts.retain(|_, state| {
            let keep = !state.is_stale(now, config.login_attempt_window);
            if !keep {
                report.lockouts_dropped += 1;
            }

            keep
        });

        report
    }

    pub fn close_all_connections(&self, reason: &str) {
        for sender in self.inner.connections.iter() {
            let _ = sender.value().send(ConnectionCommand::Close {
                code: 1001,
                reason: reason.to_owned(),
            });
        }
    }

    pub async fn begin_shutdown(&self) {
        if self.inner.shutdown.is_cancelled() {
            return;
        }

        self.inner.shutdown.cancel();
        self.close_all_connections("server shutting down");

        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if self.connected_clients() == 0 {
                break;
            }

            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}
