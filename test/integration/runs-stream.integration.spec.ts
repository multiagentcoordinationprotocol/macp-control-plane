import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestSSEClient } from '../helpers/sse-client';
import { decisionModeRequest, decisionHappyScript } from '../fixtures/decision-mode';
import { waitFor } from '../helpers/wait-for';

describe('Run SSE Streaming (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(decisionHappyScript());
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  // Wait until the canonical event log has settled: run.completed present AND the
  // count stable across two consecutive polls. Trailing envelopes can land after
  // run.completed, so capturing the log on the first "has run.completed" poll
  // yields an incomplete set and makes exact count assertions racy.
  async function settledEvents(runId: string): Promise<any[]> {
    let prevCount = -1;
    return waitFor(
      async () => {
        const e = (await ctx.client.listEvents(runId)) as any[];
        const settled = e.some((ev: any) => ev.type === 'run.completed') && e.length === prevCount;
        prevCount = e.length;
        return settled ? e : null;
      },
      { timeoutMs: 10000, intervalMs: 150, label: 'canonical events settled' },
    );
  }

  it('SSE stream delivers canonical events', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const sse = new TestSSEClient(ctx.url, 'test-key-integration');
    sse.connect(runId, { includeSnapshot: true });

    try {
      await waitFor(() => sse.events.length > 0, { timeoutMs: 5000, label: 'first SSE event' });

      for (const event of sse.events) {
        expect(event).toHaveProperty('type');
        expect(event).toHaveProperty('data');
        expect(['snapshot', 'canonical_event', 'heartbeat']).toContain(event.type);
      }
    } finally {
      sse.close();
    }
  });

  it('SSE stream includes snapshot when requested', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const sse = new TestSSEClient(ctx.url, 'test-key-integration');
    sse.connect(runId, { includeSnapshot: true });

    try {
      const snapshots = await waitFor(
        () => {
          const s = sse.getEventsByType('snapshot');
          return s.length > 0 ? s : null;
        },
        { timeoutMs: 5000, label: 'snapshot event' },
      );

      const snapshot = snapshots[0].data as Record<string, unknown>;
      expect(snapshot).toHaveProperty('run');
      expect(snapshot).toHaveProperty('participants');
    } finally {
      sse.close();
    }
  });

  it('SSE events have sequential IDs for resume support', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const sse = new TestSSEClient(ctx.url, 'test-key-integration');
    sse.connect(runId);

    try {
      const ids = await waitFor(
        () => {
          const canonical = sse.getEventsByType('canonical_event');
          if (canonical.length < 2) return null;
          return canonical.map((e) => e.id).filter((id) => id !== undefined);
        },
        { timeoutMs: 5000, label: '>=2 canonical events' },
      );
      expect(ids.length).toBeGreaterThan(0);
    } finally {
      sse.close();
    }
  });

  it('reconnect with Last-Event-Id header replays only events with seq > N', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    // Let the run finish so the full event log is persisted (and settled).
    const events = await settledEvents(runId);

    const lastEventId = events[1].seq as number;
    const expected = events.filter((e: any) => e.seq > lastEventId);

    const sse = new TestSSEClient(ctx.url, 'test-key-integration');
    sse.connect(runId, {
      includeSnapshot: false,
      headers: { 'Last-Event-Id': String(lastEventId) },
    });

    try {
      const replayed = await waitFor(
        () => {
          const canonical = sse.getEventsByType('canonical_event');
          return canonical.length >= expected.length ? canonical : null;
        },
        { timeoutMs: 5000, label: 'Last-Event-Id backfill delivered' },
      );

      const seqs = replayed.map((e) => (e.data as any).seq);
      expect(Math.min(...seqs)).toBe(lastEventId + 1);
      for (const seq of seqs) {
        expect(seq).toBeGreaterThan(lastEventId);
      }
      expect(seqs.length).toBe(expected.length);
    } finally {
      sse.close();
    }
  });

  it('afterSeq query param wins over Last-Event-Id header when both are present', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const events = await settledEvents(runId);

    // High afterSeq via query, low Last-Event-Id via header. If the header won,
    // backfill would start right after seq 1; the query must win.
    const afterSeq = events[events.length - 2].seq as number;
    const expected = events.filter((e: any) => e.seq > afterSeq);
    expect(expected.length).toBeGreaterThan(0);

    const sse = new TestSSEClient(ctx.url, 'test-key-integration');
    sse.connect(runId, {
      afterSeq,
      includeSnapshot: false,
      headers: { 'Last-Event-Id': '1' },
    });

    try {
      const replayed = await waitFor(
        () => {
          const canonical = sse.getEventsByType('canonical_event');
          return canonical.length >= expected.length ? canonical : null;
        },
        { timeoutMs: 5000, label: 'afterSeq backfill delivered' },
      );

      // Backfill emits in ascending order, so the very first replayed event
      // proves which resume point was honored.
      expect((replayed[0].data as any).seq).toBe(afterSeq + 1);
      for (const event of replayed) {
        expect((event.data as any).seq).toBeGreaterThan(afterSeq);
      }
    } finally {
      sse.close();
    }
  });

  it('SSE stream can resume from afterSeq', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const events = await waitFor(
      async () => {
        const e = await ctx.client.listEvents(runId);
        return Array.isArray(e) && e.length > 0 ? e : null;
      },
      { timeoutMs: 5000, label: 'at least one canonical event' },
    );

    const midSeq = (events[0] as { seq: number }).seq;

    const sse = new TestSSEClient(ctx.url, 'test-key-integration');
    sse.connect(runId, { afterSeq: midSeq });

    try {
      await waitFor(() => sse.events.length > 0, { timeoutMs: 5000, label: 'SSE resume delivered events' });

      const canonicalEvents = sse.getEventsByType('canonical_event');
      for (const event of canonicalEvents) {
        const data = event.data as Record<string, unknown>;
        if (data.seq !== undefined) {
          expect(data.seq as number).toBeGreaterThan(midSeq);
        }
      }
    } finally {
      sse.close();
    }
  });
});
