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
connection with their own Bearer tokens (RFC-MACP-0004 §4). The read-only observer stream
filters envelopes by `sessionId` and never writes a frame.

## Event Pipeline

```
Runtime gRPC stream
  → StreamConsumerService (consumption loop + idle timeout + reconnection)
    → EventNormalizerService (raw → canonical, including derived events)
      → RunEventService (transactional sequence allocation + persistence)
        → EventRepository.appendRaw + appendCanonical
        → ProjectionService.applyAndPersist (update UI read model)
        → MetricsService.recordEvents (update counters)
        → StreamHubService.publishEvent (SSE → live UI subscribers)
```

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
| Run Orchestration | `src/runs/` | RunManager (state machine), RunExecutor (coordination), StreamConsumer (event loop) |
| Runtime Abstraction | `src/runtime/` | `RuntimeProvider` interface, `RustRuntimeProvider` (gRPC), `ProtoRegistryService` |
| Events | `src/events/` | Normalization (raw→canonical), transactional persistence, SSE publishing |
| Projection | `src/projection/` | Applies canonical events to build UI read models (versioned) |
| Dashboard | `src/dashboard/` | Aggregated KPIs, recent runs, runtime health, and time-series chart data |
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

| Mode | Proto Package | Key Message Types |
|------|--------------|-------------------|
| Decision | `macp.modes.decision.v1` | Proposal, Evaluation, Objection, Vote |
| Proposal | `macp.modes.proposal.v1` | Proposal, CounterProposal, Accept, Reject, Withdraw |
| Task | `macp.modes.task.v1` | TaskRequest, TaskAccept, TaskUpdate, TaskComplete, TaskFail |
| Handoff | `macp.modes.handoff.v1` | HandoffOffer, HandoffContext, HandoffAccept, HandoffDecline |
| Quorum | `macp.modes.quorum.v1` | ApprovalRequest, Approve, Reject, Abstain |

All modes terminate with `Commitment` (from `macp.v1.CommitmentPayload`).

## Key Design Decisions

1. **Scenario-agnostic**: Accepts only a generic `RunDescriptor` — scenario-specific fields (`kickoff[]`, `participants[].role`, `policyHints`, `commitments[]`, `initiatorParticipantId`) are rejected with 400 via `forbidNonWhitelisted: true`.
2. **Three-layer event pipeline**: Raw → canonical → projections. Raw preserves original data; canonical provides normalized, typed view.
3. **Observer-only streaming**: `subscribeSession({runId, sessionId})` returns a read-only `RuntimeSessionHandle` — `events` async iterable + `abort()`. No `send()`.
4. **Transactional event persistence**: Sequence allocation + persistence in single DB transaction.
5. **Snake_case → camelCase normalization**: ProtoRegistryService converts Python/JSON snake_case to protobufjs camelCase.
6. **Proto-encoded payloads**: Real runtime requires proto encoding; control plane supports JSON fallback for testing.
7. **Circuit breaker**: CLOSED/OPEN/HALF_OPEN wrapping all gRPC unary calls with configurable threshold and reset.
