# MACP Control Plane — API Reference

The generated OpenAPI schema is exposed at `/docs` (Swagger UI) and `/docs-json` (raw schema) when `NODE_ENV=development`.

## Authentication

All endpoints except health probes and metrics require authentication.

```bash
# API key auth
curl -H 'Authorization: Bearer <api-key>' http://localhost:3001/runs

# Dev mode: leave AUTH_API_KEYS empty to disable auth
```

Rate limit: 100 requests per 60 seconds per client. Payload limit: 1MB.

### Upstream runtime auth (observer identity)

The control-plane has **exactly one** runtime identity. It never calls `Send`; agents authenticate to the runtime directly (RFC-MACP-0004 §4). The scope is fixed: `is_observer: true, can_start_sessions: false`.

Configuration, env vars, and the three-step fallback chain (JWT mint → static Bearer → dev header) are documented in [ARCHITECTURE.md § Runtime Credential Resolution](./ARCHITECTURE.md#runtime-credential-resolution). For the runtime-side token configuration (`MACP_AUTH_TOKENS_JSON` shape, JWT claim expectations, TLS/mTLS), see [runtime/docs/getting-started.md#authentication](../../runtime/docs/getting-started.md#authentication) and [runtime/docs/deployment.md#authentication](../../runtime/docs/deployment.md#authentication).

Per-agent tokens are **not** held by the control-plane — they live in the scenario layer (examples-service) and flow to agents via their bootstrap.

---

## Runs

### `POST /runs`

Create and launch a runtime execution run. Accepts only a **scenario-agnostic `RunDescriptor`**.
Scenario-specific fields (`kickoff[]`, `participants[].role`, `commitments[]`,
`policyHints`, `initiatorParticipantId`) are rejected with 400.

```bash
curl -X POST http://localhost:3001/runs \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <key>' \
  -d '{
    "mode": "live",
    "runtime": { "kind": "rust" },
    "session": {
      "modeName": "macp.mode.decision.v1",
      "modeVersion": "1.0.0",
      "configurationVersion": "config.default",
      "ttlMs": 60000,
      "participants": [
        { "id": "agent-1" },
        { "id": "agent-2" }
      ],
      "metadata": {
        "cancelCallback": { "url": "http://initiator/agent/cancel", "bearer": "opt-shared-secret" }
      }
    },
    "execution": {
      "idempotencyKey": "unique-key",
      "tags": ["production"],
      "requester": { "actorId": "user-1", "actorType": "user" }
    }
  }'
```

**Response (202):** `{ "runId": "<uuid>", "sessionId": "<uuid>", "status": "queued", "traceId": "..." }`

The caller distributes `sessionId` to every agent via bootstrap. The initiator agent
uses its own Bearer token to call `SessionStart(sessionId)` on the runtime. The
control-plane's async observer loop polls `GetSession(sessionId)` until `OPEN`,
then subscribes read-only.

If the caller provides `session.sessionId`, the control-plane validates it (must
be UUID v4/v7 or base64url 22+ chars) and echoes it back in the response.

### `POST /runs/validate`
Preflight validation without creating a run.

### `GET /runs`
List runs with filtering and pagination.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `status` | string | — | Filter by run status |
| `tags` | string | — | Comma-separated tag filter |
| `createdAfter` | ISO date | — | Filter runs created after |
| `createdBefore` | ISO date | — | Filter runs created before |
| `limit` | number | 50 | Max results (1-200) |
| `offset` | number | 0 | Pagination offset |
| `sortBy` | string | createdAt | `createdAt` or `updatedAt` |
| `sortOrder` | string | desc | `asc` or `desc` |
| `includeArchived` | boolean | false | Include archived runs |
| `environment` | string | — | Filter by metadata environment (exact match) |
| `scenarioRef` | string | — | Filter by metadata scenario ref (partial ILIKE match) |
| `search` | string | — | Search across run ID, tags, scenarioRef, environment |

### `GET /runs/:id`
Fetch the run record.

### `GET /runs/:id/state`
Fetch the projected run state for UI rendering. Returns:

```json
{
  "run": { "runId", "status", "modeName", "runtimeSessionId", "startedAt", "endedAt" },
  "participants": [{ "participantId", "role", "status", "latestSummary" }],
  "graph": { "nodes": [...], "edges": [...] },
  "decision": { "current": { "action", "confidence", "finalized", "proposalId", "outcomePositive", "prompt", "resolvedAt", "resolvedBy", "proposals": [...] } },
  "signals": { "signals": [{ "id", "name", "severity", "sourceParticipantId", "confidence", "payload", "acknowledgedAt", "acknowledgedBy" }] },
  "progress": { "entries": [{ "participantId", "percentage", "message" }] },
  "timeline": { "latestSeq", "totalEvents", "recent": [...] },
  "trace": { "traceId", "spanCount", "linkedArtifacts" },
  "outboundMessages": { "total", "queued", "accepted", "rejected" },
  "policy": { "policyVersion", "policyDescription", "resolvedAt", "outcomePositive", "commitmentEvaluations": [...], "expectedCommitments": [...], "voteTally": [...], "quorumStatus": "pending|reached|failed" }
}
```

**Decision projection enrichments (§2.1 – §2.3):**

- `decision.current.prompt` — populated from the initiator's `Proposal` envelope when the runtime includes a `prompt` / `rationale` field. The control-plane no longer reads scenario-specific fields from the request body.
- `decision.current.proposals[]` — per-contributor breakdown built from `proposal.created` and `proposal.updated` events. Each entry: `{ participantId, action, confidence?, reasons[], ts, vote?: 'allow'|'deny', messageType? }`. Capped at 50 most-recent.
- `decision.current.resolvedAt` / `resolvedBy` — populated from the `decision.finalized` event's `ts` and `sender`.

**Policy projection enrichments (§2.4 – §2.5):**

- `policy.expectedCommitments[]` — populated from runtime `PolicyResolved` events when the runtime attaches commitment expectations. The control-plane no longer seeds this from the request body.
- `policy.voteTally[]` — derived from vote-bearing `proposal.updated` events (Vote / Approve / Reject / Accept / Evaluation). Each entry: `{ commitmentId (≈ proposalId until finalized), allow, deny, threshold, quorum: { required, cast } }`. `required` is the count of `role === 'voter'` participants (fallback: total participants); `threshold` is the simple majority `ceil(required/2)`.
- `policy.quorumStatus` — `pending` until a `policy.commitment.evaluated` with `decision === 'allow'` arrives (→ `reached`). On run terminal (`failed` / `cancelled`) with no `allow` evaluation, flips to `failed`.

**Participant status values:** `idle` | `active` | `waiting` | `completed` | `failed` | `skipped`.

On run terminal transition (`completed` / `failed` / `cancelled`), non-terminal participants are swept:
- `completed` — participant emitted at least one canonical event during the run.
- `skipped` — participant was declared but never emitted any event.
- `failed` — on `run.failed` only, assigned to the **last-active** participant (by `latestActivityAt`).

**Decision `outcomePositive` semantics:** `boolean | null | undefined`.
- `boolean` — explicit outcome was emitted, or inferred from the action (`approve`/`accept`/`selected`/`completed` → `true`; `reject`/`declined`/`failed` → `false`).
- `null` — decision is finalized but no outcome could be inferred (e.g. `step_up`).
- `undefined` — decision has not resolved yet (run still in flight).

**Signal entry fields:** each entry carries `payload` (the decoded signal payload), and once a matching `signal.acknowledged` event arrives, `acknowledgedAt` + `acknowledgedBy` are populated in place.

### `GET /runs/:id/events`
List canonical events for a single run.

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `afterSeq` | int ≥ 0 | 0 | Return events with sequence strictly greater. |
| `limit` | int ≥ 1 | 200 | Maximum entries returned. |
| `afterTs` | ISO-8601 | — | Time lower bound (inclusive) (§4.2). |
| `beforeTs` | ISO-8601 | — | Time upper bound (exclusive) (§4.2). |
| `type` | csv | — | Comma-separated canonical event types (e.g. `signal.emitted,signal.acknowledged`) (§4.2). |

**Response shape (backward-compatible):**
- With only `afterSeq`/`limit` → returns a bare `CanonicalEvent[]` array (legacy shape retained).
- With any of `afterTs`, `beforeTs`, or `type` → returns `{ data: CanonicalEvent[], total, limit, nextCursor? }`.

### `GET /events` (§4.1)
Cross-run canonical events with filters. Useful for the `/logs` and `/traces` UIs when aggregating across runs.

| Param | Type | Notes |
|-------|------|-------|
| `runId` | uuid | Scope to a single run (equivalent to `/runs/:id/events`). |
| `scenarioRef` | string | Match `run.sourceRef` exactly or `run.metadata.scenarioRef` via ILIKE. |
| `type` | csv | Comma-separated canonical event types. |
| `afterSeq` | int ≥ 0 | Sequence cursor. |
| `afterTs` | ISO-8601 | Time lower bound (inclusive). |
| `beforeTs` | ISO-8601 | Time upper bound (exclusive). |
| `limit` | int ≥ 1 (default 500) | Maximum entries returned. |

Response: `{ data: CanonicalEvent[], total, limit, nextCursor? }`. `nextCursor` is set to the last event's `seq` only when the page is full (`data.length === limit`), so consumers can pass it as `afterSeq` on the next page. Authorization matches the per-run events endpoint.

### Stable `total` counts (§4.3)

The following list endpoints return `{ data, total, limit, offset | nextCursor }`:

- `GET /runs` — paginated by `limit` + `offset`, includes `total`.
- `GET /audit` — paginated by `limit` + `offset`, includes `total`.
- `GET /events` (§4.1) — cursor-based via `nextCursor` or offset-style via `limit`, includes `total`.
- `GET /runs/:id/events` — bare array for the legacy fast-path, `{ data, total, limit, nextCursor }` when any filter is supplied.

### `POST /runs/:id/cancel`
Cancel a running session. Body: `{ "reason": "optional" }`

Two flows, selected via run metadata:

- **Option A (default)** — control-plane HTTP-POSTs to the initiator agent's `cancelCallback` URL (recorded in the run's `metadata.cancelCallback`). The agent then calls `runtime.CancelSession` with its own identity. Fails with 400 if no callback is registered.
- **Option B (policy-delegated)** — when the run's `metadata.cancellationDelegated` is `true`, the control-plane calls `runtime.CancelSession` directly using its own observer identity. Requires the scenario's policy to grant cancel authority to the control-plane.

### `POST /runs/:id/clone`
Clone a run with optional overrides. Body: `{ "tags": [...], "context": {...} }`

### `POST /runs/:id/archive`
Archive a run. Sets `archivedAt` timestamp and adds `'archived'` tag. Excluded from default listings (retrievable with `includeArchived=true`).

### `DELETE /runs/:id`
Delete a terminal run (completed, failed, or cancelled only).

### `POST /runs/:id/projection/rebuild`
Rebuild the projection from canonical events.

---

## Messages & Signals — emission is NOT via the control-plane

Agents emit envelopes directly against the runtime via `macp-sdk-python` or
`macp-sdk-typescript`. The control-plane observes them via `StreamSession` and
exposes read-only views.

### Removed endpoints (return 410 Gone)

| Endpoint | Migration |
| --- | --- |
| `POST /runs/:id/messages` | `from macp_sdk import DecisionSession; DecisionSession(client, session_id=…).evaluate(...)` |
| `POST /runs/:id/signal`   | `session.signal(...)` via the SDK (or build an `Envelope` with `messageType='Signal'` and unary-`Send` it) |
| `POST /runs/:id/context`  | Construct an envelope with `messageType='ContextUpdate'` via `macp_sdk.build_envelope()` |

Each response: `{ "statusCode": 410, "errorCode": "ENDPOINT_REMOVED", "message": "…" }`.

### `GET /runs/:id/messages`
List outbound messages captured from the runtime stream.

---

## SSE Streaming

### `GET /runs/:id/stream`
Subscribe to live run events over Server-Sent Events.

```bash
curl -N -H 'Authorization: Bearer <key>' \
  'http://localhost:3001/runs/{id}/stream?includeSnapshot=true&afterSeq=0'
```

| Query Param | Default | Description |
|-------------|---------|-------------|
| `afterSeq` | — | Resume from sequence (exclusive) |
| `includeSnapshot` | true | Send initial state snapshot |
| `heartbeatMs` | 15000 | Heartbeat interval (min 1000) |

**SSE Event Types:**
- `snapshot` — Full projected state
- `canonical_event` — Individual canonical event (id = sequence number for resume)
- `heartbeat` — Keep-alive

**Resume:** Use `Last-Event-Id` header or `afterSeq` query param.

---

## Replay

### `POST /runs/:id/replay`
Create a replay descriptor. Body: `{ "mode": "timed", "speed": 2, "fromSeq": 1, "toSeq": 100 }`

Returns: `{ "runId", "mode", "speed", "streamUrl", "stateUrl" }`

### `GET /runs/:id/replay/stream`
Stream replayed canonical events as SSE.

| Mode | Behavior |
|------|----------|
| `instant` | All events emitted immediately |
| `timed` | Events with proportional timing (adjustable via `speed`) |
| `step` | All events without delay (for scrubber UIs) |

### `GET /runs/:id/replay/state`
Project run state at a specific sequence: `?seq=42`

---

## Batch Operations

### `POST /runs/batch/cancel`
Cancel multiple runs. Body: `{ "runIds": ["id1", "id2"] }`

### `POST /runs/batch/export`
Export multiple runs. Body: `{ "runIds": ["id1", "id2"] }`

### `POST /runs/batch/archive`
Archive multiple runs. Body: `{ "runIds": ["id1", "id2"] }`

### `POST /runs/batch/delete`
Delete multiple terminal runs. Body: `{ "runIds": ["id1", "id2"] }`

### `POST /runs/compare`
Compare two runs side-by-side. Body: `{ "leftRunId": "id1", "rightRunId": "id2" }`

### `GET /runs/:id/export`
Export full run bundle. Query: `includeCanonical` (default true), `includeRaw` (false), `eventLimit` (10000), `format` (`json`|`jsonl`).

---

## Dashboard

### `GET /dashboard/overview`
Single aggregated endpoint for the UI dashboard — KPIs, recent runs, runtime health, and chart data.

| Param | Values | Default | Notes |
|-------|--------|---------|-------|
| `window` | `1h`, `6h`, `24h`, `7d`, `30d` | `24h` | Preferred — drives all KPIs and chart series (§5.1). |
| `range` | `24h`, `7d`, `30d` | — | Deprecated alias for `window`; retained for backward compatibility. |
| `from` | ISO-8601 timestamp | — | Explicit start; overrides `window`. |
| `to` | ISO-8601 timestamp | now | Explicit end when `from` is supplied. |
| `scenarioRef` | string | — | Filter runs by `source_ref` (exact match) or `metadata.scenarioRef` (ILIKE). |
| `environment` | string | — | Filter runs by `metadata.environment` (exact match). |

Bucket granularity is chosen automatically — `minute` for windows ≤ 6h, `hour` for 24h, `day` for 7d/30d. When using `from`/`to`, the bucket is derived from the range (≤ 6h → minute; ≤ 48h → hour; otherwise day).

Returns:
```json
{
  "kpis": {
    "totalRuns", "activeRuns", "completedRuns", "failedRuns", "cancelledRuns",
    "totalSignals", "totalTokens", "totalCostUsd", "avgDurationMs"
  },
  "recentRuns": [
    { "id", "status", "runtimeKind", "sourceRef?", "startedAt?", "endedAt?", "createdAt" }
  ],
  "runtimeHealth": { "ok": true, "runtimeKind": "rust", "detail?": "..." },
  "charts": {
    "runVolume":       { "labels": [...], "data": [...] },
    "latency":         { "labels": [...], "data": [...] },
    "signalVolume":    { "labels": [...], "data": [...] },
    "errorClasses":    { "labels": [...], "data": [...] },
    "throughput":      { "labels": [...], "data": [...] },
    "queueDepth":      { "labels": [...], "data": [...] },
    "latencyP50":      { "labels": [...], "data": [...] },
    "latencyP95":      { "labels": [...], "data": [...] },
    "latencyP99":      { "labels": [...], "data": [...] },
    "cost":            { "labels": [...], "data": [...] },
    "successRate":     { "labels": [...], "data": [...] },
    "decisionOutcome": { "labels": [...], "data": [...] },
    "perScenario":     { "labels": [...], "data": [...] }
  }
}
```

Chart series semantics (§5.2):

- **throughput** — completed runs per bucket (runs/min or runs/hour depending on window).
- **queueDepth** — runs created per bucket still in a non-terminal status (`queued`/`starting`/`binding_session`) as of query time.
- **latencyP50 / P95 / P99** — run duration percentiles in milliseconds, computed per bucket from `runs.ended_at - runs.started_at` for `status = 'completed'`.
- **cost** — sum of `estimated_cost_usd` per bucket (from `run_metrics`).
- **successRate** — `completed / (completed + failed + cancelled)` per bucket, expressed as 0–100.
- **decisionOutcome** — net outcome per bucket (`positive - negative`) derived from `decision.finalized` events' `outcome_positive` field.
- **perScenario** — top-10 scenarios by run volume within the window.

The `recentRuns` array contains up to 10 latest non-archived runs matching the active filters. The `runtimeHealth` reflects the current runtime connection status. `totalTokens` and `totalCostUsd` are aggregated from `run_metrics` for runs in the time range. Pack metadata should be fetched separately from the Examples Service.

### `GET /dashboard/agents/metrics`
Aggregated per-agent metrics derived from canonical events.

Returns:
```json
[
  {
    "participantId": "fraud-agent",
    "runs": 42,
    "messages": 100,
    "signals": 18,
    "averageConfidence": 0.85
  }
]
```

---

## Observability

### `GET /runs/:id/traces`
Trace summary with run context: `{ "traceId", "spanCount", "lastSpanId", "linkedArtifacts", "runStatus", "scenarioRef" }`.

- `runStatus` — current status of the run (`queued` | `starting` | `binding_session` | `running` | `completed` | `failed` | `cancelled`).
- `scenarioRef` — the scenario reference the run was launched from (e.g. `fraud-detection@1.2.0`), or `undefined` if the run was not launched from a scenario.

### Control-plane trace enrichment (§6, Wave 5)

The control plane instruments its critical paths with OpenTelemetry spans parented to a single `run.lifecycle` span. Exporter config via `OTEL_ENABLED` + `OTEL_EXPORTER_OTLP_ENDPOINT`.

Parent: `run.lifecycle` (started in `RunManager.createRun`, ended in `markCompleted`/`markFailed`/`markCancelled`).

Child spans emitted by the control plane:
- `runtime.send_message` — outbound session-bound message (`RunExecutor.sendMessage`); attributes: `macp.message_type`, `macp.sender`.
- `stream.handle_raw_event` — each raw event pulled from the runtime stream; attributes: `macp.raw_kind`, `macp.message_type`, `macp.session_id`.
- `run-event.persist` — transactional raw + canonical event persistence with projection update; attribute: `macp.event_count`, `macp.raw_kind`.
- `run-event.emit` — transactional emission of control-plane-synthesized events; attribute: `macp.event_count`.

Span annotations (`addEvent`) are attached to the run span for key canonical events: `signal.emitted`, `signal.acknowledged`, `policy.denied`, `decision.finalized`. These appear inline on the waterfall without requiring new span instrumentation.

**gRPC traceparent propagation.** All calls to the Rust runtime carry W3C `traceparent` + `tracestate` headers via gRPC metadata, so spans emitted by the runtime or downstream agents will become children of the active control-plane span when their tracers honour the context.

**Canonical event trace context.** `CanonicalEvent.trace.traceId` / `spanId` are stamped from the active run span when events are emitted by the control plane (and back-filled for runtime-emitted events that don't carry their own trace context). This ties the event stream to the waterfall even when upstream exporters aren't fully wired.

### `GET /runs/:id/artifacts`
List artifacts (trace bundles, reports, logs).

### `POST /runs/:id/artifacts`
Create an artifact: `{ "kind": "json", "label": "...", "inline": {...} }`

### `GET /runs/:id/metrics`
Metrics summary including token usage and estimated cost:
```json
{
  "runId", "eventCount", "messageCount", "signalCount", "proposalCount",
  "toolCallCount", "decisionCount", "streamReconnectCount",
  "promptTokens", "completionTokens", "totalTokens", "estimatedCostUsd",
  "firstEventAt?", "lastEventAt?", "durationMs?", "sessionState?"
}
```

**Token usage convention:** Agents include token data in envelope metadata when sending via `macp-sdk-*` directly to the runtime. The control-plane observes that envelope on its read-only stream:
```json
// Envelope emitted by the agent via the SDK (e.g. session.send(...))
{
  "messageType": "Evaluation",
  "sender": "fraud-agent",
  "payload": { ... },
  "metadata": {
    "tokenUsage": {
      "promptTokens": 150,
      "completionTokens": 80,
      "model": "gpt-4o-mini"
    }
  }
}
```

The control plane extracts `tokenUsage` from event data/metadata during normalization and accumulates per-run totals. Cost is estimated using built-in per-model rates:

| Model | Prompt ($/1M tokens) | Completion ($/1M tokens) |
|-------|---------------------|--------------------------|
| `gpt-4o` | $2.50 | $10.00 |
| `gpt-4o-mini` | $0.15 | $0.60 |
| `gpt-4-turbo` | $10.00 | $30.00 |
| `claude-3-opus` | $15.00 | $75.00 |
| `claude-3-sonnet` | $3.00 | $15.00 |
| `claude-3-haiku` | $0.25 | $1.25 |
| _(unknown/default)_ | $1.00 | $3.00 |

### Run Metadata Enrichment

When a run completes or fails, the control plane asynchronously enriches the run's `metadata` field with:

| Field | Source | Description |
|-------|--------|-------------|
| `durationMs` | `endedAt - startedAt` | Run wall-clock duration |
| `eventCount` | MetricsService | Total canonical events |
| `signalCount` | MetricsService | Total signals emitted |
| `decisionCount` | MetricsService | Total decisions finalized |
| `finalAction` | Last `decision.finalized` event | Commitment action string |
| `finalConfidence` | Last `decision.finalized` event | Decision confidence score |

Enrichment is fire-and-forget — errors are logged but never fail the run transition.

---

## Runtime

### `GET /runtime/manifest`
Runtime identity and supported modes.

### `GET /runtime/modes`
Registered execution modes with message types and terminal types.

### `GET /runtime/roots`
Runtime root descriptors.

### `GET /runtime/health`
Runtime health: `{ "ok": true, "runtimeKind": "rust", "detail": "..." }`

### `POST /runtime/policies`
Register a governance policy with the runtime.

Body:
```json
{
  "policyId": "policy.fraud.majority-veto",
  "mode": "macp.mode.decision.v1",
  "description": "Majority voting with veto support",
  "rules": {
    "voting": { "algorithm": "majority", "threshold": 0.5, "quorum": { "type": "count", "value": 2 } },
    "objection_handling": { "block_severity_vetoes": true, "veto_threshold": 1 },
    "commitment": { "authority": "initiator_only", "require_vote_quorum": true }
  },
  "schemaVersion": 1
}
```

Returns: `{ "ok": true }` or `{ "ok": false, "error": "..." }`

### `GET /runtime/policies`
List registered governance policies. Optional `?mode=macp.mode.decision.v1` filter.

Returns array of policy descriptors with parsed `rules` objects.

### `GET /runtime/policies/:policyId`
Get a specific governance policy by ID.

### `DELETE /runtime/policies/:policyId`
Unregister a governance policy. Returns: `{ "ok": true }`

### Policy Errors

| Error Code | HTTP | When |
|------------|------|------|
| `UNKNOWN_POLICY_VERSION` | 400 | `policy_version` not found in registry at session start |
| `POLICY_DENIED` | 403 | Commitment rejected because policy rules not satisfied (includes structured `reasons` array) |
| `INVALID_POLICY_DEFINITION` | 400 | Policy rules fail schema validation at registration, or policy mode doesn't match session mode at SessionStart |
| `SESSION_ALREADY_EXISTS` | 409 | Duplicate session start attempt |

### Policy Projection

The `GET /runs/:id/state` response includes a `policy` field:
```json
{
  "policy": {
    "policyVersion": "policy.fraud.majority-veto",
    "policyDescription": "Majority voting with veto support",
    "resolvedAt": "2026-04-05T12:00:00Z",
    "commitmentEvaluations": [
      {
        "commitmentId": "commit-1",
        "decision": "allow",
        "reasons": ["quorum met", "no blocking objections"],
        "ts": "2026-04-05T12:01:00Z"
      }
    ]
  }
}
```

Policy events are produced when:
- Runtime resolves a policy at session start → `policy.resolved`
- Runtime evaluates a commitment against policy → `policy.commitment.evaluated`
- Runtime denies a commitment due to policy → `policy.denied`

### Policy Rule Schemas (RFC-MACP-0012)

Rules are opaque to the control-plane — the request body is passed through as JSON to `runtime.RegisterPolicy`. Per-mode rule schemas (Decision / Proposal / Task / Handoff / Quorum), worked examples, and evaluation semantics are documented canonically in [runtime/docs/policy.md](../../runtime/docs/policy.md) — see *Rule examples by mode*, *How evaluation works*, and *Commitment authority*.

---

## Webhooks

### `POST /webhooks`
Register a webhook. Body: `{ "url": "https://...", "events": ["run.completed"], "secret": "hmac-secret" }`

### `GET /webhooks`
List all webhook subscriptions.

### `PATCH /webhooks/:id`
Update a webhook. Body: `{ "url?", "events?", "secret?", "active?" }`

### `DELETE /webhooks/:id`
Remove a webhook (204 No Content).

---

## Administration

### `GET /audit`
List audit log entries. Query: `actor`, `action`, `resource`, `resourceId`, `createdAfter`, `createdBefore`, `limit` (50), `offset` (0).

### `POST /admin/circuit-breaker/reset`
Manually reset the runtime circuit breaker.

### `GET /admin/circuit-breaker/history`
Returns the circuit breaker state transition log (§5.3). Up to 200 most-recent entries are retained in-memory per process.

| Param | Values | Default | Notes |
|-------|--------|---------|-------|
| `window` | `1h`, `6h`, `24h`, `7d` | — | Named convenience cutoff. |
| `since` | ISO-8601 | — | Explicit cutoff; overrides `window`. |

Response:
```json
{
  "state": "CLOSED" | "OPEN" | "HALF_OPEN",
  "history": [
    { "state": "CLOSED", "enteredAt": "2026-04-13T00:00:00Z", "reason": "initial" },
    { "state": "OPEN",   "enteredAt": "2026-04-13T01:23:45Z", "reason": "5 consecutive failures" },
    { "state": "HALF_OPEN", "enteredAt": "2026-04-13T01:24:15Z", "reason": "reset timeout after 30000ms" },
    { "state": "CLOSED", "enteredAt": "2026-04-13T01:24:17Z", "reason": "half-open probe succeeded" }
  ]
}
```

Notes: history is in-memory and resets on process restart. For persistent observability, scrape Prometheus `circuit_breaker_state` + `macp_circuit_breaker_{success,failures}_total`.

---

## Health (Public, no auth)

### `GET /healthz`
Liveness probe: `{ "status": "ok" }`

### `GET /readyz`
Readiness probe: `{ "status", "checks": { "database", "runtime", "streamConsumer", "circuitBreaker" } }`

### `GET /metrics`
Prometheus metrics (text format).

---

## Canonical Event Types

Canonical event types are exported as `CANONICAL_EVENT_TYPES` from `src/contracts/control-plane.ts`. Consumers should import that constant rather than string-matching.

| Type | Description |
|------|-------------|
| `run.created` | Run record created |
| `run.started` | Execution began |
| `run.completed` | Successfully resolved |
| `run.failed` | Failed with error |
| `run.cancelled` | User-cancelled |
| `session.bound` | Runtime session established |
| `session.stream.opened` | gRPC stream connected |
| `session.state.changed` | Session state transition |
| `participant.seen` | Participant registered |
| `message.sent` | Outbound message acknowledged |
| `message.received` | Inbound message from runtime |
| `message.send_failed` | Message delivery failed |
| `signal.emitted` | Ambient signal broadcast |
| `signal.acknowledged` | Signal ack — annotates matching `signal.emitted` entry with `acknowledgedAt` / `acknowledgedBy` |
| `proposal.created` | New proposal/request submitted (Proposal, CounterProposal, ApprovalRequest, TaskRequest, HandoffOffer) |
| `proposal.updated` | Evaluation/vote/counter received (Evaluation, Vote, Accept, Reject, Withdraw, Approve, Abstain, TaskAccept, etc.) |
| `decision.proposed` | Decision candidate proposed (reserved; not currently emitted by the default normalizer) |
| `decision.finalized` | Commitment issued — decision is binding and resolved |
| `progress.reported` | Task progress update |
| `tool.called` | Tool invocation |
| `tool.completed` | Tool result |
| `artifact.created` | Artifact linked |
| `policy.resolved` | Policy resolved at session start |
| `policy.commitment.evaluated` | Commitment evaluated against policy rules |
| `policy.denied` | Commitment rejected by policy (includes reasons) |
| `llm.call.completed` | Synthesized by the control plane when an agent message carries LLM metadata (§3.3) |

### Decision Lifecycle — event payload shapes (§3.2)

**Note on naming.** The MACP specification uses terms like *submit / accept / reject* to describe proposal transitions, but the control-plane collapses these to two canonical types on the normalized event stream: `proposal.created` (first time a proposal is seen) and `proposal.updated` (any subsequent contribution — evaluation, vote, counter-proposal, acceptance, rejection, withdrawal). The raw runtime message type is preserved in `data.messageType` so consumers can discriminate.

**`proposal.created`** — subject `{ kind: "proposal", id: <proposalId | messageId> }`
```json
{
  "modeName": "macp.mode.decision.v1",
  "messageType": "Proposal",
  "messageId": "<uuid>",
  "sessionId": "<uuid>",
  "sender": "<participantId>",
  "decodedPayload": {
    "proposalId": "prop-1",
    "option": "<string>",
    "rationale": "<string>",
    "confidence": 0.9
  },
  "payloadTypeName": "macp.modes.decision.v1.ProposalPayload"
}
```

**`proposal.updated`** — subject `{ kind: "proposal", id: <proposalId | messageId> }`

Same envelope as `proposal.created`. `messageType` (e.g. `Evaluation`, `Vote`, `CounterProposal`, `Accept`, `Reject`) and `decodedPayload` discriminate the contribution. Typical `decodedPayload` fields by contribution type:
- `Evaluation` → `{ proposalId, recommendation: "APPROVE"|"REVIEW"|"BLOCK"|"REJECT", confidence, reason }`
- `Vote` → `{ proposalId, vote: "APPROVE"|"REJECT"|"ABSTAIN", reason }` (ABSTAIN votes are excluded from voting ratio denominators per RFC-MACP-0004)
- `Objection` → `{ proposalId, severity: "critical"|"high"|"medium"|"low", reason }` (only `critical` counts toward veto)
- `CounterProposal` → `{ proposalId, revisedAction, rationale }`

**`decision.finalized`** — subject `{ kind: "decision", id: <commitmentId | messageId> }`
```json
{
  "modeName": "macp.mode.decision.v1",
  "messageType": "Commitment",
  "messageId": "<uuid>",
  "sessionId": "<uuid>",
  "sender": "<participantId>",
  "decodedPayload": {
    "proposalId": "prop-1",
    "commitmentId": "commit-1",
    "action": "approve",
    "confidence": 1.0,
    "reason": "Consensus reached",
    "outcome_positive": true
  },
  "payloadTypeName": "macp.modes.decision.v1.CommitmentPayload"
}
```

The projection layer folds `decision.finalized` into `decision.current` with `{ action, confidence, reasons, finalized: true, proposalId, outcomePositive }`. `outcomePositive` resolution is documented above under `GET /runs/:id/state`.

### LLM Interaction Contract (§3.3 + §8)

**`llm.call.completed`** — subject `{ kind: "message", id: <messageId> }`

The control plane synthesizes this event when an agent message carries LLM usage metadata. No Runtime / agent-SDK change is required to start emitting it — the control plane extracts from the same conventions used by the metrics pipeline.

**Where agents put it (any of these, checked in order):**
1. `payload.llmCall` — preferred, full-fidelity form.
2. `payload.metadata.llmCall` — same schema, on the message metadata channel.
3. `payload.tokenUsage` — minimal form (counts + model only).
4. `payload.metadata.tokenUsage` — minimal form on metadata.

**Recognized fields** (all optional; camelCase or snake_case accepted):

| Field | Type | Notes |
|-------|------|-------|
| `promptTokens` / `prompt_tokens` | int | Input tokens. |
| `completionTokens` / `completion_tokens` | int | Output tokens. |
| `model` | string | Model identifier, e.g. `gpt-4o-mini`, `claude-3-haiku`. |
| `latencyMs` / `latency_ms` | int | Wall-clock call latency. |
| `provider` | string | `openai`, `anthropic`, etc. |
| `prompt` | any | The prompt content (subject to redaction). |
| `response` | any | The response content (subject to redaction). |
| `estimatedCostUsd` | float | If the agent pre-computed it; otherwise the CP will continue to use `MODEL_COSTS`. |
| `artifactId` | uuid | If the agent pre-pinned the prompt/response as an artifact. |

**Emitted event `data.decodedPayload` shape:**
```json
{
  "model": "gpt-4o-mini",
  "promptTokens": 120,
  "completionTokens": 45,
  "totalTokens": 165,
  "latencyMs": 890,
  "provider": "openai",
  "prompt": "...",
  "response": "..."
}
```

**Projection surface** — `RunStateProjection.llm`:
```json
{
  "calls": [
    { "participantId", "model", "promptTokens", "completionTokens", "totalTokens", "latencyMs?", "ts", "messageId?", "artifactId?", "estimatedCostUsd?" }
  ],
  "totals": {
    "callCount", "promptTokens", "completionTokens", "totalTokens", "estimatedCostUsd"
  }
}
```

Calls are capped at the most recent 100. Totals continue to accumulate across the full run.

**Privacy / redaction (§8.3).** Set `MACP_REDACT_PATTERNS` to a comma-separated list of JavaScript regexes; matches in any string field of the decoded LLM payload (including `prompt` / `response`) are replaced with `[REDACTED]` before the event is persisted or broadcast on SSE. Default: off. Example:
```
MACP_REDACT_PATTERNS='sk-[A-Za-z0-9]+,\\b\\d{3}-\\d{2}-\\d{4}\\b'
```
(API keys, SSNs). Invalid patterns are logged and skipped; the rest continue to apply.

### Policy Lifecycle — event payload shapes (§3.1)

Policy events are emitted by the runtime on the stream and/or synthesized by the control-plane when a send-ack carries `POLICY_DENIED`.

**`policy.resolved`** — subject `{ kind: "policy", id: <policyId | policyVersion> }`

Emitted when the runtime sends a `PolicyResolved` message at session binding time.
```json
{
  "modeName": "<mode>",
  "messageType": "PolicyResolved",
  "sender": "<runtime agent id>",
  "policyVersion": "policy.fraud.majority",
  "decodedPayload": {
    "policyVersion": "policy.fraud.majority",
    "policyId": "policy.fraud.majority",
    "description": "Majority veto policy",
    "resolvedAt": "2026-04-12T00:00:00Z"
  }
}
```

**`policy.commitment.evaluated`** — subject `{ kind: "policy", id: <commitmentId> }`

Emitted for each commitment the runtime evaluates against the active policy.
```json
{
  "modeName": "<mode>",
  "messageType": "PolicyCommitmentEvaluated",
  "sender": "<runtime agent id>",
  "decodedPayload": {
    "commitmentId": "commit-1",
    "decision": "allow",
    "reasons": ["quorum met", "no blocking objections"]
  }
}
```

`decision` is always `"allow"` or `"deny"`. The projection accumulates these in `policy.commitmentEvaluations[]` (capped at the most recent 50).

**`policy.denied`** — subject `{ kind: "policy", id: <commitmentId | messageId> }`

Emitted in two cases:
1. The runtime sends a `PolicyDenied` stream message.
2. A runtime-emitted send-ack observed on the stream carries `error.code = "POLICY_DENIED"` (the agent's `Send` RPC was rejected by policy). The control-plane synthesizes the event so deny reasons are visible on the event stream even if the runtime doesn't echo them back as a dedicated `PolicyDenied` envelope.

```json
{
  "modeName": "<mode>",
  "messageType": "PolicyDenied",
  "sender": "<runtime agent id | undefined>",
  "errorCode": "POLICY_DENIED",
  "errorMessage": "<human-readable>",
  "decodedPayload": {
    "decision": "deny",
    "reasons": ["commitment outside policy", "..."]
  }
}
```

Reasons are extracted from `error.reasons` when available, otherwise from the `macp-error-details-bin` binary metadata, falling back to the error message. See CLAUDE.md § Policy event pipeline for the full extraction order.

---

## Data Retention

The control plane includes an optional periodic cleanup service that purges old data from PostgreSQL. When enabled, it runs on a configurable interval and deletes:

- **Terminal runs** (completed, failed, cancelled) older than `DATA_RETENTION_TTL_DAYS` — cascade deletes events, projections, metrics, sessions, artifacts, and outbound messages
- **Audit log** entries older than TTL
- **Webhook deliveries** older than TTL

Uses PostgreSQL advisory locks for multi-instance safety (only one instance runs retention at a time).

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_RETENTION_ENABLED` | `false` | Enable periodic data purge |
| `DATA_RETENTION_TTL_DAYS` | `30` | Days to keep data (min 1) |
| `DATA_RETENTION_INTERVAL_HOURS` | `24` | Hours between retention sweeps |
| `DATA_RETENTION_BATCH_SIZE` | `500` | Max runs deleted per batch |

## Error Response Format

```json
{
  "statusCode": 409,
  "errorCode": "INVALID_STATE_TRANSITION",
  "message": "cannot transition run from 'completed' to 'running'"
}
```

See `src/errors/error-codes.ts` for all error codes.
