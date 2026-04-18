import { ReplayService } from './replay.service';
import { EventRepository } from '../storage/event.repository';
import { ProjectionService } from '../projection/projection.service';
import { AppConfigService } from '../config/app-config.service';
import { firstValueFrom, toArray } from 'rxjs';

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

/** Shape returned by EventRepository query methods (DB row). */
interface CanonicalRow {
  id: string;
  runId: string;
  seq: number;
  ts: string;
  type: string;
  subjectKind: string | null;
  subjectId: string | null;
  sourceKind: string;
  sourceName: string;
  rawType: string | null;
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  data: Record<string, unknown>;
}

function makeRow(overrides: Partial<CanonicalRow> & { seq: number }): CanonicalRow {
  return {
    id: overrides.id ?? `evt-${overrides.seq}`,
    runId: overrides.runId ?? 'run-1',
    seq: overrides.seq,
    ts: overrides.ts ?? `2026-01-01T00:00:0${overrides.seq}Z`,
    type: overrides.type ?? 'message.sent',
    subjectKind: overrides.subjectKind ?? null,
    subjectId: overrides.subjectId ?? null,
    sourceKind: overrides.sourceKind ?? 'runtime',
    sourceName: overrides.sourceName ?? 'rust-runtime',
    rawType: overrides.rawType ?? null,
    traceId: overrides.traceId ?? null,
    spanId: overrides.spanId ?? null,
    parentSpanId: overrides.parentSpanId ?? null,
    data: overrides.data ?? { sender: 'a', to: ['b'] }
  };
}

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

const mockEventRepository: jest.Mocked<Pick<EventRepository, 'listCanonicalByRun' | 'listCanonicalUpTo'>> = {
  listCanonicalByRun: jest.fn(),
  listCanonicalUpTo: jest.fn()
};

const mockProjectionService: jest.Mocked<Pick<ProjectionService, 'replayStateAt'>> = {
  replayStateAt: jest.fn()
};

const mockConfig: Pick<AppConfigService, 'replayBatchSize' | 'replayMaxDelayMs'> = {
  replayBatchSize: 500,
  replayMaxDelayMs: 2000
};

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

describe('ReplayService', () => {
  let service: ReplayService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ReplayService(
      mockEventRepository as unknown as EventRepository,
      mockProjectionService as unknown as ProjectionService,
      mockConfig as AppConfigService
    );
  });

  // -----------------------------------------------------------------------
  // describe()
  // -----------------------------------------------------------------------

  describe('describe()', () => {
    it('returns correct URLs and mode', async () => {
      const descriptor = await service.describe('run-1', {
        mode: 'timed',
        speed: 2,
        fromSeq: 5,
        toSeq: 100
      });

      expect(descriptor).toEqual({
        runId: 'run-1',
        mode: 'timed',
        speed: 2,
        fromSeq: 5,
        toSeq: 100,
        streamUrl: '/runs/run-1/replay/stream?mode=timed&speed=2',
        stateUrl: '/runs/run-1/replay/state'
      });
    });

    it('defaults speed to 1 when not provided', async () => {
      const descriptor = await service.describe('run-1', { mode: 'instant' });

      expect(descriptor.speed).toBe(1);
      expect(descriptor.streamUrl).toContain('speed=1');
    });
  });

  // -----------------------------------------------------------------------
  // stream() — step mode
  // -----------------------------------------------------------------------

  describe('stream() — step mode', () => {
    it('emits all events immediately', async () => {
      const rows = [makeRow({ seq: 1 }), makeRow({ seq: 2 }), makeRow({ seq: 3 })];
      mockEventRepository.listCanonicalByRun.mockResolvedValue(rows as any);

      const observable = service.stream('run-1', { mode: 'step' });
      const emissions = await firstValueFrom(observable.pipe(toArray()));

      expect(emissions).toHaveLength(3);
      expect(emissions[0].type).toBe('canonical_event');
      expect(emissions[0].data.seq).toBe(1);
      expect(emissions[1].data.seq).toBe(2);
      expect(emissions[2].data.seq).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // stream() — instant mode
  // -----------------------------------------------------------------------

  describe('stream() — instant mode', () => {
    it('emits all events without delay', async () => {
      const rows = [makeRow({ seq: 1 }), makeRow({ seq: 2 })];
      mockEventRepository.listCanonicalByRun.mockResolvedValue(rows as any);

      const start = Date.now();
      const observable = service.stream('run-1', { mode: 'instant' });
      const emissions = await firstValueFrom(observable.pipe(toArray()));
      const elapsed = Date.now() - start;

      expect(emissions).toHaveLength(2);
      // Should complete nearly instantly (well under 500ms)
      expect(elapsed).toBeLessThan(500);
    });
  });

  // -----------------------------------------------------------------------
  // stream() — timed mode
  // -----------------------------------------------------------------------

  describe('stream() — timed mode', () => {
    it('emits with delays between events', async () => {
      const rows = [
        makeRow({ seq: 1, ts: '2026-01-01T00:00:00.000Z' }),
        makeRow({ seq: 2, ts: '2026-01-01T00:00:00.100Z' }) // 100ms later
      ];
      mockEventRepository.listCanonicalByRun.mockResolvedValue(rows as any);

      const start = Date.now();
      const observable = service.stream('run-1', { mode: 'timed', speed: 1 });
      const emissions = await firstValueFrom(observable.pipe(toArray()));
      const elapsed = Date.now() - start;

      expect(emissions).toHaveLength(2);
      // With speed=1 and 100ms gap, there should be ~100ms delay
      expect(elapsed).toBeGreaterThanOrEqual(80);
    });
  });

  // -----------------------------------------------------------------------
  // stream() — fromSeq / toSeq
  // -----------------------------------------------------------------------

  describe('stream() — fromSeq / toSeq', () => {
    it('respects fromSeq and toSeq', async () => {
      const rows = [makeRow({ seq: 5 }), makeRow({ seq: 6 }), makeRow({ seq: 7 })];
      mockEventRepository.listCanonicalByRun.mockResolvedValue(rows as any);

      const observable = service.stream('run-1', {
        mode: 'instant',
        fromSeq: 5,
        toSeq: 6
      });
      const emissions = await firstValueFrom(observable.pipe(toArray()));

      // Should emit seq 5 and 6 only; seq 7 exceeds toSeq
      expect(emissions).toHaveLength(2);
      expect(emissions[0].data.seq).toBe(5);
      expect(emissions[1].data.seq).toBe(6);

      // The repository should have been called with afterSeq = fromSeq - 1 = 4
      expect(mockEventRepository.listCanonicalByRun).toHaveBeenCalledWith('run-1', 4, 500);
    });
  });

  // -----------------------------------------------------------------------
  // stream() — empty event list
  // -----------------------------------------------------------------------

  describe('stream() — empty', () => {
    it('completes immediately with no emissions', async () => {
      mockEventRepository.listCanonicalByRun.mockResolvedValue([] as any);

      const observable = service.stream('run-1', { mode: 'instant' });
      const emissions = await firstValueFrom(observable.pipe(toArray()));

      expect(emissions).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // stateAt()
  // -----------------------------------------------------------------------

  describe('stateAt()', () => {
    it('delegates to projectionService.replayStateAt with mapped events', async () => {
      const rows = [makeRow({ seq: 1 }), makeRow({ seq: 2 })];
      mockEventRepository.listCanonicalUpTo.mockResolvedValue(rows as any);

      const fakeProjection = {
        run: { runId: 'run-1', status: 'running' as const },
        participants: [],
        graph: { nodes: [], edges: [] },
        decision: {},
        signals: { signals: [] },
        progress: { entries: [] },
        timeline: { latestSeq: 2, totalEvents: 2, recent: [] },
        trace: { spanCount: 0, linkedArtifacts: [] },
        outboundMessages: { total: 0, queued: 0, accepted: 0, rejected: 0 },
        policy: { policyVersion: '', commitmentEvaluations: [] },
        llm: {
          calls: [],
          totals: { callCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 }
        }
      };
      mockProjectionService.replayStateAt.mockResolvedValue(fakeProjection);

      const result = await service.stateAt('run-1', 2);

      expect(mockEventRepository.listCanonicalUpTo).toHaveBeenCalledWith('run-1', 2);
      expect(mockProjectionService.replayStateAt).toHaveBeenCalledWith(
        'run-1',
        expect.arrayContaining([expect.objectContaining({ seq: 1 }), expect.objectContaining({ seq: 2 })])
      );
      expect(result).toEqual(fakeProjection);
    });
  });

  // -----------------------------------------------------------------------
  // stream() — cursor-based pagination
  // -----------------------------------------------------------------------

  describe('stream() — cursor-based pagination', () => {
    it('fetches multiple batches when rows equal batchSize', async () => {
      // Reconfigure with small batch size for testing
      const smallBatchConfig = { replayBatchSize: 2, replayMaxDelayMs: 2000 };
      const paginatedService = new ReplayService(
        mockEventRepository as unknown as EventRepository,
        mockProjectionService as unknown as ProjectionService,
        smallBatchConfig as AppConfigService
      );

      // First call returns full batch (2 rows), second call returns partial (1 row)
      mockEventRepository.listCanonicalByRun
        .mockResolvedValueOnce([makeRow({ seq: 1 }), makeRow({ seq: 2 })] as any)
        .mockResolvedValueOnce([makeRow({ seq: 3 })] as any);

      const observable = paginatedService.stream('run-1', { mode: 'instant' });
      const emissions = await firstValueFrom(observable.pipe(toArray()));

      expect(emissions).toHaveLength(3);
      expect(mockEventRepository.listCanonicalByRun).toHaveBeenCalledTimes(2);
      // First call: afterSeq = 0
      expect(mockEventRepository.listCanonicalByRun).toHaveBeenNthCalledWith(1, 'run-1', 0, 2);
      // Second call: afterSeq = 2 (last seq of first batch)
      expect(mockEventRepository.listCanonicalByRun).toHaveBeenNthCalledWith(2, 'run-1', 2, 2);
    });
  });
});
