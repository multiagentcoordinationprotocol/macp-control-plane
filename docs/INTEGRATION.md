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

### Observer authorization contract (is_observer: configured token or JWT scope)

This is the single most important fact for deploying the control-plane against a
real runtime: **get it wrong and the control-plane cannot observe any session it
did not itself start** (and it never starts any — it is observer-only).

`GetSession` and `StreamSession`'s subscribe path both enforce the same three-way
rule, but through two separate, independent code paths — the mechanism and the
denial message differ:

- **`GetSession`** authorizes via `authenticate_session_access`
  (`macp-runtime/src/server.rs:261-291`; its only call site is the `get_session`
  RPC handler, `macp-runtime/src/server.rs:900-906`). A denial returns
  `PERMISSION_DENIED`, message `"FORBIDDEN: session access denied"`.
- **`StreamSession`'s subscribe path** authorizes inline in
  `process_subscribe_frame` (defined at `macp-runtime/src/server.rs:456`; the
  authorization + policy-engine block is `:480-494`) — it duplicates the same
  rule rather than calling `authenticate_session_access`. A denial returns a
  **different** message: `PERMISSION_DENIED`, `"FORBIDDEN: caller is not a
  declared participant or observer for this session"`. When grepping runtime
  logs, use the string that matches the RPC you're diagnosing.

Both paths allow the request only if the authenticated identity is **any one**
of —

1. `identity.is_observer == true`, **or**
2. the session's `initiator_sender`, **or**
3. a session participant.

`identity.is_observer` is the *first* disjunct checked on both paths — it is
always evaluated, never skipped. Both paths also apply a second, independent
fail-closed gate immediately after this check: the optional E3 ingress policy
engine (`server.rs:286-289` for `GetSession`, `server.rs:489-492` for the stream
path), which can additionally restrict a read that already passed the three-way
rule.

The control-plane, being observer-only (it never calls `Send`, so it is never an
initiator or participant — see "Adding a Runtime Provider" above), can satisfy
**only condition 1** on either path. If `is_observer` is `false` on its
credential, every `GetSession`/`StreamSession` call the control-plane makes for a
session it did not start is rejected.

**How this actually surfaces — fails fast, and correctly.**
`RunExecutorService.pollForOpenSession`
(`src/runs/run-executor.service.ts:391-430`) only swallows-and-retries an error
that is **not** an `AppException` (`:414`, `if (pollError instanceof
AppException) throw pollError;`) — the design intent being that a raw `NotFound`
while the initiator hasn't opened the session yet is expected and gets logged at
`debug` (`:415-418`). But `RustRuntimeProvider.unary` maps *every* gRPC failure
through `mapGrpcError` before the poll loop ever sees it
(`src/runtime/rust-runtime.provider.ts:928`, `throw mapGrpcError(error, method)
?? error;`), and `mapGrpcError` maps `PERMISSION_DENIED` to
`AppException(ErrorCode.FORBIDDEN, …, 403)` (`src/runtime/grpc-helpers.ts:147`,
`GRPC_STATUS_TO_HTTP`), preserving the runtime's `details` string verbatim as the
exception message. So a mis-scoped credential is **not** retried until
`SESSION_POLL_TIMEOUT_MS` — it is rethrown on the *first* `GetSession` attempt.
`handleExecuteError` (`:432`) falls through to `markFailed(runId, error)`
(`:465`), and the run's failure reason is the runtime's own message (e.g.
`FORBIDDEN: session access denied`), not a generic `RUNTIME_TIMEOUT`. This is the
good case: it fails loudly, on the first attempt, and the failure reason names
the real cause — when triaging, check the run's failure reason for the runtime's
`FORBIDDEN` string before assuming the initiator agent never showed up.

  > Out of scope here (a pre-existing code issue, not a docs issue): the
  > `debug`-level comment at `run-executor.service.ts:415` ("`NotFound` ... is
  > normal") is stale, because `NOT_FOUND` is *also* now mapped to an
  > `AppException` by `mapGrpcError` and so takes the `throw pollError` branch
  > above it rather than ever reaching the `debug` log below. Worth filing
  > separately.

**`is_observer: true` comes from a configured static token entry *or* the
`macp_scopes` claim on a minted JWT — never from the runtime's dev-auth
fallback.** `authenticate_metadata` (`security.rs:408-433`) tries, in order:

1. **The auth resolver chain** (`auth_chain`, `security.rs:415-417`) — checked
   first, before `self.identities` is ever consulted. This is the path a minted
   JWT takes: the `jwt_bearer` resolver sets
   `is_observer: scopes.is_observer.unwrap_or(false)` straight from the token's
   **`macp_scopes` claim**
   (`macp-runtime/crates/macp-auth/src/auth/resolvers/jwt_bearer.rs:314`) —
   independent of the static token map below.
2. **A configured static token map** (`self.identities`, populated from
   `MACP_AUTH_TOKENS_FILE`/`MACP_AUTH_TOKENS_JSON`) — each entry carries its own
   `is_observer` boolean (see schema below).
3. **`dev_authenticate`** (`macp-runtime/crates/macp-auth/src/security.rs:136-148`)
   — the path taken when the runtime is started with `MACP_ALLOW_INSECURE=1` and
   neither of the above is configured. Accepts *any* bearer value as an identity
   but hardcodes `is_observer: false` unconditionally (`security.rs:144`).

Concretely:

- **Local/dev** (`MACP_ALLOW_INSECURE=1`, no token file/JSON, no
  `MACP_AUTH_SERVICE_URL`): the control-plane's `RUNTIME_USE_DEV_HEADER=true`
  dev-bearer fallback reaches `dev_authenticate`, where `is_observer` is always
  `false` — the runtime still checks `is_observer` on every call (condition 1
  above is always evaluated, on both `GetSession` and the stream path); it just
  always evaluates `false` for a dev-auth identity. The dev-bearer fallback only
  *appears* to work when the dev bearer's value happens to equal the session's
  `initiator_sender` (condition 2), which is coincidental, not a guarantee.
- **Production**: a `RUNTIME_BEARER_TOKEN` must resolve, via a matching entry in
  the runtime's configured token map, to `is_observer: true`; a JWT minted via
  `MACP_AUTH_SERVICE_URL` must carry `macp_scopes.is_observer: true`. A
  `RUNTIME_BEARER_TOKEN` that matches a configured entry with
  `can_start_sessions: false` but no `is_observer: true` will authenticate
  successfully yet fail every `GetSession`/`StreamSession` call for a session it
  did not start — this fails silently at the auth layer (no config-time error)
  and, per "How this actually surfaces" above, shows up immediately as the run's
  failure reason rather than as a delayed timeout.

**Token config schema** (`RawIdentity`, `macp-runtime/crates/macp-auth/src/security.rs:21-33`,
loaded from `MACP_AUTH_TOKENS_FILE` or `MACP_AUTH_TOKENS_JSON`, either a bare list
or `{"tokens": [...]}`, per `RawConfig` at `security.rs:35-40`):

```jsonc
{
  "tokens": [
    {
      "token": "...",                 // the bearer value
      "sender": "macp-control-plane", // see sender-match note below
      "allowed_modes": [],            // optional, default: all modes
      "can_start_sessions": false,    // default: true — set false for an observer
      "max_open_sessions": null,      // optional
      "can_manage_mode_registry": false, // default: false
      "is_observer": true             // default: false — REQUIRED for the control-plane
    }
  ]
}
```

**Sender-match enforcement (agent tokens, not the control-plane's).** For any RPC
that carries an envelope with a non-empty `sender` field — `Send` (which agents
call directly — the control-plane never does) and `StreamSession` envelope
frames — `apply_authenticated_sender` (`macp-runtime/src/server.rs:223-232`,
called at `:243` for `Send` and again at `:400` for the stream path) rejects the
call `UNAUTHENTICATED` if `envelope.sender != identity.sender`. In dev-auth the
bearer value literally *is* `identity.sender` (`security.rs:138-139`), so they
match by construction and this never surfaces there; with configured tokens, an
agent's `sender` field must equal the `sender` on its configured token entry.

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
