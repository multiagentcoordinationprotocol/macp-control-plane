import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RunDescriptor } from '../contracts/control-plane';
import { ArtifactService } from '../artifacts/artifact.service';
import { AppConfigService } from '../config/app-config.service';
import { RunEventService } from '../events/run-event.service';
import { StreamHubService } from '../events/stream-hub.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { TraceService } from '../telemetry/trace.service';
import { RunRepository } from '../storage/run.repository';
import { RuntimeSessionRepository } from '../storage/runtime-session.repository';
import { RunManagerService } from './run-manager.service';
import { StreamConsumerService } from './stream-consumer.service';

/**
 * Validates a sessionId against the runtime's session validator (UUID v4/v7 or base64url 22+).
 * Mirrors `runtime/src/session.rs:146-177`.
 */
function isValidSessionId(candidate: string): boolean {
  // UUID v4 / v7 pattern (any version 1-7).
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (uuid.test(candidate)) return true;
  // base64url, 22+ chars.
  const base64url = /^[A-Za-z0-9_-]{22,}$/;
  return base64url.test(candidate);
}

/**
 * Observer-mode RunExecutor (direct-agent-auth CP-4).
 *
 * Flow:
 *  1. `launch(descriptor)` — creates the run record, pre-allocates sessionId if omitted,
 *     returns `{runId, sessionId}` immediately.
 *  2. Async `execute()` — initializes the runtime, polls `GetSession(sessionId)` until the
 *     initiator agent opens it, then subscribes to a read-only `StreamSession` and passes
 *     the handle to `StreamConsumerService`.
 *
 * **No `Send` call anywhere.** Agents emit their own envelopes. The control-plane never
 * forges SessionStart, kickoff, messages, signals, or context updates.
 */
@Injectable()
export class RunExecutorService {
  private readonly logger = new Logger(RunExecutorService.name);

  constructor(
    private readonly runManager: RunManagerService,
    private readonly runRepository: RunRepository,
    private readonly runtimeSessionRepository: RuntimeSessionRepository,
    private readonly runtimeRegistry: RuntimeProviderRegistry,
    private readonly traceService: TraceService,
    private readonly eventService: RunEventService,
    private readonly artifactService: ArtifactService,
    private readonly streamConsumer: StreamConsumerService,
    private readonly streamHub: StreamHubService,
    private readonly config: AppConfigService,
    private readonly instrumentation: InstrumentationService
  ) {}

  async validate(request: RunDescriptor) {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!request.session) {
      errors.push('session is required');
      return { valid: false, errors, warnings, runtime: { reachable: false, supportedModes: [] } };
    }

    if (!request.session.participants || request.session.participants.length === 0) {
      errors.push('session.participants must contain at least one participant');
    }

    if (!request.session.modeName) {
      errors.push('session.modeName is required');
    }

    if (request.session.sessionId && !isValidSessionId(request.session.sessionId)) {
      errors.push('session.sessionId must be a UUID v4/v7 or base64url 22+ chars');
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

  /**
   * Allocate a sessionId if the caller didn't provide one, validating when they did.
   * The sessionId is returned to the caller so they can propagate it to agents via bootstrap.
   */
  private resolveSessionId(request: RunDescriptor): string {
    if (request.session.sessionId) {
      if (!isValidSessionId(request.session.sessionId)) {
        throw new BadRequestException(
          'session.sessionId must be a UUID v4/v7 or base64url 22+ chars',
        );
      }
      return request.session.sessionId;
    }
    return randomUUID();
  }

  async launch(request: RunDescriptor): Promise<{ run: Awaited<ReturnType<RunManagerService['createRun']>>; sessionId: string }> {
    const sessionId = this.resolveSessionId(request);
    const requestWithSessionId: RunDescriptor = {
      ...request,
      session: { ...request.session, sessionId }
    };
    const run = await this.runManager.createRun(requestWithSessionId, sessionId);
    void this.execute(run.id, requestWithSessionId, sessionId);
    return { run, sessionId };
  }

  /**
   * UI-initiated cancel.
   *
   * Option A (default): proxy to the initiator agent's `cancelCallback` over HTTP.
   * Option B (scenario opt-in, `metadata.cancellationDelegated: true`): call
   * `provider.cancelSession()` directly with the control-plane's own identity.
   *
   * See direct-agent-auth.md §Cancellation design.
   */
  async cancel(runId: string, reason?: string) {
    const run = await this.runManager.getRun(runId);
    if (!run.runtimeSessionId) {
      throw new BadRequestException('run has no bound runtime session');
    }

    const metadata = (run.metadata ?? {}) as Record<string, unknown>;
    const delegated = Boolean(metadata.cancellationDelegated);
    const cancelCallback = metadata.cancelCallback as { url?: string; bearer?: string } | undefined;

    if (delegated) {
      // Option B: scenario policy delegates cancellation authority to the control-plane.
      const provider = this.runtimeRegistry.get(run.runtimeKind);
      try {
        await provider.cancelSession({
          runId,
          runtimeSessionId: run.runtimeSessionId,
          reason,
        });
      } catch (cancelError) {
        this.logger.warn(
          `cancelSession failed for run ${runId} (proceeding with local cancel): ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
        );
      }
    } else if (cancelCallback?.url) {
      // Option A: proxy UI cancel to the initiator agent's local callback.
      await this.invokeCancelCallback(runId, cancelCallback, reason);
    } else {
      // No callback registered and no policy delegation — fail closed.
      throw new BadRequestException(
        'run has no cancelCallback in metadata and no policy delegation — cannot cancel from control-plane',
      );
    }

    const cancelled = await this.runManager.markCancelled(runId);
    await this.streamConsumer.stop(runId);
    this.streamHub.complete(runId);
    return cancelled;
  }

  private async invokeCancelCallback(
    runId: string,
    callback: { url?: string; bearer?: string },
    reason?: string,
  ): Promise<void> {
    if (!callback.url) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.cancelCallbackTimeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (callback.bearer) headers.authorization = `Bearer ${callback.bearer}`;
      const body = JSON.stringify({ runId, reason: reason ?? null });
      const res = await fetch(callback.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new AppException(
          ErrorCode.INTERNAL_ERROR,
          `cancel callback ${callback.url} returned ${res.status}`,
          502,
        );
      }
    } catch (error) {
      if (error instanceof AppException) throw error;
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        `cancel callback ${callback.url} failed: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async clone(runId: string, overrides?: { tags?: string[] }): Promise<{ run: Awaited<ReturnType<RunManagerService['createRun']>>; sessionId: string }> {
    const run = await this.runManager.getRun(runId);
    const executionRequest = run.metadata?.executionRequest as RunDescriptor | undefined;
    if (!executionRequest) {
      throw new BadRequestException('run does not have an execution request in metadata');
    }

    const cloned: RunDescriptor = { ...executionRequest };
    if (overrides?.tags) {
      cloned.execution = { ...cloned.execution, tags: overrides.tags };
    }
    // Always clear idempotency key + sessionId so clone creates a new run+session.
    if (cloned.execution) {
      delete (cloned.execution as unknown as Record<string, unknown>).idempotencyKey;
    }
    cloned.session = { ...cloned.session, sessionId: undefined };

    return this.launch(cloned);
  }

  /**
   * Observer execute loop. Runs async after POST /runs returns.
   * Never writes envelopes; polls GetSession, then subscribes read-only.
   */
  private async execute(runId: string, request: RunDescriptor, sessionId: string): Promise<void> {
    const provider = this.runtimeRegistry.get(request.runtime.kind);
    const deadlineMs = this.config.runtimeRequestTimeoutMs;
    try {
      await this.runManager.markStarted(runId, request);

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

      // Poll GetSession until the initiator agent opens it, or timeout.
      const snapshot = await this.traceService.withSpan(
        'runtime.await_session_open',
        { run_id: runId, runtime_kind: request.runtime.kind, session_id: sessionId },
        async () => this.pollForOpenSession(provider, runId, sessionId)
      );

      await this.runManager.bindSession(
        runId,
        request,
        {
          runtimeSessionId: sessionId,
          initiator: snapshot.initiator ?? '',
          ack: { sessionState: snapshot.state },
        },
        initResult.capabilities as unknown as Record<string, unknown>,
      );

      // Subscribe read-only — never writes.
      const handle = provider.subscribeSession({ runId, runtimeSessionId: sessionId });

      const run = await this.runManager.markRunning(runId, sessionId);
      const subscriberId = snapshot.initiator ?? '';

      await this.streamConsumer.start({
        runId,
        execution: request,
        runtimeKind: request.runtime.kind,
        runtimeSessionId: sessionId,
        subscriberId,
        sessionHandle: handle,
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
      this.instrumentation.outboundMessagesTotal.inc({ category: 'observer', status: 'subscribed' });
    } catch (error) {
      await this.handleExecuteError(runId, error);
    }
  }

  private async pollForOpenSession(
    provider: ReturnType<RuntimeProviderRegistry['get']>,
    runId: string,
    sessionId: string,
  ) {
    const startedAt = Date.now();
    const base = this.config.sessionPollBaseMs;
    const max = this.config.sessionPollMaxMs;
    const totalTimeout = this.config.sessionPollTimeoutMs;
    let attempt = 0;

    while (Date.now() - startedAt < totalTimeout) {
      try {
        const snapshot = await provider.getSession({ runId, runtimeSessionId: sessionId });
        if (snapshot.state === 'SESSION_STATE_OPEN') return snapshot;
        if (snapshot.state === 'SESSION_STATE_EXPIRED') {
          throw new AppException(
            ErrorCode.SESSION_EXPIRED,
            `session ${sessionId} expired before any agent opened it`,
            400,
          );
        }
      } catch (pollError) {
        if (pollError instanceof AppException) throw pollError;
        // getSession failing with NotFound is normal while the agent hasn't called SessionStart yet.
        this.logger.debug(
          `getSession(${sessionId}) attempt ${attempt + 1}: ${pollError instanceof Error ? pollError.message : String(pollError)}`,
        );
      }
      attempt += 1;
      const delay = Math.min(base * 2 ** (attempt - 1), max);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw new AppException(
      ErrorCode.RUNTIME_TIMEOUT,
      `timed out after ${totalTimeout}ms waiting for initiator agent to open session ${sessionId}`,
      504,
    );
  }

  private async handleExecuteError(runId: string, error: unknown): Promise<void> {
    try {
      if (error instanceof Error) {
        const msg = error.message ?? '';
        if (msg.includes('UNKNOWN_POLICY_VERSION')) {
          await this.runManager.markFailed(
            runId,
            new AppException(ErrorCode.UNKNOWN_POLICY_VERSION, `Unknown policy version: ${msg}`, 400),
          );
          return;
        }
        if (msg.includes('POLICY_DENIED')) {
          await this.runManager.markFailed(
            runId,
            new AppException(ErrorCode.POLICY_DENIED, `Policy denied: ${msg}`, 403),
          );
          return;
        }
        if (msg.includes('INVALID_POLICY_DEFINITION')) {
          await this.runManager.markFailed(
            runId,
            new AppException(ErrorCode.INVALID_POLICY_DEFINITION, `Invalid policy definition: ${msg}`, 400),
          );
          return;
        }
        if (msg.includes('SESSION_ALREADY_EXISTS') || msg.includes('SessionAlreadyExists')) {
          await this.runManager.markFailed(
            runId,
            new AppException(ErrorCode.SESSION_ALREADY_EXISTS, `Session already exists: ${msg}`, 409),
          );
          return;
        }
      }
      await this.runManager.markFailed(runId, error);
    } catch (markFailedError) {
      this.logger.error(
        `failed to mark run ${runId} as failed (run may have been deleted): ${markFailedError instanceof Error ? markFailedError.message : String(markFailedError)}`,
      );
    }
  }
}
