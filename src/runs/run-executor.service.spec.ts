import { BadRequestException } from '@nestjs/common';
import { RunExecutorService } from './run-executor.service';
import { RunManagerService } from './run-manager.service';
import { RunRepository } from '../storage/run.repository';
import { RuntimeSessionRepository } from '../storage/runtime-session.repository';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { ProtoRegistryService } from '../runtime/proto-registry.service';
import { TraceService } from '../telemetry/trace.service';
import { RunEventService } from '../events/run-event.service';
import { ArtifactService } from '../artifacts/artifact.service';
import { StreamConsumerService } from './stream-consumer.service';
import { StreamHubService } from '../events/stream-hub.service';
import { AppConfigService } from '../config/app-config.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { ExecutionRequest, Run } from '../contracts/control-plane';
import {
  RuntimeProvider,
  RuntimeSessionHandle,
} from '../contracts/runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecutionRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    mode: 'live',
    runtime: { kind: 'rust', version: '0.3.0' },
    session: {
      modeName: 'decision',
      modeVersion: '1.0',
      configurationVersion: '1.0',
      ttlMs: 60000,
      participants: [{ id: 'agent-1', role: 'proposer' }],
    },
    kickoff: [
      {
        from: 'agent-1',
        to: ['agent-2'],
        kind: 'request',
        messageType: 'Proposal',
        payload: { text: 'hello' },
      },
    ],
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
    metadata: { executionRequest: makeExecutionRequest() },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('RunExecutorService', () => {
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
  let mockRunRepository: Record<string, jest.Mock>;
  let mockRuntimeSessionRepository: {
    findByRunId: jest.Mock;
  };
  let mockRuntimeRegistry: {
    get: jest.Mock;
  };
  let mockProtoRegistry: {
    encodePayloadEnvelope: jest.Mock;
  };
  let mockTraceService: {
    withSpan: jest.Mock;
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
    kickoffMaxRetries: number;
    clientVersion: string;
  };
  let mockProvider: {
    kind: string;
    initialize: jest.Mock;
    openSession: jest.Mock;
    startSession: jest.Mock;
    send: jest.Mock;
    streamSession: jest.Mock;
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
      openSession: jest.fn(),
      startSession: jest.fn(),
      send: jest.fn(),
      streamSession: jest.fn(),
      getSession: jest.fn(),
      cancelSession: jest.fn(),
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

    mockRunRepository = {};

    mockRuntimeSessionRepository = {
      findByRunId: jest.fn().mockResolvedValue({
        modeName: 'decision',
        initiatorParticipantId: 'agent-1',
      }),
    };

    mockRuntimeRegistry = {
      get: jest.fn().mockReturnValue(mockProvider),
    };

    mockProtoRegistry = {
      encodePayloadEnvelope: jest.fn().mockReturnValue(Buffer.from('encoded')),
    };

    mockTraceService = {
      withSpan: jest.fn().mockImplementation((_name, _attrs, fn) => fn()),
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
      kickoffMaxRetries: 3,
      clientVersion: '0.3.0',
    };

    service = new RunExecutorService(
      mockRunManager as unknown as RunManagerService,
      mockRunRepository as unknown as RunRepository,
      mockRuntimeSessionRepository as unknown as RuntimeSessionRepository,
      mockRuntimeRegistry as unknown as RuntimeProviderRegistry,
      mockProtoRegistry as unknown as ProtoRegistryService,
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
      const request = makeExecutionRequest({
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
      const request = makeExecutionRequest({
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

      const request = makeExecutionRequest();

      const result = await service.validate(request);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("does not support mode 'decision'"),
        ]),
      );
    });

    it('returns valid result when mode is in supported list', async () => {
      const request = makeExecutionRequest();

      const result = await service.validate(request);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.runtime.reachable).toBe(true);
      expect(result.runtime.supportedModes).toContain('decision');
    });

    it('does not error when supportedModes is empty (accept-all)', async () => {
      mockProvider.initialize.mockResolvedValue({
        selectedProtocolVersion: '1.0',
        runtimeInfo: { name: 'rust-runtime' },
        supportedModes: [],
        capabilities: {},
      });

      const request = makeExecutionRequest();
      const result = await service.validate(request);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns warning (not error) when runtime is unreachable', async () => {
      mockProvider.initialize.mockRejectedValue(new Error('UNAVAILABLE: connect failed'));

      const request = makeExecutionRequest();
      const result = await service.validate(request);

      // Missing runtime should be a warning, not an error
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Runtime not reachable'),
        ]),
      );
      expect(result.runtime.reachable).toBe(false);
    });

    it('returns error for kickoff message missing messageType', async () => {
      const request = makeExecutionRequest({
        kickoff: [
          {
            from: 'agent-1',
            to: ['agent-2'],
            kind: 'request',
            messageType: '',
            payload: {},
          },
        ],
      });

      const result = await service.validate(request);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('kickoff message is missing messageType');
    });

    it('returns error for kickoff message missing from', async () => {
      const request = makeExecutionRequest({
        kickoff: [
          {
            from: '',
            to: ['agent-2'],
            kind: 'request',
            messageType: 'Proposal',
            payload: {},
          },
        ],
      });

      const result = await service.validate(request);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('kickoff message is missing from');
    });
  });

  // =========================================================================
  // launch()
  // =========================================================================
  describe('launch', () => {
    it('rejects replay mode', async () => {
      const request = makeExecutionRequest({ mode: 'replay' });

      await expect(service.launch(request)).rejects.toThrow(BadRequestException);
      await expect(service.launch(request)).rejects.toThrow(
        /Use \/runs\/:id\/replay for replay mode/,
      );
    });

    it('creates run and returns it for live mode', async () => {
      const expectedRun = makeRun({ status: 'queued' });
      mockRunManager.createRun.mockResolvedValue(expectedRun);

      // Set up openSession to return a handle so execute() doesn't blow up
      const handle: RuntimeSessionHandle = {
        send: jest.fn(),
        events: (async function* () {})(),
        closeWrite: jest.fn(),
        abort: jest.fn(),
        sessionAck: Promise.resolve({
          runtimeSessionId: 'sess-1',
          initiator: 'agent-1',
          ack: {
            ok: true,
            duplicate: false,
            messageId: 'msg-1',
            sessionId: 'sess-1',
            acceptedAtUnixMs: Date.now(),
            sessionState: 'SESSION_STATE_OPEN' as const,
          },
        }),
      };
      mockProvider.openSession.mockReturnValue(handle);

      const request = makeExecutionRequest();
      const result = await service.launch(request);

      expect(result).toEqual(expectedRun);
      expect(mockRunManager.createRun).toHaveBeenCalledWith(request);
    });

    it('creates run and returns it for sandbox mode', async () => {
      const expectedRun = makeRun({ status: 'queued' });
      mockRunManager.createRun.mockResolvedValue(expectedRun);

      const handle: RuntimeSessionHandle = {
        send: jest.fn(),
        events: (async function* () {})(),
        closeWrite: jest.fn(),
        abort: jest.fn(),
        sessionAck: Promise.resolve({
          runtimeSessionId: 'sess-1',
          initiator: 'agent-1',
          ack: {
            ok: true,
            duplicate: false,
            messageId: 'msg-1',
            sessionId: 'sess-1',
            acceptedAtUnixMs: Date.now(),
            sessionState: 'SESSION_STATE_OPEN' as const,
          },
        }),
      };
      mockProvider.openSession.mockReturnValue(handle);

      const request = makeExecutionRequest({ mode: 'sandbox' });
      const result = await service.launch(request);

      expect(result).toEqual(expectedRun);
    });
  });

  // =========================================================================
  // cancel()
  // =========================================================================
  describe('cancel', () => {
    it('cancels session and marks run cancelled', async () => {
      const run = makeRun({ status: 'running', runtimeSessionId: 'sess-1' });
      mockRunManager.getRun.mockResolvedValue(run);
      mockProvider.cancelSession.mockResolvedValue({
        ack: { ok: true, sessionState: 'SESSION_STATE_RESOLVED' },
      });
      const cancelledRun = makeRun({ status: 'cancelled' });
      mockRunManager.markCancelled.mockResolvedValue(cancelledRun);

      const result = await service.cancel('run-1', 'user requested');

      expect(mockProvider.cancelSession).toHaveBeenCalledWith({
        runId: 'run-1',
        runtimeSessionId: 'sess-1',
        reason: 'user requested',
        requesterId: 'agent-1',
      });
      expect(mockRunManager.markCancelled).toHaveBeenCalledWith('run-1');
      expect(mockStreamConsumer.stop).toHaveBeenCalledWith('run-1');
      expect(mockStreamHub.complete).toHaveBeenCalledWith('run-1');
      expect(result).toEqual(cancelledRun);
    });

    it('throws BadRequestException when run has no runtime session', async () => {
      const run = makeRun({ runtimeSessionId: undefined });
      mockRunManager.getRun.mockResolvedValue(run);

      await expect(service.cancel('run-1')).rejects.toThrow(BadRequestException);
      await expect(service.cancel('run-1')).rejects.toThrow(
        /run has no bound runtime session/,
      );
    });

    it('uses undefined requesterId when session has no initiator', async () => {
      const run = makeRun({ status: 'running', runtimeSessionId: 'sess-1' });
      mockRunManager.getRun.mockResolvedValue(run);
      mockRuntimeSessionRepository.findByRunId.mockResolvedValue({
        modeName: 'decision',
        initiatorParticipantId: null,
      });
      mockProvider.cancelSession.mockResolvedValue({
        ack: { ok: true, sessionState: 'SESSION_STATE_RESOLVED' },
      });
      mockRunManager.markCancelled.mockResolvedValue(makeRun({ status: 'cancelled' }));

      await service.cancel('run-1');

      expect(mockProvider.cancelSession).toHaveBeenCalledWith(
        expect.objectContaining({ requesterId: undefined }),
      );
    });
  });

  // =========================================================================
  // sendMessage()
  // =========================================================================
  describe('sendMessage', () => {
    const baseSendResult = {
      ack: {
        ok: true,
        duplicate: false,
        messageId: 'msg-1',
        sessionId: 'sess-1',
        acceptedAtUnixMs: Date.now(),
        sessionState: 'SESSION_STATE_OPEN' as const,
      },
      envelope: {
        macpVersion: '1.0',
        mode: 'decision',
        messageType: 'Proposal',
        messageId: 'msg-1',
        sessionId: 'sess-1',
        sender: 'agent-1',
        timestampUnixMs: Date.now(),
        payload: Buffer.alloc(0),
      },
    };

    it('sends a message and returns messageId + ack', async () => {
      mockProvider.send.mockResolvedValue(baseSendResult);

      const result = await service.sendMessage('run-1', {
        from: 'agent-1',
        to: ['agent-2'],
        messageType: 'Proposal',
        payload: { action: 'approve' },
      });

      expect(result.messageId).toBe('msg-1');
      expect(result.ack.ok).toBe(true);
      expect(mockProvider.send).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          runtimeSessionId: 'sess-1',
          modeName: 'decision',
          from: 'agent-1',
          to: ['agent-2'],
          messageType: 'Proposal',
        }),
      );
      expect(mockEventService.emitControlPlaneEvents).toHaveBeenCalled();
    });

    it('throws BadRequestException when run is not ready', async () => {
      mockRunManager.getRun.mockResolvedValue(
        makeRun({ status: 'queued', runtimeSessionId: undefined }),
      );

      await expect(
        service.sendMessage('run-1', {
          from: 'agent-1',
          messageType: 'Proposal',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when run status is not binding_session or running', async () => {
      mockRunManager.getRun.mockResolvedValue(
        makeRun({ status: 'completed', runtimeSessionId: 'sess-1' }),
      );

      await expect(
        service.sendMessage('run-1', {
          from: 'agent-1',
          messageType: 'Proposal',
        }),
      ).rejects.toThrow(/run is not ready to accept session-bound messages/);
    });

    it('throws BadRequestException when run has no mode name', async () => {
      mockRunManager.getRun.mockResolvedValue(
        makeRun({ status: 'running', runtimeSessionId: 'sess-1' }),
      );
      mockRuntimeSessionRepository.findByRunId.mockResolvedValue({
        modeName: null,
        initiatorParticipantId: null,
      });
      // Also ensure executionRequest has no modeName
      mockRunManager.getRun.mockResolvedValue(
        makeRun({
          status: 'running',
          runtimeSessionId: 'sess-1',
          metadata: { executionRequest: undefined },
        }),
      );

      await expect(
        service.sendMessage('run-1', {
          from: 'agent-1',
          messageType: 'Proposal',
        }),
      ).rejects.toThrow(/run does not have a bound mode name/);
    });

    it('throws POLICY_DENIED AppException for policy error', async () => {
      mockProvider.send.mockResolvedValue({
        ...baseSendResult,
        ack: {
          ...baseSendResult.ack,
          ok: false,
          error: { code: 'POLICY_DENIED', message: 'commitment violates rule X' },
        },
      });

      await expect(
        service.sendMessage('run-1', {
          from: 'agent-1',
          messageType: 'Commitment',
        }),
      ).rejects.toThrow(AppException);

      try {
        await service.sendMessage('run-1', {
          from: 'agent-1',
          messageType: 'Commitment',
        });
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        expect((error as AppException).errorCode).toBe(ErrorCode.POLICY_DENIED);
        expect((error as AppException).getStatus()).toBe(403);
      }
    });

    it('throws UNKNOWN_POLICY_VERSION AppException', async () => {
      mockProvider.send.mockResolvedValue({
        ...baseSendResult,
        ack: {
          ...baseSendResult.ack,
          ok: false,
          error: { code: 'UNKNOWN_POLICY_VERSION', message: 'policy v99 not found' },
        },
      });

      try {
        await service.sendMessage('run-1', {
          from: 'agent-1',
          messageType: 'Commitment',
        });
        fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        expect((error as AppException).errorCode).toBe(ErrorCode.UNKNOWN_POLICY_VERSION);
        expect((error as AppException).getStatus()).toBe(400);
      }
    });

    it('throws INVALID_POLICY_DEFINITION AppException', async () => {
      mockProvider.send.mockResolvedValue({
        ...baseSendResult,
        ack: {
          ...baseSendResult.ack,
          ok: false,
          error: { code: 'INVALID_POLICY_DEFINITION', message: 'malformed rules' },
        },
      });

      try {
        await service.sendMessage('run-1', {
          from: 'agent-1',
          messageType: 'Commitment',
        });
        fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        expect((error as AppException).errorCode).toBe(ErrorCode.INVALID_POLICY_DEFINITION);
        expect((error as AppException).getStatus()).toBe(400);
      }
    });

    it('throws SESSION_ALREADY_EXISTS AppException', async () => {
      mockProvider.send.mockResolvedValue({
        ...baseSendResult,
        ack: {
          ...baseSendResult.ack,
          ok: false,
          error: { code: 'SESSION_ALREADY_EXISTS', message: 'duplicate session' },
        },
      });

      try {
        await service.sendMessage('run-1', {
          from: 'agent-1',
          messageType: 'Proposal',
        });
        fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        expect((error as AppException).errorCode).toBe(ErrorCode.SESSION_ALREADY_EXISTS);
        expect((error as AppException).getStatus()).toBe(409);
      }
    });

    it('throws MESSAGE_SEND_FAILED for INVALID_SESSION_ID with 400 status', async () => {
      mockProvider.send.mockResolvedValue({
        ...baseSendResult,
        ack: {
          ...baseSendResult.ack,
          ok: false,
          error: { code: 'INVALID_SESSION_ID', message: 'bad session id' },
        },
      });

      try {
        await service.sendMessage('run-1', {
          from: 'agent-1',
          messageType: 'Proposal',
        });
        fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        expect((error as AppException).errorCode).toBe(ErrorCode.MESSAGE_SEND_FAILED);
        expect((error as AppException).getStatus()).toBe(400);
      }
    });

    it('throws MESSAGE_SEND_FAILED with 502 for unknown error codes', async () => {
      mockProvider.send.mockResolvedValue({
        ...baseSendResult,
        ack: {
          ...baseSendResult.ack,
          ok: false,
          error: { code: 'SOME_OTHER_ERROR', message: 'unexpected' },
        },
      });

      try {
        await service.sendMessage('run-1', {
          from: 'agent-1',
          messageType: 'Proposal',
        });
        fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        expect((error as AppException).errorCode).toBe(ErrorCode.MESSAGE_SEND_FAILED);
        expect((error as AppException).getStatus()).toBe(502);
      }
    });

    it('uses payloadEnvelope when provided', async () => {
      mockProvider.send.mockResolvedValue(baseSendResult);

      await service.sendMessage('run-1', {
        from: 'agent-1',
        messageType: 'Proposal',
        payloadEnvelope: { encoding: 'proto', proto: { typeName: 'Foo', value: {} } },
      });

      expect(mockProtoRegistry.encodePayloadEnvelope).toHaveBeenCalledWith({
        encoding: 'proto',
        proto: { typeName: 'Foo', value: {} },
      });
      expect(mockProvider.send).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: Buffer.from('encoded'),
        }),
      );
    });

    it('accepts messages when run status is binding_session', async () => {
      mockRunManager.getRun.mockResolvedValue(
        makeRun({ status: 'binding_session', runtimeSessionId: 'sess-1' }),
      );
      mockProvider.send.mockResolvedValue(baseSendResult);

      const result = await service.sendMessage('run-1', {
        from: 'agent-1',
        messageType: 'Proposal',
      });

      expect(result.messageId).toBe('msg-1');
    });
  });

  // =========================================================================
  // sendSignal()
  // =========================================================================
  describe('sendSignal', () => {
    const baseSignalResult = {
      ack: {
        ok: true,
        duplicate: false,
        messageId: 'sig-1',
        sessionId: '',
        acceptedAtUnixMs: Date.now(),
        sessionState: 'SESSION_STATE_OPEN' as const,
      },
      envelope: {
        macpVersion: '1.0',
        mode: '',
        messageType: 'Signal',
        messageId: 'sig-1',
        sessionId: '',
        sender: 'agent-1',
        timestampUnixMs: Date.now(),
        payload: Buffer.alloc(0),
      },
    };

    it('sends a signal and returns messageId + ack', async () => {
      mockProvider.send.mockResolvedValue(baseSignalResult);

      const result = await service.sendSignal('run-1', {
        from: 'agent-1',
        to: ['agent-2'],
        messageType: 'HeartbeatSignal',
        payload: { status: 'alive' },
      });

      expect(result.messageId).toBe('sig-1');
      expect(result.ack.ok).toBe(true);
      expect(mockProvider.send).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeSessionId: '',
          modeName: '',
          messageType: 'Signal',
          from: 'agent-1',
          to: ['agent-2'],
        }),
      );
      expect(mockEventService.emitControlPlaneEvents).toHaveBeenCalledWith(
        'run-1',
        expect.arrayContaining([
          expect.objectContaining({
            type: 'message.sent',
            subject: { kind: 'signal', id: 'sig-1' },
          }),
        ]),
      );
    });

    it('throws BadRequestException when run is not in running state', async () => {
      mockRunManager.getRun.mockResolvedValue(
        makeRun({ status: 'binding_session', runtimeSessionId: 'sess-1' }),
      );

      await expect(
        service.sendSignal('run-1', {
          from: 'agent-1',
          to: [],
          messageType: 'Signal',
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.sendSignal('run-1', {
          from: 'agent-1',
          to: [],
          messageType: 'Signal',
        }),
      ).rejects.toThrow(/run is not in running state/);
    });

    it('throws BadRequestException when run has no session', async () => {
      mockRunManager.getRun.mockResolvedValue(
        makeRun({ status: 'running', runtimeSessionId: undefined }),
      );

      await expect(
        service.sendSignal('run-1', {
          from: 'agent-1',
          to: [],
          messageType: 'Signal',
        }),
      ).rejects.toThrow(/run is not in running state/);
    });

    it('throws SIGNAL_DISPATCH_FAILED when runtime rejects signal', async () => {
      mockProvider.send.mockResolvedValue({
        ...baseSignalResult,
        ack: {
          ...baseSignalResult.ack,
          ok: false,
          error: { code: 'INVALID_PAYLOAD', message: 'bad signal payload' },
        },
      });

      try {
        await service.sendSignal('run-1', {
          from: 'agent-1',
          to: [],
          messageType: 'Signal',
          payload: { broken: true },
        });
        fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        expect((error as AppException).errorCode).toBe(ErrorCode.SIGNAL_DISPATCH_FAILED);
        expect((error as AppException).getStatus()).toBe(502);
      }
    });
  });

  // =========================================================================
  // updateContext()
  // =========================================================================
  describe('updateContext', () => {
    const baseContextResult = {
      ack: {
        ok: true,
        duplicate: false,
        messageId: 'ctx-1',
        sessionId: '',
        acceptedAtUnixMs: Date.now(),
        sessionState: 'SESSION_STATE_OPEN' as const,
      },
      envelope: {
        macpVersion: '1.0',
        mode: '',
        messageType: 'ContextUpdate',
        messageId: 'ctx-1',
        sessionId: '',
        sender: 'agent-1',
        timestampUnixMs: Date.now(),
        payload: Buffer.alloc(0),
      },
    };

    it('sends a context update and returns messageId + ack', async () => {
      mockProvider.send.mockResolvedValue(baseContextResult);

      const result = await service.updateContext('run-1', {
        from: 'agent-1',
        context: { key: 'value' },
      });

      expect(result.messageId).toBe('ctx-1');
      expect(result.ack.ok).toBe(true);
      expect(mockProvider.send).toHaveBeenCalledWith(
        expect.objectContaining({
          messageType: 'ContextUpdate',
          from: 'agent-1',
        }),
      );
    });

    it('throws BadRequestException when run is not running', async () => {
      mockRunManager.getRun.mockResolvedValue(
        makeRun({ status: 'completed', runtimeSessionId: 'sess-1' }),
      );

      await expect(
        service.updateContext('run-1', {
          from: 'agent-1',
          context: { key: 'value' },
        }),
      ).rejects.toThrow(/run is not in running state/);
    });

    it('throws CONTEXT_UPDATE_FAILED when runtime rejects context update', async () => {
      mockProvider.send.mockResolvedValue({
        ...baseContextResult,
        ack: {
          ...baseContextResult.ack,
          ok: false,
          error: { code: 'INVALID_PAYLOAD', message: 'bad context' },
        },
      });

      try {
        await service.updateContext('run-1', {
          from: 'agent-1',
          context: { key: 'value' },
        });
        fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        expect((error as AppException).errorCode).toBe(ErrorCode.CONTEXT_UPDATE_FAILED);
      }
    });
  });

  // =========================================================================
  // clone()
  // =========================================================================
  describe('clone', () => {
    it('throws BadRequestException when run has no execution request in metadata', async () => {
      mockRunManager.getRun.mockResolvedValue(
        makeRun({ metadata: {} }),
      );

      await expect(service.clone('run-1')).rejects.toThrow(BadRequestException);
      await expect(service.clone('run-1')).rejects.toThrow(
        /run does not have an execution request in metadata/,
      );
    });

    it('clones run with tag overrides', async () => {
      const originalRequest = makeExecutionRequest();
      mockRunManager.getRun.mockResolvedValue(
        makeRun({ metadata: { executionRequest: originalRequest } }),
      );
      const clonedRun = makeRun({ id: 'run-2', status: 'queued' });
      mockRunManager.createRun.mockResolvedValue(clonedRun);

      // Set up openSession for the background execute()
      const handle: RuntimeSessionHandle = {
        send: jest.fn(),
        events: (async function* () {})(),
        closeWrite: jest.fn(),
        abort: jest.fn(),
        sessionAck: Promise.resolve({
          runtimeSessionId: 'sess-2',
          initiator: 'agent-1',
          ack: {
            ok: true,
            duplicate: false,
            messageId: 'msg-1',
            sessionId: 'sess-2',
            acceptedAtUnixMs: Date.now(),
            sessionState: 'SESSION_STATE_OPEN' as const,
          },
        }),
      };
      mockProvider.openSession.mockReturnValue(handle);

      const result = await service.clone('run-1', { tags: ['cloned', 'test'] });

      expect(result).toEqual(clonedRun);
      expect(mockRunManager.createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          execution: expect.objectContaining({ tags: ['cloned', 'test'] }),
        }),
      );
    });

    it('clones run with context overrides', async () => {
      const originalRequest = makeExecutionRequest();
      mockRunManager.getRun.mockResolvedValue(
        makeRun({ metadata: { executionRequest: originalRequest } }),
      );
      const clonedRun = makeRun({ id: 'run-2', status: 'queued' });
      mockRunManager.createRun.mockResolvedValue(clonedRun);

      const handle: RuntimeSessionHandle = {
        send: jest.fn(),
        events: (async function* () {})(),
        closeWrite: jest.fn(),
        abort: jest.fn(),
        sessionAck: Promise.resolve({
          runtimeSessionId: 'sess-2',
          initiator: 'agent-1',
          ack: {
            ok: true,
            duplicate: false,
            messageId: 'msg-1',
            sessionId: 'sess-2',
            acceptedAtUnixMs: Date.now(),
            sessionState: 'SESSION_STATE_OPEN' as const,
          },
        }),
      };
      mockProvider.openSession.mockReturnValue(handle);

      const result = await service.clone('run-1', {
        context: { newKey: 'newValue' },
      });

      expect(result).toEqual(clonedRun);
      expect(mockRunManager.createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({ context: { newKey: 'newValue' } }),
        }),
      );
    });

    it('clears idempotency key on clone', async () => {
      const originalRequest = makeExecutionRequest({
        execution: { idempotencyKey: 'original-key', tags: ['original'] },
      });
      mockRunManager.getRun.mockResolvedValue(
        makeRun({ metadata: { executionRequest: originalRequest } }),
      );
      mockRunManager.createRun.mockResolvedValue(makeRun({ id: 'run-2' }));

      const handle: RuntimeSessionHandle = {
        send: jest.fn(),
        events: (async function* () {})(),
        closeWrite: jest.fn(),
        abort: jest.fn(),
        sessionAck: Promise.resolve({
          runtimeSessionId: 'sess-2',
          initiator: 'agent-1',
          ack: {
            ok: true,
            duplicate: false,
            messageId: 'msg-1',
            sessionId: 'sess-2',
            acceptedAtUnixMs: Date.now(),
            sessionState: 'SESSION_STATE_OPEN' as const,
          },
        }),
      };
      mockProvider.openSession.mockReturnValue(handle);

      await service.clone('run-1');

      const createRunArg = mockRunManager.createRun.mock.calls[0][0] as ExecutionRequest;
      expect(createRunArg.execution?.idempotencyKey).toBeUndefined();
    });
  });

  // =========================================================================
  // execute() (tested indirectly via launch)
  // =========================================================================
  describe('execute (via launch)', () => {
    it('marks run failed when runtime mode is not supported', async () => {
      mockProvider.initialize.mockResolvedValue({
        selectedProtocolVersion: '1.0',
        runtimeInfo: { name: 'rust-runtime' },
        supportedModes: ['task'],
        capabilities: {},
      });

      const request = makeExecutionRequest(); // modeName = 'decision'
      mockRunManager.createRun.mockResolvedValue(makeRun({ id: 'run-x' }));

      await service.launch(request);

      // Give the async execute() time to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockRunManager.markFailed).toHaveBeenCalledWith(
        'run-x',
        expect.any(AppException),
      );
    });

    it('marks run failed with UNKNOWN_POLICY_VERSION on policy error', async () => {
      mockProvider.openSession.mockReturnValue({
        send: jest.fn(),
        events: (async function* () {})(),
        closeWrite: jest.fn(),
        abort: jest.fn(),
        sessionAck: Promise.reject(new Error('UNKNOWN_POLICY_VERSION: v99 not found')),
      });

      const request = makeExecutionRequest();
      mockRunManager.createRun.mockResolvedValue(makeRun({ id: 'run-p' }));

      await service.launch(request);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockRunManager.markFailed).toHaveBeenCalledWith(
        'run-p',
        expect.objectContaining({
          errorCode: ErrorCode.UNKNOWN_POLICY_VERSION,
        }),
      );
    });

    it('marks run failed with POLICY_DENIED on policy denied error', async () => {
      mockProvider.openSession.mockReturnValue({
        send: jest.fn(),
        events: (async function* () {})(),
        closeWrite: jest.fn(),
        abort: jest.fn(),
        sessionAck: Promise.reject(new Error('POLICY_DENIED: rule X violated')),
      });

      const request = makeExecutionRequest();
      mockRunManager.createRun.mockResolvedValue(makeRun({ id: 'run-pd' }));

      await service.launch(request);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockRunManager.markFailed).toHaveBeenCalledWith(
        'run-pd',
        expect.objectContaining({
          errorCode: ErrorCode.POLICY_DENIED,
        }),
      );
    });

    it('marks run failed with SESSION_ALREADY_EXISTS on duplicate session', async () => {
      mockProvider.openSession.mockReturnValue({
        send: jest.fn(),
        events: (async function* () {})(),
        closeWrite: jest.fn(),
        abort: jest.fn(),
        sessionAck: Promise.reject(new Error('SESSION_ALREADY_EXISTS: duplicate')),
      });

      const request = makeExecutionRequest();
      mockRunManager.createRun.mockResolvedValue(makeRun({ id: 'run-dup' }));

      await service.launch(request);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockRunManager.markFailed).toHaveBeenCalledWith(
        'run-dup',
        expect.objectContaining({
          errorCode: ErrorCode.SESSION_ALREADY_EXISTS,
        }),
      );
    });

    it('marks run failed with INVALID_POLICY_DEFINITION on invalid policy', async () => {
      mockProvider.openSession.mockReturnValue({
        send: jest.fn(),
        events: (async function* () {})(),
        closeWrite: jest.fn(),
        abort: jest.fn(),
        sessionAck: Promise.reject(new Error('INVALID_POLICY_DEFINITION: bad rules')),
      });

      const request = makeExecutionRequest();
      mockRunManager.createRun.mockResolvedValue(makeRun({ id: 'run-ipd' }));

      await service.launch(request);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockRunManager.markFailed).toHaveBeenCalledWith(
        'run-ipd',
        expect.objectContaining({
          errorCode: ErrorCode.INVALID_POLICY_DEFINITION,
        }),
      );
    });

    it('starts stream consumer after successful session open', async () => {
      const handle: RuntimeSessionHandle = {
        send: jest.fn(),
        events: (async function* () {})(),
        closeWrite: jest.fn(),
        abort: jest.fn(),
        sessionAck: Promise.resolve({
          runtimeSessionId: 'sess-ok',
          initiator: 'agent-1',
          ack: {
            ok: true,
            duplicate: false,
            messageId: 'msg-1',
            sessionId: 'sess-ok',
            acceptedAtUnixMs: Date.now(),
            sessionState: 'SESSION_STATE_OPEN' as const,
          },
        }),
      };
      mockProvider.openSession.mockReturnValue(handle);
      mockRunManager.markRunning.mockResolvedValue(makeRun({ traceId: undefined }));

      const request = makeExecutionRequest();
      mockRunManager.createRun.mockResolvedValue(makeRun({ id: 'run-ok' }));

      await service.launch(request);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockRunManager.markStarted).toHaveBeenCalledWith('run-ok', request);
      expect(mockRunManager.bindSession).toHaveBeenCalled();
      expect(mockStreamConsumer.start).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-ok',
          runtimeSessionId: 'sess-ok',
          sessionHandle: handle,
        }),
      );
    });

    it('registers trace artifact when run has traceId', async () => {
      const handle: RuntimeSessionHandle = {
        send: jest.fn(),
        events: (async function* () {})(),
        closeWrite: jest.fn(),
        abort: jest.fn(),
        sessionAck: Promise.resolve({
          runtimeSessionId: 'sess-tr',
          initiator: 'agent-1',
          ack: {
            ok: true,
            duplicate: false,
            messageId: 'msg-1',
            sessionId: 'sess-tr',
            acceptedAtUnixMs: Date.now(),
            sessionState: 'SESSION_STATE_OPEN' as const,
          },
        }),
      };
      mockProvider.openSession.mockReturnValue(handle);
      mockRunManager.markRunning.mockResolvedValue(makeRun({ traceId: 'trace-123' }));

      const request = makeExecutionRequest();
      mockRunManager.createRun.mockResolvedValue(makeRun({ id: 'run-tr' }));

      await service.launch(request);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockArtifactService.register).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-tr',
          kind: 'trace',
          label: 'Root run trace',
          inline: { traceId: 'trace-123' },
        }),
      );
    });
  });
});
