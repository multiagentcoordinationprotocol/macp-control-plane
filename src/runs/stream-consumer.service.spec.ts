import { StreamConsumerService } from './stream-consumer.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { EventNormalizerService } from '../events/event-normalizer.service';
import { RunEventService } from '../events/run-event.service';
import { RuntimeSessionRepository } from '../storage/runtime-session.repository';
import { RunManagerService } from './run-manager.service';
import { StreamHubService } from '../events/stream-hub.service';
import { AppConfigService } from '../config/app-config.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';

describe('StreamConsumerService', () => {
  let service: StreamConsumerService;
  let runtimeRegistry: jest.Mocked<RuntimeProviderRegistry>;
  let normalizer: jest.Mocked<EventNormalizerService>;
  let eventService: jest.Mocked<RunEventService>;
  let runtimeSessionRepository: jest.Mocked<RuntimeSessionRepository>;
  let runManager: jest.Mocked<RunManagerService>;
  let streamHub: jest.Mocked<StreamHubService>;
  let config: AppConfigService;

  beforeEach(() => {
    runtimeRegistry = {
      get: jest.fn()
    } as unknown as jest.Mocked<RuntimeProviderRegistry>;

    normalizer = {
      normalize: jest.fn().mockReturnValue([])
    } as unknown as jest.Mocked<EventNormalizerService>;

    eventService = {
      emitControlPlaneEvents: jest.fn().mockResolvedValue([]),
      persistRawAndCanonical: jest.fn().mockResolvedValue([])
    } as unknown as jest.Mocked<RunEventService>;

    runtimeSessionRepository = {
      updateState: jest.fn().mockResolvedValue(null)
    } as unknown as jest.Mocked<RuntimeSessionRepository>;

    runManager = {
      markCompleted: jest.fn().mockResolvedValue({}),
      markFailed: jest.fn().mockResolvedValue({})
    } as unknown as jest.Mocked<RunManagerService>;

    streamHub = {
      complete: jest.fn(),
      publishEvent: jest.fn(),
      publishSnapshot: jest.fn()
    } as unknown as jest.Mocked<StreamHubService>;

    config = {
      streamBackoffBaseMs: 250,
      streamBackoffMaxMs: 30000,
      streamIdleTimeoutMs: 120000,
      streamMaxRetries: 5
    } as AppConfigService;

    service = new StreamConsumerService(
      runtimeRegistry,
      normalizer,
      eventService,
      runtimeSessionRepository,
      runManager,
      streamHub,
      config,
      {
        activeStreams: { inc: jest.fn(), dec: jest.fn() },
        streamReconnectsTotal: { inc: jest.fn() }
      } as unknown as InstrumentationService,
      {
        withRunSpan: jest.fn(<T>(_runId: string, _name: string, _attrs: unknown, fn: () => Promise<T>) => fn()),
        withSpan: jest.fn(<T>(_name: string, _attrs: unknown, fn: () => Promise<T>) => fn()),
        addRunSpanEvent: jest.fn(),
        getRunTraceContext: jest.fn().mockReturnValue(undefined)
      } as any
    );
  });

  describe('backoff calculation', () => {
    it('should produce exponential delays: 250, 500, 1000, 2000, ...', () => {
      // Access the private backoffMs method for direct testing
      const backoffMs = (service as any).backoffMs.bind(service);

      // Seed Math.random to 0 so jitter = 0
      const originalRandom = Math.random;
      Math.random = () => 0;

      try {
        expect(backoffMs(0)).toBe(250); // 250 * 2^0 = 250
        expect(backoffMs(1)).toBe(500); // 250 * 2^1 = 500
        expect(backoffMs(2)).toBe(1000); // 250 * 2^2 = 1000
        expect(backoffMs(3)).toBe(2000); // 250 * 2^3 = 2000
        expect(backoffMs(4)).toBe(4000); // 250 * 2^4 = 4000
        expect(backoffMs(5)).toBe(8000); // 250 * 2^5 = 8000
      } finally {
        Math.random = originalRandom;
      }
    });

    it('should cap at streamBackoffMaxMs (30000)', () => {
      const backoffMs = (service as any).backoffMs.bind(service);
      const originalRandom = Math.random;
      Math.random = () => 0;

      try {
        // 250 * 2^7 = 32000, should be capped at 30000
        expect(backoffMs(7)).toBe(30000);
        // 250 * 2^10 = 256000, should be capped at 30000
        expect(backoffMs(10)).toBe(30000);
      } finally {
        Math.random = originalRandom;
      }
    });

    it('should add up to 20% jitter on top of the exponential value', () => {
      const backoffMs = (service as any).backoffMs.bind(service);
      const originalRandom = Math.random;

      // With Math.random = 1, jitter = exponential * 0.2 * 1
      Math.random = () => 1;
      try {
        // exponential(0) = 250, jitter = 250 * 0.2 * 1 = 50, total = 300
        expect(backoffMs(0)).toBe(300);
        // exponential(1) = 500, jitter = 500 * 0.2 * 1 = 100, total = 600
        expect(backoffMs(1)).toBe(600);
      } finally {
        Math.random = originalRandom;
      }
    });
  });

  describe('start()', () => {
    it('should be idempotent — second call returns immediately without starting a new loop', async () => {
      const mockProvider = {
        getSession: jest.fn().mockReturnValue(new Promise(() => {})) // never resolves, keeps loop active
      };
      runtimeRegistry.get.mockReturnValue(mockProvider as any);

      const params = {
        runId: 'run-1',
        execution: {
          mode: 'live' as const,
          runtime: { kind: 'rust' },
          session: {
            modeName: 'decision',
            modeVersion: '1.0',
            configurationVersion: '1.0',
            ttlMs: 60000,
            participants: [{ id: 'agent-1' }]
          }
        },
        runtimeKind: 'rust',
        runtimeSessionId: 'session-1',
        subscriberId: 'sub-1'
      };

      await service.start(params);
      // Second call should return immediately since 'run-1' is already active
      await service.start(params);

      // getSession should have been called only once (from the first start call's poll loop)
      expect(mockProvider.getSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop()', () => {
    it('should set the aborted flag on the active stream marker', async () => {
      const mockProvider = {
        getSession: jest.fn().mockReturnValue(new Promise(() => {}))
      };
      runtimeRegistry.get.mockReturnValue(mockProvider as any);

      const params = {
        runId: 'run-stop-test',
        execution: {
          mode: 'live' as const,
          runtime: { kind: 'rust' },
          session: {
            modeName: 'decision',
            modeVersion: '1.0',
            configurationVersion: '1.0',
            ttlMs: 60000,
            participants: [{ id: 'agent-1' }]
          }
        },
        runtimeKind: 'rust',
        runtimeSessionId: 'session-1',
        subscriberId: 'sub-1'
      };

      await service.start(params);
      // Verify the stream is active
      const activeMap = (service as any).active as Map<string, any>;
      expect(activeMap.has('run-stop-test')).toBe(true);
      const marker = activeMap.get('run-stop-test')!;
      expect(marker.aborted).toBe(false);

      await service.stop('run-stop-test');
      expect(marker.aborted).toBe(true);
    });

    it('should do nothing for a non-existent runId', async () => {
      // Should not throw
      await service.stop('non-existent-run');
    });
  });

  describe('onModuleDestroy()', () => {
    it('should abort all active streams', async () => {
      const mockProvider = {
        getSession: jest.fn().mockReturnValue(new Promise(() => {}))
      };
      runtimeRegistry.get.mockReturnValue(mockProvider as any);

      const makeParams = (runId: string) => ({
        runId,
        execution: {
          mode: 'live' as const,
          runtime: { kind: 'rust' },
          session: {
            modeName: 'decision',
            modeVersion: '1.0',
            configurationVersion: '1.0',
            ttlMs: 60000,
            participants: [{ id: 'agent-1' }]
          }
        },
        runtimeKind: 'rust',
        runtimeSessionId: `session-${runId}`,
        subscriberId: 'sub-1'
      });

      await service.start(makeParams('run-a'));
      await service.start(makeParams('run-b'));

      const activeMap = (service as any).active as Map<string, any>;
      const markerA = activeMap.get('run-a')!;
      const markerB = activeMap.get('run-b')!;

      expect(markerA.aborted).toBe(false);
      expect(markerB.aborted).toBe(false);

      await service.onModuleDestroy();

      expect(markerA.aborted).toBe(true);
      expect(markerB.aborted).toBe(true);
    });
  });

  describe('isHealthy()', () => {
    it('should return true when no active streams', () => {
      expect(service.isHealthy()).toBe(true);
    });

    it('should return false when a stream is active but not connected', async () => {
      const mockProvider = {
        getSession: jest.fn().mockReturnValue(new Promise(() => {}))
      };
      runtimeRegistry.get.mockReturnValue(mockProvider as any);

      await service.start({
        runId: 'health-run',
        execution: {
          mode: 'live' as const,
          runtime: { kind: 'rust' },
          session: {
            modeName: 'decision',
            modeVersion: '1.0',
            configurationVersion: '1.0',
            ttlMs: 60000,
            participants: [{ id: 'agent-1' }]
          }
        },
        runtimeKind: 'rust',
        runtimeSessionId: 'session-1',
        subscriberId: 'sub-1'
      });

      // Stream is active but not yet connected
      expect(service.isHealthy()).toBe(false);

      // Manually mark as connected to verify the other branch
      const activeMap = (service as any).active as Map<string, any>;
      const marker = activeMap.get('health-run')!;
      marker.connected = true;
      expect(service.isHealthy()).toBe(true);
    });
  });

  describe('finalizeRun idempotency', () => {
    it('should only finalize once even when called multiple times', async () => {
      const marker = { aborted: false, finalized: false, connected: true, lastProcessedSeq: 0 };

      // Access the private finalizeRun method
      const finalizeRun = (service as any).finalizeRun.bind(service);

      await finalizeRun('run-finalize-test', marker, 'completed');
      expect(runManager.markCompleted).toHaveBeenCalledTimes(1);
      expect(streamHub.complete).toHaveBeenCalledTimes(1);
      expect(marker.finalized).toBe(true);
      expect(marker.aborted).toBe(true);

      // Second call should be a no-op
      await finalizeRun('run-finalize-test', marker, 'completed');
      expect(runManager.markCompleted).toHaveBeenCalledTimes(1);
      expect(streamHub.complete).toHaveBeenCalledTimes(1);
    });

    it('should call markFailed for failed status', async () => {
      const marker = { aborted: false, finalized: false, connected: true, lastProcessedSeq: 0 };
      const finalizeRun = (service as any).finalizeRun.bind(service);
      const error = new Error('something went wrong');

      await finalizeRun('run-fail-test', marker, 'failed', error);

      expect(runManager.markFailed).toHaveBeenCalledWith('run-fail-test', error);
      expect(streamHub.complete).toHaveBeenCalledWith('run-fail-test');
      expect(marker.finalized).toBe(true);
      expect(marker.aborted).toBe(true);
    });
  });
});
