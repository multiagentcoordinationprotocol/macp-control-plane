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

describe('RunsController', () => {
  let controller: RunsController;
  let mockRunExecutor: {
    launch: jest.Mock;
    cancel: jest.Mock;
    sendMessage: jest.Mock;
    sendSignal: jest.Mock;
    updateContext: jest.Mock;
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
      sendMessage: jest.fn(),
      sendSignal: jest.fn(),
      updateContext: jest.fn(),
    };
    mockRunManager = {
      listRuns: jest.fn(),
      getRun: jest.fn(),
      getState: jest.fn(),
      deleteRun: jest.fn(),
      archiveRun: jest.fn(),
    };
    mockEventRepository = {
      listCanonicalByRun: jest.fn(),
    };
    mockReplayService = {};
    mockStreamHub = {};
    mockConfig = {
      streamSseHeartbeatMs: 15000,
    };
    mockProjectionService = {
      rebuild: jest.fn(),
    };
    mockOutboundMessageRepository = {
      listByRunId: jest.fn(),
    };

    controller = new RunsController(
      mockRunExecutor as unknown as RunExecutorService,
      mockRunManager as unknown as RunManagerService,
      mockEventRepository as unknown as EventRepository,
      mockReplayService as unknown as ReplayService,
      mockStreamHub as unknown as StreamHubService,
      mockConfig as unknown as AppConfigService,
      mockProjectionService as unknown as ProjectionService,
      mockOutboundMessageRepository as unknown as OutboundMessageRepository,
      { activeSseConnections: { inc: jest.fn(), dec: jest.fn() }, signalsTotal: { inc: jest.fn() } } as unknown as InstrumentationService,
    );
  });

  // ===========================================================================
  // listRuns
  // ===========================================================================
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
        sortOrder: 'desc' as const,
      };
      const result = await controller.listRuns(query as any);

      expect(result).toEqual(runs);
      expect(mockRunManager.listRuns).toHaveBeenCalledWith({
        status: 'running',
        tags: ['demo'],
        createdAfter: undefined,
        createdBefore: undefined,
        limit: 10,
        offset: 0,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        includeArchived: undefined,
      });
    });

    it('applies default limit, offset, sortBy, sortOrder when not provided', async () => {
      mockRunManager.listRuns.mockResolvedValue([]);

      await controller.listRuns({} as any);

      expect(mockRunManager.listRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 50,
          offset: 0,
          sortBy: 'createdAt',
          sortOrder: 'desc',
        }),
      );
    });
  });

  // ===========================================================================
  // createRun
  // ===========================================================================
  describe('createRun', () => {
    it('calls runExecutor.launch and returns correct shape', async () => {
      const fakeRun = { id: 'run-123', status: 'queued', traceId: 'trace-abc' };
      mockRunExecutor.launch.mockResolvedValue(fakeRun);

      const body = {
        mode: 'live',
        runtime: { kind: 'rust' },
        session: {
          modeName: 'macp.mode.decision.v1',
          modeVersion: '1.0.0',
          configurationVersion: 'config.default',
          ttlMs: 60000,
          participants: [{ id: 'agent-1' }],
        },
      };
      const result = await controller.createRun(body as any);

      expect(mockRunExecutor.launch).toHaveBeenCalledWith(body);
      expect(result).toEqual({
        runId: 'run-123',
        status: 'queued',
        traceId: 'trace-abc',
      });
    });

    it('returns traceId as undefined when run has no traceId', async () => {
      const fakeRun = { id: 'run-456', status: 'queued', traceId: null };
      mockRunExecutor.launch.mockResolvedValue(fakeRun);

      const result = await controller.createRun({ mode: 'sandbox' } as any);

      expect(result.traceId).toBeUndefined();
    });
  });

  // ===========================================================================
  // getRun
  // ===========================================================================
  describe('getRun', () => {
    it('delegates to runManager.getRun', async () => {
      const fakeRun = { id: 'run-789', status: 'completed' };
      mockRunManager.getRun.mockResolvedValue(fakeRun);

      const result = await controller.getRun('run-789');

      expect(mockRunManager.getRun).toHaveBeenCalledWith('run-789');
      expect(result).toEqual(fakeRun);
    });
  });

  // ===========================================================================
  // getRunState
  // ===========================================================================
  describe('getRunState', () => {
    it('delegates to runManager.getState', async () => {
      const fakeState = {
        run: { runId: 'run-1', status: 'running' },
        participants: [],
        graph: { nodes: [], edges: [] },
        timeline: { latestSeq: 5 },
      };
      mockRunManager.getState.mockResolvedValue(fakeState);

      const result = await controller.getRunState('run-1');

      expect(mockRunManager.getState).toHaveBeenCalledWith('run-1');
      expect(result).toEqual(fakeState);
    });
  });

  // ===========================================================================
  // getRunEvents
  // ===========================================================================
  describe('getRunEvents', () => {
    it('delegates to eventRepository.listCanonicalByRun', async () => {
      const events = [{ id: 'e1', seq: 1, type: 'message.received' }];
      mockEventRepository.listCanonicalByRun.mockResolvedValue(events);

      const query = { afterSeq: 5, limit: 100 };
      const result = await controller.getRunEvents('run-1', query as any);

      expect(mockEventRepository.listCanonicalByRun).toHaveBeenCalledWith('run-1', 5, 100);
      expect(result).toEqual(events);
    });

    it('applies default afterSeq=0 and limit=200 when not provided', async () => {
      mockEventRepository.listCanonicalByRun.mockResolvedValue([]);

      await controller.getRunEvents('run-1', {} as any);

      expect(mockEventRepository.listCanonicalByRun).toHaveBeenCalledWith('run-1', 0, 200);
    });
  });

  // ===========================================================================
  // cancelRun
  // ===========================================================================
  describe('cancelRun', () => {
    it('delegates to runExecutor.cancel with reason', async () => {
      const cancelledRun = { id: 'run-1', status: 'cancelled' };
      mockRunExecutor.cancel.mockResolvedValue(cancelledRun);

      const result = await controller.cancelRun('run-1', { reason: 'user requested' });

      expect(mockRunExecutor.cancel).toHaveBeenCalledWith('run-1', 'user requested');
      expect(result).toEqual(cancelledRun);
    });

    it('passes undefined reason when body has no reason', async () => {
      mockRunExecutor.cancel.mockResolvedValue({ id: 'run-1', status: 'cancelled' });

      await controller.cancelRun('run-1', {});

      expect(mockRunExecutor.cancel).toHaveBeenCalledWith('run-1', undefined);
    });
  });

  // ===========================================================================
  // sendMessage
  // ===========================================================================
  describe('sendMessage', () => {
    it('delegates to runExecutor.sendMessage', async () => {
      const sendResult = { messageId: 'msg-1', ack: { ok: true } };
      mockRunExecutor.sendMessage.mockResolvedValue(sendResult);

      const body = {
        from: 'agent-1',
        to: ['agent-2'],
        messageType: 'Evaluation',
        payloadEnvelope: {
          encoding: 'proto',
          proto: { typeName: 'macp.modes.decision.v1.EvaluationPayload', value: { proposal_id: 'p1' } }
        }
      };
      const result = await controller.sendMessage('run-1', body as any);

      expect(mockRunExecutor.sendMessage).toHaveBeenCalledWith('run-1', body);
      expect(result).toEqual(sendResult);
    });
  });

  // ===========================================================================
  // sendSignal
  // ===========================================================================
  describe('sendSignal', () => {
    it('delegates to runExecutor.sendSignal', async () => {
      const signalResult = { messageId: 'msg-1', ack: { ok: true } };
      mockRunExecutor.sendSignal.mockResolvedValue(signalResult);

      const body = {
        from: 'agent-1',
        to: ['agent-2'],
        messageType: 'Signal',
        payload: { data: 'test' },
        signalType: 'alert',
      };
      const result = await controller.sendSignal('run-1', body as any);

      expect(mockRunExecutor.sendSignal).toHaveBeenCalledWith('run-1', body);
      expect(result).toEqual(signalResult);
    });
  });

  // ===========================================================================
  // updateContext
  // ===========================================================================
  describe('updateContext', () => {
    it('delegates to runExecutor.updateContext', async () => {
      const contextResult = { messageId: 'msg-ctx', ack: { ok: true } };
      mockRunExecutor.updateContext.mockResolvedValue(contextResult);

      const body = { from: 'agent-1', context: { key: 'value' } };
      const result = await controller.updateContext('run-1', body as any);

      expect(mockRunExecutor.updateContext).toHaveBeenCalledWith('run-1', body);
      expect(result).toEqual(contextResult);
    });
  });

  // ===========================================================================
  // rebuildProjection
  // ===========================================================================
  describe('rebuildProjection', () => {
    it('fetches events and delegates to projectionService.rebuild', async () => {
      const fakeRun = { id: 'run-1', status: 'completed' };
      mockRunManager.getRun.mockResolvedValue(fakeRun);
      const events = [{ id: 'e1', seq: 1, type: 'run.created' }];
      mockEventRepository.listCanonicalByRun.mockResolvedValue(events);
      const projection = { run: { runId: 'run-1', status: 'completed' } };
      mockProjectionService.rebuild.mockResolvedValue(projection);

      const result = await controller.rebuildProjection('run-1');

      expect(mockRunManager.getRun).toHaveBeenCalledWith('run-1');
      expect(mockEventRepository.listCanonicalByRun).toHaveBeenCalledWith('run-1', 0, 100000);
      expect(mockProjectionService.rebuild).toHaveBeenCalledWith('run-1', events);
      expect(result).toEqual(projection);
    });
  });

});
