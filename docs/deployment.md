# Self-hosting Greeklish

This repository contains application source and generic configuration examples. Supply
host-specific service management, credentials, database backups, and reverse-proxy rules
for your own installation.

## Before deployment

Complete the [local setup](../README.md#run-locally) first. Choose your own public domain,
configure its DNS for your host, and arrange HTTPS termination at the reverse proxy.
Keep PostgreSQL on a private interface. If the crawler is on another host, give it a
controlled private route to the backend and configure its remote-backend URL and token.

Set `RUST_ENV=production`, the correct listener address, your public
`MODERATION_ALLOWED_ORIGINS`, and independent production secrets in `backend/.env`.
Use a separate production database and back it up. Only enable optional comments and
notifications after supplying their required configuration.

## Services

Run PostgreSQL 17 with TimescaleDB, the Rust backend, and the browser crawlers as separate
services. Starting from the repository root, compile the backend:

```sh
(cd backend && cargo build --release --locked)
```

Run `backend/target/release/backend` with `backend/` as its working directory so it can
load `backend/.env`, or have your process manager supply the environment explicitly.
Wait for `/health` to report a reachable database before building the frontend.
The UI produces static files in `ui/build/`:

```sh
(cd ui && PUBLIC_APP_VERSION=your-release PRERENDER_WS_URL=ws://127.0.0.1:3000/ws npm run build)
```

Replace `your-release` with your release identifier. The snapshot URL must be reachable
from the machine doing the build. Leave `PUBLIC_WS_URL` and `PUBLIC_API_URL` empty for
a same-origin deployment; the browser will use the public site's `/ws` and `/api` routes.

Publish the complete `build/` directory atomically. `PUBLIC_*` variables become public
browser configuration and must never contain credentials. Keep the backend's
`REQUIRED_CLIENT_VERSION` aligned with `PUBLIC_APP_VERSION` when version enforcement is used.

## Reverse proxy and client-IP trust

The backend trusts `CF-Connecting-IP`, then `X-Real-IP`; it must only be reachable through
trusted proxies or controlled private networks. Prevent untrusted clients from reaching
its listener directly. If you do not use Cloudflare, strip incoming `CF-Connecting-IP`.
If you do, accept it only from verified Cloudflare ingress and prevent bypass of that ingress.

For Caddy and the backend running on the same host, an example is:

```caddyfile
feed.example.com {
    @internal path /internal/*
    respond @internal 404

    @backend path /ws /api/* /health
    reverse_proxy @backend 127.0.0.1:3000 {
        header_up -CF-Connecting-IP
        header_up X-Real-IP {http.request.remote.host}
        header_up X-Forwarded-Proto {scheme}
    }

    root * /srv/greeklish/ui/build
    file_server
}
```

This example assumes direct client-to-Caddy connections. Adapt the trusted network and
addresses when either component runs in a container or behind another proxy. Configure
`MODERATION_ALLOWED_ORIGINS` for the public origin. Keep `/internal/*` accessible only to
authorized crawlers, protected by the shared internal API token and network controls.

## Process management and updates

Use your operating system's process manager to keep the backend and crawler loops running,
restart them after failures, and collect their logs. The development commands in the README
run in the foreground; this source release does not install system services for you.

For an update, back up the database, install dependencies from the lockfiles, compile the
backend, and restart it so pending migrations are applied. Check `/health`, build the UI
against the updated backend, then switch the served static directory to the new output.
Review migrations before updating; changing the application binary back does not reverse
database schema changes. Keep source, release identifiers, and any client-version
requirement consistent for the version you serve.

## Data and secrets

Store environment files outside published static directories. Back up the PostgreSQL volume
and test restores into an isolated instance. Database contents, browser sessions, credentials,
moderator data, and crawler queues do not belong in source-control or source release archives.

## Corresponding source

Keep the UI's source link pointed at the source for your deployed version, including your
modifications and the material required by the AGPL. Include the license and copyright notices
when distributing source. See the repository's `LICENSE` for the complete terms.
