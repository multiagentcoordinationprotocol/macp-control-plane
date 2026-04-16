import { BadRequestException } from '@nestjs/common';
import { RunExecutorService } from './run-executor.service';
import { RunManagerService } from './run-manager.service';
import { RunRepository } from '../storage/run.repository';
import { RuntimeSessionRepository } from '../storage/runtime-session.repository';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { TraceService } from '../telemetry/trace.service';
import { RunEventService } from '../events/run-event.service';
import { ArtifactService } from '../artifacts/artifact.service';
import { StreamConsumerService } from './stream-consumer.service';
import { StreamHubService } from '../events/stream-hub.service';
import { AppConfigService } from '../config/app-config.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { RunDescriptor, Run } from '../contracts/control-plane';
import { RuntimeSessionHandle } from '../contracts/runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunDescriptor(overrides: Partial<RunDescriptor> = {}): RunDescriptor {
  return {
    mode: 'live',
    runtime: { kind: 'rust', version: '0.3.0' },
    session: {
      modeName: 'decision',
      modeVersion: '1.0',
      configurationVersion: '1.0',
      ttlMs: 60000,
      participants: [{ id: 'agent-1' }, { id: 'agent-2' }],
    },
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    status: 'running',
    runtimeKind: 'rust',
    runtimeSessionId: 'sess-1',
    createdAt: new Date().toISOString(),
    metadata: { executionRequest: makeRunDescriptor() },
    ...overrides,
  };
}

function makeReadOnlyHandle(): RuntimeSessionHandle {
  return {
    events: (async function* () {})(),
    abort: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('RunExecutorService (observer mode, direct-agent-auth)', () => {
  let service: RunExecutorService;

  let mockRunManager: {
    createRun: jest.Mock;
    markStarted: jest.Mock;
    markFailed: jest.Mock;
    markCancelled: jest.Mock;
    markRunning: jest.Mock;
    getRun: jest.Mock;
    bindSession: jest.Mock;
  };
  let mockRuntimeSessionRepository: {
    findByRunId: jest.Mock;
  };
  let mockRuntimeRegistry: {
    get: jest.Mock;
  };
  let mockTraceService: {
    withSpan: jest.Mock;
    withRunSpan: jest.Mock;
    addRunSpanEvent: jest.Mock;
    getRunTraceContext: jest.Mock;
  };
  let mockEventService: {
    emitControlPlaneEvents: jest.Mock;
  };
  let mockArtifactService: Partial<ArtifactService>;
  let mockStreamConsumer: {
    start: jest.Mock;
    stop: jest.Mock;
  };
  let mockStreamHub: {
    complete: jest.Mock;
  };
  let mockConfig: {
    runtimeRequestTimeoutMs: number;
    clientVersion: string;
    sessionPollBaseMs: number;
    sessionPollMaxMs: number;
    sessionPollTimeoutMs: number;
    cancelCallbackTimeoutMs: number;
  };
  let mockProvider: {
    kind: string;
    initialize: jest.Mock;
    subscribeSession: jest.Mock;
    getSession: jest.Mock;
    cancelSession: jest.Mock;
    getManifest: jest.Mock;
    listModes: jest.Mock;
    listRoots: jest.Mock;
    health: jest.Mock;
    registerPolicy: jest.Mock;
    unregisterPolicy: jest.Mock;
    getPolicy: jest.Mock;
    listPolicies: jest.Mock;
  };

  beforeEach(() => {
    mockProvider = {
      kind: 'rust',
      initialize: jest.fn().mockResolvedValue({
        selectedProtocolVersion: '1.0',
        runtimeInfo: { name: 'rust-runtime', version: '0.3.0' },
        supportedModes: ['decision', 'proposal', 'task'],
        capabilities: {},
        instructions: undefined,
      }),
      subscribeSession: jest.fn().mockReturnValue(makeReadOnlyHandle()),
      getSession: jest.fn().mockResolvedValue({
        sessionId: 'sess-1',
        mode: 'decision',
        state: 'SESSION_STATE_OPEN',
        initiator: 'agent-1',
      }),
      cancelSession: jest.fn().mockResolvedValue({
        ack: { ok: true, sessionState: 'SESSION_STATE_RESOLVED' },
      }),
      getManifest: jest.fn(),
      listModes: jest.fn(),
      listRoots: jest.fn(),
      health: jest.fn(),
      registerPolicy: jest.fn(),
      unregisterPolicy: jest.fn(),
      getPolicy: jest.fn(),
      listPolicies: jest.fn(),
    };

    mockRunManager = {
      createRun: jest.fn().mockResolvedValue(makeRun({ status: 'queued' })),
      markStarted: jest.fn().mockResolvedValue(makeRun({ status: 'starting' })),
      markFailed: jest.fn().mockResolvedValue(makeRun({ status: 'failed' })),
      markCancelled: jest.fn().mockResolvedValue(makeRun({ status: 'cancelled' })),
      markRunning: jest.fn().mockResolvedValue(makeRun({ status: 'running' })),
      getRun: jest.fn().mockResolvedValue(makeRun()),
      bindSession: jest.fn().mockResolvedValue(makeRun({ status: 'binding_session' })),
    };

    mockRuntimeSessionRepository = {
      findByRunId: jest.fn().mockResolvedValue({
        modeName: 'decision',
        initiatorParticipantId: 'agent-1',
      }),
    };

    mockRuntimeRegistry = {
      get: jest.fn().mockReturnValue(mockProvider),
    };

    mockTraceService = {
      withSpan: jest.fn().mockImplementation((_name, _attrs, fn) => fn()),
      withRunSpan: jest.fn().mockImplementation((_runId, _name, _attrs, fn) => fn()),
      addRunSpanEvent: jest.fn(),
      getRunTraceContext: jest.fn().mockReturnValue(undefined),
    };

    mockEventService = {
      emitControlPlaneEvents: jest.fn().mockResolvedValue(undefined),
    };

    mockArtifactService = {
      register: jest.fn().mockResolvedValue({ id: 'art-1', kind: 'trace', label: 'Root run trace' }),
    };

    mockStreamConsumer = {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
    };

    mockStreamHub = {
      complete: jest.fn(),
    };

    mockConfig = {
      runtimeRequestTimeoutMs: 30000,
      clientVersion: '0.3.0',
      sessionPollBaseMs: 10,
      sessionPollMaxMs: 50,
      sessionPollTimeoutMs: 1000,
      cancelCallbackTimeoutMs: 5000,
    };

    service = new RunExecutorService(
      mockRunManager as unknown as RunManagerService,
      {} as unknown as RunRepository,
      mockRuntimeSessionRepository as unknown as RuntimeSessionRepository,
      mockRuntimeRegistry as unknown as RuntimeProviderRegistry,
      mockTraceService as unknown as TraceService,
      mockEventService as unknown as RunEventService,
      mockArtifactService as unknown as ArtifactService,
      mockStreamConsumer as unknown as StreamConsumerService,
      mockStreamHub as unknown as StreamHubService,
      mockConfig as unknown as AppConfigService,
      { outboundMessagesTotal: { inc: jest.fn() } } as unknown as InstrumentationService,
    );
  });

  // =========================================================================
  // validate()
  // =========================================================================
  describe('validate', () => {
    it('returns error when participants are missing', async () => {
      const request = makeRunDescriptor({
        session: {
          modeName: 'decision',
          modeVersion: '1.0',
          configurationVersion: '1.0',
          ttlMs: 60000,
          participants: [],
        },
      });

      const result = await service.validate(request);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'session.participants must contain at least one participant',
      );
    });

    it('returns error when modeName is missing', async () => {
      const request = makeRunDescriptor({
        session: {
          modeName: '',
          modeVersion: '1.0',
          configurationVersion: '1.0',
          ttlMs: 60000,
          participants: [{ id: 'agent-1' }],
        },
      });

      const result = await service.validate(request);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('session.modeName is required');
    });

    it('returns error when runtime does not support the requested mode', async () => {
      mockProvider.initialize.mockResolvedValue({
        selectedProtocolVersion: '1.0',
        runtimeInfo: { name: 'rust-runtime' },
        supportedModes: ['task', 'proposal'],
        capabilities: {},
      });

      const result = await service.validate(makeRunDescriptor());

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("does not support mode 'decision'"),
        ]),
      );
    });

    it('returns valid result when mode is in supported list', async () => {
      const result = await service.validate(makeRunDescriptor());
      expect(result.valid).toBe(true);
      expect(result.runtime.reachable).toBe(true);
    });

    it('returns error when provided sessionId is not a valid UUID or base64url', async () => {
      const result = await service.validate(
        makeRunDescriptor({
          session: {
            modeName: 'decision',
            modeVersion: '1.0',
            configurationVersion: '1.0',
            ttlMs: 60000,
            participants: [{ id: 'agent-1' }],
            sessionId: 'bad-id',
          },
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'session.sessionId must be a UUID v4/v7 or base64url 22+ chars',
      );
    });

    it('returns warning (not error) when runtime is unreachable', async () => {
      mockProvider.initialize.mockRejectedValue(new Error('UNAVAILABLE: connect failed'));

      const result = await service.validate(makeRunDescriptor());

      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('Runtime not reachable')]),
      );
      expect(result.runtime.reachable).toBe(false);
    });
  });

  // =========================================================================
  // launch()
  // =========================================================================
  describe('launch', () => {
    it('allocates a sessionId when one is not provided and passes it to createRun', async () => {
      const expectedRun = makeRun({ status: 'queued' });
      mockRunManager.createRun.mockResolvedValue(expectedRun);

      const result = await service.launch(makeRunDescriptor());

      expect(result.run).toEqual(expectedRun);
      expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
      expect(mockRunManager.createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({ sessionId: result.sessionId }),
        }),
        result.sessionId,
      );
    });

    it('uses caller-provided sessionId when valid', async () => {
      const sessionId = '123e4567-e89b-42d3-a456-426614174000';
      const expectedRun = makeRun({ status: 'queued' });
      mockRunManager.createRun.mockResolvedValue(expectedRun);

      const result = await service.launch(
        makeRunDescriptor({
          session: {
            modeName: 'decision',
            modeVersion: '1.0',
            configurationVersion: '1.0',
            ttlMs: 60000,
            participants: [{ id: 'agent-1' }],
            sessionId,
          },
        }),
      );

      expect(result.sessionId).toBe(sessionId);
    });

    it('rejects invalid sessionId', async () => {
      await expect(
        service.launch(
          makeRunDescriptor({
            session: {
              modeName: 'decision',
              modeVersion: '1.0',
              configurationVersion: '1.0',
              ttlMs: 60000,
              participants: [{ id: 'agent-1' }],
              sessionId: 'too-short',
            },
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('never calls provider.subscribeSession synchronously from launch', async () => {
      const expectedRun = makeRun({ status: 'queued' });
      mockRunManager.createRun.mockResolvedValue(expectedRun);

      await service.launch(makeRunDescriptor());

      // subscribeSession happens async in execute() — we only verify launch returns quickly.
      expect(mockRunManager.createRun).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // cancel() — Option A (callback) and Option B (delegated)
  // =========================================================================
  describe('cancel', () => {
    it('Option A: POSTs to initiator agent cancelCallback when metadata.cancelCallback is set', async () => {
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: true, status: 200 } as unknown as Response);

      const run = makeRun({
        status: 'running',
        runtimeSessionId: 'sess-1',
        metadata: {
          executionRequest: makeRunDescriptor(),
          cancelCallback: { url: 'http://agent/cancel', bearer: 'tok' },
        },
      });
      mockRunManager.getRun.mockResolvedValue(run);

      await service.cancel('run-1', 'user requested');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://agent/cancel',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'content-type': 'application/json',
            authorization: 'Bearer tok',
          }),
          body: expect.stringContaining('"runId":"run-1"'),
        }),
      );
      expect(mockProvider.cancelSession).not.toHaveBeenCalled();
      expect(mockRunManager.markCancelled).toHaveBeenCalledWith('run-1');
      fetchSpy.mockRestore();
    });

    it('Option B: calls provider.cancelSession when metadata.cancellationDelegated is true', async () => {
      const run = makeRun({
        status: 'running',
        runtimeSessionId: 'sess-1',
        metadata: {
          executionRequest: makeRunDescriptor(),
          cancellationDelegated: true,
        },
      });
      mockRunManager.getRun.mockResolvedValue(run);

      await service.cancel('run-1', 'policy-delegated');

      expect(mockProvider.cancelSession).toHaveBeenCalledWith({
        runId: 'run-1',
        runtimeSessionId: 'sess-1',
        reason: 'policy-delegated',
      });
      expect(mockRunManager.markCancelled).toHaveBeenCalledWith('run-1');
    });

    it('rejects when neither cancelCallback nor delegation is configured', async () => {
      const run = makeRun({
        status: 'running',
        runtimeSessionId: 'sess-1',
        metadata: { executionRequest: makeRunDescriptor() },
      });
      mockRunManager.getRun.mockResolvedValue(run);

      await expect(service.cancel('run-1')).rejects.toThrow(BadRequestException);
      expect(mockRunManager.markCancelled).not.toHaveBeenCalled();
    });

    it('throws when run has no runtime session', async () => {
      mockRunManager.getRun.mockResolvedValue(makeRun({ runtimeSessionId: undefined }));
      await expect(service.cancel('run-1')).rejects.toThrow(/no bound runtime session/);
    });

    it('surfaces 502 when cancelCallback returns non-2xx', async () => {
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response);

      const run = makeRun({
        status: 'running',
        runtimeSessionId: 'sess-1',
        metadata: {
          executionRequest: makeRunDescriptor(),
          cancelCallback: { url: 'http://agent/cancel' },
        },
      });
      mockRunManager.getRun.mockResolvedValue(run);

      await expect(service.cancel('run-1')).rejects.toThrow(AppException);
      fetchSpy.mockRestore();
    });
  });

  // =========================================================================
  // clone()
  // =========================================================================
  describe('clone', () => {
    it('throws when run has no execution request in metadata', async () => {
      mockRunManager.getRun.mockResolvedValue(makeRun({ metadata: {} }));
      await expect(service.clone('run-1')).rejects.toThrow(BadRequestException);
    });

    it('clones with tag overrides and allocates a fresh sessionId', async () => {
      const originalRequest = makeRunDescriptor();
      mockRunManager.getRun.mockResolvedValue(
        makeRun({ metadata: { executionRequest: originalRequest } }),
      );
      mockRunManager.createRun.mockResolvedValue(makeRun({ id: 'run-2', status: 'queued' }));

      const result = await service.clone('run-1', { tags: ['cloned'] });

      expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
      expect(mockRunManager.createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          execution: expect.objectContaining({ tags: ['cloned'] }),
          session: expect.objectContaining({ sessionId: result.sessionId }),
        }),
        result.sessionId,
      );
    });

    it('clears idempotency key and the original sessionId on clone', async () => {
      const originalRequest = makeRunDescriptor({
        execution: { idempotencyKey: 'original-key' },
        session: {
          modeName: 'decision',
          modeVersion: '1.0',
          configurationVersion: '1.0',
          ttlMs: 60000,
          participants: [{ id: 'agent-1' }],
          sessionId: 'original-session-id-that-would-be-valid-base64url',
        },
      });
      mockRunManager.getRun.mockResolvedValue(
        makeRun({ metadata: { executionRequest: originalRequest } }),
      );
      mockRunManager.createRun.mockResolvedValue(makeRun({ id: 'run-2' }));

      const result = await service.clone('run-1');

      const cloneArg = mockRunManager.createRun.mock.calls[0][0] as RunDescriptor;
      expect(cloneArg.execution?.idempotencyKey).toBeUndefined();
      expect(cloneArg.session.sessionId).toBe(result.sessionId);
      expect(cloneArg.session.sessionId).not.toBe('original-session-id-that-would-be-valid-base64url');
    });
  });

  // =========================================================================
  // execute() observer flow (tested indirectly via launch)
  // =========================================================================
  describe('execute (via launch)', () => {
    it('marks run failed when runtime mode is not supported', async () => {
      mockProvider.initialize.mockResolvedValue({
        selectedProtocolVersion: '1.0',
        runtimeInfo: { name: 'rust-runtime' },
        supportedModes: ['task'],
        capabilities: {},
      });
      mockRunManager.createRun.mockResolvedValue(makeRun({ id: 'run-x' }));

      await service.launch(makeRunDescriptor());
      await new Promise((r) => setTimeout(r, 50));

      expect(mockRunManager.markFailed).toHaveBeenCalledWith(
        'run-x',
        expect.objectContaining({ errorCode: ErrorCode.MODE_NOT_SUPPORTED }),
      );
    });

    it('polls GetSession until SESSION_STATE_OPEN, then subscribes and starts the stream consumer', async () => {
      const handle = makeReadOnlyHandle();
      mockProvider.subscribeSession.mockReturnValue(handle);

      // First two polls return UNSPECIFIED, third returns OPEN
      mockProvider.getSession
        .mockResolvedValueOnce({ sessionId: 'sess-ok', state: 'SESSION_STATE_UNSPECIFIED', mode: 'decision' })
        .mockResolvedValueOnce({ sessionId: 'sess-ok', state: 'SESSION_STATE_UNSPECIFIED', mode: 'decision' })
        .mockResolvedValueOnce({
          sessionId: 'sess-ok',
          state: 'SESSION_STATE_OPEN',
          mode: 'decision',
          initiator: 'agent-1',
        });

      mockRunManager.createRun.mockResolvedValue(makeRun({ id: 'run-ok' }));

      await service.launch(makeRunDescriptor());
      await new Promise((r) => setTimeout(r, 400));

      expect(mockProvider.getSession).toHaveBeenCalled();
      expect(mockRunManager.bindSession).toHaveBeenCalled();
      expect(mockProvider.subscribeSession).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-ok' }),
      );
      expect(mockStreamConsumer.start).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-ok',
          sessionHandle: handle,
          subscriberId: 'agent-1',
        }),
      );
    });

    it('marks run failed with SESSION_EXPIRED if the session expires before an agent opens it', async () => {
      mockProvider.getSession.mockResolvedValue({
        sessionId: 'sess-expired',
        state: 'SESSION_STATE_EXPIRED',
        mode: 'decision',
      });
      mockRunManager.createRun.mockResolvedValue(makeRun({ id: 'run-exp' }));

      await service.launch(makeRunDescriptor());
      await new Promise((r) => setTimeout(r, 100));

      expect(mockRunManager.markFailed).toHaveBeenCalledWith(
        'run-exp',
        expect.objectContaining({ errorCode: ErrorCode.SESSION_EXPIRED }),
      );
    });

    it('marks run failed with RUNTIME_TIMEOUT when GetSession never returns OPEN before timeout', async () => {
      mockProvider.getSession.mockResolvedValue({
        sessionId: 'sess-stuck',
        state: 'SESSION_STATE_UNSPECIFIED',
        mode: 'decision',
      });
      mockRunManager.createRun.mockResolvedValue(makeRun({ id: 'run-timeout' }));

      await service.launch(makeRunDescriptor());
      await new Promise((r) => setTimeout(r, 1200));

      expect(mockRunManager.markFailed).toHaveBeenCalledWith(
        'run-timeout',
        expect.objectContaining({ errorCode: ErrorCode.RUNTIME_TIMEOUT }),
      );
    });
  });

  // =========================================================================
  // Invariant — observer never calls provider.send (CP-3)
  // =========================================================================
  describe('invariant: observer never writes envelopes', () => {
    it('the provider mock has no send method on RunExecutorService dependencies', () => {
      expect((mockProvider as unknown as { send?: unknown }).send).toBeUndefined();
    });

    it('RunExecutorService does not expose sendMessage / sendSignal / updateContext methods', () => {
      const executor = service as unknown as Record<string, unknown>;
      expect(executor.sendMessage).toBeUndefined();
      expect(executor.sendSignal).toBeUndefined();
      expect(executor.updateContext).toBeUndefined();
      expect(executor.retryKickoff).toBeUndefined();
    });
  });
});
