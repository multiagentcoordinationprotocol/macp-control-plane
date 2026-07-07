import { SessionDiscoveryService } from './session-discovery.service';
import { AppConfigService } from '../config/app-config.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { RunManagerService } from './run-manager.service';
import { StreamConsumerService } from './stream-consumer.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { SessionLifecycleEvent } from '../contracts/runtime';

function makeLifecycleEvent(
  type: SessionLifecycleEvent['eventType'],
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
    markCancelled: jest.Mock;
    markSuspended: jest.Mock;
    markResumed: jest.Mock;
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
      markFailed: jest.fn().mockResolvedValue({}),
      markCancelled: jest.fn().mockResolvedValue({}),
      markSuspended: jest.fn().mockResolvedValue({}),
      markResumed: jest.fn().mockResolvedValue({})
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

  it('reconnects after a RESOURCE_EXHAUSTED watch-stream error and resumes discovery (T8)', async () => {
    // Runtime v0.5.0 terminates a lagging watch stream with RESOURCE_EXHAUSTED
    // (gRPC code 8). The discovery loop must reconnect and keep discovering.
    const lagError = Object.assign(new Error('watch stream lagged'), { code: 8 });
    const failingStream = (async function* () {
      await Promise.resolve();
      throw lagError;
    })();
    mockProvider.watchSessions
      .mockReturnValueOnce(failingStream)
      .mockReturnValueOnce(scriptedStream([makeLifecycleEvent('created', 'session-after-reconnect')]));
    mockRunManager.findBySessionId.mockResolvedValue(null);

    await service.onModuleInit();

    // Wait until the loop parks in its 5s reconnect sleep, then cancel it to
    // fast-forward instead of waiting the full backoff.
    for (let i = 0; i < 50 && !(service as unknown as { reconnectResolve?: () => void }).reconnectResolve; i++) {
      await flushAsync();
    }
    (service as unknown as { reconnectResolve?: () => void }).reconnectResolve?.();
    await flushAsync();
    await flushAsync();

    // Reconnected at least once (first stream errored, second was consumed).
    expect(mockProvider.watchSessions.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockRunManager.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ sessionId: 'session-after-reconnect' }) }),
      'session-after-reconnect',
      'session-after-reconnect'
    );

    await service.onModuleDestroy();
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

  it('marks a suspended run failed when it expires (max_suspend_ms elapsed, T4)', async () => {
    // A session paused via SuspendSession banks TTL; if the suspend cap
    // (max_suspend_ms) elapses the runtime expires it. The run is in `suspended`
    // status, and suspended → failed is a valid transition.
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-susp-exp', status: 'suspended' });
    mockProvider.watchSessions.mockReturnValue(
      scriptedStream([makeLifecycleEvent('expired', 'session-se')])
    );

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markFailed).toHaveBeenCalledWith('run-susp-exp', expect.any(Error));
    expect(mockRunManager.markCompleted).not.toHaveBeenCalled();
    expect(mockRunManager.markCancelled).not.toHaveBeenCalled();
  });

  it('marks the run cancelled on a cancelled event (macp-proto 0.1.3)', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-cancel', status: 'running' });
    mockProvider.watchSessions.mockReturnValue(
      scriptedStream([makeLifecycleEvent('cancelled', 'session-c')])
    );

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markCancelled).toHaveBeenCalledWith('run-cancel');
    expect(mockRunManager.markFailed).not.toHaveBeenCalled();
    expect(mockRunManager.markCompleted).not.toHaveBeenCalled();
  });

  it('marks the run suspended on a suspended event without finalizing', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-suspend', status: 'running' });
    mockProvider.watchSessions.mockReturnValue(
      scriptedStream([makeLifecycleEvent('suspended', 'session-s')])
    );

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markSuspended).toHaveBeenCalledWith('run-suspend');
    expect(mockRunManager.markCompleted).not.toHaveBeenCalled();
    expect(mockRunManager.markFailed).not.toHaveBeenCalled();
    expect(mockRunManager.markCancelled).not.toHaveBeenCalled();
  });

  it('marks the run resumed on a resumed event', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-resume', status: 'suspended' });
    mockProvider.watchSessions.mockReturnValue(
      scriptedStream([makeLifecycleEvent('resumed', 'session-rs')])
    );

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markResumed).toHaveBeenCalledWith('run-resume');
  });

  it('does not suspend a run that is already in a terminal state', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-done2', status: 'completed' });
    mockProvider.watchSessions.mockReturnValue(
      scriptedStream([makeLifecycleEvent('suspended', 'session-done2')])
    );

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markSuspended).not.toHaveBeenCalled();
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
