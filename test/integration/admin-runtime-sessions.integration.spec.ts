import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';
import { decisionModeRequest, decisionSlowScript } from '../fixtures/decision-mode';
import { waitFor } from '../helpers/wait-for';
import { isRealRuntime } from '../helpers/real-runtime-gate';
import { CIRCUIT_BREAKER_OPEN_MESSAGE } from '../../src/runtime/circuit-breaker';

/**
 * End-to-end coverage for `GET /admin/runtime/sessions` (Phase 7 of
 * plans/absorb-runtime-v0.8.0.md), added during /implement's finalization pass
 * to close a seam the phase's own unit tests couldn't reach: unit tests mock
 * both `RustRuntimeProvider` and `RunRepository` directly, so they never prove
 * the endpoint's diff logic against a real Postgres-backed run record or a
 * real HTTP round trip through auth + the global exception filter.
 *
 * `ScriptedMockRuntimeProvider.listSessions()` is a stub that always returns
 * an empty result (see its own comment inviting per-test overrides, mirroring
 * `watchSessions`/`watchSignals`) — each test below overrides
 * `ctx.mockRuntime.listSessions` directly to script the runtime-side half of
 * the diff, while the control-plane-side half comes from a real run created
 * through the HTTP API and persisted in the real test database.
 *
 * Gated mock-only (isRealRuntime ? describe.skip : describe), matching
 * handoff-implicit-accept.integration.spec.ts — this depends on
 * ScriptedMockRuntimeProvider's `listSessions` being directly overridable
 * per test, not real-runtime behavior. Without this gate, `beforeEach`
 * assigning to `ctx.mockRuntime.listSessions` throws under
 * `INTEGRATION_RUNTIME=docker|remote` (`test-app.ts` sets `mockRuntime = null`
 * for those modes), hard-failing every test in this file.
 *
 * Uses `decisionSlowScript()` (not `decisionHappyScript()`) so a run stays in
 * `running` for ~2s instead of racing to `completed` in ~35-177ms — several
 * tests below need the run to still be active while they script
 * `listSessions()` and call the endpoint; the one test that specifically
 * needs a *completed* run waits for that state explicitly.
 */
(isRealRuntime ? describe.skip : describe)('GET /admin/runtime/sessions (integration, Phase 7 finalization)', () => {
  let ctx: TestAppContext;
  let client: TestClient;

  beforeAll(async () => {
    ctx = await createTestApp(decisionSlowScript(2000));
    client = ctx.client;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
    // Reset to the stub between tests so one test's override never leaks into the next.
    ctx.mockRuntime.listSessions = async () => ({ sessions: [], complete: true, pagesFetched: 0 });
  });

  it('requires auth like every other admin route', async () => {
    const noAuthClient = new TestClient(ctx.url);
    const res = await noAuthClient.requestNoAuth('GET', '/admin/runtime/sessions');
    expect(res.status).toBe(401);
  });

  it('reports no drift when a real, bound run is echoed back as a live runtime session', async () => {
    const { runId, sessionId } = await client.createRun(decisionModeRequest());
    // `runtimeSessionId` is pre-allocated at run creation, before the runtime
    // session exists — waiting on it would be a no-op. Wait for `running`
    // instead, which only happens after RunExecutorService's bindSession
    // succeeds, i.e. the session genuinely exists on the (mock) runtime side.
    await waitFor(
      async () => {
        const r = (await client.getRun(runId)) as any;
        return r.status === 'running' ? r : null;
      },
      { timeoutMs: 3000, label: 'run reached running' }
    );

    ctx.mockRuntime.listSessions = async () => ({
      sessions: [{ sessionId, mode: 'macp.mode.decision.v1', state: 'SESSION_STATE_OPEN' as const }],
      complete: true,
      pagesFetched: 1
    });

    const result = (await client.request('GET', '/admin/runtime/sessions')) as any;
    expect(result.complete).toBe(true);
    expect(result.untrackedSessions).toEqual([]);
    expect(result.missingFromRuntime).toEqual([]);
    expect(result.liveRuntimeSessionCount).toBe(1);
  });

  it('reports a runtime session with no matching tracked run as untracked drift', async () => {
    const orphanSessionId = '11111111-1111-4111-8111-111111111111';
    ctx.mockRuntime.listSessions = async () => ({
      sessions: [{ sessionId: orphanSessionId, mode: 'macp.mode.handoff.v1', state: 'SESSION_STATE_OPEN' as const }],
      complete: true,
      pagesFetched: 1
    });

    const result = (await client.request('GET', '/admin/runtime/sessions')) as any;
    expect(result.untrackedSessions).toEqual([
      { sessionId: orphanSessionId, mode: 'macp.mode.handoff.v1', state: 'SESSION_STATE_OPEN' }
    ]);
  });

  it('reports a tracked, bound run the runtime no longer lists as missingFromRuntime', async () => {
    const { runId, sessionId } = await client.createRun(decisionModeRequest());
    await waitFor(
      async () => {
        const r = (await client.getRun(runId)) as any;
        return r.status === 'running' ? r : null;
      },
      { timeoutMs: 3000, label: 'run reached running' }
    );

    // Runtime reports no sessions at all — the tracked run's session is gone.
    ctx.mockRuntime.listSessions = async () => ({ sessions: [], complete: true, pagesFetched: 1 });

    const result = (await client.request('GET', '/admin/runtime/sessions')) as any;
    expect(result.missingFromRuntime).toEqual([{ runId, runtimeSessionId: sessionId }]);
  });

  it('excludes a completed run whose session the runtime still reports (retention window) from untrackedSessions', async () => {
    // Drive a real run through the full pipeline to `completed` — this is the
    // production condition the ship-gate's retention-window fix protects
    // against: the control plane has already finalized and stopped tracking
    // this run as active, while the runtime (per its own retention window)
    // still reports the now-terminal session for a while. A naive diff
    // against the raw session list would show this as "untracked" drift;
    // the real endpoint must not.
    const { runId, sessionId } = await client.createRun(decisionModeRequest());
    await waitFor(
      async () => {
        const r = (await client.getRun(runId)) as any;
        return r.status === 'completed' ? r : null;
      },
      { timeoutMs: 5000, label: 'run completed' }
    );

    ctx.mockRuntime.listSessions = async () => ({
      sessions: [{ sessionId, mode: 'macp.mode.decision.v1', state: 'SESSION_STATE_RESOLVED' as const }],
      complete: true,
      pagesFetched: 1
    });

    const result = (await client.request('GET', '/admin/runtime/sessions')) as any;
    expect(result.untrackedSessions).toEqual([]);
    expect(result.runtimeSessionCount).toBe(1);
    expect(result.liveRuntimeSessionCount).toBe(0);
  }, 10000);

  it('surfaces complete: false verbatim and returns missingFromRuntime as null under a truncated drain', async () => {
    const { runId } = await client.createRun(decisionModeRequest());
    await waitFor(
      async () => {
        const r = (await client.getRun(runId)) as any;
        return r.status === 'running' ? r : null;
      },
      { timeoutMs: 3000, label: 'run reached running' }
    );

    ctx.mockRuntime.listSessions = async () => ({ sessions: [], complete: false, pagesFetched: 200 });

    const result = (await client.request('GET', '/admin/runtime/sessions')) as any;
    expect(result.complete).toBe(false);
    expect(result.missingFromRuntime).toBeNull();
    expect(result.untrackedSessions).toEqual([]);
  });

  it('still reports a genuine untracked (orphan) session under a truncated drain — the forward diff stays sound even when the reverse one is suppressed', async () => {
    const orphanSessionId = '22222222-2222-4222-8222-222222222222';
    ctx.mockRuntime.listSessions = async () => ({
      sessions: [{ sessionId: orphanSessionId, mode: 'macp.mode.handoff.v1', state: 'SESSION_STATE_OPEN' as const }],
      complete: false,
      pagesFetched: 200
    });

    const result = (await client.request('GET', '/admin/runtime/sessions')) as any;
    expect(result.complete).toBe(false);
    expect(result.missingFromRuntime).toBeNull();
    expect(result.untrackedSessions).toEqual([
      { sessionId: orphanSessionId, mode: 'macp.mode.handoff.v1', state: 'SESSION_STATE_OPEN' }
    ]);
  });

  it('translates a circuit-breaker-open failure into a real HTTP 503, not a bare 500', async () => {
    ctx.mockRuntime.listSessions = async () => {
      throw new Error(CIRCUIT_BREAKER_OPEN_MESSAGE);
    };

    const res = await ctx.client.requestNoAuth('GET', '/admin/runtime/sessions', {
      headers: { Authorization: 'Bearer test-key-integration' }
    });

    expect(res.status).toBe(503);
    const body = res.body as Record<string, unknown>;
    expect(body.errorCode).toBe('CIRCUIT_BREAKER_OPEN');
  });
});
