# Self-hosting

The web app (`apps/web`) is a Next.js server. It needs PostgreSQL for accounts and history; Redis is optional.

## Docker Compose quick start

```sh
git clone https://github.com/Shidori5417/vuln-stack.git
cd vulnstack
cp .env.example .env
# edit .env: set BETTER_AUTH_SECRET (>= 32 chars), e.g. `openssl rand -base64 32`
docker compose up -d --build
```

The app listens on `http://localhost:3000` (change with `WEB_PORT`). The compose file starts the web app, `postgres:17-alpine` (volume `postgres-data`) and `redis:7-alpine`, and wires `DATABASE_URL` and `REDIS_URL` to them. To use external services, edit the `web` service environment in `docker-compose.yml`.

Without GitHub OAuth credentials the app still runs and anonymous scanning works, but sign-in is disabled and the UI explains what is missing.

## Environment variables

Application variables (see `apps/web/.env.example`):

| Variable                     | Default                 | Description                                                                                                                                                 |
| ---------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`               | unset                   | Postgres connection string, e.g. `postgres://user:pass@host:5432/vulnstack`. Unset: local PGlite in `.data/pglite` (development only)                       |
| `BETTER_AUTH_SECRET`         | unset                   | Random string, at least 32 characters. Signs sessions and encrypts stored GitHub tokens. Keep it stable: changing it invalidates sessions and stored tokens |
| `BETTER_AUTH_URL`            | `http://localhost:3000` | Public URL of the app. Used for OAuth callbacks and for links handed to the CLI                                                                             |
| `GITHUB_CLIENT_ID`           | unset                   | GitHub OAuth app client id                                                                                                                                  |
| `GITHUB_CLIENT_SECRET`       | unset                   | GitHub OAuth app client secret                                                                                                                              |
| `GITHUB_TOKEN`               | unset                   | Optional server-side token (no scopes). Enables GitHub Advisory Database queries and raises GitHub API limits for public repo scans                         |
| `NVD_API_KEY`                | unset                   | Optional key for NVD CVSS enrichment ([request one](https://nvd.nist.gov/developers/request-an-api-key))                                                    |
| `REDIS_URL`                  | unset                   | Optional shared advisory cache. Falls back to Postgres (or memory) when unset or unreachable                                                                |
| `VULNSTACK_MAX_UPLOAD_MB`    | `10`                    | Maximum request body for anonymous scans                                                                                                                    |
| `VULNSTACK_MAX_FILES`        | `200`                   | Maximum number of files per scan (uploads and repository scans)                                                                                             |
| `VULNSTACK_SCANS_PER_MINUTE` | `10`                    | Scans per minute per client / user                                                                                                                          |
| `VULNSTACK_SCAN_TIMEOUT_MS`  | `55000`                 | Time budget of a single scan                                                                                                                                |
| `VULNSTACK_TRUST_PROXY`      | `0`                     | Set to `1` only behind a reverse proxy that sets `X-Forwarded-For`                                                                                          |
| `VULNSTACK_MIGRATIONS_DIR`   | bundled `drizzle/`      | Override the folder SQL migrations are read from                                                                                                            |

Compose-only variables (root `.env.example`): `WEB_PORT` (published host port, default `3000`).

## GitHub OAuth app

1. GitHub, Settings, Developer settings, OAuth Apps, New OAuth App.
2. Homepage URL: your `BETTER_AUTH_URL`.
3. Authorization callback URL: `<BETTER_AUTH_URL>/api/auth/callback/github`.
4. Put the client id and a generated client secret into `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` and restart.

Sign-in requests the scopes `read:user` and `user:email` only. The broader `repo` scope is requested on demand, when a signed-in user asks to scan a private repository. That token is stored encrypted (with `BETTER_AUTH_SECRET`) and used only for that user's repository scans.

## Postgres and Redis

- **Postgres** stores users, sessions, projects, scans, findings, triage state and API tokens (SHA-256 hashes only). It is also the fallback advisory cache (`vuln_cache` table).
- **Redis** is optional and only caches advisory lookups. If it is missing or fails, the app silently uses Postgres.
- **PGlite** (embedded Postgres in `.data/pglite`) is used when `DATABASE_URL` is unset. It is meant for local development; do not use it in production.

## Migrations

Migrations run automatically when the app first connects to the database, on the first request after start. There is no separate migration step. Set `VULNSTACK_MIGRATIONS_DIR` to read migrations from a different folder.

## Reverse proxy

Put the app behind TLS (Caddy, nginx, Traefik). Set `BETTER_AUTH_URL` to the public HTTPS URL, otherwise OAuth callbacks fail.

Set `VULNSTACK_TRUST_PROXY=1` only if your proxy overwrites `X-Forwarded-For` with the real client address. Otherwise rate limiting would key on a spoofable header. With the default `0` all anonymous clients share one bucket, which is also what you get behind a proxy that does not forward the header.

## Limits

| Limit                    | Default                             | Notes                                                                                                                                      |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Request body             | 10 MB                               | `VULNSTACK_MAX_UPLOAD_MB`                                                                                                                  |
| Files per scan           | 200                                 | `VULNSTACK_MAX_FILES`                                                                                                                      |
| Manual package list      | 1000 packages                       | Fixed                                                                                                                                      |
| Scans per minute         | 10                                  | `VULNSTACK_SCANS_PER_MINUTE`; one window per signed-in user (web scans and CLI uploads share it) or per client address for anonymous scans |
| Website scans per minute | one third (rounded up) of the above | Stricter because they fetch third-party sites                                                                                              |
| Scan time budget         | 55 s                                | `VULNSTACK_SCAN_TIMEOUT_MS`                                                                                                                |

Rate limit counters are held in memory per instance. Running several replicas multiplies the effective limit.

## Backups

Everything worth keeping is in Postgres:

```sh
docker compose exec postgres pg_dump -U vulnstack vulnstack > vulnstack-$(date +%F).sql
```

Restore into an empty database with `psql`. Redis holds only a disposable cache. Back up `.env` separately and securely, since losing `BETTER_AUTH_SECRET` makes stored GitHub tokens unreadable (users can sign in again to refresh them).

## Upgrading

```sh
git pull
docker compose up -d --build
```

Migrations are applied on start. Take a database backup before upgrading across releases.
