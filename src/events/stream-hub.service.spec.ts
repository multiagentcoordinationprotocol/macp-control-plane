import { StreamHubService, StreamHubMessage } from './stream-hub.service';
import { MemoryStreamHubStrategy } from './memory-stream-hub.strategy';
import { CanonicalEvent, RunStateProjection } from '../contracts/control-plane';
import { Subscription } from 'rxjs';

describe('StreamHubService', () => {
  let service: StreamHubService;
  let strategy: MemoryStreamHubStrategy;

  beforeEach(() => {
    jest.useFakeTimers();
    strategy = new MemoryStreamHubStrategy();
    service = new StreamHubService(strategy);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const makeEvent = (runId: string, seq = 1): CanonicalEvent => ({
    id: `evt-${seq}`,
    runId,
    seq,
    ts: new Date().toISOString(),
    type: 'message.sent',
    source: { kind: 'runtime', name: 'test-runtime' },
    data: { content: `event-${seq}` }
  });

  const makeSnapshot = (runId: string): RunStateProjection => ({
    run: {
      runId,
      status: 'running'
    },
    participants: [],
    graph: { nodes: [], edges: [] },
    decision: {},
    signals: { signals: [] },
    progress: { entries: [] },
    timeline: { latestSeq: 0, totalEvents: 0, recent: [] },
    trace: { spanCount: 0, linkedArtifacts: [] },
    outboundMessages: { total: 0, queued: 0, accepted: 0, rejected: 0 },
    policy: { policyVersion: '', commitmentEvaluations: [] },
    llm: {
      calls: [],
      totals: { callCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 }
    }
  });

  describe('publishEvent()', () => {
    it('emits to subscribers', () => {
      const received: StreamHubMessage[] = [];
      const sub = service.stream('run-1').subscribe((msg) => received.push(msg));

      const event = makeEvent('run-1');
      service.publishEvent(event);

      expect(received).toHaveLength(1);
      expect(received[0].event).toBe('canonical_event');
      expect(received[0].data).toBe(event);

      sub.unsubscribe();
    });
  });

  describe('publishSnapshot()', () => {
    it('emits to subscribers', () => {
      const received: StreamHubMessage[] = [];
      const sub = service.stream('run-1').subscribe((msg) => received.push(msg));

      const snapshot = makeSnapshot('run-1');
      service.publishSnapshot('run-1', snapshot);

      expect(received).toHaveLength(1);
      expect(received[0].event).toBe('snapshot');
      expect(received[0].data).toBe(snapshot);

      sub.unsubscribe();
    });
  });

  describe('stream()', () => {
    it('creates observable that receives events', () => {
      const received: StreamHubMessage[] = [];
      const sub = service.stream('run-1').subscribe((msg) => received.push(msg));

      service.publishEvent(makeEvent('run-1', 1));
      service.publishEvent(makeEvent('run-1', 2));

      expect(received).toHaveLength(2);
      expect((received[0].data as CanonicalEvent).seq).toBe(1);
      expect((received[1].data as CanonicalEvent).seq).toBe(2);

      sub.unsubscribe();
    });

    it('tracks subscriber count', () => {
      const subs: Subscription[] = [];

      subs.push(service.stream('run-1').subscribe());
      subs.push(service.stream('run-1').subscribe());

      // Access the private subscriberCounts map on the strategy for testing
      const counts = (strategy as any).subscriberCounts as Map<string, number>;
      expect(counts.get('run-1')).toBe(2);

      subs[0].unsubscribe();
      expect(counts.get('run-1')).toBe(1);

      subs[1].unsubscribe();
      expect(counts.get('run-1')).toBe(0);
    });
  });

  describe('complete()', () => {
    it('ends the stream for a runId', () => {
      let completed = false;
      const sub = service.stream('run-1').subscribe({
        complete: () => {
          completed = true;
        }
      });

      service.complete('run-1');
      expect(completed).toBe(true);

      sub.unsubscribe();
    });

    it('removes the subject and subscriber count after completion', () => {
      const sub = service.stream('run-1').subscribe();
      service.complete('run-1');

      const subjects = (strategy as any).subjects as Map<string, unknown>;
      const counts = (strategy as any).subscriberCounts as Map<string, number>;
      expect(subjects.has('run-1')).toBe(false);
      expect(counts.has('run-1')).toBe(false);

      sub.unsubscribe();
    });

    it('clears any pending cleanup timer', () => {
      const sub = service.stream('run-1').subscribe();
      sub.unsubscribe();

      // A cleanup timer should now be scheduled
      const timers = (strategy as any).cleanupTimers as Map<string, ReturnType<typeof setTimeout>>;
      expect(timers.has('run-1')).toBe(true);

      // complete() should clear it
      service.complete('run-1');
      expect(timers.has('run-1')).toBe(false);
    });
  });

  describe('cleanup timer', () => {
    it('fires after all subscribers unsubscribe', () => {
      const sub = service.stream('run-1').subscribe();
      // Publish something to ensure the subject exists
      service.publishEvent(makeEvent('run-1'));

      sub.unsubscribe();

      // The subject should still exist before the timer fires
      const subjects = (strategy as any).subjects as Map<string, unknown>;
      expect(subjects.has('run-1')).toBe(true);

      // Advance time by 60 seconds (the cleanup delay)
      jest.advanceTimersByTime(60_000);

      // Now the subject should be cleaned up
      expect(subjects.has('run-1')).toBe(false);
    });

    it('is cancelled if a new subscriber arrives before it fires', () => {
      const sub1 = service.stream('run-1').subscribe();
      service.publishEvent(makeEvent('run-1'));

      sub1.unsubscribe();

      // Advance partway (not enough for cleanup)
      jest.advanceTimersByTime(30_000);

      // A new subscriber arrives
      const sub2 = service.stream('run-1').subscribe();

      // The cleanup timer should have been cancelled
      const timers = (strategy as any).cleanupTimers as Map<string, ReturnType<typeof setTimeout>>;
      expect(timers.has('run-1')).toBe(false);

      // Advance past the original cleanup time
      jest.advanceTimersByTime(60_000);

      // Subject should still exist because we have an active subscriber
      const subjects = (strategy as any).subjects as Map<string, unknown>;
      expect(subjects.has('run-1')).toBe(true);

      sub2.unsubscribe();
    });
  });

  describe('multiple runs are isolated', () => {
    it('events for one run do not leak to another', () => {
      const received1: StreamHubMessage[] = [];
      const received2: StreamHubMessage[] = [];

      const sub1 = service.stream('run-1').subscribe((msg) => received1.push(msg));
      const sub2 = service.stream('run-2').subscribe((msg) => received2.push(msg));

      service.publishEvent(makeEvent('run-1', 1));
      service.publishEvent(makeEvent('run-2', 2));

      expect(received1).toHaveLength(1);
      expect((received1[0].data as CanonicalEvent).runId).toBe('run-1');

      expect(received2).toHaveLength(1);
      expect((received2[0].data as CanonicalEvent).runId).toBe('run-2');

      sub1.unsubscribe();
      sub2.unsubscribe();
    });

    it('completing one run does not affect another', () => {
      let completed1 = false;
      let completed2 = false;

      const sub1 = service.stream('run-1').subscribe({
        complete: () => {
          completed1 = true;
        }
      });
      const sub2 = service.stream('run-2').subscribe({
        complete: () => {
          completed2 = true;
        }
      });

      service.complete('run-1');

      expect(completed1).toBe(true);
      expect(completed2).toBe(false);

      // run-2 should still receive events
      const received: StreamHubMessage[] = [];
      const sub3 = service.stream('run-2').subscribe((msg) => received.push(msg));
      service.publishEvent(makeEvent('run-2', 3));
      expect(received).toHaveLength(1);

      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
    });
  });

  describe('onModuleDestroy()', () => {
    it('cleans everything up', () => {
      const completions: string[] = [];

      const sub1 = service.stream('run-1').subscribe({
        complete: () => completions.push('run-1')
      });
      const sub2 = service.stream('run-2').subscribe({
        complete: () => completions.push('run-2')
      });

      // Create a cleanup timer by unsubscribing from a stream
      const sub3 = service.stream('run-3').subscribe({
        complete: () => completions.push('run-3')
      });
      sub3.unsubscribe();

      service.onModuleDestroy();

      // All subjects should be completed
      expect(completions).toContain('run-1');
      expect(completions).toContain('run-2');

      // All internal maps should be cleared
      const subjects = (strategy as any).subjects as Map<string, unknown>;
      const counts = (strategy as any).subscriberCounts as Map<string, number>;
      const timers = (strategy as any).cleanupTimers as Map<string, ReturnType<typeof setTimeout>>;

      expect(subjects.size).toBe(0);
      expect(counts.size).toBe(0);
      expect(timers.size).toBe(0);

      sub1.unsubscribe();
      sub2.unsubscribe();
    });
  });
});
