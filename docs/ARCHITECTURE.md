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
2. **Static Bearer** — attaches `RUNTIME_BEARER_TOKEN` verbatim. Must match an entry in the runtime's `MACP_AUTH_TOKENS_JSON` with `can_start_sessions: false` **and `is_observer: true`** — see [INTEGRATION.md § Observer authorization contract](INTEGRATION.md#observer-authorization-contract-is_observer-configured-token-or-jwt-scope) for why the latter is load-bearing (the runtime's dev-auth fallback can never produce `is_observer: true`, so a token missing it authenticates fine but fails every `GetSession` on a session the control-plane did not start).
3. **Dev bearer** *(deprecated, `RUNTIME_USE_DEV_HEADER=true`)* — runtime v0.5.0 removed the `x-macp-agent-id` header path entirely, so this fallback now attaches `Authorization: Bearer <RUNTIME_DEV_AGENT_ID>`. A dev-mode runtime (`MACP_ALLOW_INSECURE=1`, no auth configured) accepts any bearer and uses its value as the sender identity, so the control-plane keeps its `macp-control-plane` identity. Rejected in production (fail-fast unless a static bearer or JWT-mint is configured).

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

## Stream Resume & Cross-Process Recovery (runtime v0.5.0, T7)

Every `runtime_sessions` row tracks two independent markers, both written together in a
single `updateStreamCursor` call after each processed raw item once `lastProcessedSeq > 0`
(session snapshots and stream-status frames included — for those the monotonic floor simply
makes the write a no-op):

- **`last_stream_cursor`** — the control-plane's own canonical event `seq` for the run.
  Purely a CP-side bookkeeping value (e.g. used to compute `resumeFromSeq` for the
  poll-only fallback); the runtime has no notion of it.
- **`last_envelope_ordinal`** — the runtime's 1-based, **exclusive**, **compaction-stable**
  count of accepted envelopes delivered on this run's per-session `StreamSession`. This is
  the value passed back to the runtime as `after_sequence` on `StreamSession` to resume
  a subscription without re-replaying history already ingested. Only session-stream
  envelopes increment it — ambient signals, snapshots, and stream-status frames do not.

Both values are strictly monotonic per run by their own semantics, so
`RuntimeSessionRepository.updateStreamCursor` writes them as a **`GREATEST` floor** in a
single UPDATE (`GREATEST(COALESCE(last_stream_cursor, 0), $cursor)` /
`GREATEST(last_envelope_ordinal, $ordinal)`) rather than a blind `.set()`. This is not a
read-then-write — there is no race window — it simply makes an entire class of clobber
bugs (an unseeded resume marker, a stale caller value, a race between writers) structurally
impossible: on the happy path the floor is a no-op, since a real value is always ≥ what's
already stored.

**In-process resume** (no restart): on a stream disconnect, `StreamConsumerService`
resubscribes from the in-memory `marker.envelopeOrdinal` it has been incrementing as
envelopes are durably persisted (`stream-consumer.service.ts`, gated on
`STREAM_RESUME_ENABLED`).

**Cross-process resume** (control-plane restart): `RunRecoveryService` re-derives the
resume point from the *persisted* `last_envelope_ordinal` on `onApplicationBootstrap`,
since the in-memory marker is gone.

- With `STREAM_RESUME_ENABLED=true` (default), recovery resolves the run's runtime
  provider and calls `subscribeSession({ runId, runtimeSessionId, afterSequence:
  session.lastEnvelopeOrdinal })` to reattach the per-session `StreamSession` directly,
  seeding `StreamConsumerService.start()` with that handle and `pollOnly: false`.
- With the flag off, or if resolving the provider / calling `subscribeSession` fails,
  recovery falls back to the poll-only path (`GetSession` polling) — but **still** seeds
  `resumeFromEnvelopeOrdinal` from the persisted value. A failed subscribe never fails
  recovery; the run is still recovered, just via poll-only.
- The ordinal is a property of the session's history, not of the transport mode, so it is
  seeded identically on every path (resume-enabled, resume-disabled, subscribe-failure
  fallback). The historical bug this guards against: seeding only `resumeFromSeq` and
  leaving the envelope-ordinal marker at its zero default caused the very first poll
  cycle's `session-snapshot` (which always normalizes to a positive `seq`) to pass the
  `lastProcessedSeq > 0` persistence guard and write `0` back over the real stored
  ordinal — destroying the resume point within one poll cycle of every restart, so a run
  surviving a second restart (or any flag-off recovery) would resume from 0 and
  re-ingest its entire session history as duplicates. The `GREATEST` floor above closes
  this class of bug structurally; seeding the ordinal on every recovery path closes the
  specific instance of it.

**Bias toward resuming too low, never too high.** There is no message-id dedup in the
control-plane — a redelivered envelope inserts a genuinely duplicate row (fresh
`randomUUID()`, freshly allocated `seq`; only the unique index on `(run_id, seq)` prevents
literal double-processing of the *same* seq, not duplicate ingestion of the same envelope
under a new one). A too-low resume is therefore recoverable in principle (duplicates are
at least detectable). A too-high resume is not: the runtime's `get_incoming_after` returns
`Ok(empty)` both for an out-of-range ordinal *and* for a missing/evicted session log, and
attaches the live broadcast either way — so a skipped range of history disappears with no
error, no gap event, and live envelopes still flowing normally. This is why recovery never
invents an ordinal and never resubscribes from `0` as a fallback strategy — 0 is only ever
the correct value for a session with no prior persisted ordinal (a genuinely fresh run),
never a substitute for a marker that failed to seed.

**The `FAILED_PRECONDITION` → `session.stream.gap` → poll-only safety net** (already in
`stream-consumer.service.ts`, exercised whether the handle came from initial `start()` or
from `RunRecoveryService`'s cross-process resume) is what protects a resume point that
*was* valid when persisted but has since been compacted out of the runtime's log:
`isCompactedHistoryError` recognizes gRPC `FAILED_PRECONDITION` (code 9) or a
"compacted"-flavored message, `emitStreamGap` emits a `session.stream.gap` canonical event
and flags the projection `historyGap: true` (idempotent per run via `marker.historyGap`),
and the consumer degrades to poll-only **without ever resubscribing from 0** — the gap is
made visible instead of silently skipped. `test/integration/stream-gap.integration.spec.ts`
covers this path against a scripted mock runtime.

**How the rejection actually arrives against runtime 0.7.0 — not as a stream error.** Live
re-verification found that the runtime does *not* end the stream for a compacted-history
resume: `is_stream_terminal_error` (`macp-runtime/src/server.rs:745-755`) omits
`FailedPrecondition`, so the rejection is delivered as a **non-terminal inline `MACPError`
frame with the stream left open** (`server.rs:608-628`). The consumer therefore also
classifies the inline frame, not just the stream-error path — without that, the gap event
never fired at all and the consumer sat on an open stream that had replayed nothing.

Two caveats a maintainer should know. First, detection matches on the message text, because
the runtime sets the inline frame's `code` to `status.message()` rather than a status name —
so there is no machine-readable code to key on, and a future rewording of that string breaks
detection silently. Second, the classification runs *after* the `STREAM_RESUME_ENABLED` check,
so with resume disabled an inline compaction frame still degrades to poll-only but does not
record the gap. `test/integration/stream-resume-live.integration.spec.ts` proves the whole
path end to end against a real runtime; it is gated and skips under the mock runtime CI pins.

**Known residual gap (accepted, not fixed):** the cursor write in
`RunEventService.persistRawAndCanonical` happens outside the same DB transaction as the
canonical-event insert, so a crash between that commit and the cursor write lags the
stored ordinal by exactly one envelope — the next resume (in-process or cross-process)
re-ingests that one envelope as a duplicate. This is a bounded, single-envelope duplicate
on an unclean crash, not a gap; folding the cursor write into the hot-path transaction
would be a larger change than this trade-off currently justifies.


### Operational note: sessions restarted before this feature shipped

`last_envelope_ordinal` was write-only before cross-process resume landed, and worse, every
restart overwrote it with `0` (recovery seeded the in-memory marker at 0 and the cursor write was
a blind `SET`). Rows carrying that clobbered `0` may still exist for runs that were active across
an upgrade.

For such a run, the first restart after this feature deploys resubscribes with `after_sequence: 0`,
which the runtime cannot distinguish from a genuinely fresh subscription — so it replays the full
session history and the control-plane re-ingests it as duplicate events. This is a **bounded,
one-time** effect: it only touches runs that were active across the deploy *and* had already
survived an earlier restart, and the monotonic floor means the clobber cannot recur afterwards.

It is deliberately not "fixed" by reconstructing the ordinal from the raw event count: that count
includes any duplicates already present, so it can overshoot the true delivered ordinal — and
overshooting resumes *too high*, which the runtime answers with an empty replay plus a live
broadcast, losing the skipped range with no error and no gap event. Duplicated events are
detectable after the fact; silently skipped ones are not.

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
| Runtime Abstraction | `src/runtime/` | `RuntimeProvider` interface, `RustRuntimeProvider` (gRPC), `ProtoRegistryService`, `RuntimeCredentialResolverService` (JWT → static-bearer → dev-bearer chain), `RuntimeJwtMinterService` (short-lived JWT mint + cache) |
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
queued → starting → binding_session → running ──────→ completed
  │         │              │             │  ▲
  │         │              │             ▼  │
  │         │              │          suspended        (non-terminal pause,
  │         │              │             │              macp-proto 0.1.3)
  └────┬────┘──────┬───────┘─────┬───────┘
       ▼           ▼             ▼
     failed     cancelled
```

Terminal states: `completed`, `failed`, `cancelled` (no outgoing transitions).
`running ⇄ suspended` is the non-terminal pause/resume pair: `POST /runs/:id/suspend`
calls `runtime.SuspendSession` (TTL banked), `POST /runs/:id/resume` restores it.
Both are Core control-plane RPCs — not `Send` — so they are permitted under the
observer invariant. A suspended run can still be cancelled or fail.

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
4. **JWT-first runtime auth**: The credential resolver prefers minted short-lived JWTs (via `MACP_AUTH_SERVICE_URL`) and falls back to a static Bearer or a deprecated dev bearer. Scopes are fixed at mint time (`is_observer: true, can_start_sessions: false`) so the observer identity can never accidentally gain write authority.
5. **Transactional event persistence**: Sequence allocation + persistence in single DB transaction.
6. **Snake_case → camelCase normalization**: ProtoRegistryService converts Python/JSON snake_case to protobufjs camelCase.
7. **Proto-encoded payloads**: Real runtime requires proto encoding; control plane supports JSON fallback for testing.
8. **Circuit breaker**: CLOSED/OPEN/HALF_OPEN wrapping all gRPC unary calls with configurable threshold and reset.
9. **Bindable idempotency**: `bindSession` catches `ConflictException` from the state-machine guard and returns the current run, so a raced transition (RunExecutor vs SessionDiscovery) logs a warning instead of crashing the process.
10. **Graceful drain on shutdown**: Background observation services expose tracked loop promises and a bounded drain (default 2s) from `onModuleDestroy`, ensuring in-flight `persistRawAndCanonical` chain entries complete before the DB pool closes. `WebhookService` follows the same pattern — it tracks in-flight deliveries and cancels pending retry-backoff timers on `onModuleDestroy`, so a delivery retry can't wake after the pool closes and write against a dead connection.

## CI/CD & Deployment

The pipeline (lint → typecheck → tests → audit/scans → build → Docker) and the release/deploy flow are documented in [CICD.md](./CICD.md). Production deployment is single-VM Docker Compose — see [deploy/README.md](../deploy/README.md).

## Operating alongside runtime v0.5.0

- **Runtime metrics**: the control-plane exposes its own Prometheus metrics at `GET /metrics` (prom-client, `@Public()`). The runtime independently exposes its own Prometheus endpoint via `MACP_METRICS_ADDR` (e.g. `MACP_METRICS_ADDR=0.0.0.0:9464`). Scrape both to cover the CP and the runtime — nothing in the CP scrapes the runtime for you. For local debugging you can expose `9464` from the runtime container.
- **JWT algorithms**: runtime v0.5.0 removed **HS256** from the default JWT algorithm allowlist (RS256/ES256 only). The CP mints RS256 tokens via the auth-service, so no CP change is needed. Deployments that intentionally use shared-secret HS256 tokens against the runtime must opt in explicitly with `MACP_AUTH_JWT_ALGS=HS256` on the **runtime** side.
- **Dev-mode startup**: runtime v0.5.0 refuses to start without `MACP_ALLOW_INSECURE=1`, and the published image no longer bakes it in — set it explicitly for local/dev/test runtimes.
