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

1. The control-plane runtime identity is least-privilege: `can_start_sessions: false, is_observer: true` — either encoded in a minted short-lived JWT (preferred) or in a static entry in the runtime's `MACP_AUTH_TOKENS_JSON`.
2. The control-plane never calls `Send` — enforced by an invariant lint test (`src/runtime/observer-invariant.spec.ts`).
3. `POST /runs` accepts only a scenario-agnostic `RunDescriptor`. Fields like `kickoff[]`, `participants[].role`, `policyHints`, `commitments[]`, `initiatorParticipantId` are rejected (`forbidNonWhitelisted: true`).
4. `sessionId` ownership: allocated by the control-plane (UUID v4) at `POST /runs` and returned to the caller, which distributes it to agents via bootstrap.
5. Cancellation authority stays with the initiator agent unless the scenario's policy explicitly delegates to the control-plane (see `metadata.cancellationDelegated`).
6. The observer `StreamSession` writes exactly one passive-subscribe frame (`{subscribeSessionId, afterSequence}`) per RFC-MACP-0006 §3.2 and then **keeps the write side open** — half-closing would signal "client is done" and stop live-envelope broadcast.

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

Make sure the runtime is running at `RUNTIME_ADDRESS`. For dev auth against the reference runtime profile, start the runtime with `MACP_ALLOW_INSECURE=1 MACP_ALLOW_DEV_SENDER_HEADER=1` (see [runtime/docs/getting-started.md#authentication](../macp-runtime/docs/getting-started.md#authentication) → *Development mode*) and set on the control-plane:

```bash
RUNTIME_ALLOW_INSECURE=true
RUNTIME_USE_DEV_HEADER=true
RUNTIME_DEV_AGENT_ID=macp-control-plane
```

## Runtime auth (observer identity)

The control-plane has **exactly one** runtime identity with fixed scope `is_observer: true, can_start_sessions: false`. `RuntimeCredentialResolverService` resolves credentials per gRPC call using a three-step fallback chain:

| Mode | Trigger | Control-plane env |
| --- | --- | --- |
| JWT mint (preferred) | `MACP_AUTH_SERVICE_URL` set | `MACP_AUTH_SERVICE_URL`, `MACP_AUTH_SERVICE_TIMEOUT_MS`, `MACP_AUTH_TOKEN_TTL_SECONDS`, `MACP_AUTH_TOKEN_SENDER` |
| Static Bearer | JWT disabled or mint fails | `RUNTIME_BEARER_TOKEN` (must match an entry in the runtime's `MACP_AUTH_TOKENS_JSON` with `can_start_sessions: false`) |
| Dev header | `RUNTIME_USE_DEV_HEADER=true`, local only | `RUNTIME_DEV_AGENT_ID` |

For the runtime-side token configuration, TLS, and the full production auth story, see:

- [runtime/docs/getting-started.md#authentication](../macp-runtime/docs/getting-started.md#authentication) — dev / production / JWT modes and resolver order
- [runtime/docs/deployment.md#authentication](../macp-runtime/docs/deployment.md#authentication) — production resolver chain (JWT → static bearer → dev fallback); TLS env vars live in [§ Production checklist](../macp-runtime/docs/deployment.md#production-checklist) and [§ Environment variables](../macp-runtime/docs/deployment.md#environment-variables)
- [python-sdk/docs/auth.md#observer-identities](../python-sdk/docs/auth.md#observer-identities) — observer-identity pattern (the shape the control-plane uses) and `expected_sender` guardrail

Per-agent tokens are **not** held by the control-plane — the scenario layer distributes them to agents via bootstrap. See `../ui-console/plans/direct-agent-auth.md` for the onboarding flow.

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
