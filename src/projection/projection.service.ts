import { Injectable, Logger } from '@nestjs/common';
import {
  CanonicalEvent,
  GraphProjection,
  OutboundMessageSummary,
  ParticipantProjection,
  ProgressProjection,
  RunStateProjection,
  RunSummaryProjection
} from '../contracts/control-plane';
import { ProjectionRepository } from '../storage/projection.repository';

export const PROJECTION_SCHEMA_VERSION = 3;

@Injectable()
export class ProjectionService {
  private readonly logger = new Logger(ProjectionService.name);

  constructor(private readonly projectionRepository: ProjectionRepository) {}

  async get(runId: string): Promise<RunStateProjection | null> {
    const row = await this.projectionRepository.get(runId);
    if (!row) return null;

    // Schema version migration: if stored schema is older, mark as needing rebuild
    const storedSchemaVersion = (row as unknown as Record<string, unknown>).schemaVersion as number | undefined;
    if (storedSchemaVersion != null && storedSchemaVersion < PROJECTION_SCHEMA_VERSION) {
      this.logger.warn(`projection for run ${runId} has schema v${storedSchemaVersion}, current is v${PROJECTION_SCHEMA_VERSION} — returning stale data (rebuild recommended)`);
    }

    return {
      run: row.runSummary as unknown as RunSummaryProjection,
      participants: row.participants as unknown as ParticipantProjection[],
      graph: row.graph as unknown as GraphProjection,
      decision: row.decision as unknown as RunStateProjection['decision'],
      signals: row.signals as unknown as RunStateProjection['signals'],
      progress: row.progress as unknown as ProgressProjection ?? { entries: [] },
      timeline: row.timeline as unknown as RunStateProjection['timeline'],
      trace: row.traceSummary as unknown as RunStateProjection['trace'],
      outboundMessages: (row as unknown as Record<string, unknown>).outboundMessages as OutboundMessageSummary ?? { total: 0, queued: 0, accepted: 0, rejected: 0 },
      policy: (row as unknown as Record<string, unknown>).policy as RunStateProjection['policy'] ?? { policyVersion: '', commitmentEvaluations: [] }
    };
  }

  async applyAndPersist(runId: string, events: CanonicalEvent[], tx?: unknown): Promise<RunStateProjection> {
    const current = (await this.get(runId)) ?? this.empty(runId);
    const next = this.applyEvents(current, events);
    const version = (events.at(-1)?.seq ?? current.timeline.latestSeq) || 0;
    await this.projectionRepository.upsert(runId, next, version, PROJECTION_SCHEMA_VERSION, tx as Parameters<typeof this.projectionRepository.upsert>[4]);
    return next;
  }

  applyEvents(current: RunStateProjection, events: CanonicalEvent[]): RunStateProjection {
    let next: RunStateProjection;
    try {
      next = structuredClone(current);
    } catch {
      this.logger.warn('structuredClone failed, falling back to JSON round-trip');
      next = JSON.parse(JSON.stringify(current));
    }

    for (const event of events) {
      next.timeline.latestSeq = event.seq;
      next.timeline.totalEvents += 1;
      next.timeline.recent = [...next.timeline.recent, {
        id: event.id,
        seq: event.seq,
        ts: event.ts,
        type: event.type,
        subject: event.subject
      }].slice(-50);

      if (event.trace?.traceId) {
        next.trace.traceId = event.trace.traceId;
      }
      if (event.trace?.spanId) {
        next.trace.lastSpanId = event.trace.spanId;
        next.trace.spanCount += 1;
      }

      switch (event.type) {
        case 'run.created':
        case 'run.started':
        case 'run.completed':
        case 'run.failed':
        case 'run.cancelled': {
          next.run = {
            ...next.run,
            runId: current.run.runId || event.runId,
            status: (event.data.status as RunSummaryProjection['status']) ?? next.run.status,
            runtimeSessionId: (event.data.runtimeSessionId as string | undefined) ?? next.run.runtimeSessionId,
            startedAt: (event.data.startedAt as string | undefined) ?? next.run.startedAt,
            endedAt: (event.data.endedAt as string | undefined) ?? next.run.endedAt,
            traceId: (event.data.traceId as string | undefined) ?? next.run.traceId,
            modeName: (event.data.modeName as string | undefined) ?? next.run.modeName
          };
          break;
        }
        case 'session.bound':
        case 'session.state.changed': {
          next.run.runtimeSessionId = (event.data.sessionId as string | undefined) ?? next.run.runtimeSessionId;
          if (typeof event.data.state === 'string') {
            if (event.data.state === 'SESSION_STATE_RESOLVED') next.run.status = 'completed';
            if (event.data.state === 'SESSION_STATE_EXPIRED') next.run.status = 'failed';
          }
          break;
        }
        case 'participant.seen': {
          const participantId = String(event.data.participantId ?? event.subject?.id ?? '');
          if (!next.participants.find((participant) => participant.participantId === participantId)) {
            next.participants.push({ participantId, status: 'idle' });
            next.graph.nodes.push({ id: participantId, kind: 'participant', status: 'idle' });
          }
          break;
        }
        case 'message.sent': {
          const sender = String(event.data.sender ?? event.data.from ?? '');
          const recipients = (event.data.to as string[] | undefined) ?? [];
          this.touchParticipant(next, sender, event.ts, 'active', String(event.data.messageType ?? event.type));
          recipients.forEach((recipient) => this.touchParticipant(next, recipient, event.ts, 'waiting', undefined));
          recipients.forEach((recipient) => {
            if (sender && recipient) {
              next.graph.edges.push({ from: sender, to: recipient, kind: event.type, ts: event.ts });
            }
          });
          next.graph.edges = next.graph.edges.slice(-200);
          // Track outbound message stats
          if (!next.outboundMessages) {
            next.outboundMessages = { total: 0, queued: 0, accepted: 0, rejected: 0 };
          }
          next.outboundMessages.total += 1;
          next.outboundMessages.accepted += 1;
          break;
        }
        case 'message.send_failed': {
          if (!next.outboundMessages) {
            next.outboundMessages = { total: 0, queued: 0, accepted: 0, rejected: 0 };
          }
          next.outboundMessages.total += 1;
          next.outboundMessages.rejected += 1;
          break;
        }
        case 'message.received': {
          const sender = String(event.data.sender ?? event.data.from ?? '');
          const recipients = (event.data.to as string[] | undefined) ?? [];
          this.touchParticipant(next, sender, event.ts, 'active', String(event.data.messageType ?? event.type));
          recipients.forEach((recipient) => this.touchParticipant(next, recipient, event.ts, 'waiting', undefined));
          recipients.forEach((recipient) => {
            if (sender && recipient) {
              next.graph.edges.push({ from: sender, to: recipient, kind: event.type, ts: event.ts });
            }
          });
          next.graph.edges = next.graph.edges.slice(-200);
          break;
        }
        case 'signal.emitted': {
          const decodedPayload = event.data.decodedPayload as Record<string, unknown> | undefined;
          next.signals.signals = [
            ...next.signals.signals,
            {
              id: event.subject?.id ?? event.id,
              name: String(decodedPayload?.signalType ?? event.data.messageType ?? 'Signal'),
              severity: decodedPayload?.severity as string | undefined,
              sourceParticipantId: (event.data.sender as string | undefined) ?? undefined,
              ts: event.ts,
              confidence: safeOptionalNumber(decodedPayload?.confidence)
            }
          ].slice(-200);
          break;
        }
        case 'proposal.created':
        case 'proposal.updated': {
          const proposalPayload = event.data.decodedPayload as Record<string, unknown> | undefined;
          next.decision.current = {
            action: String(proposalPayload?.proposalId ?? proposalPayload?.requestId ?? event.subject?.id ?? 'proposal'),
            confidence: safeOptionalNumber(proposalPayload?.confidence) ?? next.decision.current?.confidence,
            reasons: [String(proposalPayload?.reason ?? proposalPayload?.summary ?? proposalPayload?.rationale ?? event.type)].filter(Boolean),
            finalized: false,
            proposalId: String(proposalPayload?.proposalId ?? proposalPayload?.requestId ?? event.subject?.id ?? '')
          };
          break;
        }
        case 'decision.finalized': {
          const payload = event.data.decodedPayload as Record<string, unknown> | undefined;
          next.decision.current = {
            action: String(payload?.action ?? 'resolved'),
            confidence: safeOptionalNumber(payload?.confidence) ?? next.decision.current?.confidence,
            reasons: [String(payload?.reason ?? 'Commitment observed')],
            finalized: true,
            proposalId: String(payload?.commitmentId ?? next.decision.current?.proposalId ?? ''),
            outcomePositive: payload?.outcomePositive != null
              ? Boolean(payload.outcomePositive)
              : payload?.outcome_positive != null
                ? Boolean(payload.outcome_positive)
                : true
          };
          next.run.status = 'completed';
          // Propagate outcomePositive to policy projection
          next.policy.outcomePositive = next.decision.current.outcomePositive;
          break;
        }
        case 'progress.reported': {
          const progressPayload = event.data.decodedPayload as Record<string, unknown> | undefined;
          next.progress.entries = [
            ...next.progress.entries,
            {
              participantId: String(event.data.sender ?? ''),
              percentage: safeOptionalNumber(progressPayload?.percentage ?? progressPayload?.progress),
              message: String(progressPayload?.message ?? progressPayload?.status ?? ''),
              ts: event.ts
            }
          ].slice(-100);
          break;
        }
        case 'artifact.created': {
          const artifactId = String(event.subject?.id ?? event.id);
          next.trace.linkedArtifacts = [...new Set([...next.trace.linkedArtifacts, artifactId])];
          break;
        }
        case 'policy.resolved': {
          const policyPayload = event.data.decodedPayload as Record<string, unknown> | undefined;
          next.policy.policyVersion = String(policyPayload?.policyVersion ?? event.data.policyVersion ?? '');
          next.policy.policyDescription = String(policyPayload?.description ?? '');
          next.policy.resolvedAt = event.ts;
          break;
        }
        case 'policy.commitment.evaluated': {
          const evalPayload = event.data.decodedPayload as Record<string, unknown> | undefined;
          next.policy.commitmentEvaluations = [
            ...next.policy.commitmentEvaluations,
            {
              commitmentId: String(evalPayload?.commitmentId ?? event.subject?.id ?? ''),
              decision: (evalPayload?.decision as 'allow' | 'deny') ?? 'allow',
              reasons: (evalPayload?.reasons as string[]) ?? [],
              ts: event.ts
            }
          ].slice(-50);
          break;
        }
        default:
          break;
      }
    }

    return next;
  }

  async replayStateAt(runId: string, events: CanonicalEvent[]): Promise<RunStateProjection> {
    return this.applyEvents(this.empty(runId), events);
  }

  async rebuild(runId: string, events: CanonicalEvent[]): Promise<RunStateProjection> {
    const projection = this.applyEvents(this.empty(runId), events);
    const version = events.at(-1)?.seq ?? 0;
    await this.projectionRepository.upsert(runId, projection, version, PROJECTION_SCHEMA_VERSION);
    this.logger.log(`projection rebuilt for run ${runId} at schema version ${PROJECTION_SCHEMA_VERSION}`);
    return projection;
  }

  empty(runId: string): RunStateProjection {
    return {
      run: { runId, status: 'queued' },
      participants: [],
      graph: { nodes: [], edges: [] },
      decision: {},
      signals: { signals: [] },
      progress: { entries: [] },
      timeline: { latestSeq: 0, totalEvents: 0, recent: [] },
      trace: { spanCount: 0, linkedArtifacts: [] },
      outboundMessages: { total: 0, queued: 0, accepted: 0, rejected: 0 },
      policy: { policyVersion: '', commitmentEvaluations: [] }
    };
  }

  private touchParticipant(
    projection: RunStateProjection,
    participantId: string,
    ts: string,
    status: ParticipantProjection['status'],
    summary?: string
  ) {
    if (!participantId) return;
    let participant = projection.participants.find((item) => item.participantId === participantId);
    if (!participant) {
      participant = { participantId, status: 'idle' };
      projection.participants.push(participant);
      projection.graph.nodes.push({ id: participantId, kind: 'participant', status: 'idle' });
    }
    participant.status = status;
    participant.latestActivityAt = ts;
    if (summary) participant.latestSummary = summary;

    const node = projection.graph.nodes.find((item) => item.id === participantId);
    if (node) node.status = status;
  }
}

function safeOptionalNumber(val: unknown): number | undefined {
  if (val === undefined || val === null) return undefined;
  const n = Number(val);
  return Number.isFinite(n) ? n : undefined;
}
