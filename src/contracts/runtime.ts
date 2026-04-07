import {
  CanonicalEvent,
  ExecutionRequest,
  ParticipantRef,
  SessionState
} from './control-plane';

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

export interface RuntimeStartSessionRequest {
  runId: string;
  execution: ExecutionRequest;
}

export interface RuntimeStartSessionResult {
  runtimeSessionId: string;
  initiator: string;
  ack: RuntimeAck;
}

export interface RuntimeSendRequest {
  runId: string;
  runtimeSessionId: string;
  modeName: string;
  from: string;
  to: string[];
  messageType: string;
  payload: Buffer;
  payloadDescriptor?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface RuntimeSendResult {
  ack: RuntimeAck;
  envelope: RuntimeEnvelope;
}

export interface RuntimeStreamSessionRequest {
  runId: string;
  runtimeSessionId: string;
  modeName: string;
  subscriberId: string;
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

/** Request to open a unified bidirectional session stream */
export interface RuntimeOpenSessionRequest {
  runId: string;
  execution: ExecutionRequest;
}

/** Handle to an open bidirectional StreamSession */
export interface RuntimeSessionHandle {
  /** Send an envelope through the open stream */
  send(envelope: RuntimeEnvelope): void;
  /** Async iterable of raw events from the stream */
  events: AsyncIterable<RawRuntimeEvent>;
  /** Close the write side (after all kickoff messages sent) */
  closeWrite(): void;
  /** Abort the stream immediately */
  abort(): void;
  /** The ack derived from the SessionStart echo (resolved after first response) */
  sessionAck: Promise<RuntimeStartSessionResult>;
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

export interface RuntimeProvider {
  readonly kind: string;

  initialize(req: RuntimeInitializeRequest, opts?: RuntimeCallOptions): Promise<RuntimeInitializeResult>;

  /** Open a unified bidirectional session — replaces startSession() + streamSession() */
  openSession(req: RuntimeOpenSessionRequest): RuntimeSessionHandle;

  /** @deprecated Use openSession() for new session creation. Kept for backward compat. */
  startSession(req: RuntimeStartSessionRequest, opts?: RuntimeCallOptions): Promise<RuntimeStartSessionResult>;
  send(req: RuntimeSendRequest): Promise<RuntimeSendResult>;
  /** @deprecated Use openSession().events for streaming. Kept for reconnection fallback. */
  streamSession(req: RuntimeStreamSessionRequest): AsyncIterable<RawRuntimeEvent>;
  getSession(req: RuntimeGetSessionRequest): Promise<RuntimeSessionSnapshot>;
  cancelSession(req: RuntimeCancelSessionRequest): Promise<RuntimeCancelResult>;
  getManifest(): Promise<RuntimeManifestResult>;
  listModes(): Promise<RuntimeModeDescriptor[]>;
  listRoots(): Promise<RuntimeRootDescriptor[]>;
  health(): Promise<RuntimeHealth>;

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

export interface RuntimeCredentialResolver {
  resolve(req: {
    runtimeKind: string;
    requester?: { actorId?: string; actorType?: string };
    participant?: ParticipantRef;
    fallbackSender?: string;
  }): Promise<RuntimeCredentials>;
}

export interface NormalizeContext {
  knownParticipants: Set<string>;
  execution: ExecutionRequest;
  runtimeSessionId: string;
}

export interface EventNormalizer {
  normalize(runId: string, rawEvent: RawRuntimeEvent, ctx: NormalizeContext): CanonicalEvent[];
}
