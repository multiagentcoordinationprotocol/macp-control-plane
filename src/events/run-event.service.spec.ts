import { Logger } from '@nestjs/common';
import { RunEventService } from './run-event.service';
import { DatabaseService } from '../db/database.service';
import { RunRepository } from '../storage/run.repository';
import { EventRepository } from '../storage/event.repository';
import { ProjectionService } from '../projection/projection.service';
import { MetricsService } from '../metrics/metrics.service';
import { StreamHubService } from './stream-hub.service';
import { CanonicalEvent, RunStateProjection } from '../contracts/control-plane';
import { RawRuntimeEvent } from '../contracts/runtime';

describe('RunEventService', () => {
  let service: RunEventService;
  let database: jest.Mocked<DatabaseService>;
  let runRepository: jest.Mocked<RunRepository>;
  let eventRepository: jest.Mocked<EventRepository>;
  let projectionService: jest.Mocked<ProjectionService>;
  let metricsService: jest.Mocked<MetricsService>;
  let streamHub: jest.Mocked<StreamHubService>;
  let postCommitSideEffectFailuresTotal: { inc: jest.Mock };
  let errorSpy: jest.SpyInstance;
  let mockTx: Record<string, unknown>;
  // Shared lifecycle log used to prove commit-before-side-effects ordering.
  // The transaction mock only pushes 'tx:committed' after its callback resolves
  // (and 'tx:rolled-back' if it throws), while the repository/metrics/streamHub
  // mocks push their own markers — so tests can assert the *actual* relative
  // order of commit vs. metrics vs. publish, not just call counts.
  let callOrder: string[];

  const fakeProjection: RunStateProjection = {
    run: { runId: 'run-1', status: 'running' },
    participants: [],
    graph: { nodes: [], edges: [] },
    decision: {},
    signals: { signals: [] },
    progress: { entries: [] },
    timeline: { latestSeq: 1, totalEvents: 1, recent: [] },
    trace: { spanCount: 0, linkedArtifacts: [] },
    outboundMessages: { total: 0, queued: 0, accepted: 0, rejected: 0 },
    policy: { policyVersion: '', commitmentEvaluations: [] },
    llm: {
      calls: [],
      totals: { callCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 }
    }
  };

  beforeEach(() => {
    mockTx = {};
    callOrder = [];
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    database = {
      db: {
        // Models real commit/rollback semantics well enough to prove ordering:
        // the marker only lands once the callback has actually settled, and
        // rollback is distinguished from commit so a mutation that moves
        // post-commit work back inside the callback is observable.
        transaction: jest.fn(async (cb: (tx: any) => Promise<any>) => {
          try {
            const result = await cb(mockTx);
            callOrder.push('tx:committed');
            return result;
          } catch (err) {
            callOrder.push('tx:rolled-back');
            throw err;
          }
        })
      }
    } as unknown as jest.Mocked<DatabaseService>;

    runRepository = {
      allocateSequence: jest.fn().mockResolvedValue(1)
    } as unknown as jest.Mocked<RunRepository>;

    eventRepository = {
      appendRaw: jest.fn(async () => {
        callOrder.push('repo:appendRaw');
      }),
      appendCanonical: jest.fn(async () => {
        callOrder.push('repo:appendCanonical');
      })
    } as unknown as jest.Mocked<EventRepository>;

    projectionService = {
      applyAndPersist: jest.fn(async () => {
        callOrder.push('projection:applyAndPersist');
        return fakeProjection;
      })
    } as unknown as jest.Mocked<ProjectionService>;

    metricsService = {
      recordEvents: jest.fn(async () => {
        callOrder.push('metrics:recordEvents');
        return {};
      })
    } as unknown as jest.Mocked<MetricsService>;

    streamHub = {
      publishEvent: jest.fn(() => {
        callOrder.push('publish:event');
      }),
      publishSnapshot: jest.fn(() => {
        callOrder.push('publish:snapshot');
      })
    } as unknown as jest.Mocked<StreamHubService>;

    postCommitSideEffectFailuresTotal = { inc: jest.fn() };

    service = new RunEventService(
      database,
      runRepository,
      eventRepository,
      projectionService,
      metricsService,
      streamHub,
      {
        withRunSpan: jest.fn(<T>(_runId: string, _name: string, _attrs: unknown, fn: () => Promise<T>) => fn()),
        withSpan: jest.fn(<T>(_name: string, _attrs: unknown, fn: () => Promise<T>) => fn()),
        addRunSpanEvent: jest.fn(),
        getRunTraceContext: jest.fn().mockReturnValue(undefined)
      } as any,
      { postCommitSideEffectFailuresTotal } as any
    );
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('emitControlPlaneEvents', () => {
    it('should return an empty array when given an empty partialEvents array', async () => {
      const result = await service.emitControlPlaneEvents('run-1', []);

      expect(result).toEqual([]);
      expect(database.db.transaction).not.toHaveBeenCalled();
      expect(projectionService.applyAndPersist).not.toHaveBeenCalled();
      expect(streamHub.publishEvent).not.toHaveBeenCalled();
    });

    it('should allocate sequences and persist canonical events', async () => {
      runRepository.allocateSequence.mockResolvedValue(10);

      const partialEvents = [
        {
          ts: '2026-01-01T00:00:00.000Z',
          type: 'run.created' as const,
          source: { kind: 'macp-control-plane' as const, name: 'run-manager' },
          subject: { kind: 'run' as const, id: 'run-1' },
          data: { status: 'queued' }
        },
        {
          ts: '2026-01-01T00:00:01.000Z',
          type: 'run.started' as const,
          source: { kind: 'macp-control-plane' as const, name: 'run-manager' },
          subject: { kind: 'run' as const, id: 'run-1' },
          data: { status: 'starting' }
        }
      ];

      const result = await service.emitControlPlaneEvents('run-1', partialEvents);

      // Should have called transaction
      expect(database.db.transaction).toHaveBeenCalledTimes(1);

      // Should have allocated sequence for 2 events
      expect(runRepository.allocateSequence).toHaveBeenCalledWith('run-1', 2);

      // Should have appended canonical events with tx
      expect(eventRepository.appendCanonical).toHaveBeenCalledTimes(1);
      const appendedEvents = eventRepository.appendCanonical.mock.calls[0][0] as CanonicalEvent[];
      expect(appendedEvents).toHaveLength(2);
      expect(appendedEvents[0].seq).toBe(10);
      expect(appendedEvents[1].seq).toBe(11);
      expect(appendedEvents[0].runId).toBe('run-1');
      expect(appendedEvents[0].id).toBeDefined();

      // Transaction should pass the tx object
      expect(eventRepository.appendCanonical.mock.calls[0][1]).toBe(mockTx);

      // Result should match what was persisted
      expect(result).toHaveLength(2);
      expect(result[0].seq).toBe(10);
      expect(result[1].seq).toBe(11);
    });

    it('should publish events and snapshot after persisting', async () => {
      runRepository.allocateSequence.mockResolvedValue(1);

      const partialEvents = [
        {
          ts: '2026-01-01T00:00:00.000Z',
          type: 'session.stream.opened' as const,
          source: { kind: 'macp-control-plane' as const, name: 'stream-consumer' },
          subject: { kind: 'session' as const, id: 'session-1' },
          data: { status: 'reconnecting', detail: 'stream retry' }
        }
      ];

      const result = await service.emitControlPlaneEvents('run-1', partialEvents);

      // Projection should be applied
      expect(projectionService.applyAndPersist).toHaveBeenCalledWith('run-1', expect.any(Array), mockTx);

      // Metrics should be recorded
      expect(metricsService.recordEvents).toHaveBeenCalledWith('run-1', result);

      // Each event should be published
      expect(streamHub.publishEvent).toHaveBeenCalledTimes(1);
      expect(streamHub.publishEvent).toHaveBeenCalledWith(result[0]);

      // Snapshot should be published
      expect(streamHub.publishSnapshot).toHaveBeenCalledWith('run-1', fakeProjection);
    });

    it('should use a transaction wrapping allocateSequence and appendCanonical', async () => {
      runRepository.allocateSequence.mockResolvedValue(1);

      const partialEvents = [
        {
          ts: '2026-01-01T00:00:00.000Z',
          type: 'run.created' as const,
          source: { kind: 'macp-control-plane' as const, name: 'run-manager' },
          subject: { kind: 'run' as const, id: 'run-1' },
          data: { status: 'queued' }
        }
      ];

      await service.emitControlPlaneEvents('run-1', partialEvents);

      expect(database.db.transaction).toHaveBeenCalledTimes(1);
      // The transaction callback should have called both allocateSequence and appendCanonical
      expect(runRepository.allocateSequence).toHaveBeenCalled();
      expect(eventRepository.appendCanonical).toHaveBeenCalled();
    });
  });

  describe('persistRawAndCanonical', () => {
    const rawEvent: RawRuntimeEvent = {
      kind: 'stream-envelope',
      receivedAt: '2026-01-01T00:00:00.000Z'
    };

    const canonicalEvents: CanonicalEvent[] = [
      {
        id: 'evt-1',
        runId: 'run-1',
        seq: 0,
        ts: '2026-01-01T00:00:00.000Z',
        type: 'message.received',
        source: { kind: 'runtime', name: 'rust-runtime' },
        data: { messageType: 'Signal' }
      },
      {
        id: 'evt-2',
        runId: 'run-1',
        seq: 0,
        ts: '2026-01-01T00:00:01.000Z',
        type: 'signal.emitted',
        source: { kind: 'runtime', name: 'rust-runtime' },
        data: { messageType: 'Signal' }
      }
    ];

    it('should persist both raw and canonical events with correct sequences', async () => {
      runRepository.allocateSequence.mockResolvedValue(5);

      const result = await service.persistRawAndCanonical('run-1', rawEvent, canonicalEvents);

      // Should allocate total = 1 (raw) + 2 (canonical) = 3
      expect(runRepository.allocateSequence).toHaveBeenCalledWith('run-1', 3);

      // Should append raw with startSeq
      expect(eventRepository.appendRaw).toHaveBeenCalledWith('run-1', 5, rawEvent, mockTx);

      // Should append canonical events with seq starting at startSeq + 1
      expect(eventRepository.appendCanonical).toHaveBeenCalledTimes(1);
      const appendedCanonical = eventRepository.appendCanonical.mock.calls[0][0] as CanonicalEvent[];
      expect(appendedCanonical).toHaveLength(2);
      expect(appendedCanonical[0].seq).toBe(6); // startSeq(5) + 0 + 1
      expect(appendedCanonical[1].seq).toBe(7); // startSeq(5) + 1 + 1

      // Result should be the normalized events
      expect(result).toHaveLength(2);
      expect(result[0].seq).toBe(6);
      expect(result[1].seq).toBe(7);
    });

    it('should publish events and snapshot after persisting', async () => {
      runRepository.allocateSequence.mockResolvedValue(1);

      const result = await service.persistRawAndCanonical('run-1', rawEvent, canonicalEvents);

      // Projection should be applied
      expect(projectionService.applyAndPersist).toHaveBeenCalledWith('run-1', expect.any(Array), mockTx);

      // Metrics should be recorded
      expect(metricsService.recordEvents).toHaveBeenCalledWith('run-1', result);

      // Each canonical event should be published
      expect(streamHub.publishEvent).toHaveBeenCalledTimes(2);
      expect(streamHub.publishEvent).toHaveBeenCalledWith(result[0]);
      expect(streamHub.publishEvent).toHaveBeenCalledWith(result[1]);

      // Snapshot should be published
      expect(streamHub.publishSnapshot).toHaveBeenCalledWith('run-1', fakeProjection);
    });

    it('should use a transaction wrapping allocateSequence, appendRaw, and appendCanonical', async () => {
      runRepository.allocateSequence.mockResolvedValue(1);

      await service.persistRawAndCanonical('run-1', rawEvent, canonicalEvents);

      expect(database.db.transaction).toHaveBeenCalledTimes(1);
      expect(runRepository.allocateSequence).toHaveBeenCalled();
      expect(eventRepository.appendRaw).toHaveBeenCalled();
      expect(eventRepository.appendCanonical).toHaveBeenCalled();
    });

    it('should preserve existing event ids or assign new ones', async () => {
      runRepository.allocateSequence.mockResolvedValue(1);

      const eventsWithMixedIds: CanonicalEvent[] = [
        {
          id: 'existing-id',
          runId: 'run-1',
          seq: 0,
          ts: '2026-01-01T00:00:00.000Z',
          type: 'message.received',
          source: { kind: 'runtime', name: 'rust-runtime' },
          data: {}
        },
        {
          id: '',
          runId: 'run-1',
          seq: 0,
          ts: '2026-01-01T00:00:00.000Z',
          type: 'signal.emitted',
          source: { kind: 'runtime', name: 'rust-runtime' },
          data: {}
        }
      ];

      const result = await service.persistRawAndCanonical('run-1', rawEvent, eventsWithMixedIds);

      // First event should keep its existing id
      expect(result[0].id).toBe('existing-id');
      // Second event with empty string id should get a new UUID assigned
      expect(result[1].id).toBeDefined();
      expect(result[1].id).not.toBe('');
    });

    it('resolves on a post-commit metrics failure even though the transaction already committed (Phase 5, runtime 0.8.0 absorption)', async () => {
      // The DB transaction (allocateSequence/appendRaw/appendCanonical/applyAndPersist)
      // commits before metricsService.recordEvents and streamHub.publish* run. Since
      // the events are already durable by that point, a post-commit metrics failure
      // must not propagate: the caller (StreamConsumerService.handleRawEventInner)
      // would otherwise see a rejected promise, never bump its envelope ordinal, and
      // have the runtime redeliver this envelope on reconnect — appending duplicate
      // rows, since the redelivered event gets a fresh id/seq and onConflictDoNothing
      // cannot dedup it. Instead, RunEventService now catches and logs this failure
      // and the call resolves normally.
      //
      // This also asserts the actual commit-before-side-effects ordering via the
      // shared `callOrder` log: the transaction mock only records 'tx:committed'
      // after its callback resolves (and 'tx:rolled-back' if the callback throws —
      // see beforeEach). If metrics/publish were moved inside the transaction
      // callback, the callback would throw, the mock would record 'tx:rolled-back'
      // instead of 'tx:committed', and the ordering assertions below would fail.
      runRepository.allocateSequence.mockResolvedValue(1);
      metricsService.recordEvents.mockImplementationOnce(async () => {
        callOrder.push('metrics:recordEvents');
        throw new Error('metrics backend unavailable');
      });

      const result = await service.persistRawAndCanonical('run-1', rawEvent, canonicalEvents);
      expect(result).toHaveLength(2);

      // The transaction (and everything inside it) already ran and resolved —
      // the events are durably persisted regardless of the metrics outcome.
      expect(eventRepository.appendRaw).toHaveBeenCalled();
      expect(eventRepository.appendCanonical).toHaveBeenCalled();
      expect(projectionService.applyAndPersist).toHaveBeenCalled();

      // Commit happened, rollback did not — and metrics ran strictly after commit.
      expect(callOrder).toContain('tx:committed');
      expect(callOrder).not.toContain('tx:rolled-back');
      const commitIndex = callOrder.indexOf('tx:committed');
      const metricsIndex = callOrder.indexOf('metrics:recordEvents');
      expect(commitIndex).toBeGreaterThanOrEqual(0);
      expect(metricsIndex).toBeGreaterThan(commitIndex);

      // The metrics failure must not suppress the sibling post-commit steps.
      expect(streamHub.publishEvent).toHaveBeenCalledTimes(2);
      expect(streamHub.publishSnapshot).toHaveBeenCalledWith('run-1', fakeProjection);

      // The failure was logged, not swallowed silently.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('metrics backend unavailable'));
      expect(postCommitSideEffectFailuresTotal.inc).toHaveBeenCalledWith({ step: 'metrics' });
    });

    it('resolves on a post-commit SSE publish failure, with metrics and snapshot still recorded (twin of the metrics-failure case)', async () => {
      runRepository.allocateSequence.mockResolvedValue(1);
      streamHub.publishEvent.mockImplementationOnce(() => {
        callOrder.push('publish:event');
        throw new Error('stream hub unavailable');
      });

      const result = await service.persistRawAndCanonical('run-1', rawEvent, canonicalEvents);
      expect(result).toHaveLength(2);

      // Metrics still recorded despite the first publishEvent throwing.
      expect(metricsService.recordEvents).toHaveBeenCalledWith('run-1', result);
      // The second event's publish still fires — one bad event doesn't block its siblings.
      expect(streamHub.publishEvent).toHaveBeenCalledTimes(2);
      expect(streamHub.publishEvent).toHaveBeenCalledWith(result[1]);
      // Snapshot publish still fires after a publishEvent failure.
      expect(streamHub.publishSnapshot).toHaveBeenCalledWith('run-1', fakeProjection);

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stream hub unavailable'));
      expect(postCommitSideEffectFailuresTotal.inc).toHaveBeenCalledWith({ step: 'publish_event' });
    });
  });

  describe('post-commit failure isolation on emitControlPlaneEvents (Phase 5, runtime 0.8.0 absorption)', () => {
    // emitControlPlaneEvents shares the identical post-commit tail with
    // persistRawAndCanonical (see runPostCommitSideEffects) — this is its own
    // post-commit path, exercised because it's what emitStreamGap /
    // stream-consumer.service.ts's poll-fallback reconnect event call into, and
    // AC2 explicitly requires this path (not just persistRawAndCanonical's) to
    // resolve rather than throw on a post-commit failure.
    it('resolves on a post-commit metrics failure instead of throwing out to emitStreamGap/consumeLoop', async () => {
      runRepository.allocateSequence.mockResolvedValue(1);
      metricsService.recordEvents.mockImplementationOnce(async () => {
        throw new Error('metrics backend unavailable');
      });

      const partialEvents = [
        {
          ts: '2026-01-01T00:00:00.000Z',
          type: 'session.stream.gap' as const,
          source: { kind: 'macp-control-plane' as const, name: 'stream-consumer' },
          subject: { kind: 'session' as const, id: 'session-1' },
          data: { requestedAfter: 5, detail: 'compacted' }
        }
      ];

      const result = await service.emitControlPlaneEvents('run-1', partialEvents);

      expect(result).toHaveLength(1);
      expect(streamHub.publishEvent).toHaveBeenCalledTimes(1);
      expect(streamHub.publishSnapshot).toHaveBeenCalledWith('run-1', fakeProjection);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('metrics backend unavailable'));
      expect(postCommitSideEffectFailuresTotal.inc).toHaveBeenCalledWith({ step: 'metrics' });
    });
  });
});
