import { ObservabilityController } from './observability.controller';
import { RunManagerService } from '../runs/run-manager.service';
import { ArtifactService } from '../artifacts/artifact.service';
import { MetricsService } from '../metrics/metrics.service';
import { ProjectionService } from '../projection/projection.service';
import { RunEventService } from '../events/run-event.service';
import { EventRepository } from '../storage/event.repository';

describe('ObservabilityController', () => {
  let controller: ObservabilityController;
  let mockRunManager: { getRun: jest.Mock };
  let mockArtifactService: { list: jest.Mock; register: jest.Mock };
  let mockMetricsService: { get: jest.Mock };
  let mockProjectionService: { get: jest.Mock; rebuild: jest.Mock };
  let mockEventService: { emitControlPlaneEvents: jest.Mock };
  let mockEventRepository: { listCanonicalUpTo: jest.Mock };

  const runId = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    mockRunManager = {
      getRun: jest.fn().mockResolvedValue({
        id: runId,
        status: 'completed',
        sourceKind: 'scenario',
        sourceRef: 'fraud-detection@1.2.0'
      }),
    };
    mockArtifactService = {
      list: jest.fn(),
      register: jest.fn(),
    };
    mockMetricsService = {
      get: jest.fn(),
    };
    mockProjectionService = {
      get: jest.fn(),
      rebuild: jest.fn(),
    };
    mockEventService = {
      emitControlPlaneEvents: jest.fn().mockResolvedValue([]),
    };
    mockEventRepository = {
      listCanonicalUpTo: jest.fn(),
    };

    controller = new ObservabilityController(
      mockRunManager as unknown as RunManagerService,
      mockArtifactService as unknown as ArtifactService,
      mockMetricsService as unknown as MetricsService,
      mockProjectionService as unknown as ProjectionService,
      mockEventService as unknown as RunEventService,
      mockEventRepository as unknown as EventRepository,
    );
  });

  // ===========================================================================
  // getTraces
  // ===========================================================================
  describe('getTraces', () => {
    it('returns trace from projection plus runStatus + scenarioRef (§4.4)', async () => {
      const traceSummary = { spanCount: 12, linkedArtifacts: ['art-1'] };
      mockProjectionService.get.mockResolvedValue({ trace: traceSummary });

      const result = await controller.getTraces(runId);

      expect(mockRunManager.getRun).toHaveBeenCalledWith(runId);
      expect(mockProjectionService.get).toHaveBeenCalledWith(runId);
      expect(result).toEqual({
        ...traceSummary,
        runStatus: 'completed',
        scenarioRef: 'fraud-detection@1.2.0',
      });
    });

    it('returns empty default trace when projection has no trace, still includes runStatus (§4.4)', async () => {
      mockProjectionService.get.mockResolvedValue({ trace: undefined });

      const result = await controller.getTraces(runId);

      expect(result).toEqual({
        spanCount: 0,
        linkedArtifacts: [],
        runStatus: 'completed',
        scenarioRef: 'fraud-detection@1.2.0',
      });
    });

    it('returns empty default when projection is null but keeps run metadata (§4.4)', async () => {
      mockProjectionService.get.mockResolvedValue(null);

      const result = await controller.getTraces(runId);

      expect(result).toEqual({
        spanCount: 0,
        linkedArtifacts: [],
        runStatus: 'completed',
        scenarioRef: 'fraud-detection@1.2.0',
      });
    });

    it('scenarioRef is undefined when run has no source.ref (§4.4)', async () => {
      mockRunManager.getRun.mockResolvedValueOnce({ id: runId, status: 'running' });
      mockProjectionService.get.mockResolvedValue({ trace: { spanCount: 3, linkedArtifacts: [] } });

      const result = await controller.getTraces(runId);

      expect(result).toMatchObject({ runStatus: 'running', scenarioRef: undefined });
    });
  });

  // ===========================================================================
  // getArtifacts
  // ===========================================================================
  describe('getArtifacts', () => {
    it('delegates to artifactService.list', async () => {
      const artifacts = [
        { id: 'art-1', runId, kind: 'json', label: 'result' },
      ];
      mockArtifactService.list.mockResolvedValue(artifacts);

      const result = await controller.getArtifacts(runId);

      expect(mockRunManager.getRun).toHaveBeenCalledWith(runId);
      expect(mockArtifactService.list).toHaveBeenCalledWith(runId);
      expect(result).toEqual(artifacts);
    });
  });

  // ===========================================================================
  // createArtifact
  // ===========================================================================
  describe('createArtifact', () => {
    it('persists artifact and emits event', async () => {
      const artifact = {
        id: 'art-new',
        runId,
        kind: 'json',
        label: 'output',
        uri: 'https://example.com/output.json',
        createdAt: '2026-03-19T00:00:00.000Z',
      };
      mockArtifactService.register.mockResolvedValue(artifact);

      const body = {
        kind: 'json' as const,
        label: 'output',
        uri: 'https://example.com/output.json',
      };
      const result = await controller.createArtifact(runId, body as any);

      expect(mockRunManager.getRun).toHaveBeenCalledWith(runId);
      expect(mockArtifactService.register).toHaveBeenCalledWith({
        runId,
        kind: 'json',
        label: 'output',
        uri: 'https://example.com/output.json',
        inline: undefined,
      });
      expect(mockEventService.emitControlPlaneEvents).toHaveBeenCalledWith(
        runId,
        [
          expect.objectContaining({
            type: 'artifact.created',
            source: { kind: 'control-plane', name: 'observability-controller' },
            subject: { kind: 'artifact', id: 'art-new' },
            data: expect.objectContaining({
              kind: 'json',
              label: 'output',
              artifactId: 'art-new',
              uri: 'https://example.com/output.json',
            }),
          }),
        ],
      );
      expect(result).toEqual(artifact);
    });

    it('passes inline data when provided', async () => {
      const artifact = {
        id: 'art-inline',
        runId,
        kind: 'json',
        label: 'inline result',
        inline: { foo: 'bar' },
        createdAt: '2026-03-19T00:00:00.000Z',
      };
      mockArtifactService.register.mockResolvedValue(artifact);

      const body = {
        kind: 'json' as const,
        label: 'inline result',
        inline: { foo: 'bar' },
      };
      await controller.createArtifact(runId, body as any);

      expect(mockArtifactService.register).toHaveBeenCalledWith(
        expect.objectContaining({
          inline: { foo: 'bar' },
        }),
      );
    });
  });

  // ===========================================================================
  // getMetrics
  // ===========================================================================
  describe('getMetrics', () => {
    it('returns metrics when they exist', async () => {
      const metrics = {
        runId,
        eventCount: 42,
        messageCount: 10,
        signalCount: 3,
        proposalCount: 2,
        toolCallCount: 5,
        decisionCount: 1,
        streamReconnectCount: 0,
      };
      mockMetricsService.get.mockResolvedValue(metrics);

      const result = await controller.getMetrics(runId);

      expect(mockRunManager.getRun).toHaveBeenCalledWith(runId);
      expect(mockMetricsService.get).toHaveBeenCalledWith(runId);
      expect(result).toEqual(metrics);
    });

    it('returns empty default metrics when metricsService returns null', async () => {
      mockMetricsService.get.mockResolvedValue(null);

      const result = await controller.getMetrics(runId);

      expect(result).toEqual({
        runId,
        eventCount: 0,
        messageCount: 0,
        signalCount: 0,
        proposalCount: 0,
        toolCallCount: 0,
        decisionCount: 0,
        streamReconnectCount: 0,
      });
    });
  });

  // ===========================================================================
  // rebuildProjection
  // ===========================================================================
  describe('rebuildProjection', () => {
    it('calls rebuild with canonical events and returns result', async () => {
      const events = [
        { id: 'e1', seq: 1, type: 'run.created' },
        { id: 'e2', seq: 2, type: 'session.started' },
      ];
      mockEventRepository.listCanonicalUpTo.mockResolvedValue(events);

      const rebuiltProjection = {
        run: { runId, status: 'completed' },
        timeline: { latestSeq: 2 },
      };
      mockProjectionService.rebuild.mockResolvedValue(rebuiltProjection);

      const result = await controller.rebuildProjection(runId);

      expect(mockRunManager.getRun).toHaveBeenCalledWith(runId);
      expect(mockEventRepository.listCanonicalUpTo).toHaveBeenCalledWith(runId);
      expect(mockProjectionService.rebuild).toHaveBeenCalledWith(runId, events);
      expect(result).toEqual({ rebuilt: true, latestSeq: 2 });
    });
  });
});
