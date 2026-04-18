import { BadRequestException, HttpException } from '@nestjs/common';
import { RunsController } from './runs.controller';
import { RunExecutorService } from '../runs/run-executor.service';
import { RunManagerService } from '../runs/run-manager.service';
import { EventRepository } from '../storage/event.repository';
import { ReplayService } from '../replay/replay.service';
import { StreamHubService } from '../events/stream-hub.service';
import { AppConfigService } from '../config/app-config.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { ProjectionService } from '../projection/projection.service';
import { OutboundMessageRepository } from '../storage/outbound-message.repository';

describe('RunsController (observer mode)', () => {
  let controller: RunsController;
  let mockRunExecutor: {
    launch: jest.Mock;
    cancel: jest.Mock;
    clone: jest.Mock;
  };
  let mockRunManager: {
    listRuns: jest.Mock;
    getRun: jest.Mock;
    getState: jest.Mock;
    deleteRun: jest.Mock;
    archiveRun: jest.Mock;
  };
  let mockEventRepository: {
    listCanonicalByRun: jest.Mock;
  };
  let mockReplayService: Partial<ReplayService>;
  let mockStreamHub: Partial<StreamHubService>;
  let mockConfig: Partial<AppConfigService>;
  let mockProjectionService: {
    rebuild: jest.Mock;
  };
  let mockOutboundMessageRepository: {
    listByRunId: jest.Mock;
  };

  beforeEach(() => {
    mockRunExecutor = {
      launch: jest.fn(),
      cancel: jest.fn(),
      clone: jest.fn()
    };
    mockRunManager = {
      listRuns: jest.fn(),
      getRun: jest.fn(),
      getState: jest.fn(),
      deleteRun: jest.fn(),
      archiveRun: jest.fn()
    };
    mockEventRepository = {
      listCanonicalByRun: jest.fn()
    };
    mockReplayService = {};
    mockStreamHub = {};
    mockConfig = { streamSseHeartbeatMs: 15000 };
    mockProjectionService = { rebuild: jest.fn() };
    mockOutboundMessageRepository = { listByRunId: jest.fn() };

    controller = new RunsController(
      mockRunExecutor as unknown as RunExecutorService,
      mockRunManager as unknown as RunManagerService,
      mockEventRepository as unknown as EventRepository,
      mockReplayService as unknown as ReplayService,
      mockStreamHub as unknown as StreamHubService,
      mockConfig as unknown as AppConfigService,
      mockProjectionService as unknown as ProjectionService,
      mockOutboundMessageRepository as unknown as OutboundMessageRepository,
      {
        activeSseConnections: { inc: jest.fn(), dec: jest.fn() },
        signalsTotal: { inc: jest.fn() }
      } as unknown as InstrumentationService
    );
  });

  describe('listRuns', () => {
    it('delegates to runManager.listRuns with query params', async () => {
      const runs = [{ id: 'r1', status: 'running' }];
      mockRunManager.listRuns.mockResolvedValue(runs);

      const query = {
        status: 'running' as const,
        tags: ['demo'],
        limit: 10,
        offset: 0,
        sortBy: 'createdAt' as const,
        sortOrder: 'desc' as const
      };
      const result = await controller.listRuns(query as any);

      expect(result).toEqual(runs);
      expect(mockRunManager.listRuns).toHaveBeenCalled();
    });

    it('applies default limit, offset, sortBy, sortOrder when not provided', async () => {
      mockRunManager.listRuns.mockResolvedValue([]);
      await controller.listRuns({} as any);
      expect(mockRunManager.listRuns).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50, offset: 0, sortBy: 'createdAt', sortOrder: 'desc' })
      );
    });
  });

  describe('createRun', () => {
    it('launches and returns {runId, sessionId, status, traceId}', async () => {
      const run = { id: 'run-123', status: 'queued', traceId: 'trace-abc' };
      mockRunExecutor.launch.mockResolvedValue({ run, sessionId: 'sess-alloc-1' });

      const body = {
        mode: 'live',
        runtime: { kind: 'rust' },
        session: {
          modeName: 'macp.mode.decision.v1',
          modeVersion: '1.0.0',
          configurationVersion: 'config.default',
          ttlMs: 60000,
          participants: [{ id: 'agent-1' }]
        }
      };
      const result = await controller.createRun(body as any);

      expect(mockRunExecutor.launch).toHaveBeenCalledWith(body);
      expect(result).toEqual({
        runId: 'run-123',
        sessionId: 'sess-alloc-1',
        status: 'queued',
        traceId: 'trace-abc'
      });
    });
  });

  describe('getRun / getRunState / getRunEvents', () => {
    it('getRun delegates to runManager.getRun', async () => {
      mockRunManager.getRun.mockResolvedValue({ id: 'run-1', status: 'completed' });
      await controller.getRun('run-1');
      expect(mockRunManager.getRun).toHaveBeenCalledWith('run-1');
    });

    it('getRunState delegates to runManager.getState', async () => {
      mockRunManager.getState.mockResolvedValue({ run: { runId: 'run-1' } });
      await controller.getRunState('run-1');
      expect(mockRunManager.getState).toHaveBeenCalledWith('run-1');
    });

    it('getRunEvents legacy fast-path uses listCanonicalByRun', async () => {
      mockEventRepository.listCanonicalByRun.mockResolvedValue([]);
      await controller.getRunEvents('run-1', { afterSeq: 5, limit: 100 } as any);
      expect(mockEventRepository.listCanonicalByRun).toHaveBeenCalledWith('run-1', 5, 100);
    });
  });

  describe('cancelRun', () => {
    it('delegates to runExecutor.cancel', async () => {
      mockRunExecutor.cancel.mockResolvedValue({ id: 'run-1', status: 'cancelled' });
      await controller.cancelRun('run-1', { reason: 'user requested' });
      expect(mockRunExecutor.cancel).toHaveBeenCalledWith('run-1', 'user requested');
    });
  });

  // ===========================================================================
  // Removed envelope-emission endpoints (direct-agent-auth CP-5/6/7)
  // ===========================================================================
  describe('removed endpoints — return 410 Gone', () => {
    it('POST /runs/:id/messages returns 410', () => {
      expect(() => controller.sendMessage('run-1' as any)).toThrow(HttpException);
      try {
        controller.sendMessage('run-1' as any);
      } catch (err) {
        expect((err as HttpException).getStatus()).toBe(410);
      }
    });

    it('POST /runs/:id/signal returns 410', () => {
      try {
        controller.sendSignal('run-1' as any);
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(410);
      }
    });

    it('POST /runs/:id/context returns 410', () => {
      try {
        controller.updateContext('run-1' as any);
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect((err as HttpException).getStatus()).toBe(410);
      }
    });
  });

  describe('cloneRun', () => {
    it('rejects context override (scenario-specific, not accepted by control-plane)', async () => {
      await expect(controller.cloneRun('run-1', { context: { some: 'thing' } } as any)).rejects.toThrow(
        BadRequestException
      );
    });

    it('delegates to runExecutor.clone and returns {runId, sessionId, status, traceId}', async () => {
      const run = { id: 'run-2', status: 'queued', traceId: 't2' };
      mockRunExecutor.clone.mockResolvedValue({ run, sessionId: 'sess-2' });

      const result = await controller.cloneRun('run-1', { tags: ['clone'] } as any);

      expect(mockRunExecutor.clone).toHaveBeenCalledWith('run-1', { tags: ['clone'] });
      expect(result).toEqual({
        runId: 'run-2',
        sessionId: 'sess-2',
        status: 'queued',
        traceId: 't2'
      });
    });
  });

  describe('rebuildProjection', () => {
    it('fetches events and delegates to projectionService.rebuild', async () => {
      mockRunManager.getRun.mockResolvedValue({ id: 'run-1', status: 'completed' });
      mockEventRepository.listCanonicalByRun.mockResolvedValue([{ id: 'e1', seq: 1, type: 'run.created' }]);
      mockProjectionService.rebuild.mockResolvedValue({ run: { runId: 'run-1' } });

      await controller.rebuildProjection('run-1');

      expect(mockProjectionService.rebuild).toHaveBeenCalledWith('run-1', expect.any(Array));
    });
  });
});
