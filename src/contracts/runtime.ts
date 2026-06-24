import { CanonicalEvent, RunDescriptor, SessionState } from './control-plane';

export interface RuntimeCredentials {
  metadata: Record<string, string>;
  sender: string;
}

export interface RuntimeEnvelope {
  macpVersion: string;
  mode: string;
  messageType: string;
  messageId: string;
  sessionId: string;
  sender: string;
  timestampUnixMs: number;
  payload: Buffer;
}

export interface RuntimeAck {
  ok: boolean;
  duplicate: boolean;
  messageId: string;
  sessionId: string;
  acceptedAtUnixMs: number;
  sessionState: SessionState;
  error?: {
    code: string;
    message: string;
    sessionId?: string;
    messageId?: string;
    detailsBase64?: string;
    details?: Buffer | Uint8Array;
    reasons?: string[];
  };
}

export interface RawRuntimeEvent {
  kind: 'stream-envelope' | 'session-snapshot' | 'send-ack' | 'stream-status' | 'stream-inline-error';
  receivedAt: string;
  envelope?: RuntimeEnvelope;
  sessionSnapshot?: RuntimeSessionSnapshot;
  /**
   * Retained on the raw-event discriminator for the normalizer's shape-union, but
   * the control-plane observer no longer produces `send-ack` events — all outbound
   * envelopes are emitted by agents directly against the runtime. See direct-agent-auth.md §Invariants.
   */
  ack?: RuntimeAck;
  streamStatus?: {
    status: 'opened' | 'reconnecting' | 'closed';
    detail?: string;
  };
  inlineError?: {
    code: string;
    message: string;
    sessionId?: string;
    messageId?: string;
  };
}

export interface RuntimeInitializeRequest {
  clientName: string;
  clientVersion: string;
}

export interface RuntimeInitializeResult {
  selectedProtocolVersion: string;
  runtimeInfo: {
    name: string;
    title?: string;
    version?: string;
    description?: string;
    websiteUrl?: string;
  };
  supportedModes: string[];
  capabilities?: RuntimeCapabilities;
  instructions?: string;
}

export interface RuntimeGetSessionRequest {
  runId: string;
  runtimeSessionId: string;
  requesterId?: string;
}

export interface RuntimeSessionSnapshot {
  sessionId: string;
  mode: string;
  state: SessionState;
  startedAtUnixMs?: number;
  expiresAtUnixMs?: number;
  modeVersion?: string;
  configurationVersion?: string;
  policyVersion?: string;
  initiator?: string;
}

export interface RuntimeCancelSessionRequest {
  runId: string;
  runtimeSessionId: string;
  reason?: string;
  requesterId?: string;
}

export interface RuntimeCancelResult {
  ack: RuntimeAck;
}

/**
 * Session suspend / resume (RFC-MACP-0001 §7.5, macp-proto 0.1.3). Symmetric with
 * CancelSession: Core control-plane RPCs (not `Send`), permitted under the observer
 * invariant. Suspend banks the session TTL; resume restores it.
 */
export interface RuntimeSuspendSessionRequest {
  runId: string;
  runtimeSessionId: string;
  reason?: string;
  requesterId?: string;
}

export interface RuntimeSuspendResult {
  ack: RuntimeAck;
}

export interface RuntimeResumeSessionRequest {
  runId: string;
  runtimeSessionId: string;
  reason?: string;
  requesterId?: string;
}

export interface RuntimeResumeResult {
  ack: RuntimeAck;
}

export interface RuntimeManifestResult {
  agentId: string;
  title?: string;
  description?: string;
  supportedModes: string[];
  metadata?: Record<string, string>;
}

export interface RuntimeModeDescriptor {
  mode: string;
  modeVersion: string;
  title?: string;
  description?: string;
  determinismClass?: string;
  participantModel?: string;
  messageTypes: string[];
  terminalMessageTypes: string[];
  schemaUris?: Record<string, string>;
}

export interface RuntimeRootDescriptor {
  uri: string;
  name?: string;
}

export interface RuntimeHealth {
  ok: boolean;
  runtimeKind: string;
  detail?: string;
  manifest?: RuntimeManifestResult;
}

export interface RuntimeCallOptions {
  deadline?: Date;
}

/** Request to subscribe to an existing session's event stream (read-only). */
export interface RuntimeSubscribeSessionRequest {
  runId: string;
  runtimeSessionId: string;
  /**
   * RFC-MACP-0006 §3.2: replay log sequence to start from. 0 (default) replays
   * the full accepted history before switching to live broadcast.
   */
  afterSequence?: number;
}

/**
 * Handle to an observer-only StreamSession.
 *
 * **Invariant (direct-agent-auth §Invariants #5):** the control-plane NEVER writes envelopes
 * on this stream. There is intentionally no `send()` on this handle. Agents authenticate
 * to the runtime directly with their own Bearer tokens and emit their own envelopes.
 */
export interface RuntimeSessionHandle {
  /** Async iterable of raw events from the stream. */
  events: AsyncIterable<RawRuntimeEvent>;
  /** Abort the stream immediately. */
  abort(): void;
}

/** Stored runtime capabilities from Initialize response */
export interface RuntimeCapabilities {
  sessions?: { stream?: boolean };
  cancellation?: { cancelSession?: boolean };
  progress?: { progress?: boolean };
  manifest?: { getManifest?: boolean };
  modeRegistry?: { listModes?: boolean; listChanged?: boolean };
  roots?: { listRoots?: boolean; listChanged?: boolean };
  policyRegistry?: { registerPolicy?: boolean; listPolicies?: boolean; listChanged?: boolean };
}

/**
 * Observer-only runtime provider surface.
 *
 * The control-plane does not call `Send` for any reason — agents authenticate directly to
 * the runtime (RFC-MACP-0004 §4). The provider's job is to initialize, observe, inspect,
 * and (conditionally) cancel sessions. See direct-agent-auth.md §Invariants.
 */
export type SessionLifecycleEventType =
  | 'created'
  | 'resolved'
  | 'expired'
  /** macp-proto 0.1.3 lifecycle transitions (RFC-MACP-0001 §7.5). */
  | 'suspended'
  | 'resumed'
  | 'cancelled';

export interface SessionLifecycleEvent {
  eventType: SessionLifecycleEventType;
  session: RuntimeSessionSnapshot;
  observedAtUnixMs: number;
}

export interface RuntimeProvider {
  readonly kind: string;

  initialize(req: RuntimeInitializeRequest, opts?: RuntimeCallOptions): Promise<RuntimeInitializeResult>;

  /** Attach a read-only StreamSession observer. Never writes. */
  subscribeSession(req: RuntimeSubscribeSessionRequest): RuntimeSessionHandle;

  getSession(req: RuntimeGetSessionRequest): Promise<RuntimeSessionSnapshot>;

  cancelSession(req: RuntimeCancelSessionRequest): Promise<RuntimeCancelResult>;

  /** Pause a session (non-terminal). Control-plane RPC, not `Send` (RFC-MACP-0001 §7.5). */
  suspendSession(req: RuntimeSuspendSessionRequest): Promise<RuntimeSuspendResult>;

  /** Resume a previously suspended session. Control-plane RPC, not `Send`. */
  resumeSession(req: RuntimeResumeSessionRequest): Promise<RuntimeResumeResult>;

  getManifest(): Promise<RuntimeManifestResult>;
  listModes(): Promise<RuntimeModeDescriptor[]>;
  listRoots(): Promise<RuntimeRootDescriptor[]>;
  health(): Promise<RuntimeHealth>;

  // Session lifecycle observation
  listSessions(): Promise<RuntimeSessionSnapshot[]>;
  watchSessions(): AsyncIterable<SessionLifecycleEvent>;

  /**
   * Subscribe to the runtime's ambient Signal/Progress envelopes.
   *
   * The runtime broadcasts Signal and Progress envelopes on a dedicated bus
   * (signal_bus, separate from per-session stream_bus). Yields RawRuntimeEvent
   * stream-envelope items so the same normalizer that handles per-session
   * envelopes can ingest these. Caller correlates the envelope to a run via
   * `envelope.sessionId`.
   */
  watchSignals(): AsyncIterable<RawRuntimeEvent>;

  // Governance policy lifecycle (RFC-MACP-0012)
  registerPolicy(req: RuntimeRegisterPolicyRequest): Promise<RuntimeRegisterPolicyResult>;
  unregisterPolicy(req: RuntimeUnregisterPolicyRequest): Promise<RuntimeUnregisterPolicyResult>;
  getPolicy(req: RuntimeGetPolicyRequest): Promise<RuntimePolicyDescriptor>;
  listPolicies(req?: RuntimeListPoliciesRequest): Promise<RuntimePolicyDescriptor[]>;
}

// ── Policy types (RFC-MACP-0012) ────────────────────────────────────

export interface RuntimePolicyDescriptor {
  policyId: string;
  mode: string;
  description: string;
  rules: Buffer | string;
  schemaVersion: number;
  registeredAtUnixMs?: number;
}

export interface RuntimeRegisterPolicyRequest {
  descriptor: RuntimePolicyDescriptor;
}

export interface RuntimeRegisterPolicyResult {
  ok: boolean;
  error?: string;
}

export interface RuntimeUnregisterPolicyRequest {
  policyId: string;
}

export interface RuntimeUnregisterPolicyResult {
  ok: boolean;
  error?: string;
}

export interface RuntimeGetPolicyRequest {
  policyId: string;
}

export interface RuntimeListPoliciesRequest {
  mode?: string;
}

// ── Credential types ────────────────────────────────────────────────

/**
 * Single-bearer credential resolver (CP-9). The control-plane has exactly one
 * runtime identity — its own least-privilege Bearer token with `can_start_sessions: false`.
 * Per-sender token maps were removed in direct-agent-auth Phase 4.
 */
export interface RuntimeCredentialResolver {
  resolve(req: { runtimeKind: string }): Promise<RuntimeCredentials>;
}

export interface NormalizeContext {
  knownParticipants: Set<string>;
  execution: RunDescriptor;
  runtimeSessionId: string;
}

export interface EventNormalizer {
  normalize(runId: string, rawEvent: RawRuntimeEvent, ctx: NormalizeContext): CanonicalEvent[];
}
