use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "ranking_strategy", rename_all = "snake_case")]
#[ts(export, export_to = "bindings/ws.ts")]
pub enum RankingStrategy {
    Hot,
    Chronological,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "bindings/ws.ts")]
pub struct RankedItem {
    pub id: String,
    pub title: String,
    pub url: String,
    pub source_slug: String,
    pub external_id: String,
    pub score: f64,
    pub comments_count: Option<i32>,
    pub nsfw: Option<bool>,
    pub rank_position: i32,
    pub published_at: String,
    pub crawled_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "bindings/ws.ts")]
pub struct CrawlSnapshotItem {
    pub external_id: String,
    pub title: String,
    pub url: String,
    pub score: f64,
    pub comments_count: Option<i32>,
    pub nsfw: Option<bool>,
    pub rank_position: i32,
    pub published_at: String,
    pub crawled_at: String,
    #[ts(type = "unknown | null")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "bindings/ws.ts")]
pub struct CrawlSnapshot {
    pub id: String,
    pub crawled_at: String,
    pub items: Vec<CrawlSnapshotItem>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "bindings/ws.ts")]
pub enum HistoryChangeType {
    Ranking,
    Title,
    Url,
    Metadata,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "bindings/ws.ts")]
pub enum HistoryRunTrigger {
    Ticker,
    Manual,
    Ingest,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "bindings/ws.ts")]
pub enum TopicHistoryEntry {
    RankingRun {
        run_id: String,
        run_trigger: HistoryRunTrigger,
        recorded_at_ms: u64,
        changes: Vec<RankingRunChange>,
    },
    Title {
        item_id: String,
        old_title: Option<String>,
        new_title: String,
        recorded_at_ms: u64,
    },
    Url {
        item_id: String,
        old_url: Option<String>,
        new_url: String,
        recorded_at_ms: u64,
    },
    Metadata {
        item_id: String,
        changed_keys: Vec<String>,
        #[ts(type = "unknown | null")]
        old_metadata: Option<serde_json::Value>,
        #[ts(type = "unknown | null")]
        new_metadata: Option<serde_json::Value>,
        recorded_at_ms: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(tag = "event", rename_all = "snake_case")]
#[ts(export, export_to = "bindings/ws.ts")]
pub enum RankingRunChange {
    Added {
        item_id: String,
        new_rank: i32,
        new_score: f64,
    },
    Removed {
        item_id: String,
        old_rank: i32,
        old_score: f64,
    },
    RankChanged {
        item_id: String,
        old_rank: i32,
        new_rank: i32,
        old_score: f64,
        new_score: f64,
    },
}

/// A guest comment as it appears to a reader.
///
/// `own` is resolved per request from the caller's `X-Guest-Token`, so a broadcast copy always
/// carries `false` and the receiving client decides for itself.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "bindings/ws.ts")]
pub struct GuestComment {
    pub id: String,
    pub author_display_name: String,
    pub body: String,
    pub created_at: String,
    pub status: String,
    pub auto_approved: bool,
    pub own: bool,
    #[serde(default)]
    pub reply_to_comment_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "bindings/ws.ts")]
pub enum ClientMessage {
    ClientHello {
        app_version: Option<String>,
    },
    Subscribe {
        topics: Vec<String>,
    },
    Unsubscribe {
        topics: Vec<String>,
    },
    TopicHistory {
        topic: String,
        lookback_hours: u32,
        change_types: Vec<HistoryChangeType>,
        limit: Option<u32>,
        include_current_items: Option<bool>,
    },
    CrawlSnapshots {
        topic: String,
        since_ms: u64,
    },
    LatestCrawlSnapshot {
        topic: String,
    },
    ConnectionStats,
    SubscribeModeration,
    UnsubscribeModeration,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "bindings/ws.ts")]
pub enum ServerMessage {
    ClientReload {
        current_version: Option<String>,
        required_version: String,
        reason: String,
    },
    TopicSnapshot {
        topic: String,
        display_name: String,
        strategy: RankingStrategy,
        items: Vec<RankedItem>,
        as_of: u64,
    },
    TopicHistory {
        topic: String,
        display_name: String,
        strategy: RankingStrategy,
        current_items: Option<Vec<RankedItem>>,
        events: Vec<TopicHistoryEntry>,
        lookback_hours: u32,
        as_of: u64,
    },
    CrawlSnapshot {
        topic: String,
        display_name: String,
        snapshot: CrawlSnapshot,
    },
    CrawlSnapshots {
        topic: String,
        display_name: String,
        snapshots: Vec<CrawlSnapshot>,
        as_of: u64,
    },
    ConnectionStats {
        unique_client_ips: usize,
        websocket_connections: usize,
        as_of: u64,
    },
    /// An approved guest comment. Pending comments are never broadcast.
    GuestCommentCreated {
        topic: String,
        external_id: String,
        guest_comment_count: u32,
        comment: GuestComment,
    },
    /// A previously visible comment was rejected, marked as spam, or hidden.
    GuestCommentRemoved {
        topic: String,
        external_id: String,
        comment_id: String,
        guest_comment_count: u32,
    },
    GuestCommentCount {
        topic: String,
        external_id: String,
        guest_comment_count: u32,
    },
    /// Sent only to connections subscribed to the moderation channel.
    ModerationQueueChanged {
        pending: u32,
        as_of: u64,
    },
    Error {
        code: String,
        message: String,
    },
}
