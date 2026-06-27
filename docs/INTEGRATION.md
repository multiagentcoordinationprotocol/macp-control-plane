# MACP Control Plane — Integration Guide

## Adding a Runtime Provider

1. Implement the `RuntimeProvider` interface from `src/contracts/runtime.ts`
2. Register it as a NestJS provider in `app.module.ts`
3. Add it to `RuntimeProviderRegistry` so it can be looked up by `kind`

Key methods to implement (observer-only surface, post direct-agent-auth):
- `initialize()` — protocol version negotiation.
- `subscribeSession({runId, runtimeSessionId, afterSequence?})` — read-only `StreamSession` observer; returns `{events, abort}`. **Never writes envelopes.** Per RFC-MACP-0006 §3.2 the provider writes exactly one passive-subscribe frame (`{subscribeSessionId, afterSequence}`) and **keeps the write side open** for the session's lifetime. Half-closing would signal "client is done" and cause the runtime to drop every envelope broadcast afterwards. The runtime replays accepted history from `afterSequence` (default 0 = full replay) then switches to live broadcast. See [macp-runtime/docs/sdk-guide.md#streaming](../../macp-runtime/docs/sdk-guide.md#streaming) and [macp-runtime/docs/API.md#message-transport](../../macp-runtime/docs/API.md#message-transport) for the canonical stream lifecycle.
- `watchSessions()` — returns an `AsyncIterable<SessionLifecycleEvent>` for `created` / `resolved` / `expired` events. Backs `SessionDiscoveryService`. Canonical RPC: [macp-runtime/docs/API.md#session-lifecycle](../../macp-runtime/docs/API.md#session-lifecycle); SDK-side discovery patterns: [macp-sdk-python/docs/guides/session-discovery.md](../../macp-sdk-python/docs/guides/session-discovery.md).
- `watchSignals()` — returns an `AsyncIterable<RawRuntimeEvent>` of ambient Signal/Progress envelopes off the runtime's `signal_bus`. Backs `SignalConsumerService` — token-usage signals (`llm.call.completed`) arrive here, not on per-session streams. See [macp-runtime/docs/API.md#streaming-watches](../../macp-runtime/docs/API.md#streaming-watches).
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

## Authenticating to the runtime

Per-gRPC-call credential resolution uses a three-step fallback chain:

| Mode | Trigger | Control-plane env vars |
| --- | --- | --- |
| **JWT mint (preferred)** | `MACP_AUTH_SERVICE_URL` set | `MACP_AUTH_SERVICE_URL`, `MACP_AUTH_SERVICE_TIMEOUT_MS` (5000), `MACP_AUTH_TOKEN_TTL_SECONDS` (3600), `MACP_AUTH_TOKEN_SENDER` (`control-plane`) |
| **Static Bearer** | JWT disabled or mint failed | `RUNTIME_BEARER_TOKEN` |
| **Dev header** (local only) | `RUNTIME_USE_DEV_HEADER=true` | `RUNTIME_DEV_AGENT_ID` (`control-plane`) |

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
