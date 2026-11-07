# Self-hosting the control plane

The one-command self-host stack (runtime, control plane, Postgres, console, optional playground) lives in
[`macp-runtime/deploy/docker-compose.yml`](../../macp-runtime/deploy/docker-compose.yml). This page is the
control plane's contract for that stack: which image to pull, which env it needs, and how to health-check it.

## Image

`ghcr.io/multiagentcoordinationprotocol/macp-control-plane` (public). Multi-arch: `linux/amd64` and `linux/arm64`.

| Tag | Moves? | Use |
|-----|--------|-----|
| `0.8.0` / `v0.8.0` | never | **pin this** in compose |
| `0.8` / `v0.8` | on each patch release | tracks fixes within a minor |
| `latest` | on every release | not for compose |
| `sha-<short>` | never | a specific `main` commit (CI build, not a release) |

Release tags are cut by [release.yml](../.github/workflows/release.yml) (Trivy-gated before push). See [CICD.md](CICD.md#releases).

### Upgrading to 0.8.0

0.8.0 tightens auth. Check these before you move a pin from 0.7.x:

- **`AUTH_API_KEYS` is required** unless `NODE_ENV` is explicitly `development` or `test`. An empty value
  used to open the API when `NODE_ENV` was unset; now the guard fails closed, and production still refuses
  to start. The image sets `NODE_ENV=production`, so compose must set `AUTH_API_KEYS`.
- **`GET /metrics` needs the API key** (`Authorization: Bearer <key>`). Point Prometheus scrapers at it with
  a key. `/healthz` and `/readyz` stay public.
- **`MACP_AUTH_SERVICE_API_KEY`**: if you set `MACP_AUTH_SERVICE_URL` (JWT mint, hosted only), also set this
  to one of the auth-service's `TOKEN_ISSUER_KEYS`. Without it a production auth-service answers 401 and
  the CP falls back to `RUNTIME_BEARER_TOKEN` (a warning is logged at start). Self-host compose leaves both unset.
- **Tests read `TEST_DATABASE_URL` only** (default `postgres://postgres:postgres@localhost:5433/macp_control_plane_test`).
  The integration helpers refuse a database whose name lacks `test` or that equals `DATABASE_URL`.
- **Runtime:** tested range is `>=0.8.0 <0.15.0`, absorbed through macp-runtime 0.14.0.
- **Cancel** now marks a run cancelled only after the runtime accepts; a refusal returns the mapped runtime
  error (e.g. `403 FORBIDDEN`) and leaves the run unchanged.
- Authenticated requests are throttled per API key plus the console's `X-MACP-Client-IP`.

## Boot behaviour

- **Migrations run on start.** `main.ts` applies every pending `drizzle/*.sql` migration (tracked in `_migrations`)
  before Nest boots, so a fresh, empty Postgres needs no init step. Point `DATABASE_URL` at an existing database;
  the CP doesn't create the database itself, so set `POSTGRES_DB` on the Postgres container.
- **The image runs with `NODE_ENV=production`**, so the production fail-fast checks apply (below). There is
  no hosted-only requirement: no auth service, no Redis, no OTel collector.
- The CP is an observer. It never opens sessions; agents do that against the runtime directly.

## Environment

Required in compose (the production checks refuse to start without the first three):

| Variable | Example | Why |
|----------|---------|-----|
| `DATABASE_URL` | `postgres://postgres:postgres@postgres:5432/macp_control_plane` | Postgres connection |
| `AUTH_API_KEYS` | `dev-key-1` | Comma-separated API keys, exact match on `Authorization: Bearer <key>`. No commas inside a key. Empty fails startup in production |
| `RUNTIME_ALLOW_INSECURE` | `true` | Plaintext gRPC to the runtime. Without it, production requires `RUNTIME_TLS=true` |
| `RUNTIME_ADDRESS` | `runtime:50051` | Runtime gRPC `host:port` (default `127.0.0.1:50051` is wrong inside compose) |
| `RUNTIME_BEARER_TOKEN` | `macp-control-plane` | Observer identity sent to the runtime. Against a dev-mode runtime (`MACP_ALLOW_INSECURE=1`) any value is accepted and becomes the sender. Against an authenticated runtime it must be a token in the runtime's `MACP_AUTH_TOKENS_JSON`. Unset → startup warning and every runtime call is rejected |

Useful optional variables:

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3001` | Listen port (`HOST` defaults to `0.0.0.0`) |
| `CORS_ORIGIN` | `http://localhost:3000` | Set to the console's browser origin if it calls the CP directly |
| `SESSION_DISCOVERY_ENABLED` | `true` | Auto-creates runs for sessions seen on `WatchSessions`, and consumes `WatchSignals`. Keep it on so agent-launched sessions show up without a `POST /runs` |
| `LOG_LEVEL` | `info` | |
| `DB_POOL_MAX` | `20` | Must be ≥ 2 |

Leave these **unset** in compose: `MACP_AUTH_SERVICE_URL` and `MACP_AUTH_SERVICE_API_KEY` (JWT mint; hosted only — if you do set the URL, the API key must be one of the auth-service's `TOKEN_ISSUER_KEYS`), `STREAM_HUB_STRATEGY`/`REDIS_URL`
(single instance is fine; a `memory` warning is logged), `OTEL_*`, `RUNTIME_USE_DEV_HEADER` (deprecated; the
dev-bearer fallback is refused in production, so use `RUNTIME_BEARER_TOKEN`). The full list is in
[`.env.example`](../.env.example).

### Runtime retention for what-if replay

`POST /runs/:id/what-if` (runtime ≥ 0.10) replays a session's full history. By default the runtime
compacts a session's log when it ends, so what-if on a finished run answers `409 HISTORY_UNAVAILABLE`.
To keep finished sessions replayable, set **`MACP_COMPACT_TERMINAL_LOGS=0` on the runtime** (not the CP).
That trades disk for replayability. The CP needs no setting; it reads the capability from the runtime.

## Health

| Endpoint | Auth | HTTP | `ok` means |
|----------|------|------|-----------|
| `GET /healthz` | public | **200 whenever the process answers** (liveness) | Postgres reachable and no pool error. Informational only |
| `GET /readyz` | public | **200 when `ok`, 503 when not** (same JSON body either way) | Postgres **and** runtime **and** stream consumer **and** circuit breaker not `OPEN` |

`/readyz` body (identical on 200 and 503):
`{"ok":false,"database":"ok","runtime":{"ok":false,"runtimeKind":"rust","detail":"..."},"streamConsumer":"ok","circuitBreaker":"CLOSED"}`

- **Compose / Kubernetes readiness / load balancers: probe `/readyz` by status code.** The CP only reports
  healthy once it can actually serve: database up and runtime reachable. Gate the console on
  `control-plane: service_healthy`. The CP itself gates only on `postgres: service_healthy`, never on the runtime.
- **Liveness (restart) probes: `/healthz`.** A DB outage doesn't fail it, because a restart wouldn't fix that.
  A wedged process fails it by timing out. The image's built-in `HEALTHCHECK` uses `/healthz`, and the compose
  `healthcheck` below overrides it.
- Before 0.6.1, `/readyz` returned 200 even when `ok:false`. If you pin an older image, match `"ok":true` in the body.

```yaml
control-plane:
  image: ghcr.io/multiagentcoordinationprotocol/macp-control-plane:0.8.0
  environment:
    DATABASE_URL: postgres://postgres:postgres@postgres:5432/macp_control_plane
    AUTH_API_KEYS: ${CP_API_KEYS:-dev-key-1}
    RUNTIME_ADDRESS: runtime:50051
    RUNTIME_ALLOW_INSECURE: "true"
    RUNTIME_BEARER_TOKEN: macp-control-plane
  ports: ["3001:3001"]
  depends_on:
    postgres: { condition: service_healthy }
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3001/readyz"]
    interval: 10s
    timeout: 3s
    start_period: 20s
    retries: 5
```
