import { NotFoundException } from '@nestjs/common';
import { RunInsightsService } from './run-insights.service';
import { ProjectionService } from '../projection/projection.service';
import { ArtifactRepository } from '../storage/artifact.repository';
import { EventRepository } from '../storage/event.repository';
import { MetricsRepository } from '../storage/metrics.repository';
import { RunRepository } from '../storage/run.repository';
import { RuntimeSessionRepository } from '../storage/runtime-session.repository';

describe('RunInsightsService', () => {
  let service: RunInsightsService;
  let mockRunRepo: { findById: jest.Mock };
  let mockSessionRepo: { findByRunId: jest.Mock };
  let mockProjectionService: { get: jest.Mock };
  let mockEventRepo: { listCanonicalByRun: jest.Mock; listRawByRun: jest.Mock };
  let mockMetricsRepo: { get: jest.Mock };
  let mockArtifactRepo: { listByRunId: jest.Mock };

  const fakeRun = {
    id: 'run-1',
    status: 'completed',
    runtimeKind: 'rust',
    runtimeVersion: '1.0',
    runtimeSessionId: 'sess-1',
    traceId: 'trace-1',
    createdAt: '2026-01-01T00:00:00Z',
    startedAt: '2026-01-01T00:00:01Z',
    endedAt: '2026-01-01T00:01:00Z',
    mode: 'live',
    tags: ['demo'],
    sourceKind: null,
    sourceRef: null,
    metadata: {},
    idempotencyKey: null,
    lastEventSeq: 10,
    errorCode: null,
    errorMessage: null,
    updatedAt: '2026-01-01T00:01:00Z'
  };

  beforeEach(() => {
    mockRunRepo = { findById: jest.fn() };
    mockSessionRepo = { findByRunId: jest.fn().mockResolvedValue(null) };
    mockProjectionService = { get: jest.fn().mockResolvedValue(null) };
    mockEventRepo = {
      listCanonicalByRun: jest.fn().mockResolvedValue([]),
      listRawByRun: jest.fn().mockResolvedValue([])
    };
    mockMetricsRepo = { get: jest.fn().mockResolvedValue(null) };
    mockArtifactRepo = { listByRunId: jest.fn().mockResolvedValue([]) };

    service = new RunInsightsService(
      mockRunRepo as unknown as RunRepository,
      mockSessionRepo as unknown as RuntimeSessionRepository,
      mockProjectionService as unknown as ProjectionService,
      mockEventRepo as unknown as EventRepository,
      mockMetricsRepo as unknown as MetricsRepository,
      mockArtifactRepo as unknown as ArtifactRepository
    );
  });

  // =========================================================================
  // exportRun
  // =========================================================================
  describe('exportRun', () => {
    it('throws NotFoundException for missing run', async () => {
      mockRunRepo.findById.mockResolvedValue(null);
      await expect(service.exportRun('run-missing', {})).rejects.toThrow(NotFoundException);
    });

    it('returns a full export bundle with canonical events by default', async () => {
      mockRunRepo.findById.mockResolvedValue(fakeRun);

      const bundle = await service.exportRun('run-1', {});

      expect(bundle.run.id).toBe('run-1');
      expect(bundle.exportedAt).toBeDefined();
      expect(mockEventRepo.listCanonicalByRun).toHaveBeenCalledWith('run-1', 0, 10000);
      expect(mockEventRepo.listRawByRun).not.toHaveBeenCalled();
    });

    it('includes raw events when requested', async () => {
      mockRunRepo.findById.mockResolvedValue(fakeRun);

      await service.exportRun('run-1', { includeRaw: true });

      expect(mockEventRepo.listRawByRun).toHaveBeenCalledWith('run-1', 0, 10000);
    });

    it('skips canonical events when includeCanonical is false', async () => {
      mockRunRepo.findById.mockResolvedValue(fakeRun);

      await service.exportRun('run-1', { includeCanonical: false });

      expect(mockEventRepo.listCanonicalByRun).not.toHaveBeenCalled();
    });

    it('respects eventLimit', async () => {
      mockRunRepo.findById.mockResolvedValue(fakeRun);

      await service.exportRun('run-1', { eventLimit: 50 });

      expect(mockEventRepo.listCanonicalByRun).toHaveBeenCalledWith('run-1', 0, 50);
    });
  });

  // =========================================================================
  // compareRuns
  // =========================================================================
  describe('compareRuns', () => {
    it('throws NotFoundException when left run is missing', async () => {
      mockRunRepo.findById.mockResolvedValueOnce(null);
      await expect(service.compareRuns('missing', 'run-2')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when right run is missing', async () => {
      mockRunRepo.findById.mockResolvedValueOnce(fakeRun).mockResolvedValueOnce(null);
      await expect(service.compareRuns('run-1', 'missing')).rejects.toThrow(NotFoundException);
    });

    it('returns comparison result with matching statuses', async () => {
      mockRunRepo.findById.mockResolvedValue(fakeRun);

      const leftProjection = {
        run: { runId: 'run-1', status: 'completed', modeName: 'decision' },
        participants: [{ participantId: 'agent-1' }, { participantId: 'agent-2' }],
        signals: { signals: [{ name: 'alert' }] },
        decision: { current: { confidence: 0.9 } }
      };
      const rightProjection = {
        run: { runId: 'run-2', status: 'completed', modeName: 'decision' },
        participants: [{ participantId: 'agent-1' }, { participantId: 'agent-3' }],
        signals: { signals: [{ name: 'alert' }, { name: 'warning' }] },
        decision: { current: { confidence: 0.8 } }
      };

      mockProjectionService.get.mockResolvedValueOnce(leftProjection).mockResolvedValueOnce(rightProjection);

      mockMetricsRepo.get.mockResolvedValueOnce({ durationMs: 1000 }).mockResolvedValueOnce({ durationMs: 1500 });

      const result = await service.compareRuns('run-1', 'run-2');

      expect(result.statusMatch).toBe(true);
      expect(result.durationDeltaMs).toBe(500);
      expect(result.confidenceDelta).toBeCloseTo(-0.1);
      expect(result.participantsDiff.added).toEqual(['agent-3']);
      expect(result.participantsDiff.removed).toEqual(['agent-2']);
      expect(result.participantsDiff.common).toEqual(['agent-1']);
      expect(result.signalsDiff.added).toEqual(['warning']);
      expect(result.signalsDiff.removed).toEqual([]);
    });

    it('returns undefined deltas when metrics/projections are null', async () => {
      mockRunRepo.findById.mockResolvedValue(fakeRun);
      mockProjectionService.get.mockResolvedValue(null);
      mockMetricsRepo.get.mockResolvedValue(null);

      const result = await service.compareRuns('run-1', 'run-2');

      expect(result.durationDeltaMs).toBeUndefined();
      expect(result.confidenceDelta).toBeUndefined();
      expect(result.participantsDiff.common).toEqual([]);
    });
  });
});
