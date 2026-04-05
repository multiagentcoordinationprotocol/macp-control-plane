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

---

## Runs

### `POST /runs`
Create and launch a runtime execution run.

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
        { "id": "agent-1", "role": "proposer" },
        { "id": "agent-2", "role": "evaluator" }
      ]
    },
    "kickoff": [{
      "from": "agent-1",
      "to": ["agent-2"],
      "kind": "proposal",
      "messageType": "Proposal",
      "payload": { "proposalId": "p-1", "option": "Deploy" }
    }],
    "execution": {
      "idempotencyKey": "unique-key",
      "tags": ["production"],
      "requester": { "actorId": "user-1", "actorType": "user" }
    }
  }'
```

**Response (202):** `{ "runId": "uuid", "status": "queued", "traceId": "..." }`

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
  "decision": { "current": { "action", "confidence", "finalized", "proposalId" } },
  "signals": { "signals": [{ "id", "name", "severity", "sourceParticipantId", "confidence" }] },
  "progress": { "entries": [{ "participantId", "percentage", "message" }] },
  "timeline": { "latestSeq", "totalEvents", "recent": [...] },
  "trace": { "traceId", "spanCount", "linkedArtifacts" },
  "outboundMessages": { "total", "queued", "accepted", "rejected" }
}
```

### `GET /runs/:id/events`
List canonical events. Query: `afterSeq` (default 0), `limit` (default 200).

### `POST /runs/:id/cancel`
Cancel a running session. Body: `{ "reason": "optional" }`

### `POST /runs/:id/clone`
Clone a run with optional overrides. Body: `{ "tags": [...], "context": {...} }`

### `POST /runs/:id/archive`
Archive a run. Sets `archivedAt` timestamp and adds `'archived'` tag. Excluded from default listings (retrievable with `includeArchived=true`).

### `DELETE /runs/:id`
Delete a terminal run (completed, failed, or cancelled only).

### `POST /runs/:id/projection/rebuild`
Rebuild the projection from canonical events.

---

## Messages & Signals

### `POST /runs/:id/messages`
Send a session-bound MACP message into an active run.

```bash
curl -X POST http://localhost:3001/runs/{id}/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "evaluator",
    "to": ["proposer"],
    "messageType": "Evaluation",
    "payload": { "recommendation": "APPROVE", "confidence": 0.95 }
  }'
```

For proto-encoded payloads (required by real runtime):
```json
{
  "from": "evaluator",
  "to": ["proposer"],
  "messageType": "Evaluation",
  "payloadEnvelope": {
    "encoding": "proto",
    "proto": {
      "typeName": "macp.modes.decision.v1.EvaluationPayload",
      "value": { "proposalId": "p-1", "recommendation": "APPROVE", "confidence": 0.95 }
    }
  }
}
```

### `POST /runs/:id/signal`
Send a signal (ambient plane, non-binding). Signals use empty `sessionId` and `modeName`.

```json
{
  "from": "evaluator",
  "to": ["proposer"],
  "messageType": "Signal",
  "payload": { "signalType": "progress", "data": "Analyzing...", "confidence": 0.5 }
}
```

### `GET /runs/:id/messages`
List outbound messages for a run.

### `POST /runs/:id/context`
Update session context during execution.

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

| Param | Values | Default |
|-------|--------|---------|
| `range` | `24h`, `7d`, `30d` | `24h` |

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
    "runVolume": { "labels": [...], "data": [...] },
    "latency": { "labels": [...], "data": [...] },
    "signalVolume": { "labels": [...], "data": [...] },
    "errorClasses": { "labels": [...], "data": [...] }
  }
}
```

The `recentRuns` array contains up to 10 latest non-archived runs. The `runtimeHealth` reflects the current runtime connection status. `totalTokens` and `totalCostUsd` are aggregated from `run_metrics` for runs in the time range. Packs data should be fetched separately from the Examples Service.

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
Trace summary: `{ "traceId", "spanCount", "lastSpanId", "linkedArtifacts" }`

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

**Token usage convention:** Agents include token data in message metadata:
```json
POST /runs/:id/messages
{
  "from": "fraud-agent",
  "messageType": "Evaluation",
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

The control plane extracts `tokenUsage` from event data/metadata during normalization and accumulates per-run totals. Cost is estimated using built-in per-model rates.

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
| `proposal.created` | Proposal/request submitted |
| `proposal.updated` | Evaluation/vote/counter received |
| `decision.finalized` | Commitment issued |
| `progress.reported` | Task progress update |
| `tool.called` | Tool invocation |
| `tool.completed` | Tool result |
| `artifact.created` | Artifact linked |

## Error Response Format

```json
{
  "statusCode": 409,
  "errorCode": "INVALID_STATE_TRANSITION",
  "message": "cannot transition run from 'completed' to 'running'"
}
```

See `src/errors/error-codes.ts` for all error codes.
