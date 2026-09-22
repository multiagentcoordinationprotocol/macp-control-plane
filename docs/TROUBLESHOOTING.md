# MACP Control Plane — Troubleshooting

## Runtime Connection Failures

**Symptom:** `GET /readyz` returns `runtime.ok: false`

**Checks:**
1. Verify runtime is running: `grpcurl -plaintext 127.0.0.1:50051 list`
2. Check `RUNTIME_ADDRESS` env var matches the runtime's listen address
3. If using TLS, ensure `RUNTIME_TLS=true` and certificates are valid
4. Check `RUNTIME_REQUEST_TIMEOUT_MS` (default 30s) — increase if runtime is slow
5. Check circuit breaker state in `GET /readyz` — reset with `POST /admin/circuit-breaker/reset`

## Circuit Breaker Open

**Symptom:** All runtime calls fail with `CIRCUIT_BREAKER_OPEN`

**Cause:** 5 consecutive gRPC failures tripped the circuit breaker.

**Fix:**
1. Check runtime health: `GET /runtime/health`
2. If runtime is back, reset: `POST /admin/circuit-breaker/reset`
3. Or wait for auto-reset after `RUNTIME_CIRCUIT_BREAKER_RESET_MS` (default 30s)

## Migration Issues

**Symptom:** Application fails to start with database errors

**Steps:**
1. Ensure PostgreSQL is running and accessible via `DATABASE_URL`
2. Migrations run automatically on startup (see `src/db/migrate.ts`)
3. Check `drizzle/` directory for migration SQL files
4. Use `npm run drizzle:studio` to inspect database state

## Stuck Runs

**Symptom:** Runs stay in `starting` or `running` state indefinitely

**Steps:**
1. Check stream consumer logs for reconnection errors
2. Verify runtime session state: `GET /readyz`
3. Check `STREAM_MAX_RETRIES` (default 5) and `STREAM_IDLE_TIMEOUT_MS` (default 120s)
4. Manually cancel: `POST /runs/{id}/cancel`
5. If recovery is enabled (`RUN_RECOVERY_ENABLED=true`), the system auto-recovers orphaned runs on startup
6. If the run includes a cross-session commitment step, see [§ Run stalls with no `decision.finalized`](#run-stalls-with-no-decisionfinalized-non-canonical-supersedes-hash) below

## Run stalls with no `decision.finalized` (non-canonical supersedes hash)

**Symptom:** No `decision.finalized` canonical event ever lands for the affected commitment
step — that absence, not any error event, is the tell. The run does **not** hang forever:
the stream goes quiet, `STREAM_IDLE_TIMEOUT_MS` (default 120s) ends the idle iteration,
the consumer retries/backs off/resubscribes up to `STREAM_MAX_RETRIES` (default 5), then
degrades to a `getSession` poll fallback, and once that poll budget is also exhausted the
run is finalized `failed` with the message `polling exhausted without terminal session
state` (`src/runs/stream-consumer.service.ts`). Along the way `GET /runs/{id}/events`
**does** show `session.stream.opened` events with `status: reconnecting` and this terminal
failure — but that message is a **red herring**: it describes the stream/poll mechanism
timing out, not the real cause, which is the silently rejected commitment described below.
(`SESSION_POLL_TIMEOUT_MS` cannot be the culprit here — it only governs the one-time wait
for the *initiator* to open the session, before `bindSession`/`subscribeSession`, and is
long past by the time a mid-session commitment is rejected.)

**Cause:** RFC-MACP-0013 §9 (runtime v0.7.0) tightened the §7.3.1 supersedes check: a
commitment whose `supersedes.commitment_hash` is not canonical — exactly `sha256:` +
64 **lowercase** hex characters — is **hard-rejected on accept, with no dual-read
window**. Because the control-plane only sees *accepted* envelopes via its read-only
`StreamSession`, and the rejection is delivered as an inline `MACPError` frame on the
**sending agent's own bidi stream** — not on the observer stream, and not as a negative
ack — the control-plane's view is a **silent absence**: the commitment
carrying the malformed `supersedes` ref simply never appears. There is no
`message.send_failed` or other error event to grep for — the symptom is purely "the run
stopped progressing." Any agent still emitting a pre-0013 placeholder hash (`"abc123"`,
uppercase hex, an uppercase `SHA256:` prefix, or a whitespace-padded value) against a
≥0.7.0 runtime hits this, and a supersession chain that crosses the version boundary is
**permanently severed** — the sender must re-emit with a canonical hash; the runtime will
not retroactively accept the old one.

**Checks:**
1. Confirm the stalled run has a commitment step expected to carry `supersedes`
   (cross-session commitment reference, RFC-MACP-0001 §7.3.1) and that no
   `decision.finalized` ever landed for it.
2. Ask the sending agent's own logs for the inline `MACPError` frame it received for the
   rejected `CommitmentPayload` send — the control-plane never observes this rejection,
   only the sending agent does.
3. If a *prior* supersedes ref did make it into the projection (e.g. from before the
   runtime was upgraded), check `GET /runs/{id}/state` → `decision.current.supersedes`:
   `canonical: false` confirms a legacy/malformed hash is in play and flags the agent
   code that needs to move to canonical hashes. Note projections written before this
   field shipped **omit `canonical` entirely** rather than reporting `false` — it is
   derived only when a new `decision.finalized` is applied, so rebuild the projection
   (`POST /runs/{id}/projection/rebuild`) if the key is absent.
4. Verify the agent computes `commitment_hash` via the runtime's canonical algorithm
   (RFC-MACP-0013 §3–4) rather than a hand-rolled placeholder — see
   [INTEGRATION.md § Commitment `supersedes.commitment_hash` must be canonical](INTEGRATION.md#commitment-supersedescommitment_hash-must-be-canonical-runtime-v070--rfc-macp-0013-9).

**Fix:** Update the sending agent to emit a canonical `sha256:` + 64-lowercase-hex value.
There is no server-side remediation — the control-plane is observer-only and cannot
repair or replay a rejected send.

## Auth-service unreachable / JWT mint failure

**Symptom:** Log line `auth_mint_failure reason=...` or `JWT mint failed; falling back to static bearer`.

**Explanation:** `MACP_AUTH_SERVICE_URL` is set, but the auth-service is down, returned non-2xx, or its response was unparseable. The credential resolver automatically falls back to `RUNTIME_BEARER_TOKEN` for this call.

**Checks:**
1. Is the auth-service reachable? `curl -X POST $MACP_AUTH_SERVICE_URL/tokens -d '{}' -H 'content-type: application/json'` (expect a 4xx response, not a connection error).
2. Is `RUNTIME_BEARER_TOKEN` set as a fallback? Without it the call proceeds with the deprecated dev bearer (`Authorization: Bearer ${RUNTIME_DEV_AGENT_ID}`) when `RUNTIME_USE_DEV_HEADER=true`, which only a dev-mode runtime (`MACP_ALLOW_INSECURE=1`) accepts — otherwise it fails auth on the runtime side.
3. If the auth-service is healthy but calls still fail, check `MACP_AUTH_SERVICE_TIMEOUT_MS` (default 5000 ms) — slow auth-services can time out under load.

**See also:** [macp-runtime/docs/getting-started.md#authentication](../../macp-runtime/docs/getting-started.md#authentication) → *Resolver order* for how the runtime evaluates inbound credentials, and [ARCHITECTURE.md § Runtime Credential Resolution](./ARCHITECTURE.md#runtime-credential-resolution) for the control-plane side of the chain.

## bindSession ConflictException in logs

**Symptom:** Log line `bindSession no-op for run <uuid>: cannot transition ... (current status=running)`.

**Explanation:** Not an error. Two paths can race to bind the same run — `RunExecutorService` for `POST /runs`-created runs, and `SessionDiscoveryService` for runs auto-discovered via `WatchSessions`. Whichever arrives second sees the run already past `binding_session`. As of the `subscribe-session` PR, the second call is a logged no-op; it no longer crashes the process.

**When to investigate:** only if you see this repeatedly for the *same* runId — that would indicate a loop somewhere retrying the bind. A single occurrence per run is normal.

## Legacy Write Endpoints Return 410 Gone

**Symptom:** `POST /runs/:id/messages`, `/signal`, or `/context` returns `410 Gone` with `errorCode: ENDPOINT_REMOVED`.

**Explanation:** The control-plane is observer-only as of the 2026-04-15 direct-agent-auth refactor. Agents authenticate to the runtime directly and emit their own envelopes via `macp-sdk-python` / `macp-sdk-typescript`. See `docs/API.md` § "Messages & Signals — emission is NOT via the control-plane" for the mapping, and the SDK guides for the new agent flow: [macp-sdk-python direct-agent-auth](../../macp-sdk-python/docs/guides/direct-agent-auth.md), [macp-sdk-typescript agent-framework](../../macp-sdk-typescript/docs/guides/agent-framework.md).

## Agent Envelopes Not Appearing in Projection

**Symptom:** Agents call `session.send(...)` via the SDK but events don't appear in `GET /runs/:id/state`.

**Checks:**
1. Confirm the run's `runtimeSessionId` matches the `session_id` the agent is writing to (`GET /runs/:id`).
2. Check stream consumer logs for `StreamSession` reconnection loops — the observer subscribes read-only and must be connected.
3. Confirm the runtime echoes envelopes back on the stream (some runtimes only echo certain message types). `signal.emitted` and `message.sent` canonical events require `stream-envelope` entries on the observer stream. See [macp-runtime/docs/API.md#message-transport](../../macp-runtime/docs/API.md#message-transport) for StreamSession semantics and [macp-runtime/docs/sdk-guide.md#streaming](../../macp-runtime/docs/sdk-guide.md#streaming) for the observer lifecycle.
4. For session discovery, verify `SESSION_DISCOVERY_ENABLED=true` so externally-launched sessions auto-create runs. Concepts: [macp-sdk-python/docs/guides/session-discovery.md](../../macp-sdk-python/docs/guides/session-discovery.md).

## SSE Stream Drops

**Symptom:** Live stream disconnects frequently

**Checks:**
1. Check heartbeat interval: `STREAM_SSE_HEARTBEAT_MS` (default 15s)
2. Ensure no proxy/load balancer is timing out idle connections
3. Check `STREAM_IDLE_TIMEOUT_MS` (default 120s)
4. Client should handle reconnection using `Last-Event-Id` header

## High Memory Usage

**Causes:**
- Too many active SSE subscribers — StreamHub cleans up idle subjects after 60s
- Large replay queries — batch size configurable via `REPLAY_BATCH_SIZE` (default 500)
- Database connection pool exhaustion — check `DB_POOL_MAX` (default 20)
- Event accumulation — check `STREAM_MAX_RETRIES` for stuck reconnection loops

## Docker Build Fails Resolving @multiagentcoordinationprotocol/proto

**Symptom:** `docker build` fails during `npm ci` with a 401/404 from `npm.pkg.github.com`, or `cat: /run/secrets/npm_token: No such file or directory`.

**Explanation:** The private proto package installs from GitHub Packages, and the Dockerfile reads the token from a **BuildKit secret** (`npm_token`) — not a build-arg.

**Fix:**
```bash
docker build --secret id=npm_token,env=GITHUB_TOKEN -t macp-control-plane .
# docker compose: export GITHUB_TOKEN (classic PAT with read:packages) first
```

## Production Deploy Fails Health Check

**Symptom:** `deploy.sh deploy <tag>` exits with "app did not become healthy".

**Checks:**
1. `TAG=<tag> docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod logs app`
2. Most common cause: missing REQUIRED values in `.env.prod` (`AUTH_API_KEYS`, `DATABASE_URL`) — production config validation fails fast at startup.
3. `RUNTIME_TLS=false` without `RUNTIME_ALLOW_INSECURE=true` is rejected in production.
4. Did the `migrate` one-shot succeed? `docker compose ... ps -a` — a failed migration blocks `app` startup.
5. Roll back only if the release contained no schema changes: `./deploy.sh rollback` (migrations are forward-only).

## Integration Test Issues

**Test DB connection fails:**
- Start test postgres: `docker compose -f docker-compose.test.yml up -d postgres-test`
- Test DB uses port 5433 (not 5432) to avoid conflict with dev DB

**Real runtime tests fail with `InvalidPayload`:**
- Use `payloadEnvelope` with proto encoding instead of plain `payload`
- Set `INTEGRATION_RUNTIME=remote` and `RUNTIME_ADDRESS=127.0.0.1:50051`

**Prometheus metric re-registration error:**
- Tests that create multiple NestJS apps must call `promClient.register.clear()` between apps

**"Test suite failed to run" even though every assertion passed:**
- Teardown leak — background observation services (`StreamConsumerService`, `SignalConsumerService`, `SessionDiscoveryService`) had in-flight `persistRawAndCanonical` work when the DB pool closed. Fixed by `test/helpers/test-app.ts` → `drainBackgroundWork()` which awaits each service's bounded drain before Nest's own `onModuleDestroy` sweep. If you see this in a *new* test, make sure you created the app via `createTestApp(...)` so the `app.close()` wrapper is in place.

## Running a local macp-runtime for verification

Some behavior (e.g. `ListSessions` pagination across a large session store) can only be verified against a real macp-runtime — the mock runtime used by default in `npm run test:integration` never returns a paginated response. To run one locally:

1. Build the runtime binary (there is no prebuilt binary; the toolchain is pinned in `../macp-runtime/rust-toolchain.toml`):
   ```bash
   cd ../macp-runtime && cargo build --bin macp-runtime
   ```
2. Start it against its persisted session store:
   ```bash
   MACP_ALLOW_INSECURE=1 MACP_BIND_ADDR=127.0.0.1:50051 RUST_LOG=info \
     ./target/debug/macp-runtime
   ```
   - `MACP_ALLOW_INSECURE=1` is **mandatory** — without auth configured the runtime refuses to start — and it also waives the TLS requirement. In this mode the runtime accepts any `Authorization: Bearer <v>` as sender `<v>`, so the control-plane's existing dev-bearer fallback (`RUNTIME_USE_DEV_HEADER`) works unchanged.
   - Omit `MACP_MEMORY_ONLY` if you want the persisted `.macp-data` store loaded at boot, but **that store is not sufficient by itself for pagination testing**: as of this writing it holds 131 persisted sessions, and *all* of them are terminal (Resolved/Expired/Cancelled). On startup the runtime logs `evicted stale sessions from memory (registry + log cache + stream bus) count=131` — it evicts terminal sessions older than a cutoff (`../macp-runtime/src/runtime.rs:1200-1237`) — and `ListSessions`/`GetSession` return nothing for them afterward. Verify this yourself before trusting a persisted-store session count (the runtime does not support gRPC reflection, so use `grpcurl` with the checked-in proto):
     ```bash
     grpcurl -plaintext \
       -import-path node_modules/@multiagentcoordinationprotocol/proto/proto \
       -proto macp/v1/core.proto \
       -H 'Authorization: Bearer macp-control-plane' \
       -d '{}' 127.0.0.1:50051 macp.v1.MACPRuntimeService/ListSessions
     ```
   - To actually exceed a `ListSessions` page you must **seed live (OPEN) sessions** using an agent-role client — the control-plane must never emit envelopes itself (see the observer-only invariant above), so seeding has to go through `macp-sdk-python`/`macp-sdk-typescript` or a raw gRPC client acting as an agent, calling `SessionStart` directly against the runtime. Note the page size that matters here is the **control-plane's own** `RUNTIME_LIST_SESSIONS_PAGE_SIZE` (default 200) — the CP always sends an explicit `pageSize` on every `ListSessions` call, so the runtime's own server-side default (100) never applies once the CP is the caller. Gotchas that cost real debugging time when doing this:
     - The mode id is `macp.mode.decision.v1` — **not** `macp.mode.decision`.
     - `SessionStartPayload.configuration_version` **and** `mode_version` are both mandatory and must be non-empty strings (`../macp-runtime/crates/macp-core/src/session.rs:344-346`); an empty string is rejected, it is not treated as "use default".
     - The ack success field on the response is `ok` — **not** `accepted`.
     - `MACP_SESSION_START_LIMIT_PER_MINUTE` defaults to 60 **per sender**, so seeding more than 60 sessions in a minute requires spreading the `SessionStart` calls across distinct sender identities (distinct Bearer values), not just looping as one sender.
3. Run the control-plane's integration suite against it:
   ```bash
   INTEGRATION_RUNTIME=remote RUNTIME_ADDRESS=127.0.0.1:50051 \
     RUNTIME_LIST_SESSIONS_PAGE_SIZE=50 npm run test:integration
   ```
   Specs gated with `test/helpers/real-runtime-gate.ts` (`describeWithRealRuntime`) — e.g. `test/integration/list-sessions-pagination.integration.spec.ts` — only run in this mode; they are skipped, not failed, under the default mock runtime.
   - The live pagination spec asserts `pagesFetched > 1`, which requires the seeded store to span **more than one page at the control-plane's configured page size**. This doc does not prescribe a session count, so check what your store actually holds: if it is smaller than the default `RUNTIME_LIST_SESSIONS_PAGE_SIZE` (200), the whole store fits in one page and the spec fails with its "only fetched 1 page(s)" guard. There are two remedies, and you only need one: lower `RUNTIME_LIST_SESSIONS_PAGE_SIZE` (e.g. `=50`, as above, which spans multiple pages for any store above 50), or seed more than 200 live sessions so the default page size itself spans multiple pages.

## Common Error Codes

| Code | HTTP | Meaning |
|------|------|---------|
| `RUN_NOT_FOUND` | 404 | Run ID does not exist |
| `INVALID_STATE_TRANSITION` | 409 | Cannot transition run to requested state |
| `RUNTIME_UNAVAILABLE` | 502 | Cannot connect to gRPC runtime |
| `RUNTIME_TIMEOUT` | 504 | gRPC call exceeded deadline |
| `CIRCUIT_BREAKER_OPEN` | 503 | Runtime circuit breaker is open |
| `STREAM_EXHAUSTED` | 500 | Max stream reconnection retries reached |
| `SESSION_EXPIRED` | 410 | Runtime session has expired |
| `MODE_NOT_SUPPORTED` | 400 | Runtime does not support requested mode |
| `VALIDATION_ERROR` | 400 | Request body validation failed |
| `INVALID_SESSION_ID` | 400 | Session ID not recognized by runtime |
| `UNKNOWN_POLICY_VERSION` | 400 | Policy version not found in registry |
| `POLICY_DENIED` | 403 | Commitment rejected by policy rules |
| `INVALID_POLICY_DEFINITION` | 400 | Policy rules fail schema validation |
| `SESSION_ALREADY_EXISTS` | 409 | Duplicate session start attempt |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
