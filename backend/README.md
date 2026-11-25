# Real-Time Topic Feed Aggregator Backend

Rust backend for ingesting source items over an internal HTTP API and serving both current ranked topic feeds and recent topic history over WebSocket.

## Stack

- Rust `1.94.0`, edition `2024`
- `axum 0.8`
- `tokio`
- `sqlx 0.8`
- PostgreSQL 17 with TimescaleDB `2.14+`
- Native `axum` WebSockets with `serde` message types
- `ts-rs` bindings committed under [`bindings/`](./bindings)

## Local Development

Commands in this component README run from `backend/`. For first-time setup, matching
backend/crawler credentials, and startup checks, follow the [root README](../README.md).

1. Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD`, `DATABASE_URL`, and `INTERNAL_API_TOKEN`.
2. Start TimescaleDB:

```bash
docker compose up -d
```

3. Start the backend:

```bash
cargo run
```

The service applies SQL migrations at startup before it binds the HTTP port.

## Configuration

All configuration is loaded from environment variables and validated eagerly at startup.

| Variable | Description | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string | required |
| `INTERNAL_API_TOKEN` | Shared secret for `/internal/*` routes | required |
| `WS_PING_INTERVAL_SECS` | Native WebSocket ping interval | `30` |
| `WS_TIMEOUT_SECS` | Connection timeout after missing pong | `60` |
| `TICKER_INTERVAL_SECS` | Background rerank interval | `30` |
| `DEFAULT_FEED_SIZE` | Topic feed-size fallback on create | `20` |
| `HOT_GRAVITY` | Hot-strategy gravity fallback on create | `1.8` |
| `RUST_ENV` | `development` or `production` | `development` |
| `PORT` | HTTP and WebSocket listen port | `3000` |
| `REQUIRED_CLIENT_VERSION` | Client version that triggers `client_reload` when mismatched | unset |
| `SWEEPER_INTERVAL_SECS` | In-memory pruning interval for rate limits, captchas and sessions | `60` |

### Guest comments

Guest commenting stays **disabled** until `COMMENT_IP_PEPPER`, `CAPTCHA_HMAC_KEY` and
`MODERATOR_PASSWORD_ARGON2_HASH` are all set. Setting only some of them is a startup error rather
than a silently half-configured feature. While disabled, every `/api/*` route returns `404`.

| Variable | Description | Default |
| --- | --- | --- |
| `COMMENT_IP_PEPPER` | HMAC key deriving the pseudonymous `author_ip_hash`; at least 32 chars | required to enable |
| `CAPTCHA_HMAC_KEY` | HMAC key signing proof-of-work challenges; at least 32 chars | required to enable |
| `MODERATOR_PASSWORD_ARGON2_HASH` | Argon2id PHC string for the moderator password | required to enable |
| `MODERATION_ALLOWED_ORIGINS` | Comma-separated `Origin` allow-list for state-changing calls | `https://greeklish.gr` |
| `COMMENT_AUTO_APPROVE_THRESHOLD` | Approved comments before an author publishes immediately | `5` |
| `COMMENT_MAX_LENGTH` | Maximum body characters | `1000` |
| `COMMENT_MAX_PENDING_PER_AUTHOR` | Concurrent held comments per author | `3` |
| `COMMENT_IP_RETENTION_DAYS` | Days before `author_ip_hash` is erased; capped at `90` | `90` |
| `COMMENT_PER_IP_BURST_SECS` | Minimum seconds between comments from one address | `2` |
| `COMMENT_PER_IP_HOURLY_LIMIT` | Comments per address per hour | `120` |
| `COMMENT_PER_IP_DAILY_LIMIT` | Comments per address per day | `500` |
| `COMMENT_PER_AUTHOR_BURST_SECS` | Minimum seconds between comments from one author | `10` |
| `COMMENT_PER_AUTHOR_HOURLY_LIMIT` | Comments per author per hour | `30` |
| `COMMENT_PER_AUTHOR_ITEM_DAILY_LIMIT` | Comments per author per item per day, counted in the database | `30` |
| `CAPTCHA_PER_IP_HOURLY_LIMIT` | Challenges issued per address per hour | `240` |
| `CAPTCHA_MAX_NUMBER` | Proof-of-work search space | `150000` |
| `CAPTCHA_TTL_SECS` | Challenge validity | `300` |
| `MODERATOR_SESSION_TTL_SECS` | Sliding session lifetime; absolute cap is 7 days | `28800` |
| `MODERATOR_LOGIN_ATTEMPT_LIMIT` | Login attempts per address before lockout | `5` |
| `MODERATOR_LOGIN_ATTEMPT_WINDOW_SECS` | Window for counting login attempts | `900` |

Posting quotas count committed comments only; rejected, duplicate, invalid-captcha and failed
submissions refund their reserved slots. A separate 30-attempts/minute IP limit protects the write
endpoint. Authenticated moderators use a 2-second author cooldown instead of guest IP/hour/day
quotas and the pending cap; bans, captcha, duplicate detection and pre-moderation still apply.
Successful responses include `next_comment_in_secs`. A 429 returns the actual rounded-up wait in
`Retry-After` and `retry_after_secs`; `retry_scope: "item"` limits that cooldown to one article.

Both moderation queue and log accept `topic` (feed slug), `author_id` (exact UUID), `author`
(case-insensitive display-name substring), and `q` (literal substring in body or article title).
Queue statuses are `pending` (default), `approved`, `rejected`, `spam`, `hidden`, and `all`.
Filters apply before pagination; pass the opaque `next_cursor` unchanged for subsequent pages.
Cursors include timestamp and UUID so equal timestamps cannot skip records.

`GET /api/comments/discussions` lists public article discussions ordered by latest published comment.
Each entry includes feed/article metadata, the published comment count and `last_comment_at`.
Only approved comments contribute to this list; articles no longer in feed snapshots remain
available. Pass `cursor=next_cursor` to continue (default 30 discussions, `limit` capped at 100).
No schema migration is needed for this endpoint.

### Direct replies and optional Web Push

`POST /api/comments` accepts an optional `reply_to_comment_id`. It must reference an approved
comment on the same article and topic. Replies use the normal captcha, quotas and moderation;
the parent ID is included in comment HTTP/WebSocket responses. Article metadata is included in
the thread response, including for discussions whose articles have left the current feed.

The existing `X-Guest-Token` browser identity also owns a private reply inbox:

- `GET /api/replies` accepts `cursor` and `limit`, and returns `replies`, `unread_count`, `next_cursor`.
- `POST /api/replies/{id}/read` marks one owned entry read; `POST /api/replies/read` marks all read.

No account or email address is required. Only approved direct replies by another author create
inbox events. Hidden replies and replies to hidden parents are filtered from the inbox and from
queued push delivery. Reading an entry suppresses a push that has not yet been sent.

Web Push stays disabled until `WEB_PUSH_PRIVATE_KEY` contains a URL-safe base64 P-256 private key
without padding. `WEB_PUSH_SUBJECT` is an HTTPS or `mailto:` contact URI (default
`https://greeklish.gr/`). Keep this private key stable across deployments and out of Git/logs;
`GET /api/push/config` publishes only the derived public key and enabled flag.

- `POST /api/push/subscriptions` saves the browser's `{endpoint, keys: {p256dh, auth}}` subscription.
- `GET /api/push/subscriptions/{id}` returns its `watched_comment_ids` and refreshes device activity.
- `PUT /api/push/subscriptions/{id}/watches/{comment_id}` explicitly follows replies to one owned
  comment. A pending own comment may be followed before approval. Existing replies are not sent.
- `DELETE /api/push/subscriptions/{id}/watches/{comment_id}` stops following it and cancels queued jobs.
- `DELETE /api/push/subscriptions/{id}` removes that device subscription and all its watches/jobs.

All private calls use `X-Guest-Token`; mutations require JSON content type and the configured
origin policy. Subscriptions cannot be taken over by another guest identity. Only known browser
push service HTTPS endpoints are accepted; requests do not follow redirects. Invalid key material
is rejected before storage. Responses containing private notification data use `private, no-store`.

The worker encrypts generic notification text with `aes128gcm` and signs with VAPID. The payload
contains a local link to the specific reply, without putting comment text on the lock screen.
Its durable outbox is written in the comment approval transaction, with one job per event/device.
Leases recover after crashes; retries use bounded exponential backoff, at most eight attempts,
and a one-day delivery window. HTTP 404/410 removes expired subscriptions; 429/5xx and network
failures retry. Delivery is at least once across a provider-acceptance/process-crash boundary;
the stable event ID/notification tag lets the service worker replace a duplicate display.

The hourly retention pass removes inbox events after 90 days, subscriptions unused for 90 days,
and finished jobs after seven days. Public comments remain. A marker on the comment prevents
moderation restores from recreating a notification even after its inbox event has expired.

Run isolated PostgreSQL regressions with `DATABASE_URL` and
`cargo test reply_regression -- --ignored`; key validation and retry tests use `cargo test push::tests`.

Generate the password hash out of band and never commit the result:

```sh
printf '%s' 'your-password' | argon2 "$(head -c 16 /dev/urandom | base64)" -id -t 3 -m 16 -p 1 -e
```

`COMMENT_IP_RETENTION_DAYS` is capped at **90** because `ui/TOS.md` section 5 commits to retaining
technical data for at most 90 days. It is a published commitment, not a tuning knob.

## API Overview

### Public

- `GET /health`
- `GET /ws`

Guest comments, available only when the feature is configured:

- `GET /api/captcha/challenge`
- `GET /api/comments/:topic_slug/:external_id`
- `GET /api/comments/counts/:topic_slug`
- `POST /api/comments`
- `POST /api/moderation/session`
- `DELETE /api/moderation/session`

Moderation, gated by the `__Host-gl_mod` session cookie:

- `GET /api/moderation/stats`
- `GET /api/moderation/feeds` (feed selector options)
- `GET /api/moderation/queue`
- `GET /api/moderation/log`
- `POST /api/moderation/comments/:comment_id/decision`
- `POST /api/moderation/authors/:author_id/trust`

State-changing calls require `Content-Type: application/json` and an allow-listed `Origin`. Together
with `SameSite=Strict` on the session cookie that is the whole CSRF defence; there is deliberately no
CORS layer, because the UI is same-origin.

### Internal

All `/internal/*` routes require `X-Internal-Token`.

- `PUT /internal/sources/:source_slug`
- `PUT /internal/topics/:topic_slug`
- `PUT /internal/topics/:topic_slug/items/:source_slug/:external_id`
- `POST /internal/topics/:topic_slug/rerank`
- `POST /internal/topics/:topic_slug/crawl-passes`
- `POST /internal/maintenance/prune-history`

## Current Architecture

The backend uses a split model:

- current-state tables for fast live reads
- append-only history tables for backtracing changes over time

### Current-State Projection

- `sources`: source registry such as `reddit`
- `topics`: topic/feed configuration such as `rising-threads`
- `items`: latest canonical item state
  - `title`
  - `url`
  - `metadata jsonb`
  - published/crawled/update timestamps
- `topic_items`: topic membership plus latest topic-relative state
  - `current_score`
  - `external_rank`
  - latest persisted `rank_position`

These tables are the fast read model used to build the latest websocket snapshot.

Guest commenting adds four plain tables. They are **not** hypertables: comments need `UPDATE` for
status transitions and point lookups by id, which chunking and compression work against.

- `guest_authors`: pseudonymous author identity
  - `token_hash` — SHA-256 of the browser-held bearer token; the token itself is never stored
  - `approved_count` — raised only by a human approval, which is what gates auto-approval
  - `trust_state` — `normal`, `revoked` or `banned`
- `guest_comments`: the comments themselves
  - `status` — `pending`, `approved`, `rejected`, `spam` or `hidden`
  - `auto_approved` and `hold_reason` — why a comment published, or why it did not
  - `author_ip_hash` — HMAC of the address, erased after the retention window
  - `author_display_name` — snapshotted per comment, so renames never rewrite history
- `guest_comment_moderation_events`: append-only log, including `auto_approved` entries with the
  author's `approved_count` at that moment. Rows are never updated or deleted; an undo is a new
  `restored` event.
- `guest_comment_ip_blocks`: address-hash blocklist with an optional expiry

Note the naming: `comments_count` already means *the upstream thread's* comment count, in
`crawl_snapshot_items`, `RankedItem` and `CrawlSnapshotItem`. On-site counts are always
`guest_comment_count`.

### Historical Tables

- `score_snapshots`: append-only score history per `(topic_id, item_id)`
- `item_observations`: append-only content/meta history per item
  - stores `title`, `url`, `metadata jsonb`, `recorded_at`
  - a new row is inserted only when title, URL, or metadata changed
- `topic_runs`: one row per rerank run that is worth recording
  - manual reranks always create a run row
  - ticker reranks only create a run row when the ranked snapshot changed
  - external-topic ingestion reranks use trigger `ingest` and create a run row only when the ranked snapshot changed
- `topic_item_events`: append-only topic-relative rank delta history
  - `added`
  - `removed`
  - `rank_changed`

This split keeps live reads simple while still supporting backtracing and audit-style history.

## Internal Ingestion Notes

The item ingestion body currently accepts:

```json
{
  "title": "Example thread",
  "url": "https://www.reddit.com/r/programming/comments/1abcde/example/",
  "score": 245,
  "published_at": "2026-04-22T10:30:00Z",
  "crawled_at": "2026-04-22T10:35:00Z",
  "rank": 3,
  "metadata": {
    "comments_count": 41,
    "status": "active"
  }
}
```

Notes:

- `title`, `url`, `score`, and `published_at` are required
- `crawled_at`, `rank`, and `metadata` are optional
- `metadata` is stored as `jsonb`
- re-ingesting the same item updates the latest row in `items`
- if `title`, `url`, or `metadata` changed, the backend also appends a row to `item_observations`
- if the topic uses `ranking_strategy: "external"`, each successful item ingestion queues an automatic `ingest` rerank
- automatic `ingest` reranks update ranking history only when item presence or final rank positions changed

## Maintenance

`POST /internal/maintenance/prune-history` deletes feed history older than `older_than_days`
and optionally runs `VACUUM (FULL, ANALYZE)` on the affected tables. This route requires
`X-Internal-Token` and only accepts requests from a loopback peer.

```bash
(
  set -a
  . ./.env
  set +a

  curl -X POST "http://127.0.0.1:3000/internal/maintenance/prune-history" \
    -H "X-Internal-Token: ${INTERNAL_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"older_than_days":30,"vacuum":true}'
)
```

Run the command from the backend directory. The subshell exports values from `.env` only for
the `curl` call, so `INTERNAL_API_TOKEN` does not have to be exported in your terminal first.

The cleanup removes old rows from `crawl_snapshots`, `crawl_snapshot_items`,
`score_snapshots`, `item_observations`, `topic_item_events`, and `topic_runs`.
It keeps current-state rows such as `sources`, `topics`, `items`, and `topic_items`.
`VACUUM FULL` rewrites and locks the affected tables while it runs, but it is the
mode that returns disk space to the OS.

## WebSocket Behavior

- Clients send typed JSON messages:
  - `subscribe`
  - `unsubscribe`
  - `topic_history`
- The server sends:
  - `topic_snapshot`
  - `topic_history`
  - `error`
- Connection liveness uses native RFC 6455 ping/pong control frames only.
- The backend sends a ping every 30 seconds by default and closes idle connections after 60 seconds without a pong.

### Live Snapshot

Clients subscribe to one or more topics:

```json
{
  "type": "subscribe",
  "topics": ["rising-threads"]
}
```

The server responds with `topic_snapshot` messages containing the latest top `N` items for that topic.

Subscribe and unsubscribe messages may include up to 20 topics per request.

### Crawl Snapshot History

Clients can request full crawl snapshots for a topic by timestamp:

```json
{
  "type": "crawl_snapshots",
  "topic": "rising-threads",
  "since_ms": 1782940800000
}
```

Rules:

- `since_ms` is clamped to the latest 2 days
- requests older than that return only the latest 2 days of checkpoints

### Guest Comment Events

Approved guest comments are pushed to every client already subscribed to the item's topic, so no
polling is needed. The server emits:

```json
{
  "type": "guest_comment_created",
  "topic": "rising-threads",
  "external_id": "1h2i3j4",
  "guest_comment_count": 3,
  "comment": {
    "id": "0192f0c1-...",
    "author_display_name": "Επισκέπτης",
    "body": "Καλό θέμα",
    "created_at": "2026-10-09T18:22:01Z",
    "status": "approved",
    "auto_approved": false,
    "own": false
  }
}
```

Rules:

- only `approved` comments are ever broadcast; a `pending` comment reaches nobody but its own author,
  through the HTTP response that created it and through `GET /api/comments/...` with the author's
  `X-Guest-Token`
- `own` is always `false` on a broadcast copy, because a broadcast has no single recipient; each
  client decides ownership for itself
- `guest_comment_removed` is emitted when a previously visible comment is rejected, marked as spam or
  hidden, carrying the updated `guest_comment_count`
- `guest_comment_count` is the approved count for that item, suitable for the feed badge directly

### Moderation Channel

A moderator connection can subscribe to queue-depth notifications:

```json
{ "type": "subscribe_moderation" }
```

Rules:

- accepted only when the WebSocket upgrade request carried a valid `__Host-gl_mod` cookie; the
  session token therefore stays `HttpOnly` and is never echoed through a client message
- any other connection receives `{"type":"error","code":"unauthorized"}` and stays open
- the server replies immediately with the current `moderation_queue_changed` depth, then again on
  every change
- because the cookie is read at the handshake, a moderator who logs in after their page socket opened
  must establish a second connection for this channel
- the reserved registry key is `__moderation`, which is deliberately not a valid topic slug, so it
  can never collide with a real topic name

### Historical Backtrace

Clients can request a one-shot historical diff for a topic over the latest 1-24 hours:

```json
{
  "type": "topic_history",
  "topic": "rising-threads",
  "lookback_hours": 24,
  "change_types": ["ranking", "title", "metadata"],
  "limit": 500,
  "include_current_items": false
}
```

Rules:

- `lookback_hours` must be between `1` and `24`
- `change_types` must contain at least one of:
  - `ranking`
  - `title`
  - `url`
  - `metadata`
- `limit` defaults to `250` and is capped at `1000`
- `include_current_items` defaults to `false`

The response includes:

- `current_items`: optional latest snapshot, included only when requested
- `events`: recent changes ordered newest-first

The history payload is optimized to reduce bandwidth:

- history entries identify items by `item_id` only
- ranking deltas are grouped by run instead of repeating run metadata on every item event
- history timestamps are sent as epoch milliseconds
- metadata changes include only changed keys and changed sub-values when metadata is object-shaped

The `events` timeline can include:

- `ranking_run`
  - one entry per rerank run
  - includes shared run metadata once:
    - `run_id`
    - `run_trigger`
    - `recorded_at_ms`
  - includes compact per-item changes:
    - `added`
    - `removed`
    - `rank_changed`
- `title`
- `url`
- `metadata`

This lets clients request:

- ranking-only backtraces
- content-only backtraces
- full mixed timelines

Example request modes:

- ranking only: `["ranking"]`
- metadata only: `["metadata"]`
- everything: `["ranking", "title", "url", "metadata"]`

## Reverse Proxy Requirement

For MVP, `/internal/*` stays on the same listener as the public API. Those routes must be blocked from public access at the reverse proxy. The shared token is defense in depth, not the primary boundary.

Example Caddy configuration:

```caddyfile
api.example.com {
    @internal path /internal/*
    respond @internal 404

    reverse_proxy 127.0.0.1:3000
}
```

If crawlers run on a trusted private network, expose a separate internal host or allow-list upstream IPs there instead of opening `/internal/*` publicly.

When guest comments are enabled, proxy `/api/*` alongside `/ws`, and configure trusted
client-IP headers. See [deployment guidance](../docs/deployment.md) for the required trust
boundary and a single-host example. Adapt addresses to your own deployment.

## TimescaleDB Notes

- Migrations target TimescaleDB `2.x`, validated against the `latest-pg17` Docker image line.
- The schema currently includes:
  - base tables for sources, topics, items, and topic-items
  - `score_snapshots` hypertable for score history
  - `item_observations` hypertable for content/meta history
  - `topic_item_events` hypertable for ranking deltas
  - `topic_runs` for grouping rerank/change batches
  - a 30-day retention policy and compression for `score_snapshots`
  - compression for the item/topic history hypertables

## Status

This repository currently contains:

- toolchain pinning
- configuration loading and tracing setup
- schema migrations
- internal ingestion endpoints
- health endpoint
- typed WebSocket messages and bindings
- guest commenting with pre-moderation, trust-based auto-approval and an append-only moderation log
- self-hosted Altcha-protocol proof-of-work captcha, with no third-party contact
- per-address and per-author rate limiting, plus a background sweeper and data-retention pass
- live topic snapshots over WebSocket
- historical topic backtraces over WebSocket
- subscriber registry and rerank ticker
- append-only item and topic history tracking
- graceful shutdown wiring

The next pass should add database-backed integration tests and commit `.sqlx/` once the query set is stable.
