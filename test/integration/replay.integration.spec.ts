import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestSSEClient } from '../helpers/sse-client';
import { decisionModeRequest, decisionHappyScript } from '../fixtures/decision-mode';
import { waitFor } from '../helpers/wait-for';

/**
 * Replay endpoints: POST /runs/:id/replay (descriptor), GET /runs/:id/replay/stream
 * (SSE replay of persisted canonical events), GET /runs/:id/replay/state (state at seq).
 *
 * One run is driven to completion in beforeAll and replayed by every test.
 */
describe('Run Replay (integration)', () => {
  let ctx: TestAppContext;
  let runId: string;
  let allEvents: any[];

  beforeAll(async () => {
    ctx = await createTestApp(decisionHappyScript());
    // NOTE: no ctx.cleanup() in beforeEach — every test replays the same
    // completed run driven once here. Clean once up-front so state left by a
    // previous suite (e.g. still-active webhooks) can't bleed into this one.
    await ctx.cleanup();
    const created = await ctx.client.createRun(decisionModeRequest());
    runId = created.runId;
    await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return r.status === 'completed' ? r : null;
      },
      { timeoutMs: 10000, label: 'run completed' },
    );
    // Wait until the canonical event stream has fully settled: run.completed
    // present AND the count stable across two consecutive polls. Trailing
    // envelopes (e.g. the terminal snapshot) can land after run.completed, so a
    // single "has run.completed" check would capture an incomplete allEvents and
    // make the count-based assertions below racy.
    let prevCount = -1;
    allEvents = await waitFor(
      async () => {
        const e = (await ctx.client.listEvents(runId)) as any[];
        const settled = e.some((ev) => ev.type === 'run.completed') && e.length === prevCount;
        prevCount = e.length;
        return settled ? e : null;
      },
      { timeoutMs: 8000, intervalMs: 150, label: 'canonical events settled' },
    );
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  function collectReplay(path: string): Promise<TestSSEClient> {
    const sse = new TestSSEClient(ctx.url, 'test-key-integration');
    sse.connect(runId, { path });
    return sse.waitForCompletion(15000).then(() => sse);
  }

  it('POST /runs/:id/replay returns a descriptor with streamUrl/stateUrl and default speed', async () => {
    const descriptor = (await ctx.client.request('POST', `/runs/${runId}/replay`, {
      body: { mode: 'instant' },
    })) as any;

    expect(descriptor.runId).toBe(runId);
    expect(descriptor.mode).toBe('instant');
    expect(descriptor.speed).toBe(1);
    expect(descriptor.streamUrl).toBe(`/runs/${runId}/replay/stream?mode=instant&speed=1`);
    expect(descriptor.stateUrl).toBe(`/runs/${runId}/replay/state`);
  });

  it('GET /runs/:id/replay/stream?mode=instant replays every canonical event in ascending seq order, then completes', async () => {
    const sse = await collectReplay(`/runs/${runId}/replay/stream?mode=instant`);

    const replayed = sse.getEventsByType('canonical_event').map((e) => e.data as any);
    expect(replayed.length).toBe(allEvents.length);

    const seqs = replayed.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    expect(replayed.map((e) => e.type)).toEqual(allEvents.map((e) => e.type));
  });

  it('fromSeq/toSeq as query params are rejected with 400 (deviation: ReplayRequestDto lacks @Type coercion)', async () => {
    // Reality: GET /runs/:id/replay/stream?fromSeq=N arrives as the string "N";
    // ReplayRequestDto declares @IsNumber() without @Type(() => Number) and the
    // controller's ValidationPipe does not enable implicit conversion, so any
    // numeric replay bound passed via query string fails validation. The
    // fromSeq/toSeq window is therefore unusable over the documented SSE
    // endpoint — flagged as a source bug, tested as-is.
    const fromSeq = allEvents[1].seq;
    const result = (await ctx.client.request(
      'GET',
      `/runs/${runId}/replay/stream?mode=instant&fromSeq=${fromSeq}`,
    )) as any;
    expect(result.statusCode).toBe(400);
    expect(JSON.stringify(result.message)).toContain('fromSeq');
  });

  it('replay/state?seq honors the sequence upper bound (inclusive)', async () => {
    // The seq-bounded projection path works (manual Number() coercion in the
    // controller) — use it to verify bounds semantics end-to-end.
    const boundSeq = allEvents[2].seq;
    const state = (await ctx.client.request('GET', `/runs/${runId}/replay/state`, {
      query: { seq: boundSeq },
    })) as any;
    expect(state.timeline.latestSeq).toBe(boundSeq);
    expect(state.timeline.totalEvents).toBe(allEvents.filter((e) => e.seq <= boundSeq).length);
  });

  it('replay/state at a pre-Commitment seq shows the decision not yet finalized', async () => {
    const finalizedEvent = allEvents.find((e) => e.type === 'decision.finalized');
    expect(finalizedEvent).toBeDefined();

    const state = (await ctx.client.request(
      'GET',
      `/runs/${runId}/replay/state`,
      { query: { seq: finalizedEvent.seq - 1 } },
    )) as any;

    expect(state.run.runId).toBe(runId);
    expect(state.decision?.current?.finalized ?? false).toBe(false);
    expect(state.timeline.latestSeq).toBeLessThan(finalizedEvent.seq);
  });

  it('replay/state without seq reconstructs the final decision state', async () => {
    const replayed = (await ctx.client.request('GET', `/runs/${runId}/replay/state`)) as any;
    const live = (await ctx.client.getState(runId)) as any;

    // replay/state rebuilds from the full settled canonical log in one pass, so
    // its counters are exact against the settled baseline.
    expect(replayed.timeline.totalEvents).toBe(allEvents.length);
    expect(replayed.timeline.latestSeq).toBe(allEvents[allEvents.length - 1].seq);

    // Semantic equivalence with the live projection (these fields are stable —
    // unlike timeline.totalEvents, which the incrementally-built live projection
    // can undercount under concurrent event batches while replay stays exact).
    expect(replayed.run.status).toBe('completed');
    expect(replayed.run.status).toBe(live.run.status);
    expect(replayed.decision.current.finalized).toBe(true);
    expect(replayed.decision.current.finalized).toBe(live.decision.current.finalized);
    expect(replayed.participants.map((p: any) => p.participantId).sort()).toEqual(
      live.participants.map((p: any) => p.participantId).sort(),
    );
  });

  it('replay of a nonexistent run does NOT 404 (deviation: no existence check on replay endpoints)', async () => {
    // Reality: ReplayService.describe / stateAt never look up the run record, so
    // an unknown runId yields a descriptor / empty projection instead of 404.
    const missing = '00000000-0000-4000-8000-000000000000';

    const descriptor = (await ctx.client.request('POST', `/runs/${missing}/replay`, {
      body: { mode: 'instant' },
    })) as any;
    expect(descriptor.statusCode).toBeUndefined();
    expect(descriptor.runId).toBe(missing);

    const state = (await ctx.client.request('GET', `/runs/${missing}/replay/state`)) as any;
    expect(state.statusCode).toBeUndefined();
    expect(state.run.runId).toBe(missing);
    expect(state.timeline.totalEvents).toBe(0);
  });
});
