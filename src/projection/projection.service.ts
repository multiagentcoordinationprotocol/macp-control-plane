import { Injectable, Logger } from '@nestjs/common';
import {
  CanonicalEvent,
  DecisionProposalContribution,
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
  // Per-run serialization to prevent concurrent stream-consumer + signal-consumer
  // updates from racing on the read-merge-write cycle. Without this, the
  // optimistic version-check in projection.repository.upsert can drop a
  // signal-consumer's signal when a higher-version stream-consumer write
  // lands later (the second writer reads stale state, doesn't include the
  // signal, and overwrites the version-7 update with version-15).
  private readonly applyLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly projectionRepository: ProjectionRepository) {}

  async get(runId: string): Promise<RunStateProjection | null> {
    const row = await this.projectionRepository.get(runId);
    if (!row) return null;

    // Schema version migration: if stored schema is older, mark as needing rebuild
    const storedSchemaVersion = (row as unknown as Record<string, unknown>).schemaVersion as number | undefined;
    if (storedSchemaVersion != null && storedSchemaVersion < PROJECTION_SCHEMA_VERSION) {
      this.logger.warn(
        `projection for run ${runId} has schema v${storedSchemaVersion}, current is v${PROJECTION_SCHEMA_VERSION} — returning stale data (rebuild recommended)`
      );
    }

    return {
      run: row.runSummary as unknown as RunSummaryProjection,
      participants: row.participants as unknown as ParticipantProjection[],
      graph: row.graph as unknown as GraphProjection,
      decision: row.decision as unknown as RunStateProjection['decision'],
      signals: row.signals as unknown as RunStateProjection['signals'],
      progress: (row.progress as unknown as ProgressProjection) ?? { entries: [] },
      timeline: row.timeline as unknown as RunStateProjection['timeline'],
      trace: row.traceSummary as unknown as RunStateProjection['trace'],
      outboundMessages: ((row as unknown as Record<string, unknown>).outboundMessages as OutboundMessageSummary) ?? {
        total: 0,
        queued: 0,
        accepted: 0,
        rejected: 0
      },
      policy: (row.policy as unknown as RunStateProjection['policy']) ?? {
        policyVersion: '',
        commitmentEvaluations: []
      },
      llm: ((row as unknown as Record<string, unknown>).llm as RunStateProjection['llm']) ?? {
        calls: [],
        totals: { callCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 }
      }
    };
  }

  async applyAndPersist(runId: string, events: CanonicalEvent[], tx?: unknown): Promise<RunStateProjection> {
    // Chain on the per-run lock so concurrent updates serialize.
    const prior = this.applyLocks.get(runId) ?? Promise.resolve();
    const next = prior.then(async () => {
      const current = (await this.get(runId)) ?? this.empty(runId);
      const merged = this.applyEvents(current, events);
      const version = (events.at(-1)?.seq ?? current.timeline.latestSeq) || 0;
      await this.projectionRepository.upsert(
        runId,
        merged,
        version,
        PROJECTION_SCHEMA_VERSION,
        tx as Parameters<typeof this.projectionRepository.upsert>[4]
      );
      return merged;
    });
    this.applyLocks.set(
      runId,
      next.finally(() => {
        // Release if still latest; otherwise leave the chain head intact.
        if (this.applyLocks.get(runId) === next) this.applyLocks.delete(runId);
      })
    );
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
      next.timeline.recent = [
        ...next.timeline.recent,
        {
          id: event.id,
          seq: event.seq,
          ts: event.ts,
          type: event.type,
          subject: event.subject
        }
      ].slice(-50);

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
          if (event.type === 'run.created' && typeof event.data.decisionPrompt === 'string') {
            next.decision.current = {
              ...(next.decision.current ?? { action: '', finalized: false }),
              prompt: event.data.decisionPrompt
            };
          }
          if (event.type === 'run.completed') this.sweepTerminal(next, 'completed');
          if (event.type === 'run.cancelled') this.sweepTerminal(next, 'cancelled');
          if (event.type === 'run.failed') this.sweepTerminal(next, 'failed');

          if (event.type === 'run.failed' || event.type === 'run.cancelled') {
            // On terminal non-success, finalize quorum outcome if no allow evaluations were recorded
            if (next.policy.quorumStatus === 'pending' || next.policy.quorumStatus === undefined) {
              const hasAllow = next.policy.commitmentEvaluations.some((e) => e.decision === 'allow');
              next.policy.quorumStatus = hasAllow ? 'reached' : 'failed';
            }
          }
          break;
        }
        case 'session.bound':
        case 'session.state.changed': {
          next.run.runtimeSessionId = (event.data.sessionId as string | undefined) ?? next.run.runtimeSessionId;
          if (typeof event.data.contextId === 'string') {
            next.run.contextId = event.data.contextId;
          }
          if (Array.isArray(event.data.extensionKeys)) {
            next.run.extensionKeys = event.data.extensionKeys as string[];
          }
          if (event.type === 'session.bound' && Array.isArray(event.data.expectedCommitments)) {
            next.policy.expectedCommitments = event.data
              .expectedCommitments as RunStateProjection['policy']['expectedCommitments'];
            if (next.policy.expectedCommitments && next.policy.expectedCommitments.length > 0) {
              next.policy.quorumStatus = next.policy.quorumStatus ?? 'pending';
            }
          }
          if (typeof event.data.state === 'string') {
            if (event.data.state === 'SESSION_STATE_RESOLVED') {
              next.run.status = 'completed';
              this.sweepTerminal(next, 'completed');
            }
            if (event.data.state === 'SESSION_STATE_EXPIRED') {
              next.run.status = 'failed';
              this.sweepTerminal(next, 'failed');
            }
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
              confidence: safeOptionalNumber(decodedPayload?.confidence),
              payload: decodedPayload
            }
          ].slice(-200);
          break;
        }
        case 'signal.acknowledged': {
          const ackPayload = event.data.decodedPayload as Record<string, unknown> | undefined;
          const targetSignalId = String(ackPayload?.signalId ?? ackPayload?.signal_id ?? event.subject?.id ?? '');
          const acknowledger = (event.data.sender as string | undefined) ?? undefined;
          if (targetSignalId) {
            const signal = next.signals.signals.find((s) => s.id === targetSignalId);
            if (signal) {
              signal.acknowledgedAt = event.ts;
              if (acknowledger) signal.acknowledgedBy = acknowledger;
            }
          }
          break;
        }
        case 'proposal.created':
        case 'proposal.updated': {
          const proposalPayload = event.data.decodedPayload as Record<string, unknown> | undefined;
          const messageType = String(event.data.messageType ?? '');
          const sender = String(event.data.sender ?? '');
          const explicitConfidence = safeOptionalNumber(proposalPayload?.confidence);
          // Vote envelopes don't carry confidence in their payload schema, but a
          // Vote IS by definition a confident decision — default to 1.0 so the
          // per-contributor table doesn't render "—" for every voter.
          const contributionConfidence =
            explicitConfidence ?? (messageType === 'Vote' ? 1.0 : undefined);
          const contribution: DecisionProposalContribution = {
            participantId: sender,
            action: inferContributionAction(messageType, proposalPayload),
            confidence: contributionConfidence,
            reasons: extractReasons(proposalPayload),
            ts: event.ts,
            vote: inferContributionVote(messageType, proposalPayload),
            messageType: messageType || undefined
          };
          const existingProposals = next.decision.current?.proposals ?? [];
          const proposalId = String(
            proposalPayload?.proposalId ?? proposalPayload?.requestId ?? event.subject?.id ?? ''
          );
          // Aggregate confidence: when proposals contain Votes, prefer the
          // approve-ratio (so 3-of-3 approves = 100%; 2-of-4 = 50%). Falls
          // back to the explicit payload value or any prior aggregate.
          const allContributions = [...existingProposals, contribution];
          const voteContributions = allContributions.filter((p) => p.vote === 'allow' || p.vote === 'deny');
          const approveCount = voteContributions.filter((p) => p.vote === 'allow').length;
          const aggregateConfidence =
            voteContributions.length > 0
              ? approveCount / voteContributions.length
              : (explicitConfidence ?? next.decision.current?.confidence);
          next.decision.current = {
            ...(next.decision.current ?? { finalized: false }),
            action: proposalId || String(event.subject?.id ?? 'proposal'),
            confidence: aggregateConfidence,
            reasons: [
              String(proposalPayload?.reason ?? proposalPayload?.summary ?? proposalPayload?.rationale ?? event.type)
            ].filter(Boolean),
            finalized: false,
            proposalId,
            proposals: allContributions.slice(-50)
          };

          // Update voteTally if this is a vote-bearing contribution
          if (contribution.vote && proposalId) {
            this.bumpVoteTally(next, proposalId, contribution.vote, sender);
          }
          break;
        }
        case 'decision.finalized': {
          const payload = event.data.decodedPayload as Record<string, unknown> | undefined;
          const action = String(payload?.action ?? 'resolved');
          const explicitOutcome = payload?.outcomePositive ?? payload?.outcome_positive;
          const outcomePositive: boolean | null =
            explicitOutcome != null ? Boolean(explicitOutcome) : inferOutcomePositiveFromAction(action);
          const sender = (event.data.sender as string | undefined) ?? undefined;
          // Final aggregate confidence: prefer explicit, otherwise compute
          // from the vote tally we accumulated during proposal.updated.
          const priorProposals = next.decision.current?.proposals ?? [];
          const priorVotes = priorProposals.filter((p) => p.vote === 'allow' || p.vote === 'deny');
          const priorApprove = priorVotes.filter((p) => p.vote === 'allow').length;
          const computedAggregate = priorVotes.length > 0 ? priorApprove / priorVotes.length : undefined;
          next.decision.current = {
            ...(next.decision.current ?? { finalized: false }),
            action,
            confidence:
              safeOptionalNumber(payload?.confidence) ?? computedAggregate ?? next.decision.current?.confidence,
            reasons: [String(payload?.reason ?? 'Commitment observed')],
            finalized: true,
            proposalId: String(payload?.commitmentId ?? next.decision.current?.proposalId ?? ''),
            outcomePositive,
            resolvedAt: event.ts,
            resolvedBy: sender
          };
          next.run.status = 'completed';
          // Propagate outcomePositive to policy projection
          next.policy.outcomePositive = outcomePositive;
          // Derive policy.resolved from a successful commit. The runtime does
          // not emit PolicyResolved / PolicyCommitmentEvaluated envelopes
          // (RFC-MACP-0012 forward-compat surface that's not yet implemented),
          // but the runtime's policy evaluator HAS approved the commit by the
          // time decision.finalized fires — so we can mark the policy as
          // resolved here. This flips the PolicyPanel header from "pending"
          // to "resolved" for committed runs.
          next.policy.resolvedAt = next.policy.resolvedAt ?? event.ts;
          if (next.policy.quorumStatus === undefined || next.policy.quorumStatus === 'pending') {
            next.policy.quorumStatus = outcomePositive === false ? 'failed' : 'reached';
          }
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
        case 'llm.call.completed': {
          const payload = event.data.decodedPayload as Record<string, unknown> | undefined;
          if (!payload) break;
          const prompt = safeOptionalNumber(payload.promptTokens) ?? 0;
          const completion = safeOptionalNumber(payload.completionTokens) ?? 0;
          const total = safeOptionalNumber(payload.totalTokens) ?? prompt + completion;
          if (!next.llm) {
            next.llm = {
              calls: [],
              totals: { callCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 }
            };
          }
          next.llm.calls = [
            ...next.llm.calls,
            {
              participantId: String(event.data.sender ?? ''),
              model: payload.model as string | undefined,
              promptTokens: prompt,
              completionTokens: completion,
              totalTokens: total,
              latencyMs: safeOptionalNumber(payload.latencyMs),
              ts: event.ts,
              messageId: event.data.messageId as string | undefined,
              artifactId: payload.artifactId as string | undefined,
              estimatedCostUsd: safeOptionalNumber(payload.estimatedCostUsd)
            }
          ].slice(-100);
          next.llm.totals.callCount += 1;
          next.llm.totals.promptTokens += prompt;
          next.llm.totals.completionTokens += completion;
          next.llm.totals.totalTokens += total;
          if (payload.estimatedCostUsd != null) {
            next.llm.totals.estimatedCostUsd += Number(payload.estimatedCostUsd) || 0;
          }
          break;
        }
        case 'policy.commitment.evaluated': {
          const evalPayload = event.data.decodedPayload as Record<string, unknown> | undefined;
          const decision = (evalPayload?.decision as 'allow' | 'deny') ?? 'allow';
          next.policy.commitmentEvaluations = [
            ...next.policy.commitmentEvaluations,
            {
              commitmentId: String(evalPayload?.commitmentId ?? event.subject?.id ?? ''),
              decision,
              reasons: (evalPayload?.reasons as string[]) ?? [],
              ts: event.ts
            }
          ].slice(-50);
          if (decision === 'allow') {
            next.policy.quorumStatus = 'reached';
          }
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
      policy: { policyVersion: '', commitmentEvaluations: [] },
      llm: {
        calls: [],
        totals: { callCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 }
      }
    };
  }

  private bumpVoteTally(projection: RunStateProjection, commitmentId: string, vote: 'allow' | 'deny', voterId: string) {
    projection.policy.voteTally ??= [];
    let entry = projection.policy.voteTally.find((e) => e.commitmentId === commitmentId);
    if (!entry) {
      entry = {
        commitmentId,
        allow: 0,
        deny: 0,
        threshold: 0,
        quorum: { required: 0, cast: 0 }
      };
      projection.policy.voteTally.push(entry);
    }
    if (vote === 'allow') entry.allow += 1;
    else entry.deny += 1;
    entry.quorum.cast = entry.allow + entry.deny;

    // Derive required: prefer voter-role participants, fallback to all participants
    const voters = projection.participants.filter((p) => p.role === 'voter');
    const required = voters.length > 0 ? voters.length : projection.participants.length;
    entry.quorum.required = required;
    entry.threshold = Math.ceil(required / 2);

    // (bumping voterId is reserved for future vote-uniqueness tracking)
    void voterId;

    if (projection.policy.quorumStatus === undefined || projection.policy.quorumStatus === 'pending') {
      projection.policy.quorumStatus = 'pending';
    }
  }

  private sweepTerminal(projection: RunStateProjection, outcome: 'completed' | 'failed' | 'cancelled') {
    const terminal = new Set(['completed', 'failed', 'skipped']);
    const toSweep = projection.participants.filter((p) => !terminal.has(p.status));
    if (toSweep.length === 0) return;

    let lastActive: ParticipantProjection | undefined;
    if (outcome === 'failed') {
      const withActivity = toSweep.filter((p) => p.latestActivityAt);
      if (withActivity.length > 0) {
        lastActive = withActivity.reduce((a, b) => ((a.latestActivityAt ?? '') > (b.latestActivityAt ?? '') ? a : b));
      }
    }

    for (const p of toSweep) {
      const newStatus: ParticipantProjection['status'] = !p.latestActivityAt
        ? 'skipped'
        : outcome === 'failed' && p === lastActive
          ? 'failed'
          : 'completed';
      p.status = newStatus;
      const node = projection.graph.nodes.find((n) => n.id === p.participantId);
      if (node) node.status = newStatus;
    }
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

    // If the run already reached a terminal state, do not re-activate a
    // participant that's been swept to a terminal status. Late-arriving
    // envelopes (e.g. Commitment events normalized after run.completed) would
    // otherwise flip risk-agent back to 'active' even though the run is done.
    const runTerminal = projection.run.status === 'completed' || projection.run.status === 'failed' || projection.run.status === 'cancelled';
    const participantTerminal = participant.status === 'completed' || participant.status === 'failed' || participant.status === 'skipped';
    if (runTerminal && participantTerminal) {
      participant.latestActivityAt = ts;
      if (summary) participant.latestSummary = summary;
      return;
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

function inferContributionAction(messageType: string, payload?: Record<string, unknown>): string {
  // Per-messageType best-known action field, falling back to messageType itself.
  const vote = payload?.vote ?? payload?.recommendation;
  if (vote) return String(vote);
  const action = payload?.action ?? payload?.option ?? payload?.revisedAction;
  if (action) return String(action);
  return messageType || 'contribution';
}

function inferContributionVote(messageType: string, payload?: Record<string, unknown>): 'allow' | 'deny' | undefined {
  const raw = (payload?.vote ?? payload?.recommendation ?? '').toString().toUpperCase();
  if (['APPROVE', 'ACCEPT', 'ALLOW', 'YES'].includes(raw)) return 'allow';
  if (['REJECT', 'DENY', 'BLOCK', 'NO'].includes(raw)) return 'deny';
  if (
    messageType === 'Accept' ||
    messageType === 'Approve' ||
    messageType === 'TaskAccept' ||
    messageType === 'HandoffAccept'
  )
    return 'allow';
  if (messageType === 'Reject' || messageType === 'TaskReject' || messageType === 'HandoffDecline') return 'deny';
  return undefined;
}

function extractReasons(payload?: Record<string, unknown>): string[] {
  if (!payload) return [];
  const reasons: string[] = [];
  for (const field of ['reason', 'rationale', 'summary']) {
    const value = payload[field];
    if (typeof value === 'string' && value.length > 0) reasons.push(value);
  }
  const list = payload.reasons;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (typeof entry === 'string' && entry.length > 0) reasons.push(entry);
    }
  }
  return reasons;
}

// Explicit null (not undefined) means "resolved, no outcome reported" — distinct from "still running" (undefined).
// Inference aligns with CommitmentPayload.outcome_positive convention documented in CLAUDE.md.
function inferOutcomePositiveFromAction(action: string): boolean | null {
  const a = action.toLowerCase();
  if (['approve', 'approved', 'accept', 'accepted', 'selected', 'completed'].includes(a)) return true;
  if (['reject', 'rejected', 'decline', 'declined', 'failed'].includes(a)) return false;
  return null;
}
