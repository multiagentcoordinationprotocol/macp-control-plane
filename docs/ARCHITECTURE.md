# MACP Control Plane — Architecture

## System Context

The MACP Control Plane is a NestJS service that orchestrates multi-agent coordination sessions. It sits between UI clients and a runtime (currently Rust via gRPC), managing the lifecycle of coordination runs.

```
┌──────────────┐    HTTP     ┌──────────────────┐    HTTP     ┌──────────────────┐
│  UI Console  ├────────────►│   /api/proxy      ├────────────►│ Examples Service  │
│  (Next.js)   │             │   (Next.js API)   │             │ (Catalog+Compile) │
└──────┬───────┘             └────────┬──────────┘             └──────────────────┘
       │                              │
       │                              │ HTTP/SSE
       │                              ▼
       │                     ┌──────────────────┐      gRPC      ┌──────────────────┐
       └────────────────────►│  Control Plane    ├───────────────►│  MACP Runtime    │
          (via proxy)        │  (NestJS)         │◄───────────────┤  (Rust)          │
                             └────────┬──────────┘                └──────────────────┘
                                      │
                                      ▼
                               ┌──────────────┐
                               │  PostgreSQL   │
                               └──────────────┘
```

## Two Planes

MACP distinguishes between two communication planes:

```
┌─────────────────────────────────────┐    ┌───────────────────────────────────┐
│   COORDINATION PLANE (binding)       │    │   AMBIENT PLANE (non-binding)     │
│                                      │    │                                   │
│   Session-bound messages:            │    │   Signals (non-session):          │
│   SessionStart → Proposal →         │    │   - empty sessionId, empty mode   │
│   Evaluation → Vote → Commitment    │    │   - broadcast via WatchSignals    │
│                                      │    │   - progress, status, attention   │
│   Enters session history.            │    │   Does NOT enter session history.  │
│   Drives state transitions.          │    │   Used for observability.          │
└─────────────────────────────────────┘    └───────────────────────────────────┘
```

Deeper explainers: [macp-sdk-python/docs/protocol.md#two-planes-of-communication](../../macp-sdk-python/docs/protocol.md#two-planes-of-communication) (the plane-split invariant), [macp-sdk-python/docs/protocol.md#envelopes](../../macp-sdk-python/docs/protocol.md#envelopes) (envelope shape + session binding), and [macp-runtime/docs/API.md#streaming-watches](../../macp-runtime/docs/API.md#streaming-watches) (`WatchSignals` semantics on the ambient plane).

## Request Flow (observer mode — direct-agent-auth 2026-04-15)

```
POST /runs  (RunDescriptor — scenario-agnostic; see CP-1)
  → RunsController.createRun()
    → RunExecutorService.launch()
      → resolveSessionId()                   [UUID v4 allocated or validated]
      → RunManagerService.createRun(request, sessionId)   [status: queued]
      → return { runId, sessionId, status, traceId }      [synchronous 202]
      → async execute():
        → markStarted()                      [status: starting]
        → provider.initialize()              [gRPC — mode validation]
        → pollForOpenSession(sessionId)      [GetSession backoff 100ms→1s]
            ↑ waits for initiator agent to emit SessionStart directly
        → bindSession()                      [status: binding_session]
        → provider.subscribeSession()        [gRPC — read-only StreamSession]
        → markRunning()                      [status: running]
        → StreamConsumerService.start()      [begins event consumption]
```

The control-plane **never** calls `Send` — agents drive the session via their own gRPC
connection with their own Bearer tokens (RFC-MACP-0004 §4). The observer `StreamSession`
writes exactly one passive-subscribe frame (`{subscribeSessionId, afterSequence}`) per
RFC-MACP-0006 §3.2 and then **keeps the write side open**; half-closing would signal
"client is done" and cause the runtime to stop forwarding envelopes. The read-only
stream filters envelopes by `sessionId` and never writes another frame.

## Runtime Credential Resolution

Every gRPC call goes through `RuntimeCredentialResolverService`, which resolves the
control-plane's observer identity using a **three-step fallback chain**:

1. **JWT mint** (when `MACP_AUTH_SERVICE_URL` is set) — `RuntimeJwtMinterService` POSTs to `${url}/tokens` for a short-lived RS256 token with scope `{is_observer: true, can_start_sessions: false}`. Cached until expiry minus a 30s refresh buffer and 10s clock-skew; concurrent refreshes deduped via in-flight promise. Mint failures log `auth_mint_failure` and fall through.
2. **Static Bearer** — attaches `RUNTIME_BEARER_TOKEN` verbatim. Must match an entry in the runtime's `MACP_AUTH_TOKENS_JSON` with `can_start_sessions: false`.
3. **Dev header** — attaches `x-macp-agent-id: <RUNTIME_DEV_AGENT_ID>` instead of `Authorization`. Requires the runtime to enable `MACP_ALLOW_DEV_SENDER_HEADER=1`.

For token configuration on the runtime side and the resolver order as the runtime sees it, see [macp-runtime/docs/getting-started.md#authentication](../../macp-runtime/docs/getting-started.md#authentication) and [macp-runtime/docs/deployment.md#authentication](../../macp-runtime/docs/deployment.md#authentication). The minter is covered by `src/runtime/runtime-jwt-minter.service.spec.ts` (TTL refresh, concurrent-refresh dedupe, 4xx / missing-token / network failure modes).

## Event Pipeline

Two gRPC stream sources feed the same normalization pipeline:

```
                                                   ┌─→ EventRepository
                                                   │    (appendRaw + appendCanonical)
  StreamSession (per-session) ─┐                   │
                               ├→ EventNormalizer ─┼─→ ProjectionService.applyAndPersist
  WatchSignals (ambient)     ─┘  (raw → canonical)  │    (UI read model, per-run lock)
                                                   │
                                                   ├─→ MetricsService.recordEvents
                                                   │    (tokenUsage, costUsd, counts)
                                                   │
                                                   └─→ StreamHubService.publishEvent
                                                        (SSE → live UI subscribers)
```

- **`StreamConsumerService`** drives the per-session stream with idle timeout + reconnection,
  and persists a stream cursor for lossless resume.
- **`SignalConsumerService`** drives the ambient `WatchSignals` stream. Signal envelopes
  carry an empty `sessionId`; the consumer correlates each envelope to a run through the
  decoded payload's `correlation_session_id` (or `envelope.sessionId` for progress
  envelopes that are session-scoped). Without this, agent-emitted signals like
  `llm.call.completed` (token usage) would be invisible.
- **`RunEventService.persistRawAndCanonical`** runs sequence allocation, raw append,
  canonical append, and projection update inside a single DB transaction.

## Session Discovery (WatchSessions)

When `SESSION_DISCOVERY_ENABLED=true` (default), the `SessionDiscoveryService` subscribes
to the runtime's `WatchSessions` gRPC stream and auto-creates run records for sessions
started by external launchers (not via `POST /runs`). For each `created` event, it creates
a run, binds the session, subscribes the observer stream, and begins projecting events.
Terminal events (`resolved`, `expired`) finalize the auto-discovered run.

`SignalConsumerService` is gated on the same `SESSION_DISCOVERY_ENABLED` flag — if session
discovery is off, ambient signals are also ignored.

This enables the control-plane to observe and project any session the runtime hosts, even
if the launching service doesn't use the control-plane's `POST /runs` endpoint.

The three long-running observation services (`StreamConsumerService`,
`SessionDiscoveryService`, `SignalConsumerService`) each track their in-flight loop promise
and drain it on `onModuleDestroy` with a bounded 2s timeout. Reconnect sleeps are
cancellable via an aborted timer, so shutdown doesn't stall for 5s after a transient
stream end. This matters for both production graceful shutdown and integration-test
teardown — it's the fix that lets the DB pool close after all `persistRawAndCanonical`
chain entries have resolved, rather than under them. The integration-test helper
(`test/helpers/test-app.ts`) also wires `drainBackgroundWork()` into `app.close()` to
force-terminate in-progress runs before the drain.

## Message / Signal / Context — removed (direct-agent-auth CP-5/6/7)

The `POST /runs/:id/{messages,signal,context}` endpoints were removed 2026-04-15 and now
return `410 Gone` with `errorCode: ENDPOINT_REMOVED`. Agents emit envelopes directly
against the runtime using `macp-sdk-python` / `macp-sdk-typescript`. The control-plane
observes those envelopes through its read-only `subscribeSession` stream and normalizes
them into canonical events via the pipeline above.

## Layer Map

| Layer | Directory | Responsibility |
|-------|-----------|---------------|
| Controllers | `src/controllers/` | HTTP endpoints — runs, runtime, dashboard, webhooks, admin, health |
| Run Orchestration | `src/runs/` | RunManager (state machine), RunExecutor (coordination), StreamConsumer (per-session event loop), SessionDiscovery (`WatchSessions`), SignalConsumer (`WatchSignals`) |
| Runtime Abstraction | `src/runtime/` | `RuntimeProvider` interface, `RustRuntimeProvider` (gRPC), `ProtoRegistryService`, `RuntimeCredentialResolverService` (JWT → static-bearer → dev-header chain), `RuntimeJwtMinterService` (short-lived JWT mint + cache) |
| Events | `src/events/` | Normalization (raw→canonical), transactional persistence, SSE publishing |
| Projection | `src/projection/` | Applies canonical events to build UI read models (versioned) |
| Dashboard | `src/dashboard/` | Aggregated KPIs (runs, signals, tokens, cost), recent runs, runtime health, time-series charts |
| Insights | `src/insights/` | Export bundles, run comparison |
| Webhooks | `src/webhooks/` | Webhook registration, HMAC delivery, retry logic |
| Audit | `src/audit/` | Administrative action logging |
| Storage | `src/storage/` | Drizzle repository per entity |
| DB | `src/db/` | Drizzle client as `@Global` NestJS module, programmatic migrations |
| Contracts | `src/contracts/` | TypeScript interfaces for execution and events |
| DTOs | `src/dto/` | Request/response validation with class-validator |
| Errors | `src/errors/` | Error codes, AppException, global filter |
| Telemetry | `src/telemetry/` | OpenTelemetry tracing, Prometheus metrics |

## Run State Machine

```
queued → starting → binding_session → running → completed
  │         │              │             │
  └────┬────┘──────┬───────┘─────┬───────┘
       ▼           ▼             ▼
     failed     cancelled
```

Terminal states: `completed`, `failed`, `cancelled` (no outgoing transitions).

## Database Schema

11 tables: `runs` (includes `archived_at` timestamp for archive tracking), `runtime_sessions`, `run_events_raw`, `run_events_canonical`, `run_projections`, `run_artifacts`, `run_metrics`, `run_outbound_messages`, `audit_log`, `webhooks`, `webhook_deliveries`.

Key relationships:
- All run-related tables reference `runs.id` with `ON DELETE CASCADE`
- Events use `(run_id, seq)` unique indexes for ordering and deduplication
- Projections use `run_id` as primary key (one projection per run)
- Webhooks use outbox pattern for reliable delivery

## Coordination Modes

The control-plane is mode-agnostic — it forwards mode URIs to the runtime, observes the resulting envelopes, and projects them for the UI. The canonical mode specifications (message flow, terminal conditions, payload shapes) live in the runtime docs:

- [macp-runtime/docs/modes.md](../../macp-runtime/docs/modes.md) — Decision, Proposal, Task, Handoff, Quorum, plus Multi-Round and extension modes
- [macp-runtime/docs/examples.md](../../macp-runtime/docs/examples.md) — end-to-end walkthroughs per mode

All modes terminate with `Commitment` (`macp.v1.CommitmentPayload`). The control-plane normalises the per-mode message types into two canonical events — `proposal.created` / `proposal.updated` — preserving `messageType` in `data.messageType` for discrimination. See the [Canonical Event Types](./API.md#canonical-event-types) table in API.md for the mapping.

## Key Design Decisions

1. **Scenario-agnostic**: Accepts only a generic `RunDescriptor` — scenario-specific fields (`kickoff[]`, `participants[].role`, `policyHints`, `commitments[]`, `initiatorParticipantId`) are rejected with 400 via `forbidNonWhitelisted: true`.
2. **Three-layer event pipeline**: Raw → canonical → projections. Raw preserves original data; canonical provides normalized, typed view.
3. **Observer-only streaming**: `subscribeSession({runId, sessionId, afterSequence?})` returns a read-only `RuntimeSessionHandle` — `events` async iterable + `abort()`. No `send()`. The provider writes exactly one passive-subscribe frame and keeps the write side open for the session's lifetime (RFC-MACP-0006 §3.2).
4. **JWT-first runtime auth**: The credential resolver prefers minted short-lived JWTs (via `MACP_AUTH_SERVICE_URL`) and falls back to a static Bearer or dev header. Scopes are fixed at mint time (`is_observer: true, can_start_sessions: false`) so the observer identity can never accidentally gain write authority.
5. **Transactional event persistence**: Sequence allocation + persistence in single DB transaction.
6. **Snake_case → camelCase normalization**: ProtoRegistryService converts Python/JSON snake_case to protobufjs camelCase.
7. **Proto-encoded payloads**: Real runtime requires proto encoding; control plane supports JSON fallback for testing.
8. **Circuit breaker**: CLOSED/OPEN/HALF_OPEN wrapping all gRPC unary calls with configurable threshold and reset.
9. **Bindable idempotency**: `bindSession` catches `ConflictException` from the state-machine guard and returns the current run, so a raced transition (RunExecutor vs SessionDiscovery) logs a warning instead of crashing the process.
10. **Graceful drain on shutdown**: Background observation services expose tracked loop promises and a bounded drain (default 2s) from `onModuleDestroy`, ensuring in-flight `persistRawAndCanonical` chain entries complete before the DB pool closes.
