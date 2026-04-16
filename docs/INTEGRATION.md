# MACP Control Plane — Integration Guide

## Adding a Runtime Provider

1. Implement the `RuntimeProvider` interface from `src/contracts/runtime.ts`
2. Register it as a NestJS provider in `app.module.ts`
3. Add it to `RuntimeProviderRegistry` so it can be looked up by `kind`

Key methods to implement (observer-only surface, post direct-agent-auth):
- `initialize()` — protocol version negotiation.
- `subscribeSession({runId, runtimeSessionId})` — read-only `StreamSession` observer; returns `{events, abort}`. **Never writes envelopes.**
- `getSession()` — poll for session state (used by the observer's `pollForOpenSession` loop).
- `cancelSession()` — only called when `run.metadata.cancellationDelegated === true` (Option B in direct-agent-auth §Cancellation design).
- `getManifest()` / `listModes()` / `listRoots()` / `health()` — metadata.
- `registerPolicy()` / `unregisterPolicy()` / `getPolicy()` / `listPolicies()` — governance (RFC-MACP-0012).

## Agents emit envelopes directly

Agents authenticate to the runtime with their own Bearer tokens (RFC-MACP-0004 §4) and emit envelopes via `macp-sdk-python` / `macp-sdk-typescript`:

```python
# Python example (direct-agent-auth)
from macp_sdk import MacpClient, AuthConfig, DecisionSession, new_session_id

auth = AuthConfig.for_bearer(os.environ["MACP_BEARER_TOKEN"], expected_sender="evaluator")
client = MacpClient(target="runtime.internal:50051", secure=True, auth=auth)
await client.initialize()
session = DecisionSession(client, session_id=bootstrap.run.sessionId, auth=auth)
stream = session.open_stream()
await session.evaluate(proposal_id="prop-1", recommendation="APPROVE", confidence=0.95)
```

```typescript
// TypeScript example
import { MacpClient, Auth, DecisionSession } from 'macp-sdk-typescript';

const client = new MacpClient({
  address: 'runtime.internal:50051',
  secure: true,
  auth: Auth.bearer(process.env.MACP_BEARER_TOKEN!, { expectedSender: 'evaluator' }),
});
await client.initialize();
const session = new DecisionSession(client, { sessionId: bootstrap.run.sessionId });
const stream = session.openStream();
await session.evaluate({ proposalId: 'prop-1', recommendation: 'APPROVE', confidence: 0.95 });
```

The control-plane's old HTTP escalation endpoints (`POST /runs/:id/{messages,signal,context}`)
now return **410 Gone**. See `../plans/../../ui-console/plans/direct-agent-auth.md` for the full migration story.

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
# Mock runtime (fast, no external dependencies)
npm run test:integration

# Real Rust runtime (needs runtime on port 50051)
INTEGRATION_RUNTIME=remote RUNTIME_ADDRESS=127.0.0.1:50051 npm run test:integration

# Python agent E2E tests (LangChain + CrewAI)
./scripts/run-e2e.sh decision
```

See `test/integration/` for TypeScript integration tests. Python agent harnesses now live in the `examples-service` repo (not `test-agents/`).

## Environment Variables

See `.env.example` for all configurable variables with descriptions and defaults.
