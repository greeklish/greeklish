# Crawl

CLI-first crawler subproject for feeding the Rust backend.

The crawler infrastructure provides:

- proxy polling and health scoring
- dynamic proxy blacklisting
- persistent Patchright browser contexts
- browser pooling with queueing, cooldowns, and misbehavior tracking
- higher-level retry policy above the browser pool

Available commands:

- `npm run crawl:r-greece-rising`
- `npm run crawl:x-trends`
- `npm run crawl:insomnia-topics`
- `npm run crawl:myphone-topics`
- `npm run crawl:phorum-topics`
- `npm run crawl:adslgr-topics`
- `npm run crawl:lagonika-offers`
- `npm run crawl:list`
- `npm run proxies`
- `npm run test-browser`

## Setup

The commands in this component README assume your working directory is `crawl/`.
For the complete first-time setup and service startup order, use the [root README](../README.md).

1. Copy `.env.example` to `.env`.
2. Set `BACKEND_INTERNAL_API_TOKEN` to the same token used by the local Rust backend.
3. Set `BACKEND_REMOTE_BASE_URL` and `BACKEND_REMOTE_INTERNAL_API_TOKEN` if you want to send crawl data to the remote backend too. The remote token must match that backend's `INTERNAL_API_TOKEN`. Existing `.env` files that still use `BACKEND_EXTRA_BASE_URLS` and `BACKEND_EXTRA_INTERNAL_API_TOKENS` are supported; the first entry is treated as the remote backend.
4. Optionally set `PROXY_FARM_URL` if you want real proxy rotation.
5. Set `CRAWLER_DIRECT_CONNECTION=true` to bypass browser proxies for all crawlers and use the normal network stack.
6. Install dependencies:

```bash
npm ci
npx --no-install patchright install chromium
npm run install:ublock-lite
```

The uBlock Origin Lite installer downloads the current Chrome Web Store version and unpacks it
into the fixed path expected by the crawler:
`extensions/ddkjiahejlhfcafbddmgiahcphecmpfh/2025.921.2008_0`.

## Run

Start all long-running crawler loops:

```bash
# local backend only; this is the default
./bin/start-crawlers

# remote backend only
./bin/start-crawlers remote

# local and remote backends
./bin/start-crawlers both

# or
npm run start:crawlers -- remote
```

The launcher starts all targets and stops them together on Ctrl+C.

If stale browser profiles or old windows are confusing a fresh run, start with:

```bash
./bin/start-crawlers --clean-browser-data
```

That removes only the crawler-owned browser profiles before launch.

Backend target modes:

- `local`: sends crawl data only to `BACKEND_BASE_URL`. This is the default.
- `remote`: sends crawl data only to `BACKEND_REMOTE_BASE_URL`.
- `both`: sends each crawl pass to both local and remote backends.

Single-target runs use the same mode through `BACKEND_TARGET_MODE`:

```bash
BACKEND_TARGET_MODE=remote npm run crawl:r-greece-rising
BACKEND_TARGET_MODE=both npm run crawl:x-trends
```

Run a single target manually:

```bash
npm run crawl:r-greece-rising
```

That command:

- ensures the `reddit-r-greece` source exists
- ensures the `r-greece-rising` topic exists
- fetches the Reddit rising listing through the browser backbone
- ingests items into the backend
- triggers a rerank

```bash
npm run crawl:x-trends
```

That command:

- ensures the `x` source exists
- ensures the `x-trends` topic exists with backend `external` ranking
- opens `https://x.com/home` in a persistent browser context and waits for manual login when needed
- fetches `https://x.com/explore/tabs/trending`
- scrolls the virtualized trend list until the visible ranks stabilize
- ingests trends with crawl time as the item timestamp and X's displayed order as the backend rank

```bash
npm run crawl:insomnia-topics
```

That command:

- ensures the `insomnia` source exists
- ensures the `insomnia-topics` topic exists with backend `hot` ranking
- fetches the Insomnia topic stream through a persisted browser context
- logs in with `INSOMNIA_AUTH_EMAIL` and `INSOMNIA_AUTH_PASSWORD` only when the session is not already authenticated
- ingests topics with reply count as the backend hotness score input

```bash
npm run crawl:phorum-topics
```

That command:

- ensures the `phorum` source exists
- ensures the `phorum-topics` topic exists with backend `hot` ranking
- fetches the phpBB active topics list from `https://www.phorum.com.gr/search.php?search_id=active_topics`
- resolves Greek absolute and relative timestamps against the crawl response time
- ingests topics with reply count and recent reply activity as backend hotness score input

```bash
npm run crawl:myphone-topics
```

That command:

- ensures the `myphone` source exists
- ensures the `myphone-topics` topic exists with backend `hot` ranking
- fetches the IPB activity stream from `https://myphone.gr/forum/discover/`
- follows additional activity pages with the `changeTime` query parameter
- ingests topics with reply count and recent reply activity as backend hotness score input

```bash
npm run crawl:adslgr-topics
```

That command:

- ensures the `adslgr` source exists
- ensures the `adslgr-topics` topic exists with backend `hot` ranking
- fetches the vBulletin activity feed from `https://www.adslgr.com/forum/activity.php`
- clicks the more-activity link once when present
- resolves activity timestamps from the nested `.datetime .date .time` markup in `Europe/Athens`
- ingests topics with reply count and recent reply activity as backend hotness score input

```bash
npm run crawl:lagonika-offers
```

That command:

- ensures the `lagonika` source exists
- ensures the `lagonika-offers` topic exists with backend `external` ranking
- fetches `https://www.lagonika.gr/?dtype=all` through the persisted browser context
- also fetches `https://www.lagonika.gr/?dtype=sxoliasmena` to capture the latest-commented order
- extracts offer objects from `__NEXT_DATA__.props.pageProps.posts`
- ingests voting score, comments count, creation time, expiry state, store, price, and listing ranks

## Notes

- In `DEBUG_MODE=true` or `CRAWLER_DIRECT_CONNECTION=true`, browser crawlers bypass the proxy system and use the normal network stack.
- Backend deliveries use a durable outbox under `runtime-data/backend-outbox`. Each crawl pass is sent as one atomic, idempotent bulk request. Failed passes are replayed oldest-first, including their historical snapshots, when every configured backend becomes reachable again.
- In `both` mode, the crawler attempts local and remote delivery on every pass. The outbox entry is removed only after both configured backends accept it; one backend may receive the same queued pass again while the other is down, using the same idempotent crawl id.
- The first target is intentionally small and concrete. Once you are happy with the shape, more topics can be added as additional commands or config-driven targets.
