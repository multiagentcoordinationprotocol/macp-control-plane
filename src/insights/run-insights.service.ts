import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CanonicalEvent,
  MetricsSummary,
  Run,
  RunComparisonResult,
  RunExportBundle,
  RunStatus
} from '../contracts/control-plane';
import { ProjectionService } from '../projection/projection.service';
import { ArtifactRepository } from '../storage/artifact.repository';
import { EventRepository } from '../storage/event.repository';
import { MetricsRepository } from '../storage/metrics.repository';
import { RunRepository } from '../storage/run.repository';
import { RuntimeSessionRepository } from '../storage/runtime-session.repository';

@Injectable()
export class RunInsightsService {
  constructor(
    private readonly runRepository: RunRepository,
    private readonly runtimeSessionRepository: RuntimeSessionRepository,
    private readonly projectionService: ProjectionService,
    private readonly eventRepository: EventRepository,
    private readonly metricsRepository: MetricsRepository,
    private readonly artifactRepository: ArtifactRepository
  ) {}

  async exportRun(
    runId: string,
    options: { includeCanonical?: boolean; includeRaw?: boolean; eventLimit?: number }
  ): Promise<RunExportBundle> {
    const run = await this.runRepository.findById(runId);
    if (!run) throw new NotFoundException(`run ${runId} not found`);

    const includeCanonical = options.includeCanonical !== false;
    const includeRaw = options.includeRaw === true;
    const eventLimit = options.eventLimit ?? 10000;

    const [session, projection, metrics, artifacts, canonicalEvents, rawEvents] = await Promise.all([
      this.runtimeSessionRepository.findByRunId(runId),
      this.projectionService.get(runId),
      this.metricsRepository.get(runId),
      this.artifactRepository.listByRunId(runId),
      includeCanonical ? this.eventRepository.listCanonicalByRun(runId, 0, eventLimit) : Promise.resolve([]),
      includeRaw ? this.eventRepository.listRawByRun(runId, 0, eventLimit) : Promise.resolve([])
    ]);

    return {
      run: this.toRun(run),
      session: session as Record<string, unknown> | null,
      projection,
      metrics: metrics
        ? ({
            runId: metrics.runId,
            eventCount: metrics.eventCount,
            messageCount: metrics.messageCount,
            signalCount: metrics.signalCount,
            proposalCount: metrics.proposalCount,
            toolCallCount: metrics.toolCallCount,
            decisionCount: metrics.decisionCount,
            streamReconnectCount: metrics.streamReconnectCount,
            promptTokens: Number(metrics.promptTokens ?? 0),
            completionTokens: Number(metrics.completionTokens ?? 0),
            totalTokens: Number(metrics.totalTokens ?? 0),
            estimatedCostUsd: Number(metrics.estimatedCostUsd ?? 0),
            firstEventAt: metrics.firstEventAt ?? undefined,
            lastEventAt: metrics.lastEventAt ?? undefined,
            durationMs: metrics.durationMs ?? undefined,
            sessionState: (metrics.sessionState as MetricsSummary['sessionState']) ?? undefined
          } satisfies MetricsSummary)
        : null,
      artifacts: artifacts.map((a) => ({
        id: a.id,
        runId: a.runId,
        kind: a.kind as Run['source'] extends undefined ? never : 'trace' | 'json' | 'report' | 'log' | 'bundle',
        label: a.label,
        uri: a.uri ?? undefined,
        inline: a.inline ?? undefined,
        createdAt: a.createdAt
      })),
      canonicalEvents: canonicalEvents as unknown as CanonicalEvent[],
      rawEvents: rawEvents as unknown as Record<string, unknown>[],
      exportedAt: new Date().toISOString()
    };
  }

  async exportRunJsonl(
    runId: string,
    options: { includeCanonical?: boolean; includeRaw?: boolean; eventLimit?: number }
  ): Promise<string> {
    const bundle = await this.exportRun(runId, options);
    const lines: string[] = [];

    lines.push(
      JSON.stringify({
        type: 'header',
        run: bundle.run,
        session: bundle.session,
        projection: bundle.projection,
        metrics: bundle.metrics,
        artifacts: bundle.artifacts,
        exportedAt: bundle.exportedAt
      })
    );

    for (const event of bundle.canonicalEvents) {
      lines.push(JSON.stringify({ ...event, type: 'canonical_event' }));
    }

    for (const event of bundle.rawEvents) {
      lines.push(JSON.stringify({ ...event, type: 'raw_event' }));
    }

    return lines.join('\n') + '\n';
  }

  async *exportRunStream(runId: string, options: { includeRaw?: boolean }): AsyncGenerator<string> {
    const run = await this.runRepository.findById(runId);
    if (!run) throw new NotFoundException(`run ${runId} not found`);

    const [session, projection, metrics, artifacts] = await Promise.all([
      this.runtimeSessionRepository.findByRunId(runId),
      this.projectionService.get(runId),
      this.metricsRepository.get(runId),
      this.artifactRepository.listByRunId(runId)
    ]);

    // Emit header line
    yield JSON.stringify({
      type: 'header',
      run: this.toRun(run),
      session: session as Record<string, unknown> | null,
      projection,
      metrics: metrics
        ? {
            runId: metrics.runId,
            eventCount: metrics.eventCount,
            messageCount: metrics.messageCount,
            signalCount: metrics.signalCount,
            proposalCount: metrics.proposalCount,
            toolCallCount: metrics.toolCallCount,
            decisionCount: metrics.decisionCount,
            streamReconnectCount: metrics.streamReconnectCount,
            promptTokens: Number(metrics.promptTokens ?? 0),
            completionTokens: Number(metrics.completionTokens ?? 0),
            totalTokens: Number(metrics.totalTokens ?? 0),
            estimatedCostUsd: Number(metrics.estimatedCostUsd ?? 0),
            firstEventAt: metrics.firstEventAt ?? undefined,
            lastEventAt: metrics.lastEventAt ?? undefined,
            durationMs: metrics.durationMs ?? undefined,
            sessionState: (metrics.sessionState as MetricsSummary['sessionState']) ?? undefined
          }
        : null,
      artifacts: artifacts.map((a) => ({
        id: a.id,
        runId: a.runId,
        kind: a.kind,
        label: a.label,
        uri: a.uri ?? undefined,
        inline: a.inline ?? undefined,
        createdAt: a.createdAt
      })),
      exportedAt: new Date().toISOString()
    }) + '\n';

    // Stream canonical events
    for await (const event of this.eventRepository.streamCanonicalByRun(runId)) {
      yield JSON.stringify({ ...event, type: 'canonical_event' }) + '\n';
    }

    // Stream raw events if requested
    if (options.includeRaw) {
      const rawEvents = await this.eventRepository.listRawByRun(runId, 0, 100000);
      for (const event of rawEvents) {
        yield JSON.stringify({ ...event, type: 'raw_event' }) + '\n';
      }
    }
  }

  async compareRuns(leftRunId: string, rightRunId: string): Promise<RunComparisonResult> {
    const [leftRun, rightRun] = await Promise.all([
      this.runRepository.findById(leftRunId),
      this.runRepository.findById(rightRunId)
    ]);
    if (!leftRun) throw new NotFoundException(`run ${leftRunId} not found`);
    if (!rightRun) throw new NotFoundException(`run ${rightRunId} not found`);

    const [leftProjection, rightProjection, leftMetrics, rightMetrics] = await Promise.all([
      this.projectionService.get(leftRunId),
      this.projectionService.get(rightRunId),
      this.metricsRepository.get(leftRunId),
      this.metricsRepository.get(rightRunId)
    ]);

    const leftParticipants = new Set(leftProjection?.participants.map((p) => p.participantId) ?? []);
    const rightParticipants = new Set(rightProjection?.participants.map((p) => p.participantId) ?? []);
    const commonParticipants = [...leftParticipants].filter((p) => rightParticipants.has(p));
    const addedParticipants = [...rightParticipants].filter((p) => !leftParticipants.has(p));
    const removedParticipants = [...leftParticipants].filter((p) => !rightParticipants.has(p));

    const leftSignals = new Set(leftProjection?.signals.signals.map((s) => s.name) ?? []);
    const rightSignals = new Set(rightProjection?.signals.signals.map((s) => s.name) ?? []);
    const addedSignals = [...rightSignals].filter((s) => !leftSignals.has(s));
    const removedSignals = [...leftSignals].filter((s) => !rightSignals.has(s));

    const leftDuration = leftMetrics?.durationMs ?? undefined;
    const rightDuration = rightMetrics?.durationMs ?? undefined;
    const durationDeltaMs =
      leftDuration !== undefined && rightDuration !== undefined ? rightDuration - leftDuration : undefined;

    const leftConfidence = leftProjection?.decision.current?.confidence;
    const rightConfidence = rightProjection?.decision.current?.confidence;
    const confidenceDelta =
      leftConfidence !== undefined && rightConfidence !== undefined ? rightConfidence - leftConfidence : undefined;

    return {
      left: {
        runId: leftRunId,
        status: leftRun.status as RunStatus,
        modeName: leftProjection?.run.modeName,
        durationMs: leftDuration
      },
      right: {
        runId: rightRunId,
        status: rightRun.status as RunStatus,
        modeName: rightProjection?.run.modeName,
        durationMs: rightDuration
      },
      statusMatch: leftRun.status === rightRun.status,
      durationDeltaMs,
      confidenceDelta,
      participantsDiff: {
        added: addedParticipants,
        removed: removedParticipants,
        common: commonParticipants
      },
      signalsDiff: {
        added: addedSignals,
        removed: removedSignals
      }
    };
  }

  private toRun(row: typeof import('../db/schema').runs.$inferSelect): Run {
    return {
      id: row.id,
      status: row.status as RunStatus,
      runtimeKind: row.runtimeKind,
      runtimeVersion: row.runtimeVersion ?? undefined,
      runtimeSessionId: row.runtimeSessionId ?? undefined,
      traceId: row.traceId ?? undefined,
      createdAt: row.createdAt,
      startedAt: row.startedAt ?? undefined,
      endedAt: row.endedAt ?? undefined,
      tags: row.tags ?? undefined,
      archivedAt: row.archivedAt ?? null,
      source: row.sourceKind ? { kind: row.sourceKind, ref: row.sourceRef ?? undefined } : undefined,
      metadata: row.metadata ?? undefined
    };
  }
}
