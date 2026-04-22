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
  RuntimePolicyDescriptor,
  RuntimeProvider,
  RuntimeRegisterPolicyRequest,
  RuntimeRegisterPolicyResult,
  RuntimeRootDescriptor,
  RuntimeSessionHandle,
  RuntimeSessionSnapshot,
  RuntimeSubscribeSessionRequest,
  RuntimeUnregisterPolicyRequest,
  RuntimeUnregisterPolicyResult,
  SessionLifecycleEvent,
} from '../../src/contracts/runtime';

export interface ScriptedEvent {
  /** Delay before emitting this event (ms). */
  delayMs?: number;
  /** The raw event to emit. */
  event: RawRuntimeEvent;
}

export interface RuntimeScript {
  supportedModes: string[];
  /** Events the observer will see, in order. */
  events: ScriptedEvent[];
  /** Optional initiator identity returned from GetSession — defaults to 'mock-initiator'. */
  initiator?: string;
  /**
   * How long GetSession reports a non-OPEN state before flipping to OPEN.
   * Simulates the initiator agent opening the session. Default: 0ms (immediate).
   */
  sessionOpenAfterMs?: number;
}

/**
 * Scripted observer-mode mock runtime (direct-agent-auth CP-3).
 *
 * Simulates a runtime that agents have already connected to: `GetSession` flips from
 * `UNSPECIFIED` → `OPEN` after `sessionOpenAfterMs`, then the scripted event sequence
 * is streamed from `subscribeSession().events`.
 *
 * No `send()` / `openSession()` / `startSession()` methods — agents drive those directly
 * against the runtime; the control-plane observer never writes envelopes.
 */
export class ScriptedMockRuntimeProvider implements RuntimeProvider {
  readonly kind = 'scripted-mock';

  private script: RuntimeScript;
  private sessionState: SessionState = 'SESSION_STATE_OPEN';
  private sessionOpenAt: number = 0;
  private policies = new Map<string, RuntimePolicyDescriptor>();

  constructor(script: RuntimeScript) {
    this.script = script;
    this.sessionOpenAt = Date.now() + (script.sessionOpenAfterMs ?? 0);
  }

  /** Stub for HealthController readyz. */
  getCircuitBreakerState(): string {
    return 'CLOSED';
  }

  resetCircuitBreaker(): void {}

  setScript(script: RuntimeScript): void {
    this.script = script;
    this.sessionState = 'SESSION_STATE_OPEN';
    this.sessionOpenAt = Date.now() + (script.sessionOpenAfterMs ?? 0);
  }

  async initialize(_req: RuntimeInitializeRequest): Promise<RuntimeInitializeResult> {
    return {
      selectedProtocolVersion: '1.0',
      runtimeInfo: { name: 'scripted-mock', version: '0.0.1' },
      supportedModes: this.script.supportedModes,
    };
  }

  subscribeSession(req: RuntimeSubscribeSessionRequest): RuntimeSessionHandle {
    type ResolverFn = (value: IteratorResult<RawRuntimeEvent>) => void;
    const state = {
      resolveNextEvent: null as ResolverFn | null,
      eventQueue: [] as RawRuntimeEvent[],
      streamDone: false,
    };

    const emit = (event: RawRuntimeEvent) => {
      if (state.resolveNextEvent) {
        const resolve = state.resolveNextEvent;
        state.resolveNextEvent = null;
        resolve({ done: false, value: event });
      } else {
        state.eventQueue.push(event);
      }
    };

    // Schedule all scripted events unconditionally — observer mode.
    (async () => {
      for (const se of this.script.events) {
        if (se.delayMs) {
          await new Promise((r) => setTimeout(r, se.delayMs));
        }
        // Re-stamp session id on each envelope so it's routed to this subscriber's sessionId.
        if (se.event.kind === 'stream-envelope' && se.event.envelope) {
          emit({
            ...se.event,
            envelope: { ...se.event.envelope, sessionId: req.runtimeSessionId },
          });
        } else {
          emit(se.event);
        }
      }
      // Close the stream shortly after the last event, simulating SESSION_STATE_RESOLVED.
      await new Promise((r) => setTimeout(r, 50));
      emit({
        kind: 'session-snapshot',
        receivedAt: new Date().toISOString(),
        sessionSnapshot: { sessionId: req.runtimeSessionId, mode: '', state: 'SESSION_STATE_RESOLVED' },
      });
      state.streamDone = true;
      const pending = state.resolveNextEvent;
      state.resolveNextEvent = null;
      if (pending) pending({ done: true, value: undefined });
    })();

    const events: AsyncIterable<RawRuntimeEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<RawRuntimeEvent>> {
            if (state.eventQueue.length > 0) {
              return Promise.resolve({ done: false, value: state.eventQueue.shift()! });
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
          },
        };
      },
    };

    return {
      events,
      abort: () => {
        state.streamDone = true;
        const pending = state.resolveNextEvent;
        state.resolveNextEvent = null;
        if (pending) pending({ done: true, value: undefined });
      },
    };
  }

  async getSession(req: RuntimeGetSessionRequest): Promise<RuntimeSessionSnapshot> {
    const isOpen = Date.now() >= this.sessionOpenAt && this.sessionState !== 'SESSION_STATE_UNSPECIFIED';
    return {
      sessionId: req.runtimeSessionId,
      mode: this.script.supportedModes[0] ?? 'scripted-mock',
      state: isOpen ? this.sessionState : 'SESSION_STATE_UNSPECIFIED',
      initiator: this.script.initiator ?? 'mock-initiator',
    };
  }

  async cancelSession(req: RuntimeCancelSessionRequest): Promise<RuntimeCancelResult> {
    this.sessionState = 'SESSION_STATE_RESOLVED';
    return { ack: this.makeAck(req.runtimeSessionId) };
  }

  async getManifest(): Promise<RuntimeManifestResult> {
    return {
      agentId: 'scripted-mock',
      title: 'Scripted Mock Runtime',
      description: 'Observer-mode mock with scripted event sequences',
      supportedModes: this.script.supportedModes,
      metadata: {},
    };
  }

  async listModes(): Promise<RuntimeModeDescriptor[]> {
    return this.script.supportedModes.map((mode) => ({
      mode,
      modeVersion: '1.0',
      title: `Scripted ${mode}`,
      messageTypes: [
        'Proposal', 'Evaluation', 'Objection', 'Vote', 'Commitment',
        'TaskRequest', 'TaskAccept', 'TaskReject', 'TaskUpdate', 'TaskComplete', 'TaskFail',
        'CounterProposal', 'Accept', 'Reject', 'Withdraw',
        'HandoffOffer', 'HandoffContext', 'HandoffAccept', 'HandoffDecline',
        'ApprovalRequest', 'Approve', 'Abstain', 'Signal',
      ],
      terminalMessageTypes: ['Commitment'],
    }));
  }

  async listRoots(): Promise<RuntimeRootDescriptor[]> {
    return [];
  }

  async health(): Promise<RuntimeHealth> {
    return { ok: true, runtimeKind: this.kind, detail: 'scripted mock runtime always healthy' };
  }

  async registerPolicy(req: RuntimeRegisterPolicyRequest): Promise<RuntimeRegisterPolicyResult> {
    this.policies.set(req.descriptor.policyId, { ...req.descriptor, registeredAtUnixMs: Date.now() });
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

  // ── Session lifecycle observation (stub) ────────────────────────────

  async listSessions(): Promise<RuntimeSessionSnapshot[]> {
    return [];
  }

  async *watchSessions(): AsyncIterable<SessionLifecycleEvent> {
    // Scripted mock does not produce session lifecycle events — tests that need
    // them should use a dedicated fixture or override this method.
  }

  async *watchSignals(): AsyncIterable<RawRuntimeEvent> {
    // Scripted mock does not produce ambient Signal/Progress envelopes —
    // tests that need them should override this method.
  }

  private makeAck(sessionId: string, messageId?: string): RuntimeAck {
    return {
      ok: true,
      duplicate: false,
      messageId: messageId ?? randomUUID(),
      sessionId,
      acceptedAtUnixMs: Date.now(),
      sessionState: 'SESSION_STATE_OPEN',
    };
  }
}

// ── Event Builder Helpers ───────────────────────────────────────────

export function makeStreamOpened(): RawRuntimeEvent {
  return {
    kind: 'stream-status',
    receivedAt: new Date().toISOString(),
    streamStatus: { status: 'opened' },
  };
}

export function makeSessionSnapshot(
  sessionId: string,
  mode: string,
  state: SessionState = 'SESSION_STATE_OPEN',
): RawRuntimeEvent {
  return {
    kind: 'session-snapshot',
    receivedAt: new Date().toISOString(),
    sessionSnapshot: { sessionId, mode, state },
  };
}

export function makeSessionResolved(sessionId: string): RawRuntimeEvent {
  return {
    kind: 'session-snapshot',
    receivedAt: new Date().toISOString(),
    sessionSnapshot: { sessionId, mode: '', state: 'SESSION_STATE_RESOLVED' },
  };
}

export function makeStreamEnvelope(
  mode: string,
  messageType: string,
  sender: string,
  payload: Record<string, unknown>,
  sessionId?: string,
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
      payload: Buffer.from(JSON.stringify(payload)),
    },
  };
}

export function makeSendAck(sessionId: string, messageId?: string): RawRuntimeEvent {
  return {
    kind: 'send-ack',
    receivedAt: new Date().toISOString(),
    ack: {
      ok: true,
      duplicate: false,
      messageId: messageId ?? randomUUID(),
      sessionId,
      acceptedAtUnixMs: Date.now(),
      sessionState: 'SESSION_STATE_OPEN',
    },
  };
}
