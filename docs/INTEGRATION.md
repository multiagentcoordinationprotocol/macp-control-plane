# MACP Control Plane — Integration Guide

## Adding a Runtime Provider

1. Implement the `RuntimeProvider` interface from `src/contracts/runtime.ts`
2. Register it as a NestJS provider in `app.module.ts`
3. Add it to `RuntimeProviderRegistry` so it can be looked up by `kind`

Key methods to implement (observer-only surface, post direct-agent-auth):
- `initialize()` — protocol version negotiation.
- `subscribeSession({runId, runtimeSessionId, afterSequence?})` — read-only `StreamSession` observer; returns `{events, abort}`. **Never writes envelopes.** Per RFC-MACP-0006 §3.2 the provider writes exactly one passive-subscribe frame (`{subscribeSessionId, afterSequence}`) and **keeps the write side open** for the session's lifetime. Half-closing would signal "client is done" and cause the runtime to drop every envelope broadcast afterwards.
  - **`after_sequence` contract (runtime v0.5.0):** `after_sequence` is the **1-based accepted-envelope ordinal** and is **exclusive** — the runtime replays accepted history *strictly after* it, then switches to live broadcast. `0` (the default) replays from the start. The ordinal is now **stable across compaction** (it no longer shifts). Resuming below the compacted base returns `FAILED_PRECONDITION` (`"session history before ordinal {base} was compacted; resume with after_sequence >= {base} or re-read state via GetSession"`); the control-plane handles this by degrading to a `GetSession` poll and emitting a `session.stream.gap` control event (see `STREAM_RESUME_ENABLED`). **Do not** pass the CP-side canonical event sequence (`lastStreamCursor`) here — it is a different counter; use the persisted envelope ordinal.
  - **Lag termination:** a `StreamSession` (like `WatchSignals`/`WatchSessions`) terminates with `RESOURCE_EXHAUSTED` if the receiver falls too far behind. The consumer treats this like any other stream error and reconnects/resubscribes.

  See [macp-runtime/docs/sdk-guide.md#streaming](../../macp-runtime/docs/sdk-guide.md#streaming) and [macp-runtime/docs/API.md#message-transport](../../macp-runtime/docs/API.md#message-transport) for the canonical stream lifecycle.
- `watchSessions()` — returns an `AsyncIterable<SessionLifecycleEvent>` for `created` / `resolved` / `expired` events. Backs `SessionDiscoveryService`. Canonical RPC: [macp-runtime/docs/API.md#session-lifecycle](../../macp-runtime/docs/API.md#session-lifecycle); SDK-side discovery patterns: [macp-sdk-python/docs/guides/session-discovery.md](../../macp-sdk-python/docs/guides/session-discovery.md).
- `watchSignals()` — returns an `AsyncIterable<RawRuntimeEvent>` of ambient Signal/Progress envelopes off the runtime's `signal_bus`. Backs `SignalConsumerService` — token-usage signals (`llm.call.completed`) arrive here, not on per-session streams. See [macp-runtime/docs/API.md#streaming-watches](../../macp-runtime/docs/API.md#streaming-watches). **Auth (runtime v0.5.0):** `WatchSignals` now requires authentication like every other RPC — an unauthenticated (or dev-header-only) call is rejected, so ensure a bearer/JWT (or the dev-bearer fallback) is configured or `SignalConsumerService` will hot-loop reconnects.
- `getSession()` — poll for session state (used by the observer's `pollForOpenSession` loop).
- `cancelSession()` — only called when `run.metadata.cancellationDelegated === true` (Option B in direct-agent-auth §Cancellation design).
- `getManifest()` / `listModes()` / `listRoots()` / `health()` — metadata.
- `registerPolicy()` / `unregisterPolicy()` / `getPolicy()` / `listPolicies()` — governance. Rule schemas and evaluation semantics: [macp-runtime/docs/policy.md](../../macp-runtime/docs/policy.md) (RFC-MACP-0012).

## Agents emit envelopes directly

Agents authenticate to the runtime with their own Bearer tokens (RFC-MACP-0004 §4) and emit envelopes via `macp-sdk-python` / `macp-sdk-typescript`. The control-plane never brokers agent envelopes — the old HTTP escalation endpoints (`POST /runs/:id/{messages,signal,context}`) now return **410 Gone**.

For the agent-side bootstrap and how `sessionId` flows from `POST /runs` to the initiator and non-initiator agents, see:

- **Python SDK** — [guides/direct-agent-auth.md](../../macp-sdk-python/docs/guides/direct-agent-auth.md) (bootstrap shape, initiator vs non-initiator, `expected_sender`, cancellation) and [guides/agent-framework.md](../../macp-sdk-python/docs/guides/agent-framework.md) (`from_bootstrap` factory + handler context)
- **TypeScript SDK** — [README.md § Agent Framework](../../macp-sdk-typescript/README.md#agent-framework) and [docs/guides/agent-framework.md](../../macp-sdk-typescript/docs/guides/agent-framework.md) (`fromBootstrap()` + strategies)
- **Migration** — `../../macp-ui-console/plans/direct-agent-auth.md` (end-to-end story of the 2026-04-15 refactor)

### Commitment `supersedes.commitment_hash` must be canonical (runtime v0.7.0 / RFC-MACP-0013 §9)

A ≥0.7.0 runtime hard-rejects any `CommitmentPayload.supersedes.commitment_hash` that
is not exactly `sha256:` followed by 64 **lowercase** hex characters — uppercase hex,
an uppercase `SHA256:` prefix, the wrong length, or whitespace padding are all
rejected. There is **no dual-read/transitional window**: this is checked unconditionally
on accept, so a pre-0013 placeholder value (`"abc123"`, an uppercase digest, etc.) that
used to be accepted will now be rejected outright.

Agents building a `supersedes` reference must compute the hash with the runtime's
`commitment_hash` function (`macp-core::commitment_hash`, RFC-MACP-0013 §3–4) rather
than inventing a placeholder — the SDKs expose this so callers don't hand-roll it. The
canonicalization algorithm (projection, RFC 8785/JCS key ordering, domain-separated
SHA-256) is documented in the module doc comment at
[`macp-runtime/crates/macp-core/src/commitment_hash.rs`](../../macp-runtime/crates/macp-core/src/commitment_hash.rs)
if you need to reproduce it outside an SDK; the SDK mirrors are
[`macp-sdk-python/src/macp_sdk/commitment_hash.py`](../../macp-sdk-python/src/macp_sdk/commitment_hash.py)
and [`macp-sdk-typescript/src/commitment-hash.ts`](../../macp-sdk-typescript/src/commitment-hash.ts).

The control-plane projects a derived `decision.current.supersedes.canonical: boolean`
so an insight UI can badge a non-canonical value it observes in replayed pre-0013
history — this is observational only, the control-plane never rejects or drops it. See
[TROUBLESHOOTING.md § Run stalls with no `decision.finalized`](TROUBLESHOOTING.md#run-stalls-with-no-decisionfinalized-non-canonical-supersedes-hash)
for the failure mode this causes when a legacy hash is sent against a ≥0.7.0 runtime.

## Authenticating to the runtime

Per-gRPC-call credential resolution uses a three-step fallback chain:

| Mode | Trigger | Control-plane env vars |
| --- | --- | --- |
| **JWT mint (preferred)** | `MACP_AUTH_SERVICE_URL` set | `MACP_AUTH_SERVICE_URL`, `MACP_AUTH_SERVICE_TIMEOUT_MS` (5000), `MACP_AUTH_TOKEN_TTL_SECONDS` (3600), `MACP_AUTH_TOKEN_SENDER` (`control-plane`) |
| **Static Bearer** | JWT disabled or mint failed | `RUNTIME_BEARER_TOKEN` |
| **Dev bearer** *(deprecated, local only)* | `RUNTIME_USE_DEV_HEADER=true` | `RUNTIME_DEV_AGENT_ID` (`control-plane`) sent as `Authorization: Bearer <id>` — runtime v0.5.0 removed the `x-macp-agent-id` header |

Mint behaviour: token cached until expiry minus 30s refresh buffer minus 10s clock-skew, concurrent refreshes deduped, mint failures log `auth_mint_failure` and fall through to the static Bearer. For the runtime-side token shape (`MACP_AUTH_TOKENS_JSON`), TLS/mTLS, and the JWT claim expectations, see [macp-runtime/docs/getting-started.md#authentication](../../macp-runtime/docs/getting-started.md#authentication) and [macp-runtime/docs/deployment.md#authentication](../../macp-runtime/docs/deployment.md#authentication).

## Consuming SSE Streams

```bash
# Subscribe to live events (with initial state snapshot)
curl -N -H 'Authorization: Bearer <key>' \
  'http://localhost:3001/runs/{id}/stream?includeSnapshot=true'

# Resume from a specific sequence
curl -N -H 'Authorization: Bearer <key>' \
  -H 'Last-Event-Id: 42' \
  'http://localhost:3001/runs/{id}/stream'
```

SSE event types:
- `snapshot` — full `RunStateProjection` at connection time
- `canonical_event` — individual event (id = sequence number for resume)
- `heartbeat` — keep-alive every 15s (configurable)

## Using the Replay API

```bash
# Create replay descriptor
curl -X POST http://localhost:3001/runs/{id}/replay \
  -H 'Content-Type: application/json' \
  -d '{"mode": "timed", "speed": 2}'

# Stream replay
curl -N "http://localhost:3001/runs/{id}/replay/stream?mode=timed&speed=2"

# Get state at specific sequence (for timeline scrubber)
curl http://localhost:3001/runs/{id}/replay/state?seq=42
```

Replay modes: `timed` (proportional timing), `step` (all at once), `instant` (no delay).

## Adding Coordination Modes

1. Add proto definitions under `proto/macp/modes/{mode}/v1/`
2. Update `MESSAGE_TYPE_MAP` in `src/runtime/proto-registry.service.ts`
3. Update `deriveEventType()` in `src/events/event-normalizer.service.ts` for new message types
4. Add mode to `test/helpers/scripted-mock-runtime.provider.ts` supported modes list (integration tests)
5. Add a projection reducer branch in `src/projection/projection.service.ts` — the `projection-coverage.spec.ts` invariant will fail CI otherwise

## Webhooks

Register webhooks for run lifecycle events:

```bash
# Create webhook
curl -X POST http://localhost:3001/webhooks \
  -H 'Content-Type: application/json' \
  -d '{ "url": "https://example.com/webhook", "events": ["run.completed"], "secret": "my-hmac-secret" }'

# Update webhook
curl -X PATCH http://localhost:3001/webhooks/{id} \
  -H 'Content-Type: application/json' \
  -d '{ "active": false }'
```

Webhook deliveries include `X-MACP-Signature` (HMAC-SHA256) and `X-MACP-Event` headers.

## Running Integration Tests

```bash
# Start the test Postgres (port 5433 — separate from the dev DB on 5432)
docker compose -f docker-compose.test.yml up -d postgres-test

# Mock runtime (fast, no external dependencies)
npm run test:integration

# Real Rust runtime (needs runtime on port 50051)
INTEGRATION_RUNTIME=remote RUNTIME_ADDRESS=127.0.0.1:50051 npm run test:integration
```

The integration suites cover the full run lifecycle plus suspend/resume, webhook
delivery (HMAC + retry against a local receiver), replay, retention purge,
stream-gap recovery, batch operations, and SSE resume. Deterministic mock
scripting lives in `test/helpers/scripted-mock-runtime.provider.ts` — a
`RuntimeScript` is a list of `{ delayMs, event }` steps (and `{ error: { code } }`
steps to simulate stream failures like a compacted-history `FAILED_PRECONDITION`);
`test/helpers/webhook-receiver.ts` is a throwaway HTTP server for asserting
webhook payloads and signatures.

See `test/integration/` for the suites and `test/helpers/test-app.ts` for the NestJS boot
harness. The harness wraps `app.close()` so every `afterAll` hook runs
`drainBackgroundWork()` first — force-terminating in-progress runs, then awaiting
`StreamConsumerService`, `SessionDiscoveryService`, and `SignalConsumerService` drains
before the DB pool closes. Without this, pending `persistRawAndCanonical` chain entries
would race the pool teardown and surface as "Test suite failed to run" even when every
assertion passed.

Python agent E2E tests live in the `macp-playground` repo and run against the runtime
directly via `macp-sdk-python` — see `macp-playground/README.md`.

## Environment Variables

See `.env.example` for all configurable variables with descriptions and defaults.

### `listSessions()` pagination (runtime v0.7.0 absorption, Phase 2)

`RustRuntimeProvider.listSessions()` drains the runtime's paginated `ListSessions`
RPC and returns `{ sessions, complete, pagesFetched }` — `complete: false` means
the drain stopped early (page cap or overall timeout) and `sessions` is a
prefix, not the whole set.

| Variable | Default | Purpose |
|----------|---------|---------|
| `RUNTIME_LIST_SESSIONS_PAGE_SIZE` | 200 | Explicit page size sent on each `ListSessions` call. Deliberately below the runtime's max of 1000: the gRPC client has no channel options, so grpc-js's default 4 MB `max_receive_message_length` applies, and a 1000-item page of large sessions can approach that and fail with `RESOURCE_EXHAUSTED`. Must be a positive integer. |
| `RUNTIME_LIST_SESSIONS_MAX_PAGES` | 200 | Guard against a server that never clears `next_page_token`. Exhausting it returns `complete: false` with the collected prefix, never a silent truncation. Must be a positive integer. |
| `RUNTIME_LIST_SESSIONS_TIMEOUT_MS` | 60000 | Bounds the whole drain (not each page). On expiry, returns `complete: false`. Must be a positive integer. |

On `RESOURCE_EXHAUSTED` for a single page, the provider halves the page size and
retries that same page, capped at **2 halvings across the whole drain** (so 3
attempts total at the default page size: 200 → 100 → 50), then rethrows. The cap
is deliberately below the default `RUNTIME_CIRCUIT_BREAKER_THRESHOLD` of 5: an
uncapped ladder down to a page size of 1 is 8 consecutive failures through the
*shared* circuit breaker, which opens it and disables every unrelated runtime RPC
until it resets. Any other gRPC error (or a
circuit-breaker trip) propagates and discards the pages collected so far — a
partial result from a *failing* runtime is not treated the same as a page-capped
one.
