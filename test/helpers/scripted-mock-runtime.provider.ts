import { randomUUID } from 'node:crypto';
import { SessionState } from '../../src/contracts/control-plane';
import {
  RawRuntimeEvent,
  RuntimeAck,
  RuntimeCancelResult,
  RuntimeCancelSessionRequest,
  RuntimeGetPolicyRequest,
  RuntimeGetSessionRequest,
  RuntimeHealth,
  RuntimeInitializeRequest,
  RuntimeInitializeResult,
  RuntimeListPoliciesRequest,
  RuntimeManifestResult,
  RuntimeModeDescriptor,
  RuntimeOpenSessionRequest,
  RuntimePolicyDescriptor,
  RuntimeProvider,
  RuntimeRegisterPolicyRequest,
  RuntimeRegisterPolicyResult,
  RuntimeRootDescriptor,
  RuntimeSendRequest,
  RuntimeSendResult,
  RuntimeSessionHandle,
  RuntimeSessionSnapshot,
  RuntimeStartSessionRequest,
  RuntimeStartSessionResult,
  RuntimeStreamSessionRequest,
  RuntimeUnregisterPolicyRequest,
  RuntimeUnregisterPolicyResult
} from '../../src/contracts/runtime';

export interface ScriptedEvent {
  /** Delay before emitting this event (ms) */
  delayMs?: number;
  /** Emit only after a message of this type is received via send() */
  trigger?: { afterMessageType: string; fromParticipant?: string };
  /** The raw event to emit */
  event: RawRuntimeEvent;
}

export interface RuntimeScript {
  supportedModes: string[];
  events: ScriptedEvent[];
  /** Called on every send() — can return additional events to emit */
  onSend?: (req: RuntimeSendRequest) => RawRuntimeEvent[] | undefined;
}

interface SentMessage {
  req: RuntimeSendRequest;
  at: string;
}

/**
 * Enhanced mock runtime that follows a scripted sequence of events.
 * Used for integration testing where we need deterministic, multi-step
 * coordination flows without a real gRPC runtime.
 */
export class ScriptedMockRuntimeProvider implements RuntimeProvider {
  readonly kind = 'scripted-mock';
  readonly sentMessages: SentMessage[] = [];

  private script: RuntimeScript;
  private sessionState: SessionState = 'SESSION_STATE_OPEN';
  private pendingTriggerEvents: ScriptedEvent[] = [];
  private eventEmitter: ((event: RawRuntimeEvent) => void) | null = null;
  private policies = new Map<string, RuntimePolicyDescriptor>();

  constructor(script: RuntimeScript) {
    this.script = script;
  }

  /** Stub for HealthController readyz — mock is always CLOSED */
  getCircuitBreakerState(): string {
    return 'CLOSED';
  }

  /** Stub for HealthController */
  resetCircuitBreaker(): void {}

  /** Replace the script (useful for per-test configuration) */
  setScript(script: RuntimeScript): void {
    this.script = script;
    this.sentMessages.length = 0;
    this.sessionState = 'SESSION_STATE_OPEN';
    this.pendingTriggerEvents = [];
  }

  async initialize(
    _req: RuntimeInitializeRequest
  ): Promise<RuntimeInitializeResult> {
    return {
      selectedProtocolVersion: '1.0',
      runtimeInfo: { name: 'scripted-mock', version: '0.0.1' },
      supportedModes: this.script.supportedModes
    };
  }

  openSession(req: RuntimeOpenSessionRequest): RuntimeSessionHandle {
    const sessionId = randomUUID();
    const initiator =
      req.execution.session.participants[0]?.id ?? 'mock-initiator';
    const ack = this.makeAck(sessionId);

    // Separate trigger-based events from immediate/delayed events
    const immediateEvents: ScriptedEvent[] = [];
    this.pendingTriggerEvents = [];
    for (const se of this.script.events) {
      if (se.trigger) {
        this.pendingTriggerEvents.push(se);
      } else {
        immediateEvents.push(se);
      }
    }

    const self = this;
    type ResolverFn = (value: IteratorResult<RawRuntimeEvent>) => void;
    const state = {
      resolveNextEvent: null as ResolverFn | null,
      eventQueue: [] as RawRuntimeEvent[],
      streamDone: false
    };

    self.eventEmitter = (event: RawRuntimeEvent) => {
      if (state.resolveNextEvent) {
        const resolve = state.resolveNextEvent;
        state.resolveNextEvent = null;
        resolve({ done: false, value: event });
      } else {
        state.eventQueue.push(event);
      }
    };

    // Schedule immediate events
    (async () => {
      for (const se of immediateEvents) {
        if (se.delayMs) {
          await new Promise((r) => setTimeout(r, se.delayMs));
        }
        self.eventEmitter?.(se.event);
      }
      // If no trigger events remain, close after a short delay
      if (self.pendingTriggerEvents.length === 0) {
        await new Promise((r) => setTimeout(r, 50));
        state.streamDone = true;
        const pending = state.resolveNextEvent;
        state.resolveNextEvent = null;
        if (pending) {
          pending({ done: true, value: undefined });
        }
      }
    })();

    const events: AsyncIterable<RawRuntimeEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<RawRuntimeEvent>> {
            if (state.eventQueue.length > 0) {
              return Promise.resolve({
                done: false,
                value: state.eventQueue.shift()!
              });
            }
            if (state.streamDone) {
              return Promise.resolve({ done: true, value: undefined });
            }
            return new Promise((resolve) => {
              state.resolveNextEvent = resolve;
            });
          },
          return(): Promise<IteratorResult<RawRuntimeEvent>> {
            state.streamDone = true;
            return Promise.resolve({ done: true, value: undefined });
          }
        };
      }
    };

    const handle: RuntimeSessionHandle = {
      send: () => {
        /* Messages from control plane (kickoff) go through here */
      },
      events,
      closeWrite: () => {
        /* Half-close write side */
      },
      abort: () => {
        state.streamDone = true;
        const pending = state.resolveNextEvent;
        state.resolveNextEvent = null;
        if (pending) {
          pending({ done: true, value: undefined });
        }
      },
      sessionAck: Promise.resolve({
        runtimeSessionId: sessionId,
        initiator,
        ack
      })
    };

    return handle;
  }

  async send(req: RuntimeSendRequest): Promise<RuntimeSendResult> {
    const messageId = randomUUID();
    this.sentMessages.push({ req, at: new Date().toISOString() });

    // Check for triggered events
    const toFire: ScriptedEvent[] = [];
    this.pendingTriggerEvents = this.pendingTriggerEvents.filter((se) => {
      const trigger = se.trigger!;
      const typeMatch = trigger.afterMessageType === req.messageType;
      const participantMatch =
        !trigger.fromParticipant || trigger.fromParticipant === req.from;
      if (typeMatch && participantMatch) {
        toFire.push(se);
        return false; // Remove from pending
      }
      return true;
    });

    // Fire triggered events
    for (const se of toFire) {
      if (se.delayMs) {
        setTimeout(() => this.eventEmitter?.(se.event), se.delayMs);
      } else {
        // Small delay to ensure ordering
        setTimeout(() => this.eventEmitter?.(se.event), 10);
      }
    }

    // Call onSend hook
    if (this.script.onSend) {
      const extraEvents = this.script.onSend(req);
      if (extraEvents) {
        for (const event of extraEvents) {
          setTimeout(() => this.eventEmitter?.(event), 20);
        }
      }
    }

    // If no more pending triggers and this is a session-bound message,
    // schedule stream end. Skip for signals (empty sessionId).
    if (
      this.pendingTriggerEvents.length === 0 &&
      req.runtimeSessionId !== ''
    ) {
      setTimeout(() => {
        this.eventEmitter?.(makeSessionResolved(req.runtimeSessionId));
      }, 100);
    }

    return {
      ack: this.makeAck(req.runtimeSessionId, messageId),
      envelope: {
        macpVersion: '1.0',
        mode: req.modeName,
        messageType: req.messageType,
        messageId,
        sessionId: req.runtimeSessionId,
        sender: req.from,
        timestampUnixMs: Date.now(),
        payload: req.payload
      }
    };
  }

  async startSession(
    req: RuntimeStartSessionRequest
  ): Promise<RuntimeStartSessionResult> {
    const sessionId = randomUUID();
    return {
      runtimeSessionId: sessionId,
      initiator:
        req.execution.session.participants[0]?.id ?? 'mock-initiator',
      ack: this.makeAck(sessionId)
    };
  }

  async *streamSession(
    _req: RuntimeStreamSessionRequest
  ): AsyncIterable<RawRuntimeEvent> {
    yield {
      kind: 'stream-status',
      receivedAt: new Date().toISOString(),
      streamStatus: { status: 'opened' }
    };
  }

  async getSession(
    req: RuntimeGetSessionRequest
  ): Promise<RuntimeSessionSnapshot> {
    return {
      sessionId: req.runtimeSessionId,
      mode: this.script.supportedModes[0] ?? 'scripted-mock',
      state: this.sessionState
    };
  }

  async cancelSession(
    req: RuntimeCancelSessionRequest
  ): Promise<RuntimeCancelResult> {
    this.sessionState = 'SESSION_STATE_RESOLVED';
    return { ack: this.makeAck(req.runtimeSessionId) };
  }

  async getManifest(): Promise<RuntimeManifestResult> {
    return {
      agentId: 'scripted-mock',
      title: 'Scripted Mock Runtime',
      description: 'Integration test runtime with scripted event sequences',
      supportedModes: this.script.supportedModes,
      metadata: {}
    };
  }

  async listModes(): Promise<RuntimeModeDescriptor[]> {
    return this.script.supportedModes.map((mode) => ({
      mode,
      modeVersion: '1.0',
      title: `Scripted ${mode}`,
      messageTypes: [
        'Proposal',
        'Evaluation',
        'Objection',
        'Vote',
        'Commitment',
        'TaskRequest',
        'TaskAccept',
        'TaskReject',
        'TaskUpdate',
        'TaskComplete',
        'TaskFail',
        'CounterProposal',
        'Accept',
        'Reject',
        'Withdraw',
        'HandoffOffer',
        'HandoffContext',
        'HandoffAccept',
        'HandoffDecline',
        'ApprovalRequest',
        'Approve',
        'Abstain',
        'Signal'
      ],
      terminalMessageTypes: ['Commitment']
    }));
  }

  async listRoots(): Promise<RuntimeRootDescriptor[]> {
    return [];
  }

  async health(): Promise<RuntimeHealth> {
    return {
      ok: true,
      runtimeKind: this.kind,
      detail: 'scripted mock runtime always healthy'
    };
  }

  async registerPolicy(req: RuntimeRegisterPolicyRequest): Promise<RuntimeRegisterPolicyResult> {
    this.policies.set(req.descriptor.policyId, {
      ...req.descriptor,
      registeredAtUnixMs: Date.now()
    });
    return { ok: true };
  }

  async unregisterPolicy(req: RuntimeUnregisterPolicyRequest): Promise<RuntimeUnregisterPolicyResult> {
    this.policies.delete(req.policyId);
    return { ok: true };
  }

  async getPolicy(req: RuntimeGetPolicyRequest): Promise<RuntimePolicyDescriptor> {
    const policy = this.policies.get(req.policyId);
    if (!policy) {
      return { policyId: req.policyId, mode: '', description: 'not found', rules: Buffer.from('{}'), schemaVersion: 0 };
    }
    return policy;
  }

  async listPolicies(req?: RuntimeListPoliciesRequest): Promise<RuntimePolicyDescriptor[]> {
    const all = Array.from(this.policies.values());
    if (req?.mode) {
      return all.filter((p) => p.mode === req.mode || p.mode === '*');
    }
    return all;
  }

  private makeAck(sessionId: string, messageId?: string): RuntimeAck {
    return {
      ok: true,
      duplicate: false,
      messageId: messageId ?? randomUUID(),
      sessionId,
      acceptedAtUnixMs: Date.now(),
      sessionState: 'SESSION_STATE_OPEN'
    };
  }
}

// ── Event Builder Helpers ───────────────────────────────────────────

export function makeStreamOpened(): RawRuntimeEvent {
  return {
    kind: 'stream-status',
    receivedAt: new Date().toISOString(),
    streamStatus: { status: 'opened' }
  };
}

export function makeSessionSnapshot(
  sessionId: string,
  mode: string,
  state: SessionState = 'SESSION_STATE_OPEN'
): RawRuntimeEvent {
  return {
    kind: 'session-snapshot',
    receivedAt: new Date().toISOString(),
    sessionSnapshot: { sessionId, mode, state }
  };
}

export function makeSessionResolved(sessionId: string): RawRuntimeEvent {
  return {
    kind: 'session-snapshot',
    receivedAt: new Date().toISOString(),
    sessionSnapshot: {
      sessionId,
      mode: '',
      state: 'SESSION_STATE_RESOLVED'
    }
  };
}

export function makeStreamEnvelope(
  mode: string,
  messageType: string,
  sender: string,
  payload: Record<string, unknown>,
  sessionId?: string
): RawRuntimeEvent {
  return {
    kind: 'stream-envelope',
    receivedAt: new Date().toISOString(),
    envelope: {
      macpVersion: '1.0',
      mode,
      messageType,
      messageId: randomUUID(),
      sessionId: sessionId ?? randomUUID(),
      sender,
      timestampUnixMs: Date.now(),
      payload: Buffer.from(JSON.stringify(payload))
    }
  };
}

export function makeSendAck(
  sessionId: string,
  messageId?: string
): RawRuntimeEvent {
  return {
    kind: 'send-ack',
    receivedAt: new Date().toISOString(),
    ack: {
      ok: true,
      duplicate: false,
      messageId: messageId ?? randomUUID(),
      sessionId,
      acceptedAtUnixMs: Date.now(),
      sessionState: 'SESSION_STATE_OPEN'
    }
  };
}
