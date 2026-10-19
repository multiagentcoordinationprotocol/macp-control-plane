import * as grpc from '@grpc/grpc-js';
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
    mockInstrumentation = { watchStreamLaggedTotal: { inc: jest.fn() } } as unknown as Partial<InstrumentationService>;

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
    mockProvider.watchSessions.mockReturnValue(scriptedStream([makeLifecycleEvent('created', 'session-abc')]));

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
      scriptedStream([makeLifecycleEvent('created', 'session-dup'), makeLifecycleEvent('created', 'session-dup')])
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

  function streamLagged(): Error {
    const metadata = new grpc.Metadata();
    metadata.set('macp-error-code', 'STREAM_LAGGED');
    return Object.assign(new Error('8 RESOURCE_EXHAUSTED: WatchSessions receiver fell behind by 7 events'), {
      code: 8,
      details: 'WatchSessions receiver fell behind by 7 events',
      metadata
    });
  }

  function failingWith(err: Error): AsyncIterable<SessionLifecycleEvent> {
    return (async function* () {
      await Promise.resolve();
      throw err;
    })();
  }

  const laggedCounter = () =>
    (mockInstrumentation as unknown as { watchStreamLaggedTotal: { inc: jest.Mock } }).watchStreamLaggedTotal.inc;
  const parked = () => Boolean((service as unknown as { reconnectResolve?: () => void }).reconnectResolve);

  it('on a coded STREAM_LAGGED end, counts it once and reconnects without the 5s delay; the initial sync re-emits sessions (v0.9.0)', async () => {
    mockProvider.watchSessions
      .mockReturnValueOnce(failingWith(streamLagged()))
      .mockReturnValueOnce(scriptedStream([makeLifecycleEvent('created', 'session-resynced')]))
      .mockReturnValue(failingWith(new Error('end of script')));

    await service.onModuleInit();
    for (let i = 0; i < 50 && !mockRunManager.createRun.mock.calls.length; i++) await flushAsync();

    // Reconnected and consumed the re-sync before ever parking in a back-off sleep.
    expect(mockRunManager.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ sessionId: 'session-resynced' }) }),
      'session-resynced',
      'session-resynced'
    );
    expect(laggedCounter()).toHaveBeenCalledTimes(1);
    expect(laggedCounter()).toHaveBeenCalledWith({ stream: 'watch_sessions' });

    await service.onModuleDestroy();
  });

  it('takes the normal delay for a second STREAM_LAGGED right after an immediate reconnect (no hot loop)', async () => {
    mockProvider.watchSessions
      .mockReturnValueOnce(failingWith(streamLagged()))
      .mockReturnValueOnce(failingWith(streamLagged()))
      .mockReturnValue(failingWith(new Error('end of script')));

    await service.onModuleInit();
    for (let i = 0; i < 50 && !parked(); i++) await flushAsync();

    expect(parked()).toBe(true);
    expect(mockProvider.watchSessions).toHaveBeenCalledTimes(2);
    expect(laggedCounter()).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
  });

  it('keeps the 5s delay and does not count an uncoded watch-stream end', async () => {
    mockProvider.watchSessions.mockReturnValueOnce(
      failingWith(Object.assign(new Error('8 RESOURCE_EXHAUSTED'), { code: 8 }))
    );

    await service.onModuleInit();
    for (let i = 0; i < 50 && !parked(); i++) await flushAsync();

    expect(parked()).toBe(true);
    expect(mockProvider.watchSessions).toHaveBeenCalledTimes(1);
    expect(laggedCounter()).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('skips created event when a run for that session already exists', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'preexisting-run', status: 'running' });
    mockProvider.watchSessions.mockReturnValue(scriptedStream([makeLifecycleEvent('created', 'session-existing')]));

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.createRun).not.toHaveBeenCalled();
    expect(mockStreamConsumer.start).not.toHaveBeenCalled();
  });

  describe('reconciling known runs from the initial-sync snapshot', () => {
    const reconcile = async (runStatus: string, state: SessionLifecycleEvent['session']['state']) => {
      mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-known', status: runStatus });
      mockProvider.watchSessions.mockReturnValue(
        scriptedStream([makeLifecycleEvent('created', 'session-known', { state })])
      );
      await service.onModuleInit();
      await flushAsync();
    };
    const transitions = () => ({
      completed: mockRunManager.markCompleted.mock.calls.length,
      failed: mockRunManager.markFailed.mock.calls.length,
      cancelled: mockRunManager.markCancelled.mock.calls.length,
      suspended: mockRunManager.markSuspended.mock.calls.length,
      resumed: mockRunManager.markResumed.mock.calls.length
    });
    const only = (key: keyof ReturnType<typeof transitions>) => ({
      ...{ completed: 0, failed: 0, cancelled: 0, suspended: 0, resumed: 0 },
      [key]: 1
    });

    it.each([
      ['running', 'SESSION_STATE_RESOLVED', 'completed'],
      ['running', 'SESSION_STATE_EXPIRED', 'failed'],
      ['suspended', 'SESSION_STATE_CANCELLED', 'cancelled'],
      ['running', 'SESSION_STATE_SUSPENDED', 'suspended'],
      ['suspended', 'SESSION_STATE_OPEN', 'resumed']
    ] as const)(
      'a %s run whose snapshot is %s is marked %s (a lifecycle event lost in a lag)',
      async (status, state, expected) => {
        await reconcile(status, state);
        expect(transitions()).toEqual(only(expected));
        expect(mockRunManager.createRun).not.toHaveBeenCalled();
      }
    );

    it.each([
      ['running', 'SESSION_STATE_OPEN'],
      ['suspended', 'SESSION_STATE_SUSPENDED'],
      ['completed', 'SESSION_STATE_RESOLVED'],
      ['binding_session', 'SESSION_STATE_RESOLVED'],
      ['starting', 'SESSION_STATE_SUSPENDED']
    ] as const)('a %s run whose snapshot is %s is left alone', async (status, state) => {
      await reconcile(status, state);
      expect(Object.values(transitions()).every((n) => n === 0)).toBe(true);
    });

    it('applies a state change seen on the post-lag resync of an already-known session', async () => {
      mockRunManager.findBySessionId
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ id: 'session-lagged', status: 'running' });
      mockProvider.watchSessions
        .mockReturnValueOnce(
          (async function* () {
            yield makeLifecycleEvent('created', 'session-lagged');
            throw streamLagged();
          })()
        )
        .mockReturnValueOnce(
          scriptedStream([makeLifecycleEvent('created', 'session-lagged', { state: 'SESSION_STATE_SUSPENDED' })])
        )
        .mockReturnValue(failingWith(new Error('end of script')));

      await service.onModuleInit();
      for (let i = 0; i < 50 && !mockRunManager.markSuspended.mock.calls.length; i++) await flushAsync();

      expect(mockRunManager.createRun).toHaveBeenCalledTimes(1);
      expect(mockRunManager.markSuspended).toHaveBeenCalledWith('session-lagged');
      await service.onModuleDestroy();
    });

    it('keeps discovering other sessions when reconciling one run fails', async () => {
      mockRunManager.findBySessionId.mockImplementation(async (sid: string) =>
        sid === 'session-bad' ? { id: 'run-bad', status: 'running' } : null
      );
      mockRunManager.markCompleted.mockRejectedValueOnce(new Error('invalid transition'));
      mockProvider.watchSessions.mockReturnValue(
        scriptedStream([
          makeLifecycleEvent('created', 'session-bad', { state: 'SESSION_STATE_RESOLVED' }),
          makeLifecycleEvent('created', 'session-new')
        ])
      );

      await service.onModuleInit();
      for (let i = 0; i < 20 && !mockRunManager.createRun.mock.calls.length; i++) await flushAsync();

      expect(mockRunManager.createRun).toHaveBeenCalledWith(expect.anything(), 'session-new', 'session-new');
    });

    it('keeps the watch open when the run lookup for an already-known session fails', async () => {
      mockRunManager.findBySessionId
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('db blip'))
        .mockResolvedValue(null);
      mockProvider.watchSessions.mockReturnValue(
        scriptedStream([
          makeLifecycleEvent('created', 'session-k'),
          makeLifecycleEvent('created', 'session-k', { state: 'SESSION_STATE_RESOLVED' }),
          makeLifecycleEvent('created', 'session-new')
        ])
      );

      await service.onModuleInit();
      for (let i = 0; i < 20 && mockRunManager.createRun.mock.calls.length < 2; i++) await flushAsync();

      expect(mockRunManager.createRun.mock.calls.map((c: unknown[]) => c[1])).toEqual(['session-k', 'session-new']);
      // session-new arrived on the same (single-use) stream, so the failed lookup did not end it.
      expect(mockRunManager.markCompleted).not.toHaveBeenCalled();
    });
  });

  it('marks the run completed on a resolved event', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-done', status: 'running' });
    mockProvider.watchSessions.mockReturnValue(scriptedStream([makeLifecycleEvent('resolved', 'session-r')]));

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markCompleted).toHaveBeenCalledWith('run-done');
    expect(mockRunManager.markFailed).not.toHaveBeenCalled();
  });

  it('marks the run failed on an expired event', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-expire', status: 'running' });
    mockProvider.watchSessions.mockReturnValue(scriptedStream([makeLifecycleEvent('expired', 'session-e')]));

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
    mockProvider.watchSessions.mockReturnValue(scriptedStream([makeLifecycleEvent('expired', 'session-se')]));

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markFailed).toHaveBeenCalledWith('run-susp-exp', expect.any(Error));
    expect(mockRunManager.markCompleted).not.toHaveBeenCalled();
    expect(mockRunManager.markCancelled).not.toHaveBeenCalled();
  });

  it('marks the run cancelled on a cancelled event (macp-proto 0.1.3)', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-cancel', status: 'running' });
    mockProvider.watchSessions.mockReturnValue(scriptedStream([makeLifecycleEvent('cancelled', 'session-c')]));

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markCancelled).toHaveBeenCalledWith('run-cancel');
    expect(mockRunManager.markFailed).not.toHaveBeenCalled();
    expect(mockRunManager.markCompleted).not.toHaveBeenCalled();
  });

  it('marks the run suspended on a suspended event without finalizing', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-suspend', status: 'running' });
    mockProvider.watchSessions.mockReturnValue(scriptedStream([makeLifecycleEvent('suspended', 'session-s')]));

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markSuspended).toHaveBeenCalledWith('run-suspend');
    expect(mockRunManager.markCompleted).not.toHaveBeenCalled();
    expect(mockRunManager.markFailed).not.toHaveBeenCalled();
    expect(mockRunManager.markCancelled).not.toHaveBeenCalled();
  });

  it('marks the run resumed on a resumed event', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-resume', status: 'suspended' });
    mockProvider.watchSessions.mockReturnValue(scriptedStream([makeLifecycleEvent('resumed', 'session-rs')]));

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markResumed).toHaveBeenCalledWith('run-resume');
  });

  it('does not suspend a run that is already in a terminal state', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-done2', status: 'completed' });
    mockProvider.watchSessions.mockReturnValue(scriptedStream([makeLifecycleEvent('suspended', 'session-done2')]));

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markSuspended).not.toHaveBeenCalled();
  });

  it('ignores terminal lifecycle events when the run is already in a terminal state', async () => {
    mockRunManager.findBySessionId.mockResolvedValue({ id: 'run-term', status: 'completed' });
    mockProvider.watchSessions.mockReturnValue(
      scriptedStream([makeLifecycleEvent('resolved', 'session-t'), makeLifecycleEvent('expired', 'session-t')])
    );

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markCompleted).not.toHaveBeenCalled();
    expect(mockRunManager.markFailed).not.toHaveBeenCalled();
  });

  it('ignores terminal events for unknown sessions', async () => {
    mockRunManager.findBySessionId.mockResolvedValue(null);
    mockProvider.watchSessions.mockReturnValue(scriptedStream([makeLifecycleEvent('resolved', 'session-unknown')]));

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunManager.markCompleted).not.toHaveBeenCalled();
    expect(mockRunManager.markFailed).not.toHaveBeenCalled();
  });

  it('onModuleDestroy cancels a WatchSessions stream parked on an idle next()', async () => {
    let release!: () => void;
    const parked = new Promise<IteratorResult<SessionLifecycleEvent>>((resolve) => {
      release = () => resolve({ done: true, value: undefined });
    });
    const returnFn = jest.fn(async () => {
      release();
      return { done: true as const, value: undefined };
    });
    mockProvider.watchSessions.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => parked, return: returnFn })
    });

    await service.onModuleInit();
    await flushAsync();
    await service.onModuleDestroy();

    expect(returnFn).toHaveBeenCalled();
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
