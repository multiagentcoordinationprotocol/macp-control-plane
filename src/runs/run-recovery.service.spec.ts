import { RunRecoveryService } from './run-recovery.service';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';
import { RunEventService } from '../events/run-event.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { RunRepository } from '../storage/run.repository';
import { RuntimeSessionRepository } from '../storage/runtime-session.repository';
import { RunManagerService } from './run-manager.service';
import { StreamConsumerService } from './stream-consumer.service';

describe('RunRecoveryService', () => {
  let service: RunRecoveryService;
  let mockConfig: Partial<AppConfigService>;
  let mockDatabase: { tryAdvisoryLock: jest.Mock; advisoryUnlock: jest.Mock };
  let mockRunRepo: { listActiveRuns: jest.Mock };
  let mockSessionRepo: { findByRunId: jest.Mock };
  let mockRunManager: { markRunning: jest.Mock; markFailed: jest.Mock };
  let mockStreamConsumer: { start: jest.Mock };
  let mockEventService: { emitControlPlaneEvents: jest.Mock };
  let mockRuntimeRegistry: { get: jest.Mock };
  let mockProvider: { subscribeSession: jest.Mock };

  const buildRun = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 'run-1',
    status: 'running',
    runtimeKind: 'rust',
    runtimeSessionId: 'sess-1',
    lastEventSeq: 42,
    metadata: {
      executionRequest: {
        mode: 'live',
        runtime: { kind: 'rust' },
        session: {
          modeName: 'decision',
          modeVersion: '1.0',
          configurationVersion: 'v1',
          ttlMs: 60000,
          participants: [{ id: 'agent-1' }]
        }
      }
    },
    ...overrides
  });

  beforeEach(() => {
    mockConfig = { runRecoveryEnabled: true, streamResumeEnabled: false };
    mockDatabase = {
      tryAdvisoryLock: jest.fn().mockResolvedValue(true),
      advisoryUnlock: jest.fn().mockResolvedValue(undefined)
    };
    mockRunRepo = { listActiveRuns: jest.fn().mockResolvedValue([]) };
    mockSessionRepo = { findByRunId: jest.fn().mockResolvedValue(null) };
    mockRunManager = {
      markRunning: jest.fn().mockResolvedValue({}),
      markFailed: jest.fn().mockResolvedValue({})
    };
    mockStreamConsumer = { start: jest.fn().mockResolvedValue(undefined) };
    mockEventService = { emitControlPlaneEvents: jest.fn().mockResolvedValue([]) };
    mockProvider = { subscribeSession: jest.fn().mockReturnValue({ events: (async function* () {})(), abort: jest.fn() }) };
    mockRuntimeRegistry = { get: jest.fn().mockReturnValue(mockProvider) };

    service = new RunRecoveryService(
      mockConfig as AppConfigService,
      mockDatabase as unknown as DatabaseService,
      mockRunRepo as unknown as RunRepository,
      mockSessionRepo as unknown as RuntimeSessionRepository,
      mockRunManager as unknown as RunManagerService,
      mockStreamConsumer as unknown as StreamConsumerService,
      mockEventService as unknown as RunEventService,
      { recoveryTotal: { inc: jest.fn() } } as unknown as InstrumentationService,
      mockRuntimeRegistry as unknown as RuntimeProviderRegistry
    );
  });

  it('skips recovery when disabled', async () => {
    const disabledService = new RunRecoveryService(
      { runRecoveryEnabled: false } as AppConfigService,
      mockDatabase as unknown as DatabaseService,
      mockRunRepo as unknown as RunRepository,
      mockSessionRepo as unknown as RuntimeSessionRepository,
      mockRunManager as unknown as RunManagerService,
      mockStreamConsumer as unknown as StreamConsumerService,
      mockEventService as unknown as RunEventService,
      { recoveryTotal: { inc: jest.fn() } } as unknown as InstrumentationService,
      mockRuntimeRegistry as unknown as RuntimeProviderRegistry
    );
    await disabledService.onApplicationBootstrap();
    expect(mockRunRepo.listActiveRuns).not.toHaveBeenCalled();
  });

  it('does nothing when no active runs', async () => {
    await service.onApplicationBootstrap();
    expect(mockRunRepo.listActiveRuns).toHaveBeenCalled();
    expect(mockStreamConsumer.start).not.toHaveBeenCalled();
  });

  it('recovers a running run by starting stream consumer (flag off: poll-only, ordinal still seeded)', async () => {
    const run = buildRun();
    mockRunRepo.listActiveRuns.mockResolvedValue([run]);
    mockSessionRepo.findByRunId.mockResolvedValue({
      initiatorParticipantId: 'agent-1',
      runtimeSessionId: 'sess-1',
      lastEnvelopeOrdinal: 17
    });

    await service.onApplicationBootstrap();

    expect(mockEventService.emitControlPlaneEvents).toHaveBeenCalledWith(
      'run-1',
      expect.arrayContaining([
        expect.objectContaining({
          type: 'session.stream.opened',
          data: expect.objectContaining({ status: 'recovered' })
        })
      ])
    );
    // AC2 (amended): flag off -> pollOnly true, no sessionHandle, but the
    // ordinal is still seeded — this is the clobber-bug regression coverage.
    expect(mockRuntimeRegistry.get).not.toHaveBeenCalled();
    expect(mockStreamConsumer.start).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        runtimeSessionId: 'sess-1',
        subscriberId: 'agent-1',
        resumeFromSeq: 42,
        resumeFromEnvelopeOrdinal: 17,
        pollOnly: true,
        sessionHandle: undefined
      })
    );
  });

  it('promotes binding_session to running before recovery', async () => {
    const run = buildRun({ id: 'run-2', status: 'binding_session', runtimeSessionId: 'sess-2', lastEventSeq: 10 });
    mockRunRepo.listActiveRuns.mockResolvedValue([run]);

    await service.onApplicationBootstrap();

    expect(mockRunManager.markRunning).toHaveBeenCalledWith('run-2', 'sess-2');
  });

  it('marks run as failed when recovery fails', async () => {
    const run = buildRun({ id: 'run-3', runtimeSessionId: 'sess-3', lastEventSeq: 0, metadata: {} });
    mockRunRepo.listActiveRuns.mockResolvedValue([run]);

    await service.onApplicationBootstrap();

    expect(mockRunManager.markFailed).toHaveBeenCalledWith('run-3', expect.any(Error));
  });

  it('does not crash if markFailed also fails', async () => {
    const run = buildRun({ id: 'run-4', runtimeSessionId: null, lastEventSeq: 0 });
    mockRunRepo.listActiveRuns.mockResolvedValue([run]);
    mockSessionRepo.findByRunId.mockResolvedValue(null);
    mockRunManager.markFailed.mockRejectedValue(new Error('db down'));

    // Should not throw
    await service.onApplicationBootstrap();

    expect(mockRunManager.markFailed).toHaveBeenCalled();
  });

  describe('stream resume enabled (STREAM_RESUME_ENABLED=true)', () => {
    beforeEach(() => {
      mockConfig = { ...mockConfig, streamResumeEnabled: true };
      service = new RunRecoveryService(
        mockConfig as AppConfigService,
        mockDatabase as unknown as DatabaseService,
        mockRunRepo as unknown as RunRepository,
        mockSessionRepo as unknown as RuntimeSessionRepository,
        mockRunManager as unknown as RunManagerService,
        mockStreamConsumer as unknown as StreamConsumerService,
        mockEventService as unknown as RunEventService,
        { recoveryTotal: { inc: jest.fn() } } as unknown as InstrumentationService,
        mockRuntimeRegistry as unknown as RuntimeProviderRegistry
      );
    });

    it('AC1: resolves a provider and calls subscribeSession with the persisted ordinal, not 0, not poll-only', async () => {
      const run = buildRun();
      mockRunRepo.listActiveRuns.mockResolvedValue([run]);
      mockSessionRepo.findByRunId.mockResolvedValue({
        initiatorParticipantId: 'agent-1',
        runtimeSessionId: 'sess-1',
        lastEnvelopeOrdinal: 99
      });
      const handle = { events: (async function* () {})(), abort: jest.fn() };
      mockProvider.subscribeSession.mockReturnValue(handle);

      await service.onApplicationBootstrap();

      expect(mockRuntimeRegistry.get).toHaveBeenCalledWith('rust');
      expect(mockProvider.subscribeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          runtimeSessionId: 'sess-1',
          afterSequence: 99
        })
      );
      expect(mockProvider.subscribeSession).not.toHaveBeenCalledWith(expect.objectContaining({ afterSequence: 0 }));
      expect(mockStreamConsumer.start).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeFromEnvelopeOrdinal: 99,
          sessionHandle: handle,
          pollOnly: false
        })
      );
    });

    it('AC1b: a subscribeSession failure degrades to poll-only and the run is still recovered', async () => {
      const run = buildRun();
      mockRunRepo.listActiveRuns.mockResolvedValue([run]);
      mockSessionRepo.findByRunId.mockResolvedValue({
        initiatorParticipantId: 'agent-1',
        runtimeSessionId: 'sess-1',
        lastEnvelopeOrdinal: 55
      });
      mockProvider.subscribeSession.mockImplementation(() => {
        throw new Error('registry unavailable');
      });

      const result = await service.onApplicationBootstrap();

      expect(mockStreamConsumer.start).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeFromEnvelopeOrdinal: 55,
          sessionHandle: undefined,
          pollOnly: true
        })
      );
      // The run itself must still be recovered — failure is not propagated.
      expect(mockRunManager.markFailed).not.toHaveBeenCalled();
      expect(result).toBeUndefined(); // onApplicationBootstrap has no return; asserting it didn't throw
    });

    it('seeds ordinal 0 when no prior session/ordinal exists (fresh run, never a clobber)', async () => {
      const run = buildRun();
      mockRunRepo.listActiveRuns.mockResolvedValue([run]);
      mockSessionRepo.findByRunId.mockResolvedValue({
        initiatorParticipantId: 'agent-1',
        runtimeSessionId: 'sess-1'
        // no lastEnvelopeOrdinal field
      });

      await service.onApplicationBootstrap();

      expect(mockProvider.subscribeSession).toHaveBeenCalledWith(expect.objectContaining({ afterSequence: 0 }));
    });
  });

  describe('end-to-end wiring through a real StreamConsumerService (compacted-resume path)', () => {
    it('AC3: a FAILED_PRECONDITION on the resumed subscribe emits session.stream.gap and degrades to poll-only without resubscribing from 0', async () => {
      // Use the real StreamConsumerService (not the mock) so this test proves
      // RunRecoveryService's sessionHandle actually reaches consumeLoop's
      // existing gap-detection logic end-to-end, rather than only asserting
      // on mock call arguments.
      const normalizer = { normalize: jest.fn().mockReturnValue([]) };
      const eventService = {
        emitControlPlaneEvents: jest.fn().mockResolvedValue([]),
        persistRawAndCanonical: jest.fn().mockResolvedValue([])
      };
      const runtimeSessionRepository = {
        updateState: jest.fn().mockResolvedValue(null),
        updateStreamCursor: jest.fn().mockResolvedValue(null)
      };
      const runManager = {
        markCompleted: jest.fn().mockResolvedValue({}),
        markFailed: jest.fn().mockResolvedValue({}),
        markCancelled: jest.fn().mockResolvedValue({}),
        markRunning: jest.fn().mockResolvedValue({})
      };
      const streamHub = { complete: jest.fn(), publishEvent: jest.fn(), publishSnapshot: jest.fn() };
      const streamConfig = {
        streamBackoffBaseMs: 1,
        streamBackoffMaxMs: 5,
        streamIdleTimeoutMs: 120000,
        streamMaxRetries: 5,
        streamResumeEnabled: true,
        runRecoveryEnabled: true
      };
      const instrumentation = {
        activeStreams: { inc: jest.fn(), dec: jest.fn() },
        streamReconnectsTotal: { inc: jest.fn() },
        streamResumeGapTotal: { inc: jest.fn() },
        recoveryTotal: { inc: jest.fn() }
      };
      const traceService = {
        withRunSpan: jest.fn((_r: string, _n: string, _a: unknown, fn: () => Promise<unknown>) => fn()),
        withSpan: jest.fn((_n: string, _a: unknown, fn: () => Promise<unknown>) => fn()),
        addRunSpanEvent: jest.fn(),
        getRunTraceContext: jest.fn().mockReturnValue(undefined)
      };

      const gapError = Object.assign(new Error('session history before ordinal 5 was compacted'), { code: 9 });
      const failingHandle = {
        events: (async function* () {
          throw gapError;
        })(),
        abort: jest.fn()
      };
      const provider = {
        subscribeSession: jest.fn().mockReturnValue(failingHandle),
        getSession: jest.fn().mockResolvedValue({ state: 'SESSION_STATE_RESOLVED' })
      };
      const realRuntimeRegistry = { get: jest.fn().mockReturnValue(provider) };

      const realStreamConsumer = new StreamConsumerService(
        realRuntimeRegistry as unknown as RuntimeProviderRegistry,
        normalizer as any,
        eventService as any,
        runtimeSessionRepository as any,
        runManager as any,
        streamHub as any,
        streamConfig as unknown as AppConfigService,
        instrumentation as unknown as InstrumentationService,
        traceService as any
      );

      const wiredService = new RunRecoveryService(
        streamConfig as unknown as AppConfigService,
        mockDatabase as unknown as DatabaseService,
        mockRunRepo as unknown as RunRepository,
        mockSessionRepo as unknown as RuntimeSessionRepository,
        runManager as unknown as RunManagerService,
        realStreamConsumer,
        eventService as unknown as RunEventService,
        instrumentation as unknown as InstrumentationService,
        realRuntimeRegistry as unknown as RuntimeProviderRegistry
      );

      const run = buildRun();
      mockRunRepo.listActiveRuns.mockResolvedValue([run]);
      mockSessionRepo.findByRunId.mockResolvedValue({
        initiatorParticipantId: 'agent-1',
        runtimeSessionId: 'sess-1',
        lastEnvelopeOrdinal: 5
      });

      await wiredService.onApplicationBootstrap();
      // Let the fire-and-forget consumeLoop (started by streamConsumer.start)
      // run to completion.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(provider.subscribeSession).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-1', runtimeSessionId: 'sess-1', afterSequence: 5 })
      );
      // Never resubscribed on the gap, and never from 0.
      expect(provider.subscribeSession).toHaveBeenCalledTimes(1);
      const gapEmitted = eventService.emitControlPlaneEvents.mock.calls.some((call) =>
        (call[1] as any[]).some((e) => e.type === 'session.stream.gap')
      );
      expect(gapEmitted).toBe(true);
      expect(runManager.markCompleted).toHaveBeenCalledWith('run-1');
    });
  });

  // Regression test for the clobber bug: a recovery cycle must never pass a
  // lower resumeFromEnvelopeOrdinal than what was persisted. This fails if
  // change 2 (seeding resumeFromEnvelopeOrdinal on every path) is reverted —
  // reverting change 1 (the monotonic SQL floor) is covered separately in
  // runtime-session.repository.spec.ts, since that clobber happens inside the
  // repository write, not in what RunRecoveryService passes to start().
  it('never seeds a lower resumeFromEnvelopeOrdinal than the persisted value (clobber regression)', async () => {
    const run = buildRun();
    mockRunRepo.listActiveRuns.mockResolvedValue([run]);
    mockSessionRepo.findByRunId.mockResolvedValue({
      initiatorParticipantId: 'agent-1',
      runtimeSessionId: 'sess-1',
      lastEnvelopeOrdinal: 12345
    });

    await service.onApplicationBootstrap();

    const call = mockStreamConsumer.start.mock.calls[0][0];
    expect(call.resumeFromEnvelopeOrdinal).toBe(12345);
    expect(call.resumeFromEnvelopeOrdinal).not.toBe(0);
  });
});
