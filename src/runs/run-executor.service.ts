import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ExecutionRequest, RunMessageInput } from '../contracts/control-plane';
import { ArtifactService } from '../artifacts/artifact.service';
import { AppConfigService } from '../config/app-config.service';
import { RunEventService } from '../events/run-event.service';
import { StreamHubService } from '../events/stream-hub.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { ProtoRegistryService } from '../runtime/proto-registry.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { TraceService } from '../telemetry/trace.service';
import { RunRepository } from '../storage/run.repository';
import { RuntimeSessionRepository } from '../storage/runtime-session.repository';
import { RunManagerService } from './run-manager.service';
import { StreamConsumerService } from './stream-consumer.service';

@Injectable()
export class RunExecutorService {
  private readonly logger = new Logger(RunExecutorService.name);

  constructor(
    private readonly runManager: RunManagerService,
    private readonly runRepository: RunRepository,
    private readonly runtimeSessionRepository: RuntimeSessionRepository,
    private readonly runtimeRegistry: RuntimeProviderRegistry,
    private readonly protoRegistry: ProtoRegistryService,
    private readonly traceService: TraceService,
    private readonly eventService: RunEventService,
    private readonly artifactService: ArtifactService,
    private readonly streamConsumer: StreamConsumerService,
    private readonly streamHub: StreamHubService,
    private readonly config: AppConfigService
  ) {}

  async validate(request: ExecutionRequest) {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!request.session.participants || request.session.participants.length === 0) {
      errors.push('session.participants must contain at least one participant');
    }

    if (!request.session.modeName) {
      errors.push('session.modeName is required');
    }

    if (request.kickoff) {
      for (const msg of request.kickoff) {
        if (!msg.messageType) {
          errors.push('kickoff message is missing messageType');
        }
        if (!msg.from) {
          errors.push('kickoff message is missing from');
        }
      }
    }

    let runtimeInfo: { reachable: boolean; supportedModes: string[]; capabilities?: unknown } = {
      reachable: false,
      supportedModes: []
    };

    try {
      const provider = this.runtimeRegistry.get(request.runtime.kind);
      const deadlineMs = this.config.runtimeRequestTimeoutMs;
      const initResult = await provider.initialize(
        { clientName: 'macp-control-plane', clientVersion: this.config.clientVersion },
        { deadline: new Date(Date.now() + deadlineMs) }
      );
      runtimeInfo = {
        reachable: true,
        supportedModes: initResult.supportedModes,
        capabilities: initResult.capabilities
      };

      if (
        initResult.supportedModes.length > 0 &&
        !initResult.supportedModes.includes(request.session.modeName)
      ) {
        errors.push(
          `Runtime does not support mode '${request.session.modeName}'. Supported: ${initResult.supportedModes.join(', ')}`
        );
      }
    } catch (error) {
      warnings.push(`Runtime not reachable: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      runtime: runtimeInfo
    };
  }

  async launch(request: ExecutionRequest) {
    if (request.mode === 'replay') {
      throw new BadRequestException('Use /runs/:id/replay for replay mode. POST /runs launches live or sandbox executions.');
    }

    const run = await this.runManager.createRun(request);
    void this.execute(run.id, request);
    return run;
  }

  async cancel(runId: string, reason?: string) {
    const run = await this.runManager.getRun(runId);
    if (!run.runtimeSessionId) {
      throw new BadRequestException('run has no bound runtime session');
    }
    const provider = this.runtimeRegistry.get(run.runtimeKind);
    const session = await this.runtimeSessionRepository.findByRunId(runId);
    const requesterId = session?.initiatorParticipantId ?? undefined;
    await provider.cancelSession({
      runId,
      runtimeSessionId: run.runtimeSessionId,
      reason,
      requesterId
    });
    const cancelled = await this.runManager.markCancelled(runId);
    await this.streamConsumer.stop(runId);
    this.streamHub.complete(runId);
    return cancelled;
  }

  async sendMessage(runId: string, params: RunMessageInput) {
    const run = await this.runManager.getRun(runId);
    if (!run.runtimeSessionId || !['binding_session', 'running'].includes(run.status)) {
      throw new BadRequestException('run is not ready to accept session-bound messages');
    }

    const executionRequest = run.metadata?.executionRequest as ExecutionRequest | undefined;
    const runtimeSession = await this.runtimeSessionRepository.findByRunId(runId);
    const modeName = runtimeSession?.modeName ?? executionRequest?.session?.modeName;
    if (!modeName) {
      throw new BadRequestException('run does not have a bound mode name');
    }

    const provider = this.runtimeRegistry.get(run.runtimeKind);
    const payload = params.payloadEnvelope
      ? this.protoRegistry.encodePayloadEnvelope(params.payloadEnvelope)
      : Buffer.from(JSON.stringify(params.payload ?? {}), 'utf8');

    const sendResult = await provider.send({
      runId,
      runtimeSessionId: run.runtimeSessionId,
      modeName,
      from: params.from,
      to: params.to ?? [],
      messageType: params.messageType,
      payload,
      payloadDescriptor: (params.payloadEnvelope as unknown as Record<string, unknown>) ?? params.payload ?? {},
      metadata: params.metadata
    });

    if (!sendResult.ack.ok && sendResult.ack.error) {
      const errorCode = sendResult.ack.error.code;

      // Map runtime policy errors to specific error codes
      if (errorCode === 'POLICY_DENIED') {
        throw new AppException(
          ErrorCode.POLICY_DENIED,
          `Policy denied commitment: ${sendResult.ack.error.message}`,
          403
        );
      }
      if (errorCode === 'UNKNOWN_POLICY_VERSION') {
        throw new AppException(
          ErrorCode.UNKNOWN_POLICY_VERSION,
          `Unknown policy version: ${sendResult.ack.error.message}`,
          400
        );
      }
      if (errorCode === 'INVALID_POLICY_DEFINITION') {
        throw new AppException(
          ErrorCode.INVALID_POLICY_DEFINITION,
          `Invalid policy definition: ${sendResult.ack.error.message}`,
          400
        );
      }
      if (errorCode === 'SESSION_ALREADY_EXISTS') {
        throw new AppException(
          ErrorCode.SESSION_ALREADY_EXISTS,
          `Session already exists: ${sendResult.ack.error.message}`,
          409
        );
      }

      throw new AppException(
        ErrorCode.MESSAGE_SEND_FAILED,
        `Runtime rejected message: [${errorCode}] ${sendResult.ack.error.message}`,
        errorCode === 'INVALID_SESSION_ID' ? 400 : 502
      );
    }

    await this.eventService.emitControlPlaneEvents(runId, [
      {
        ts: new Date().toISOString(),
        type: 'message.sent',
        source: { kind: 'control-plane', name: 'run-executor' },
        subject: { kind: 'message', id: sendResult.envelope.messageId },
        data: {
          sessionId: run.runtimeSessionId,
          sender: params.from,
          to: params.to ?? [],
          messageType: params.messageType,
          ack: sendResult.ack,
          payloadDescriptor: (params.payloadEnvelope as unknown as Record<string, unknown>) ?? params.payload ?? {},
          metadata: params.metadata ?? {}
        }
      }
    ]);

    return { messageId: sendResult.envelope.messageId, ack: sendResult.ack };
  }

  async sendSignal(runId: string, params: {
    from: string;
    to: string[];
    messageType: string;
    payload?: Record<string, unknown>;
  }) {
    const run = await this.runManager.getRun(runId);
    if (!run.runtimeSessionId || run.status !== 'running') {
      throw new BadRequestException('run is not in running state');
    }
    const provider = this.runtimeRegistry.get(run.runtimeKind);

    // Runtime requires empty session_id and mode for Signal messages
    const sendResult = await provider.send({
      runId,
      runtimeSessionId: '',
      modeName: '',
      from: params.from,
      to: params.to,
      messageType: 'Signal',
      payload: Buffer.from(JSON.stringify(params.payload ?? {}), 'utf8'),
      payloadDescriptor: params.payload
    });

    // Check ack for errors
    if (!sendResult.ack.ok && sendResult.ack.error) {
      throw new AppException(
        ErrorCode.SIGNAL_DISPATCH_FAILED,
        `Runtime rejected signal: [${sendResult.ack.error.code}] ${sendResult.ack.error.message}`,
        502
      );
    }

    await this.eventService.emitControlPlaneEvents(runId, [
      {
        ts: new Date().toISOString(),
        type: 'message.sent',
        source: { kind: 'control-plane', name: 'run-executor' },
        subject: { kind: 'signal', id: sendResult.envelope.messageId },
        data: {
          sessionId: run.runtimeSessionId,
          sender: params.from,
          to: params.to,
          messageType: params.messageType,
          ack: sendResult.ack,
          payloadDescriptor: params.payload ?? {}
        }
      }
    ]);

    return { messageId: sendResult.envelope.messageId, ack: sendResult.ack };
  }

  async updateContext(runId: string, dto: { from: string; context: Record<string, unknown> }) {
    const run = await this.runManager.getRun(runId);
    if (!run.runtimeSessionId || run.status !== 'running') {
      throw new BadRequestException('run is not in running state');
    }
    const provider = this.runtimeRegistry.get(run.runtimeKind);

    const sendResult = await provider.send({
      runId,
      runtimeSessionId: '',
      modeName: '',
      from: dto.from,
      to: [],
      messageType: 'ContextUpdate',
      payload: Buffer.from(JSON.stringify(dto.context), 'utf8'),
      payloadDescriptor: dto.context
    });

    if (!sendResult.ack.ok && sendResult.ack.error) {
      throw new AppException(
        ErrorCode.CONTEXT_UPDATE_FAILED,
        `Runtime rejected context update: [${sendResult.ack.error.code}] ${sendResult.ack.error.message}`,
        502
      );
    }

    await this.eventService.emitControlPlaneEvents(runId, [
      {
        ts: new Date().toISOString(),
        type: 'message.sent',
        source: { kind: 'control-plane', name: 'run-executor' },
        subject: { kind: 'message', id: sendResult.envelope.messageId },
        data: {
          sessionId: run.runtimeSessionId,
          sender: dto.from,
          to: [],
          messageType: 'ContextUpdate',
          ack: sendResult.ack,
          payloadDescriptor: dto.context
        }
      }
    ]);

    return { messageId: sendResult.envelope.messageId, ack: sendResult.ack };
  }

  async clone(runId: string, overrides?: { tags?: string[]; context?: Record<string, unknown> }) {
    const run = await this.runManager.getRun(runId);
    const executionRequest = run.metadata?.executionRequest as ExecutionRequest | undefined;
    if (!executionRequest) {
      throw new BadRequestException('run does not have an execution request in metadata');
    }

    const cloned = { ...executionRequest };
    if (overrides?.tags) {
      cloned.execution = { ...cloned.execution, tags: overrides.tags };
    }
    if (overrides?.context) {
      cloned.session = { ...cloned.session, context: overrides.context };
    }
    // Clear idempotency key so clone creates a new run
    if (cloned.execution) {
      delete (cloned.execution as unknown as Record<string, unknown>).idempotencyKey;
    }

    return this.launch(cloned);
  }

  private async execute(runId: string, request: ExecutionRequest): Promise<void> {
    const provider = this.runtimeRegistry.get(request.runtime.kind);
    const deadlineMs = this.config.runtimeRequestTimeoutMs;
    try {
      await this.runManager.markStarted(runId, request);

      // Mode validation via Initialize
      const initResult = await this.traceService.withSpan(
        'runtime.initialize',
        {
          run_id: runId,
          runtime_kind: request.runtime.kind,
          mode_name: request.session.modeName
        },
        async () => {
          return provider.initialize(
            { clientName: 'macp-control-plane', clientVersion: this.config.clientVersion },
            { deadline: new Date(Date.now() + deadlineMs) }
          );
        }
      );

      if (initResult.instructions) {
        this.logger.log(`runtime instructions: ${initResult.instructions}`);
      }

      if (
        initResult.supportedModes.length > 0 &&
        !initResult.supportedModes.includes(request.session.modeName)
      ) {
        throw new AppException(
          ErrorCode.MODE_NOT_SUPPORTED,
          `Runtime does not support mode '${request.session.modeName}'. Supported: ${initResult.supportedModes.join(', ')}`,
          400
        );
      }

      // Open unified bidirectional session stream
      const handle = provider.openSession({ runId, execution: request });

      // Wait for SessionStart confirmation
      const session = await this.traceService.withSpan(
        'runtime.open_session',
        {
          run_id: runId,
          runtime_kind: request.runtime.kind,
          mode_name: request.session.modeName
        },
        async () => handle.sessionAck
      );

      await this.runManager.bindSession(runId, request, session, initResult.capabilities as unknown as Record<string, unknown>);

      // Send kickoff messages through the bidirectional stream
      for (const message of request.kickoff ?? []) {
        try {
          const payload = message.payloadEnvelope
            ? this.protoRegistry.encodePayloadEnvelope(message.payloadEnvelope)
            : Buffer.from(JSON.stringify(message.payload ?? {}), 'utf8');

          const kickoffEnvelope = {
            macpVersion: '1.0',
            mode: request.session.modeName,
            messageType: message.messageType,
            messageId: randomUUID(),
            sessionId: session.runtimeSessionId,
            sender: message.from,
            timestampUnixMs: Date.now(),
            payload
          };

          // Retry kickoff send through the stream handle
          await this.retryKickoff(async () => {
            handle.send(kickoffEnvelope);
            return {
              ack: {
                ok: true,
                duplicate: false,
                messageId: kickoffEnvelope.messageId,
                sessionId: session.runtimeSessionId,
                acceptedAtUnixMs: Date.now(),
                sessionState: 'SESSION_STATE_OPEN' as const
              },
              envelope: kickoffEnvelope
            };
          });

          await this.eventService.emitControlPlaneEvents(runId, [
            {
              ts: new Date().toISOString(),
              type: 'message.sent',
              source: { kind: 'control-plane', name: 'run-executor' },
              subject: { kind: 'message', id: kickoffEnvelope.messageId },
              data: {
                sessionId: session.runtimeSessionId,
                sender: message.from,
                to: message.to,
                messageType: message.messageType,
                kind: message.kind,
                ack: {
                  ok: true,
                  duplicate: false,
                  messageId: kickoffEnvelope.messageId,
                  sessionId: session.runtimeSessionId,
                  acceptedAtUnixMs: Date.now(),
                  sessionState: 'SESSION_STATE_OPEN'
                },
                payloadDescriptor: (message.payloadEnvelope as unknown as Record<string, unknown>) ?? message.payload ?? {}
              }
            }
          ]);
        } catch (kickoffError) {
          this.logger.error(
            `kickoff message failed for run ${runId}, messageType=${message.messageType}: ${kickoffError instanceof Error ? kickoffError.message : String(kickoffError)}`
          );
          await this.eventService.emitControlPlaneEvents(runId, [
            {
              ts: new Date().toISOString(),
              type: 'message.send_failed',
              source: { kind: 'control-plane', name: 'run-executor' },
              subject: { kind: 'message', id: message.messageType },
              data: {
                sessionId: session.runtimeSessionId,
                sender: message.from,
                to: message.to,
                messageType: message.messageType,
                error: kickoffError instanceof Error ? kickoffError.message : String(kickoffError)
              }
            }
          ]);
          handle.abort();
          await this.runManager.markFailed(runId, kickoffError);
          return;
        }
      }

      // Half-close the write side — kickoff phase done
      handle.closeWrite();

      const run = await this.runManager.markRunning(runId, session.runtimeSessionId);
      const subscriberId = session.initiator;

      // Pass the session handle to the stream consumer
      await this.streamConsumer.start({
        runId,
        execution: request,
        runtimeKind: request.runtime.kind,
        runtimeSessionId: session.runtimeSessionId,
        subscriberId,
        sessionHandle: handle
      });

      if (run.traceId) {
        const artifact = await this.artifactService.register({
          runId,
          kind: 'trace',
          label: 'Root run trace',
          inline: { traceId: run.traceId }
        });
        await this.eventService.emitControlPlaneEvents(runId, [
          {
            ts: new Date().toISOString(),
            type: 'artifact.created',
            source: { kind: 'control-plane', name: 'run-executor' },
            subject: { kind: 'artifact', id: artifact.id },
            trace: { traceId: run.traceId },
            data: {
              kind: artifact.kind,
              label: artifact.label,
              traceId: run.traceId,
              artifactId: artifact.id
            }
          }
        ]);
      }
    } catch (error) {
      // Surface policy-specific errors with appropriate error codes
      if (error instanceof Error) {
        const msg = error.message ?? '';
        if (msg.includes('UNKNOWN_POLICY_VERSION')) {
          await this.runManager.markFailed(
            runId,
            new AppException(ErrorCode.UNKNOWN_POLICY_VERSION, `Unknown policy version: ${msg}`, 400)
          );
          return;
        }
        if (msg.includes('POLICY_DENIED')) {
          await this.runManager.markFailed(
            runId,
            new AppException(ErrorCode.POLICY_DENIED, `Policy denied: ${msg}`, 403)
          );
          return;
        }
        if (msg.includes('INVALID_POLICY_DEFINITION')) {
          await this.runManager.markFailed(
            runId,
            new AppException(ErrorCode.INVALID_POLICY_DEFINITION, `Invalid policy definition: ${msg}`, 400)
          );
          return;
        }
        if (msg.includes('SESSION_ALREADY_EXISTS') || msg.includes('SessionAlreadyExists')) {
          await this.runManager.markFailed(
            runId,
            new AppException(ErrorCode.SESSION_ALREADY_EXISTS, `Session already exists: ${msg}`, 409)
          );
          return;
        }
      }
      await this.runManager.markFailed(runId, error);
    }
  }

  private async retryKickoff<T>(fn: () => Promise<T>): Promise<T> {
    const maxRetries = this.config.kickoffMaxRetries;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          const backoffMs = Math.min(250 * 2 ** attempt, 5000);
          const jitter = Math.random() * backoffMs * 0.2;
          this.logger.warn(`kickoff attempt ${attempt + 1} failed, retrying in ${Math.round(backoffMs + jitter)}ms`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs + jitter));
        }
      }
    }
    throw lastError;
  }
}
