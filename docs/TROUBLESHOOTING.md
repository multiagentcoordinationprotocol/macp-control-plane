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

## Legacy Write Endpoints Return 410 Gone

**Symptom:** `POST /runs/:id/messages`, `/signal`, or `/context` returns `410 Gone` with `errorCode: ENDPOINT_REMOVED`.

**Explanation:** The control-plane is observer-only as of the 2026-04-15 direct-agent-auth refactor. Agents authenticate to the runtime directly and emit their own envelopes via `macp-sdk-python` / `macp-sdk-typescript`. See `docs/API.md` § "Messages & Signals — emission is NOT via the control-plane" for migration guidance.

## Agent Envelopes Not Appearing in Projection

**Symptom:** Agents call `session.send(...)` via the SDK but events don't appear in `GET /runs/:id/state`.

**Checks:**
1. Confirm the run's `runtimeSessionId` matches the `session_id` the agent is writing to (`GET /runs/:id`).
2. Check stream consumer logs for `StreamSession` reconnection loops — the observer subscribes read-only and must be connected.
3. Confirm the runtime echoes envelopes back on the stream (some runtimes only echo certain message types). `signal.emitted` and `message.sent` canonical events require `stream-envelope` entries on the observer stream.
4. For session discovery, verify `SESSION_DISCOVERY_ENABLED=true` so externally-launched sessions auto-create runs.

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

## Integration Test Issues

**Test DB connection fails:**
- Start test postgres: `docker compose -f docker-compose.test.yml up -d postgres-test`
- Test DB uses port 5433 (not 5432) to avoid conflict with dev DB

**Real runtime tests fail with `InvalidPayload`:**
- Use `payloadEnvelope` with proto encoding instead of plain `payload`
- Set `INTEGRATION_RUNTIME=remote` and `RUNTIME_ADDRESS=127.0.0.1:50051`

**Prometheus metric re-registration error:**
- Tests that create multiple NestJS apps must call `promClient.register.clear()` between apps

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
