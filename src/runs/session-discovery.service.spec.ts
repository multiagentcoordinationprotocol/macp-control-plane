import { SessionDiscoveryService } from './session-discovery.service';
import { AppConfigService } from '../config/app-config.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { RunManagerService } from './run-manager.service';
import { StreamConsumerService } from './stream-consumer.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { SessionLifecycleEvent } from '../contracts/runtime';

function makeLifecycleEvent(
  type: 'created' | 'resolved' | 'expired',
  sessionId: string,
  overrides: Partial<SessionLifecycleEvent['session']> = {}
): SessionLifecycleEvent {
  return {
    eventType: type,
    observedAtUnixMs: Date.now(),
    session: {
      sessionId,
      mode: 'decision',
      state: 'SESSION_STATE_OPEN',
      initiator: 'agent-1',
      modeVersion: '1.0.0',
      configurationVersion: 'cfg.default',
      policyVersion: 'policy.default',
      startedAtUnixMs: 1_000,
      expiresAtUnixMs: 301_000,
      ...overrides
    }
  };
}

async function* scriptedStream(events: SessionLifecycleEvent[]) {
  for (const ev of events) yield ev;
}

describe('SessionDiscoveryService', () => {
  let service: SessionDiscoveryService;
  let mockConfig: Partial<AppConfigService>;
  let mockRegistry: { get: jest.Mock };
  let mockRunManager: {
    findBySessionId: jest.Mock;
    createRun: jest.Mock;
    markStarted: jest.Mock;
    bindSession: jest.Mock;
    markRunning: jest.Mock;
    markCompleted: jest.Mock;
    markFailed: jest.Mock;
  };
  let mockStreamConsumer: { start: jest.Mock };
  let mockProvider: { watchSessions: jest.Mock; subscribeSession: jest.Mock };
  let mockInstrumentation: Partial<InstrumentationService>;

  beforeEach(() => {
    mockConfig = { sessionDiscoveryEnabled: true };
    mockProvider = {
      watchSessions: jest.fn(),
      subscribeSession: jest.fn().mockReturnValue({ events: (async function* () {})(), abort: jest.fn() })
    };
    mockRegistry = { get: jest.fn().mockReturnValue(mockProvider) };
    mockRunManager = {
      findBySessionId: jest.fn().mockResolvedValue(null),
      createRun: jest.fn(async (_desc, _sid, runId) => ({ id: runId ?? 'run-x', status: 'queued' })),
      markStarted: jest.fn().mockResolvedValue({}),
      bindSession: jest.fn().mockResolvedValue({}),
      markRunning: jest.fn().mockResolvedValue({}),
      markCompleted: jest.fn().mockResolvedValue({}),
      markFailed: jest.fn().mockResolvedValue({})
    };
    mockStreamConsumer = { start: jest.fn().mockResolvedValue(undefined) };
    mockInstrumentation = {};

    service = new SessionDiscoveryService(
      mockRegistry as unknown as RuntimeProviderRegistry,
      mockRunManager as unknown as RunManagerService,
      mockStreamConsumer as unknown as StreamConsumerService,
      mockInstrumentation as InstrumentationService,
      mockConfig as AppConfigService
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('skips discovery loop when SESSION_DISCOVERY_ENABLED=false', async () => {
    const disabled = new SessionDiscoveryService(
      mockRegistry as unknown as RuntimeProviderRegistry,
      mockRunManager as unknown as RunManagerService,
      mockStreamConsumer as unknown as StreamConsumerService,
      mockInstrumentation as InstrumentationService,
      { sessionDiscoveryEnabled: false } as AppConfigService
    );
    await disabled.onModuleInit();
    expect(mockRegistry.get).not.toHaveBeenCalled();
    expect(mockProvider.watchSessions).not.toHaveBeenCalled();
  });

  it('auto-creates a run for a newly created session and starts stream consumer', async () => {
    mockProvider.watchSessions.mockReturnValue(
      scriptedStream([makeLifecycleEvent('created', 'session-abc')])
    );

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'live',
        runtime: { kind: 'rust' },
        session: expect.objectContaining({
          sessionId: 'session-abc',
          modeName: 'decision',
          metadata: expect.objectContaining({ source: 'session-discovery', initiator: 'agent-1' })
        })
      }),
      'session-abc',
      'session-abc'
    );
    expect(mockRunManager.markStarted).toHaveBeenCalled();
    expect(mockRunManager.bindSession).toHaveBeenCalled();
    expect(mockRunManager.markRunning).toHaveBeenCalledWith(expect.any(String), 'session-abc');
    expect(mockProvider.subscribeSession).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeSessionId: 'session-abc' })
    );
    expect(mockStreamConsumer.start).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeSessionId: 'session-abc',
        subscriberId: expect.stringMatching(/^discovery-/)
      })
    );
  });

  it('skips duplicate created events for the same session', async () => {
    mockProvider.watchSessions.mockReturnValue(
      scriptedStream([
        makeLifecycleEvent('created', 'session-dup'),
        makeLifecycleEvent('created', 'session-dup')
      ])
    );

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.createRun).toHaveBeenCalledTimes(1);
  });

  it('skips created event when a run for that session already exists', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'preexisting-run', status: 'running' });
    mockProvider.watchSessions.mockReturnValue(
      scriptedStream([makeLifecycleEvent('created', 'session-existing')])
    );

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.createRun).not.toHaveBeenCalled();
    expect(mockStreamConsumer.start).not.toHaveBeenCalled();
  });

  it('marks the run completed on a resolved event', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-done', status: 'running' });
    mockProvider.watchSessions.mockReturnValue(
      scriptedStream([makeLifecycleEvent('resolved', 'session-r')])
    );

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markCompleted).toHaveBeenCalledWith('run-done');
    expect(mockRunManager.markFailed).not.toHaveBeenCalled();
  });

  it('marks the run failed on an expired event', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-expire', status: 'running' });
    mockProvider.watchSessions.mockReturnValue(
      scriptedStream([makeLifecycleEvent('expired', 'session-e')])
    );

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markFailed).toHaveBeenCalledWith('run-expire', expect.any(Error));
    expect(mockRunManager.markCompleted).not.toHaveBeenCalled();
  });

  it('ignores terminal lifecycle events when the run is already in a terminal state', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-term', status: 'completed' });
    mockProvider.watchSessions.mockReturnValue(
      scriptedStream([
        makeLifecycleEvent('resolved', 'session-t'),
        makeLifecycleEvent('expired', 'session-t')
      ])
    );

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markCompleted).not.toHaveBeenCalled();
    expect(mockRunManager.markFailed).not.toHaveBeenCalled();
  });

  it('ignores terminal events for unknown sessions', async () => {
    mockRunManager.findBySessionId.mockResolvedValue(null);
    mockProvider.watchSessions.mockReturnValue(
      scriptedStream([makeLifecycleEvent('resolved', 'session-unknown')])
    );

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markCompleted).not.toHaveBeenCalled();
    expect(mockRunManager.markFailed).not.toHaveBeenCalled();
  });

  it('ignores events missing a sessionId', async () => {
    mockProvider.watchSessions.mockReturnValue(
      scriptedStream([
        {
          eventType: 'created',
          observedAtUnixMs: Date.now(),
          session: { sessionId: '', mode: 'decision', state: 'SESSION_STATE_OPEN' }
        } as SessionLifecycleEvent
      ])
    );

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.createRun).not.toHaveBeenCalled();
  });
});

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}
