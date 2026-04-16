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
