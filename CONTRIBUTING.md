# Contributing

Project contributions are distributed under AGPL-3.0-or-later. Preserve copyright notices
and keep third-party license information with any code you add.

Follow the [local setup guide](README.md). Use focused tests for the component you change:
`npm --prefix crawl test`, `npm --prefix grhyph/js test`, `npm --prefix ui run check`,
or `cargo test --locked` from `backend/`. The crawler tests include browser fixtures; run
`npx --no-install patchright install chromium` from `crawl/` once before testing.
Browser checks are documented in `ui/README.md`.

## Database regression tests

The default `cargo test --locked` run skips tests marked `#[ignore]`. To enable them,
provision a separate local PostgreSQL test instance and a test user with permission to
create databases. Export that instance's connection URL as `DATABASE_URL` in your test
shell, then run from the repository root:

```sh
(cd backend && cargo test --locked -- --ignored)
```

The SQLx test harness creates isolated test databases. Use a dedicated test instance;
these commands are not a production health check. The application `.env` is loaded by
`main()`, which the test harness does not run, so explicitly supply the test URL in the environment.

## Secret scanning

Install Gitleaks 8.30.1 or newer, then enable the checked-in pre-commit hook:

```sh
git config --local core.hooksPath .githooks
```

The hook checks staged file names and scans staged content with Gitleaks. CI separately
checks all tracked file names and the complete checked-out Git history. Hook installation
is local to each clone. Avoid committing environment files, browser profiles, database exports,
logs, or credentials, even temporarily. Use sanitized fixtures and `.env.example` placeholders.

For a vulnerability, use the repository's private security reporting feature when it is enabled.
Do not post credentials, private user data, or exploitation details in a public issue.
