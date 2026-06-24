export type ExecutionMode = 'live' | 'sandbox';

export interface ParticipantRef {
  /** Bare sender string — must match the agent's identity in the runtime. */
  id: string;
}

/**
 * Populated on the `policy.expectedCommitments[]` projection when (future) runtime
 * `PolicyResolved` events supply commitment expectations. Not part of the inbound
 * HTTP contract — the control-plane does not accept commitments from callers.
 */
export interface ExpectedCommitment {
  id: string;
  title?: string;
  description?: string;
  requiredRoles?: string[];
  policyRef?: string;
}

export interface ExecutionRequester {
  actorId?: string;
  actorType?: 'user' | 'service' | 'system';
}

/**
 * Scenario-agnostic cancellation callback (Option A, direct-agent-auth plan §Cancellation design).
 * Points to a per-initiator HTTP endpoint the control-plane POSTs when the UI cancels a run.
 * `bearer` is optional and opaque; the initiator validates it.
 */
export interface CancelCallback {
  url: string;
  bearer?: string;
}

/**
 * Scenario-agnostic run descriptor — the control-plane accepts only these fields.
 *
 * No scenario-specific fields cross this boundary: no kickoff templates, no policy hints,
 * no participant roles, no initiator designation. Agents authenticate to the runtime
 * directly; the control-plane is an observer. See direct-agent-auth.md §Generic contracts.
 *
 * Canonical JSON Schema: multiagentcoordinationprotocol/schemas/json/macp-run-descriptor.schema.json
 */
export interface RunDescriptor {
  mode: ExecutionMode;
  runtime: {
    kind: string;
    version?: string;
  };
  session: {
    /**
     * Optional caller-allocated session id. Must satisfy runtime validator
     * (UUID v4/v7 or base64url 22+ chars). When omitted, control-plane allocates a UUID v4.
     */
    sessionId?: string;
    modeName: string;
    modeVersion: string;
    configurationVersion: string;
    /** Opaque; control-plane never interprets it. */
    policyVersion?: string;
    ttlMs: number;
    /** Bare sender strings; for audit / projection only. */
    participants: ParticipantRef[];
    /**
     * Opaque metadata bag. Reserved keys:
     *   - `source`, `sourceRef`          — scenario provenance tags (for filtering)
     *   - `environment`, `scenarioRef`   — filter facets
     *   - `cancelCallback`               — CancelCallback (Option A)
     *   - `cancellationDelegated`        — boolean (Option B — control-plane may cancel directly)
     */
    metadata?: Record<string, unknown>;
  };
  execution?: {
    idempotencyKey?: string;
    tags?: string[];
    requester?: ExecutionRequester;
  };
}

export type RunStatus =
  | 'queued'
  | 'starting'
  | 'binding_session'
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type SessionState =
  | 'SESSION_STATE_UNSPECIFIED'
  | 'SESSION_STATE_OPEN'
  | 'SESSION_STATE_RESOLVED'
  | 'SESSION_STATE_EXPIRED'
  /** Non-terminal pause introduced in macp-proto 0.1.3 (RFC-MACP-0001 §7.5). */
  | 'SESSION_STATE_SUSPENDED'
  /** Terminal state for a session ended by an accepted CancelSession RPC (macp-proto 0.1.3). */
  | 'SESSION_STATE_CANCELLED';

export interface Run {
  id: string;
  status: RunStatus;
  runtimeKind: string;
  runtimeVersion?: string;
  runtimeSessionId?: string;
  traceId?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  tags?: string[];
  archivedAt?: string | null;
  source?: {
    kind?: string;
    ref?: string;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Published set of canonical event types (v1). Consumers should import this
 * constant rather than string-matching. Shape changes to the payloads of these
 * events require a new version (e.g. `CANONICAL_EVENT_TYPES_V2`).
 */
export const CANONICAL_EVENT_TYPES = [
  'run.created',
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.suspended',
  'run.resumed',
  'session.bound',
  'session.stream.opened',
  'session.state.changed',
  'participant.seen',
  'message.sent',
  'message.received',
  'message.send_failed',
  'signal.emitted',
  'signal.acknowledged',
  'proposal.created',
  'proposal.updated',
  'decision.proposed',
  'decision.finalized',
  'progress.reported',
  'tool.called',
  'tool.completed',
  'artifact.created',
  'policy.resolved',
  'policy.commitment.evaluated',
  'policy.denied',
  'llm.call.completed'
] as const;

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

export interface CanonicalEvent {
  id: string;
  runId: string;
  seq: number;
  ts: string;
  type: CanonicalEventType | string;
  schemaVersion?: number;
  subject?: {
    kind:
      | 'run'
      | 'session'
      | 'participant'
      | 'message'
      | 'signal'
      | 'proposal'
      | 'decision'
      | 'tool'
      | 'artifact'
      | 'trace'
      | 'policy';
    id: string;
  };
  source: {
    kind: 'runtime' | 'control-plane' | 'replay';
    name: string;
    rawType?: string;
  };
  trace?: {
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
  };
  data: Record<string, unknown>;
}

export interface Artifact {
  id: string;
  runId: string;
  kind: 'trace' | 'json' | 'report' | 'log' | 'bundle';
  label: string;
  uri?: string;
  inline?: Record<string, unknown>;
  createdAt: string;
}

export interface RunSummaryProjection {
  runId: string;
  status: RunStatus;
  runtimeSessionId?: string;
  startedAt?: string;
  endedAt?: string;
  traceId?: string;
  modeName?: string;
  contextId?: string;
  extensionKeys?: string[];
}

export interface ParticipantProjection {
  participantId: string;
  role?: string;
  status: 'idle' | 'active' | 'waiting' | 'completed' | 'failed' | 'skipped';
  latestActivityAt?: string;
  latestSummary?: string;
}

export interface GraphProjection {
  nodes: Array<{ id: string; kind: string; status: string }>;
  edges: Array<{ from: string; to: string; kind: string; ts: string }>;
}

export interface DecisionProposalContribution {
  participantId: string;
  action: string;
  confidence?: number;
  reasons: string[];
  ts: string;
  vote?: 'allow' | 'deny';
  messageType?: string;
}

/**
 * Cross-session commitment supersession (RFC-MACP-0001 §7.3, macp-proto 0.1.3).
 * Points at the prior commitment this one replaces. Observed-only — the
 * control-plane surfaces it for insight UIs; it does not resolve the chain.
 */
export interface CommitmentSupersedes {
  sessionId: string;
  commitmentHash: string;
}

export interface DecisionProjection {
  current?: {
    action: string;
    confidence?: number;
    reasons?: string[];
    finalized: boolean;
    proposalId?: string;
    outcomePositive?: boolean | null;
    prompt?: string;
    proposals?: DecisionProposalContribution[];
    resolvedAt?: string;
    resolvedBy?: string;
    /** Set when the finalized commitment supersedes a prior one (cross-session). */
    supersedes?: CommitmentSupersedes;
  };
}

export interface SignalProjection {
  signals: Array<{
    id: string;
    name: string;
    severity?: string;
    sourceParticipantId?: string;
    ts: string;
    confidence?: number;
    payload?: Record<string, unknown>;
    acknowledgedAt?: string;
    acknowledgedBy?: string;
  }>;
}

export interface TimelineProjection {
  latestSeq: number;
  totalEvents: number;
  recent: Array<Pick<CanonicalEvent, 'id' | 'seq' | 'ts' | 'type' | 'subject'>>;
}

export interface TraceSummary {
  traceId?: string;
  spanCount: number;
  lastSpanId?: string;
  linkedArtifacts: string[];
}

export interface ProgressProjection {
  entries: Array<{
    participantId: string;
    percentage?: number;
    message?: string;
    ts: string;
  }>;
}

export interface OutboundMessageSummary {
  total: number;
  queued: number;
  accepted: number;
  rejected: number;
}

export interface VoteTallyEntry {
  commitmentId: string;
  allow: number;
  deny: number;
  threshold: number;
  quorum: { required: number; cast: number };
}

export interface PolicyProjection {
  policyVersion: string;
  policyDescription?: string;
  resolvedAt?: string;
  outcomePositive?: boolean | null;
  commitmentEvaluations: Array<{
    commitmentId: string;
    decision: 'allow' | 'deny';
    reasons: string[];
    ts: string;
  }>;
  expectedCommitments?: ExpectedCommitment[];
  voteTally?: VoteTallyEntry[];
  quorumStatus?: 'pending' | 'reached' | 'failed';
}

export interface LlmCallEntry {
  participantId: string;
  model?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs?: number;
  ts: string;
  messageId?: string;
  artifactId?: string;
  estimatedCostUsd?: number;
}

export interface LlmProjection {
  calls: LlmCallEntry[];
  totals: {
    callCount: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
}

export interface RunStateProjection {
  run: RunSummaryProjection;
  participants: ParticipantProjection[];
  graph: GraphProjection;
  decision: DecisionProjection;
  signals: SignalProjection;
  progress: ProgressProjection;
  timeline: TimelineProjection;
  trace: TraceSummary;
  outboundMessages: OutboundMessageSummary;
  policy: PolicyProjection;
  llm: LlmProjection;
}

export interface ReplayRequest {
  mode: 'instant' | 'timed' | 'step';
  speed?: number;
  fromSeq?: number;
  toSeq?: number;
}

export interface RunExportBundle {
  run: Run;
  session: Record<string, unknown> | null;
  projection: RunStateProjection | null;
  metrics: MetricsSummary | null;
  artifacts: Artifact[];
  canonicalEvents: CanonicalEvent[];
  rawEvents: Record<string, unknown>[];
  exportedAt: string;
}

export interface RunComparisonRequest {
  leftRunId: string;
  rightRunId: string;
}

export interface RunComparisonResult {
  left: { runId: string; status: RunStatus; modeName?: string; durationMs?: number };
  right: { runId: string; status: RunStatus; modeName?: string; durationMs?: number };
  statusMatch: boolean;
  durationDeltaMs?: number;
  confidenceDelta?: number;
  participantsDiff: {
    added: string[];
    removed: string[];
    common: string[];
  };
  signalsDiff: {
    added: string[];
    removed: string[];
  };
}

export interface MetricsSummary {
  runId: string;
  eventCount: number;
  messageCount: number;
  signalCount: number;
  proposalCount: number;
  toolCallCount: number;
  decisionCount: number;
  streamReconnectCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  firstEventAt?: string;
  lastEventAt?: string;
  durationMs?: number;
  sessionState?: SessionState;
}
