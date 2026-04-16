# MACP Control Plane (NestJS)

A scenario-agnostic, **observer-only** control plane for the MACP runtime.

This service is the backend that a Next.js UI talks to for run lifecycle, live stream projection, replay, traces, metrics, and artifacts.

## Role

The control plane is an observer. **It never calls `Send`** on the runtime.

- **UI**: browse runs, launch, render graphs and traces.
- **Scenario layer** (e.g. `examples-service`): compile scenarios → produce a generic `RunDescriptor` for this service + per-agent bootstrap for the initiator + participant agents.
- **Agents**: authenticate to the runtime directly with their own Bearer tokens and emit their own envelopes (SessionStart, kickoff, Proposal / Evaluation / Vote / etc.) via `macp-sdk-python` or `macp-sdk-typescript`.
- **Control plane**: allocates `sessionId`, polls `GetSession(sessionId)` until the initiator agent opens it, then subscribes read-only to `StreamSession(sessionId)`. Projects canonical events for the UI.
- **Runtime**: authoritative orchestrator of MACP envelopes and modes.

## Invariants (see `../ui-console/plans/direct-agent-auth.md` §Invariants)

1. The control-plane runtime identity is least-privilege: `can_start_sessions: false` in runtime's `MACP_AUTH_TOKENS_JSON`.
2. The control-plane never calls `Send` — enforced by an invariant lint test (`src/runtime/observer-invariant.spec.ts`).
3. `POST /runs` accepts only a scenario-agnostic `RunDescriptor`. Fields like `kickoff[]`, `participants[].role`, `policyHints`, `commitments[]`, `initiatorParticipantId` are rejected (`forbidNonWhitelisted: true`).
4. `sessionId` ownership: allocated by the control-plane (UUID v4) at `POST /runs` and returned to the caller, which distributes it to agents via bootstrap.
5. Cancellation authority stays with the initiator agent unless the scenario's policy explicitly delegates to the control-plane (see `metadata.cancellationDelegated`).

## Endpoints

### Runs
- `POST /runs` — accepts a `RunDescriptor`; returns `{runId, sessionId, status, traceId}`
- `GET /runs/:id` — run record
- `GET /runs/:id/state` — projected UI state
- `GET /runs/:id/events` — canonical events
- `GET /runs/:id/stream` — SSE of live events
- `POST /runs/:id/cancel` — UI cancel (Option A: proxies to initiator agent's cancelCallback; Option B: calls runtime.CancelSession when policy-delegated)
- `POST /runs/validate` — preflight validation
- `POST /runs/:id/clone` — clone with optional tag overrides (session context overrides rejected)
- `POST /runs/:id/replay` — replay descriptor

### Removed (direct-agent-auth CP-5/6/7)
These endpoints return **410 Gone**. Agents emit envelopes via the SDKs directly:
- ~~`POST /runs/:id/messages`~~
- ~~`POST /runs/:id/signal`~~
- ~~`POST /runs/:id/context`~~

### Runtime discovery
- `GET /runtime/manifest`, `/runtime/modes`, `/runtime/roots`, `/runtime/health`
- `GET /runtime/policies`, `POST /runtime/policies`, `DELETE /runtime/policies/:id`

### Observability
- `GET /runs/:id/traces`, `/runs/:id/artifacts`, `/runs/:id/metrics`
- `GET /dashboard/overview`, `/dashboard/agents/metrics`
- `GET /healthz`, `/readyz`, `/metrics`, `/docs` (dev only)

## Request shape

```json
{
  "mode": "live",
  "runtime": { "kind": "rust" },
  "session": {
    "sessionId": "optional — UUID v4/v7 or base64url 22+",
    "modeName": "macp.mode.decision.v1",
    "modeVersion": "1.0.0",
    "configurationVersion": "config.default",
    "policyVersion": "policy.default",
    "ttlMs": 600000,
    "participants": [
      { "id": "fraud-agent" },
      { "id": "risk-agent" },
      { "id": "growth-agent" }
    ],
    "metadata": {
      "source": "examples-service",
      "sourceRef": "fraud/high-value-new-device@1.0.0",
      "environment": "production",
      "cancelCallback": {
        "url": "http://initiator.internal/agent/cancel",
        "bearer": "opt-in-shared-secret"
      }
    }
  },
  "execution": {
    "idempotencyKey": "fraud-high-value-new-device-demo-1",
    "tags": ["demo", "fraud"],
    "requester": { "actorId": "coordinator", "actorType": "service" }
  }
}
```

Response: `{ "runId": "<uuid>", "sessionId": "<uuid>", "status": "queued", "traceId": "..." }`

## Local development

```bash
cp .env.example .env
npm install
npm run drizzle:migrate
npm run start:dev
```

Make sure the runtime is running at `RUNTIME_ADDRESS`. For dev auth against the reference runtime profile:

```bash
export MACP_ALLOW_INSECURE=1
export MACP_ALLOW_DEV_SENDER_HEADER=1
cargo run
```

Then:

```bash
RUNTIME_ALLOW_INSECURE=true
RUNTIME_USE_DEV_HEADER=true
RUNTIME_DEV_AGENT_ID=control-plane
```

## Production runtime auth

Add one entry to the runtime's `MACP_AUTH_TOKENS_JSON` for the control-plane. It is a **read-only observer** and must not have session-start authority:

```json
{
  "token": "obs-control-plane-token",
  "sender": "control-plane",
  "can_start_sessions": false
}
```

If your deployment makes the control-plane the policy admin (optional), set `can_manage_mode_registry: true`.

Then in the control-plane environment:
```bash
RUNTIME_BEARER_TOKEN=obs-control-plane-token
```

Each agent additionally gets its own entry (with `can_start_sessions: true` for the initiator). Per-agent tokens are **not** shared with the control-plane — the scenario layer distributes them to agents via bootstrap. See `../ui-console/plans/direct-agent-auth.md` for the full onboarding flow.

## Migration from pre-2026-04 control-plane

If you're upgrading from a control-plane version that had `POST /runs/:id/{messages,signal,context}`, those endpoints now return **410 Gone**. Agents must migrate to `macp-sdk-python` or `macp-sdk-typescript` and authenticate directly to the runtime. `RUNTIME_AGENT_TOKENS_JSON` is removed; its entries move to the runtime's `MACP_AUTH_TOKENS_JSON` (one per agent) and to the scenario layer's per-agent bootstrap.

## Database tables

- `runs` (with `runtime_session_id` populated at creation)
- `runtime_sessions`
- `run_events_raw`, `run_events_canonical`
- `run_projections`, `run_artifacts`, `run_metrics`
- `run_outbound_messages`, `audit_log`, `webhooks`, `webhook_deliveries`

## Repo layout

```text
src/
  controllers/        # NestJS controllers
  runs/               # run manager, observer executor, stream consumer
  runtime/            # observer-only runtime provider, proto decoder, credential resolver
  events/             # canonical event normalizer + SSE hub
  projection/         # UI read models
  replay/             # deterministic replay endpoints
  metrics/            # metrics aggregation
  artifacts/          # artifact registration/listing
  storage/            # Drizzle repositories
  db/                 # Drizzle schema + database service
  telemetry/          # OpenTelemetry bootstrap and manual spans
  dto/                # request/response schemas for OpenAPI
  contracts/          # TypeScript interfaces (RunDescriptor, RuntimeProvider, ...)
```
