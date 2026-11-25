# Greeklish

Greeklish collects discussions, trends, and offers from Greek online communities and
shows them in a live feed. The application combines a Rust backend, browser
crawlers, a Svelte frontend, and the `grhyph` Greek hyphenation library.

The user interface is in Greek. These setup and contributor instructions are in English.
You can run your own instance without access to the Greeklish.gr servers or private repositories.

- [Requirements](#requirements)
- [Run locally](#run-locally)
- [Configuration](#configuration)
- [Tests and checks](#tests-and-checks)
- [Build and self-host](#build-and-self-host)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## How it works

Crawlers read supported source websites and send items to the backend's internal API.
The backend stores items and history in PostgreSQL/TimescaleDB, ranks feeds, and sends live
updates to the browser over WebSocket. The UI also supports optional guest comments,
moderation, replies, and Web Push notifications.

| Directory | Contents | More information |
| --- | --- | --- |
| `backend/` | Rust HTTP API, WebSocket feeds, ranking, comments, and database migrations | [Backend README](backend/README.md) |
| `crawl/` | Node.js / Patchright crawlers and persistent browser sessions | [Crawler README](crawl/README.md) |
| `ui/` | SvelteKit frontend and browser checks | [UI README](ui/README.md) |
| `grhyph/` | Go and JavaScript hyphenation implementations | [Library README](grhyph/README.md) |
| `docs/` | Self-hosting guidance | [Deployment guide](docs/deployment.md) |

## Requirements

The examples use a POSIX shell. On Windows, use a Linux environment such as WSL2.

| Tool | Requirement |
| --- | --- |
| Git | To clone the repository |
| Node.js and npm | Node.js 22.12 or newer in the Node 22 release line; Node 22 is used in CI |
| Rust | Rust 1.94.0, selected by `backend/rust-toolchain.toml`; use rustup to manage the toolchain |
| Docker and Docker Compose | A running Docker engine and the `docker compose` command, for the local database |
| OpenSSL | To generate local passwords and API tokens |
| curl | To check backend health from the terminal |
| `unzip` | Required by the crawler's uBlock Origin Lite installer |
| A graphical desktop | Required for the default crawler configuration and interactive source logins |

Python 3 and Gitleaks 8.30.1 or newer are needed for contributor/release checks.
Go 1.23 or newer is only needed to work on the Go version of `grhyph`.
A native Rust build also needs your platform's C compiler/linker and development tools.

Check the main tools before continuing:

```sh
node --version
npm --version
rustup --version
docker compose version
openssl version
unzip -v
```

## Run locally

All commands below start from the **repository root**, the directory containing
`backend/`, `crawl/`, and `ui/`. Commands in parentheses change directory only for that
command. Open each additional terminal at the same repository root.

### 1. Get the source and install dependencies

```sh
git clone https://github.com/greeklish/greeklish.git
cd greeklish
npm --prefix ui ci
npm --prefix crawl ci
```

If you downloaded a source archive, extract it and enter its `greeklish/` directory instead
of cloning. The UI uses the bundled `grhyph/js` package; no separate clone or npm publication
of `grhyph` is needed.

### 2. Configure your local instance

Copy the examples if you do not already have local configuration:

```sh
test -f backend/.env || cp backend/.env.example backend/.env
test -f crawl/.env || cp crawl/.env.example crawl/.env
test -f ui/.env || cp ui/.env.example ui/.env
```

Run the following command **twice** to generate two different values. Use the first as your
database password and the second as the shared backend/crawler API token:

```sh
openssl rand -hex 32
```

Edit the corresponding lines in `backend/.env`. Replace the angle-bracket placeholders
below with the generated values, and keep the remaining settings from the example:

```dotenv
POSTGRES_PASSWORD=<database-password>
DATABASE_URL=postgres://timescaledb:<database-password>@127.0.0.1:55432/greeklish_feed
INTERNAL_API_TOKEN=<api-token>
BIND_ADDRESS=127.0.0.1
PORT=3000
```

Use the **same API token** in `crawl/.env`:

```dotenv
BACKEND_TARGET_MODE=local
BACKEND_BASE_URL=http://127.0.0.1:3000
BACKEND_INTERNAL_API_TOKEN=<api-token>
CRAWLER_DIRECT_CONNECTION=true
```

Keep the defaults in `ui/.env` for this setup. Real `.env` files are ignored by Git.
Guest comments and Web Push can remain disabled while you get the basic feed running.

### 3. Start the database and backend — terminal 1

```sh
(cd backend && docker compose up -d)
(cd backend && docker compose exec timescaledb pg_isready -U timescaledb -d greeklish_feed)
```

Wait until the second command reports **accepting connections**, then start the backend:

```sh
(cd backend && cargo run --locked)
```

The first Rust build can take a while. The backend applies database migrations automatically
and then listens on `127.0.0.1:3000`. Leave this terminal running.

### 4. Check the backend and start the UI — terminal 2

```sh
curl --fail http://127.0.0.1:3000/health
```

A healthy response includes `"database":{"reachable":true,"status":"ok"}` and an uptime.
If the request fails or the database is unreachable, resolve that before continuing.

```sh
npm --prefix ui run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Open **http://127.0.0.1:5173** in your browser. Leave this terminal running too.
The backend must be running when the UI first loads because the page requests an initial
feed snapshot. An empty feed is normal until a crawler has ingested items.

### 5. Start a crawler — terminal 3

Install the crawler browser and extension once:

```sh
(cd crawl && npx --no-install patchright install chromium)
npm --prefix crawl run install:ublock-lite
```

On a Linux machine missing browser system libraries, use this browser installation command
instead; it may request elevated access to install system packages:

```sh
(cd crawl && npx --no-install patchright install --with-deps chromium)
```

List available targets, then start one source:

```sh
npm --prefix crawl run crawl:list
npm --prefix crawl run crawl:r-greece-rising
```

The default configuration opens a visible browser. Follow any source login or verification
prompt there. Successful crawl logs report ingested items, which then appear in the UI.
Supported targets also include Insomnia, MyPhone, Phorum, ADSLgr, Lagonika, and X trends.
Some sources require your own account; use each source according to its access requirements.

To run all crawler loops instead of a single target:

```sh
npm --prefix crawl run start:crawlers
```

See the [crawler README](crawl/README.md) for source-specific settings, saved sessions,
remote backends, and proxy configuration. For an unattended environment, set `HEADLESS=true`
in `crawl/.env` after completing any necessary interactive account setup.

### Stop and restart

Press **Ctrl+C** in each crawler, UI, and backend terminal. To stop the database while
keeping its volume and data:

```sh
(cd backend && docker compose stop)
```

To restart, repeat steps 3–5. Dependency and browser installation only need repeating when
the corresponding versions change. Browser sessions are stored in `crawl/browser-data/`;
queued crawler work is stored in `crawl/runtime-data/`. Both directories are ignored by Git.

## Configuration

| File | Purpose | Important values |
| --- | --- | --- |
| `backend/.env` | Database access, backend listener, internal authentication, optional comments/push | `DATABASE_URL`, `INTERNAL_API_TOKEN`, `BIND_ADDRESS`, `PORT` |
| `crawl/.env` | Backend destinations, source logins, browser behavior | `BACKEND_TARGET_MODE`, `BACKEND_BASE_URL`, `BACKEND_INTERNAL_API_TOKEN`, `HEADLESS` |
| `ui/.env` | Initial snapshot and public browser endpoints | `PRERENDER_WS_URL`, `PUBLIC_WS_URL`, `PUBLIC_API_URL`, `PUBLIC_APP_VERSION` |

`PUBLIC_*` values are visible to browsers; put only public configuration there.
Restart the relevant process after changing its environment file. Changing a database
password in `.env` does not change an existing database user's password; update the database
user and configuration together if the database volume has already been initialized.

Guest comments require all three of `COMMENT_IP_PEPPER`, `CAPTCHA_HMAC_KEY`, and
`MODERATOR_PASSWORD_ARGON2_HASH` in `backend/.env`. Store a generated Argon2id PHC hash,
not the moderator's plaintext password, and single-quote the hash so its `$` characters
survive environment parsing. Set `MODERATION_ALLOWED_ORIGINS` to the UI origin you use.
Web Push additionally requires `WEB_PUSH_PRIVATE_KEY` and a suitable `WEB_PUSH_SUBJECT`.
See [backend configuration](backend/README.md) for generation instructions, limits,
moderation behavior, and notification setup.

## Tests and checks

After dependency installation and the crawler Chromium installation, run these from the
repository root. They do not require a running backend or database:

```sh
npm --prefix crawl test
npm --prefix grhyph/js test
node ui/tests/reply-service-worker.mjs
npm --prefix ui run check
```

The crawler suite uses browser fixtures and test API configuration rather than live source
logins. To test the Go library or run the default Rust tests:

```sh
(cd grhyph && go test ./...)
(cd backend && cargo test --locked)
```

Database regression tests are explicitly ignored by default. Running them requires
`DATABASE_URL` to point at a separate local test PostgreSQL instance with permission to
create isolated databases. See [contributor instructions](CONTRIBUTING.md) before enabling them.
Additional UI browser suites and their prerequisites are documented in the [UI README](ui/README.md).

With Python 3 and Gitleaks installed, Git clones can also run:

```sh
python3 scripts/check-release.py
scripts/scan-secrets.sh
```

These two checks inspect the Git index/history, so they require a Git checkout rather than
an extracted source archive. GitHub Actions runs the release-file check, secret scanning,
crawler tests, JavaScript hyphenation tests, notification-worker tests, and Svelte checks.

## Build and self-host

For a deployment build, keep your configured backend running and run:

```sh
(cd backend && cargo build --release --locked)
(cd ui && PUBLIC_APP_VERSION=your-release PRERENDER_WS_URL=ws://127.0.0.1:3000/ws npm run build)
```

The outputs are `backend/target/release/backend` and the static `ui/build/` directory.
The UI build needs backend access for its initial feed snapshot. Use a release identifier
of your choice in place of `your-release`.

Before serving the app publicly, follow the [deployment guide](docs/deployment.md) for HTTPS,
reverse-proxy routing, client-IP trust, private crawler access, process management, and backups.
The development server is for local work; serve the static UI behind your public reverse proxy.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `Missing required environment variable` | Copy and edit the component's `.env`, and run it using the documented commands. The backend loads `.env` from its working directory. |
| Database connection refused | Check `docker compose ps` from `backend/`, wait for `pg_isready`, and use host port `55432` in `DATABASE_URL`, not container port `5432`. |
| Database authentication failed | The URL password must match the initialized database user's password. Editing `POSTGRES_PASSWORD` alone does not update an existing volume. |
| UI fails while loading the initial feed | Check `/health`, keep the backend running, and verify `PRERENDER_WS_URL` in `ui/.env`. |
| UI opens but feeds are empty | Start a crawler, check its login/browser state, and wait for a successful ingestion. No live data or database dump is bundled. |
| Crawler receives `401` | `BACKEND_INTERNAL_API_TOKEN` must match the destination backend's `INTERNAL_API_TOKEN`. |
| Chromium executable or shared libraries are missing | Install the Patchright browser; on Linux, use the `--with-deps` command in step 5. |
| `unzip` not found | Install your operating system's `unzip` package, then rerun `install:ublock-lite`. |
| Browser cannot open on a server | Use a graphical session for required logins, or set `HEADLESS=true` when an interactive browser is unnecessary. |
| Comments/API return `404` | Guest comments are disabled until all three required comment secrets are configured. |
| Comment or moderation requests are rejected for their origin | Match `MODERATION_ALLOWED_ORIGINS` to your UI's scheme, hostname, and port, then restart the backend. |
| Port is already in use | Stop the conflicting local process, or change the port and each corresponding URL/origin in your configuration. |
| Git check says Gitleaks is missing | Install Gitleaks 8.30.1 or newer, or set `GITLEAKS_BIN` to its executable path. |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and pre-commit hook.
See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

Project code, including the Go and JavaScript versions of `grhyph`, is licensed under
**GNU Affero General Public License version 3 or later (AGPL-3.0-or-later)**.
See [LICENSE](LICENSE), [NOTICE](NOTICE), and [grhyph/NOTICE](grhyph/NOTICE).
Third-party dependencies retain their respective licenses. The hosted website's terms
in `ui/TOS.md` concern use of that service and do not replace this software license.

The UI includes a source-code link in its information dialog. If you host a modified
version, point that link to the corresponding source for the version you serve and
follow the license's source-availability requirements.
