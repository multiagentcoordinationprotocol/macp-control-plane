import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ExecutionRequest, RunStateProjection } from '../contracts/control-plane';
import { AuditService } from '../audit/audit.service';
import { TraceService } from '../telemetry/trace.service';
import { ProjectionService } from '../projection/projection.service';
import { MetricsService } from '../metrics/metrics.service';
import { EventRepository } from '../storage/event.repository';
import { RunEventService } from '../events/run-event.service';
import { RunRepository } from '../storage/run.repository';
import { RuntimeSessionRepository } from '../storage/runtime-session.repository';
import { WebhookService } from '../webhooks/webhook.service';

@Injectable()
export class RunManagerService {
  private readonly logger = new Logger(RunManagerService.name);

  constructor(
    private readonly runRepository: RunRepository,
    private readonly runtimeSessionRepository: RuntimeSessionRepository,
    private readonly projectionService: ProjectionService,
    private readonly runEventService: RunEventService,
    private readonly traceService: TraceService,
    private readonly auditService: AuditService,
    private readonly webhookService: WebhookService,
    private readonly metricsService: MetricsService,
    private readonly eventRepository: EventRepository
  ) {}

  async createRun(request: ExecutionRequest) {
    const idempotencyKey = request.execution?.idempotencyKey;
    if (idempotencyKey) {
      const existing = await this.runRepository.findByIdempotencyKey(idempotencyKey);
      if (existing) return existing;
    }

    const runId = randomUUID();
    const traceId = this.traceService.startRunTrace(runId, {
      runtime_kind: request.runtime.kind,
      mode_name: request.session.modeName,
      execution_mode: request.mode
    });

    // Phase 3.6: Auto-tag sandbox runs
    const tags = [...(request.execution?.tags ?? [])];
    if (request.mode === 'sandbox' && !tags.includes('sandbox')) {
      tags.push('sandbox');
    }

    const record = await this.runRepository.create({
      id: runId,
      status: 'queued',
      mode: request.mode,
      runtimeKind: request.runtime.kind,
      runtimeVersion: request.runtime.version,
      idempotencyKey,
      tags,
      sourceKind: request.session.metadata?.source as string | undefined,
      sourceRef: request.session.metadata?.sourceRef as string | undefined,
      metadata: {
        executionRequest: request,
        requester: request.execution?.requester
      },
      traceId
    });

    await this.runEventService.emitControlPlaneEvents(record.id, [
      {
        ts: new Date().toISOString(),
        type: 'run.created',
        source: { kind: 'control-plane', name: 'run-manager' },
        subject: { kind: 'run', id: record.id },
        trace: { traceId },
        data: {
          status: record.status,
          modeName: request.session.modeName,
          runtimeKind: request.runtime.kind,
          runtimeVersion: request.runtime.version,
          traceId
        }
      }
    ]);

    return record;
  }

  async markStarted(runId: string, request: ExecutionRequest) {
    const run = await this.runRepository.markStarted(runId);
    await this.runEventService.emitControlPlaneEvents(runId, [
      {
        ts: new Date().toISOString(),
        type: 'run.started',
        source: { kind: 'control-plane', name: 'run-manager' },
        subject: { kind: 'run', id: runId },
        trace: run.traceId ? { traceId: run.traceId } : undefined,
        data: {
          status: 'starting',
          startedAt: run.startedAt,
          modeName: request.session.modeName,
          runtimeKind: request.runtime.kind,
          traceId: run.traceId
        }
      }
    ]);
    return run;
  }

  async bindSession(
    runId: string,
    request: ExecutionRequest,
    session: { runtimeSessionId: string; initiator: string; ack: { sessionState: string } },
    capabilities?: Record<string, unknown>
  ) {
    const run = await this.runRepository.update(runId, {
      status: 'binding_session',
      runtimeSessionId: session.runtimeSessionId
    });
    await this.runtimeSessionRepository.upsert({
      runId,
      runtimeKind: request.runtime.kind,
      runtimeSessionId: session.runtimeSessionId,
      modeName: request.session.modeName,
      modeVersion: request.session.modeVersion,
      configurationVersion: request.session.configurationVersion,
      policyVersion: request.session.policyVersion,
      initiatorParticipantId: session.initiator,
      sessionState: session.ack.sessionState,
      lastSeenAt: new Date().toISOString(),
      capabilities: (capabilities ?? {}) as Record<string, unknown>,
      metadata: {
        participants: request.session.participants,
        roots: request.session.roots ?? []
      }
    });

    const participantEvents = request.session.participants.map((participant) => ({
      ts: new Date().toISOString(),
      type: 'participant.seen' as const,
      source: { kind: 'control-plane' as const, name: 'run-manager' },
      subject: { kind: 'participant' as const, id: participant.id },
      data: {
        participantId: participant.id,
        role: participant.role,
        transportIdentity: participant.transportIdentity,
        status: 'idle'
      }
    }));

    await this.runEventService.emitControlPlaneEvents(runId, [
      {
        ts: new Date().toISOString(),
        type: 'session.bound',
        source: { kind: 'control-plane', name: 'run-manager' },
        subject: { kind: 'session', id: session.runtimeSessionId },
        data: {
          sessionId: session.runtimeSessionId,
          initiator: session.initiator,
          state: session.ack.sessionState,
          modeName: request.session.modeName,
          modeVersion: request.session.modeVersion,
          configurationVersion: request.session.configurationVersion,
          policyVersion: request.session.policyVersion,
          participants: request.session.participants.map((item) => item.id)
        }
      },
      ...participantEvents
    ]);

    return run;
  }

  async markRunning(runId: string, runtimeSessionId: string) {
    const run = await this.runRepository.markRunning(runId, runtimeSessionId);
    await this.runEventService.emitControlPlaneEvents(runId, [
      {
        ts: new Date().toISOString(),
        type: 'session.state.changed',
        source: { kind: 'control-plane', name: 'run-manager' },
        subject: { kind: 'session', id: runtimeSessionId },
        trace: run.traceId ? { traceId: run.traceId } : undefined,
        data: {
          sessionId: runtimeSessionId,
          state: 'SESSION_STATE_OPEN'
        }
      }
    ]);
    void this.webhookService.fireEvent({
      event: 'run.started',
      runId,
      status: 'running',
      timestamp: new Date().toISOString()
    });
    return run;
  }

  async markCompleted(runId: string) {
    const current = await this.getRun(runId);
    if (current.status === 'completed') return current;
    const run = await this.runRepository.markCompleted(runId);
    this.traceService.endRunTrace(runId, 'completed');
    await this.runEventService.emitControlPlaneEvents(runId, [
      {
        ts: new Date().toISOString(),
        type: 'run.completed',
        source: { kind: 'control-plane', name: 'run-manager' },
        subject: { kind: 'run', id: runId },
        trace: run.traceId ? { traceId: run.traceId } : undefined,
        data: {
          status: 'completed',
          endedAt: run.endedAt,
          runtimeSessionId: run.runtimeSessionId,
          traceId: run.traceId
        }
      }
    ]);
    void this.webhookService.fireEvent({
      event: 'run.completed',
      runId,
      status: 'completed',
      timestamp: new Date().toISOString()
    });
    void this.enrichRunMetadata(runId, run);
    return run;
  }

  async markCancelled(runId: string) {
    const current = await this.getRun(runId);
    if (current.status === 'cancelled') return current;
    const run = await this.runRepository.markCancelled(runId);
    this.traceService.endRunTrace(runId, 'cancelled');
    await this.runEventService.emitControlPlaneEvents(runId, [
      {
        ts: new Date().toISOString(),
        type: 'run.cancelled',
        source: { kind: 'control-plane', name: 'run-manager' },
        subject: { kind: 'run', id: runId },
        trace: run.traceId ? { traceId: run.traceId } : undefined,
        data: {
          status: 'cancelled',
          endedAt: run.endedAt,
          runtimeSessionId: run.runtimeSessionId,
          traceId: run.traceId
        }
      }
    ]);
    void this.webhookService.fireEvent({
      event: 'run.cancelled',
      runId,
      status: 'cancelled',
      timestamp: new Date().toISOString()
    });
    return run;
  }

  async markFailed(runId: string, error: unknown) {
    const current = await this.getRun(runId);
    if (current.status === 'failed') return current;
    const message = error instanceof Error ? error.message : String(error);
    const run = await this.runRepository.markFailed(runId, 'RUN_FAILED', message);
    this.traceService.endRunTrace(runId, 'failed', message);
    await this.runEventService.emitControlPlaneEvents(runId, [
      {
        ts: new Date().toISOString(),
        type: 'run.failed',
        source: { kind: 'control-plane', name: 'run-manager' },
        subject: { kind: 'run', id: runId },
        trace: run.traceId ? { traceId: run.traceId } : undefined,
        data: {
          status: 'failed',
          endedAt: run.endedAt,
          runtimeSessionId: run.runtimeSessionId,
          traceId: run.traceId,
          error: message
        }
      }
    ]);
    void this.webhookService.fireEvent({
      event: 'run.failed',
      runId,
      status: 'failed',
      timestamp: new Date().toISOString(),
      data: { error: message }
    });
    void this.enrichRunMetadata(runId, run);
    return run;
  }

  async listRuns(filters: {
    status?: import('../contracts/control-plane').RunStatus;
    tags?: string[];
    createdAfter?: string;
    createdBefore?: string;
    limit?: number;
    offset?: number;
    sortBy?: 'createdAt' | 'updatedAt';
    sortOrder?: 'asc' | 'desc';
    includeArchived?: boolean;
    environment?: string;
    scenarioRef?: string;
    search?: string;
  }) {
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;
    const [data, total] = await Promise.all([
      this.runRepository.list(filters),
      this.runRepository.listCount({
        status: filters.status,
        tags: filters.tags,
        createdAfter: filters.createdAfter,
        createdBefore: filters.createdBefore,
        includeArchived: filters.includeArchived,
        environment: filters.environment,
        scenarioRef: filters.scenarioRef,
        search: filters.search,
      }),
    ]);
    return { data, total, limit, offset };
  }

  async deleteRun(runId: string) {
    const run = await this.getRun(runId);
    const terminalStatuses = ['completed', 'failed', 'cancelled'];
    if (!terminalStatuses.includes(run.status)) {
      throw new BadRequestException('only terminal runs (completed, failed, cancelled) can be deleted');
    }
    await this.auditService.record({
      actor: 'control-plane',
      actorType: 'system',
      action: 'run.deleted',
      resource: 'run',
      resourceId: runId
    });
    await this.runRepository.delete(runId);
  }

  async archiveRun(runId: string) {
    await this.getRun(runId);
    await this.auditService.record({
      actor: 'control-plane',
      actorType: 'system',
      action: 'run.archived',
      resource: 'run',
      resourceId: runId
    });
    return this.runRepository.archive(runId);
  }

  async getRun(runId: string) {
    const run = await this.runRepository.findById(runId);
    if (!run) throw new NotFoundException(`run ${runId} not found`);
    return run;
  }

  async getState(runId: string): Promise<RunStateProjection> {
    await this.getRun(runId);
    return (await this.projectionService.get(runId)) ?? this.projectionService.empty(runId);
  }

  private async enrichRunMetadata(
    runId: string,
    run: { startedAt?: string | null; endedAt?: string | null; metadata?: Record<string, unknown> | null }
  ) {
    try {
      const [metrics, events] = await Promise.all([
        this.metricsService.get(runId),
        this.eventRepository.listCanonicalByRun(runId, 0, 2000)
      ]);

      const decisionEvent = [...events].reverse().find((e) => e.type === 'decision.finalized');
      const decisionData = decisionEvent?.data as Record<string, unknown> | undefined;
      const decodedPayload = decisionData?.decodedPayload as Record<string, unknown> | undefined;

      const durationMs =
        run.startedAt && run.endedAt
          ? new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()
          : metrics?.durationMs ?? undefined;

      const enrichment: Record<string, unknown> = {};
      if (durationMs !== undefined) enrichment.durationMs = durationMs;
      if (metrics?.eventCount) enrichment.eventCount = metrics.eventCount;
      if (metrics?.signalCount) enrichment.signalCount = metrics.signalCount;
      if (metrics?.decisionCount) enrichment.decisionCount = metrics.decisionCount;
      if (decodedPayload?.action) enrichment.finalAction = String(decodedPayload.action);
      if (decodedPayload?.confidence != null) enrichment.finalConfidence = Number(decodedPayload.confidence);

      if (Object.keys(enrichment).length > 0) {
        await this.runRepository.update(runId, {
          metadata: { ...(run.metadata ?? {}), ...enrichment }
        });
      }
    } catch (err) {
      this.logger.warn(`Failed to enrich metadata for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
