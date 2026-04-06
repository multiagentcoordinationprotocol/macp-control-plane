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
  let mockTx: Record<string, unknown>;

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
  };

  beforeEach(() => {
    mockTx = {};

    database = {
      db: {
        transaction: jest.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTx)),
      },
    } as unknown as jest.Mocked<DatabaseService>;

    runRepository = {
      allocateSequence: jest.fn().mockResolvedValue(1),
    } as unknown as jest.Mocked<RunRepository>;

    eventRepository = {
      appendRaw: jest.fn().mockResolvedValue(undefined),
      appendCanonical: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<EventRepository>;

    projectionService = {
      applyAndPersist: jest.fn().mockResolvedValue(fakeProjection),
    } as unknown as jest.Mocked<ProjectionService>;

    metricsService = {
      recordEvents: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<MetricsService>;

    streamHub = {
      publishEvent: jest.fn(),
      publishSnapshot: jest.fn(),
    } as unknown as jest.Mocked<StreamHubService>;

    service = new RunEventService(
      database,
      runRepository,
      eventRepository,
      projectionService,
      metricsService,
      streamHub,
    );
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
          source: { kind: 'control-plane' as const, name: 'run-manager' },
          subject: { kind: 'run' as const, id: 'run-1' },
          data: { status: 'queued' },
        },
        {
          ts: '2026-01-01T00:00:01.000Z',
          type: 'run.started' as const,
          source: { kind: 'control-plane' as const, name: 'run-manager' },
          subject: { kind: 'run' as const, id: 'run-1' },
          data: { status: 'starting' },
        },
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
          source: { kind: 'control-plane' as const, name: 'stream-consumer' },
          subject: { kind: 'session' as const, id: 'session-1' },
          data: { status: 'reconnecting', detail: 'stream retry' },
        },
      ];

      const result = await service.emitControlPlaneEvents('run-1', partialEvents);

      // Projection should be applied
      expect(projectionService.applyAndPersist).toHaveBeenCalledWith('run-1', result);

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
          source: { kind: 'control-plane' as const, name: 'run-manager' },
          subject: { kind: 'run' as const, id: 'run-1' },
          data: { status: 'queued' },
        },
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
      receivedAt: '2026-01-01T00:00:00.000Z',
    };

    const canonicalEvents: CanonicalEvent[] = [
      {
        id: 'evt-1',
        runId: 'run-1',
        seq: 0,
        ts: '2026-01-01T00:00:00.000Z',
        type: 'message.received',
        source: { kind: 'runtime', name: 'rust-runtime' },
        data: { messageType: 'Signal' },
      },
      {
        id: 'evt-2',
        runId: 'run-1',
        seq: 0,
        ts: '2026-01-01T00:00:01.000Z',
        type: 'signal.emitted',
        source: { kind: 'runtime', name: 'rust-runtime' },
        data: { messageType: 'Signal' },
      },
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
      expect(projectionService.applyAndPersist).toHaveBeenCalledWith('run-1', result);

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
          data: {},
        },
        {
          id: '',
          runId: 'run-1',
          seq: 0,
          ts: '2026-01-01T00:00:00.000Z',
          type: 'signal.emitted',
          source: { kind: 'runtime', name: 'rust-runtime' },
          data: {},
        },
      ];

      const result = await service.persistRawAndCanonical('run-1', rawEvent, eventsWithMixedIds);

      // First event should keep its existing id
      expect(result[0].id).toBe('existing-id');
      // Second event with empty string id should get a new UUID assigned
      expect(result[1].id).toBeDefined();
      expect(result[1].id).not.toBe('');
    });
  });
});
