/* eslint-disable @typescript-eslint/no-explicit-any -- gRPC dynamic proto loading returns untyped objects */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import {
  RawRuntimeEvent,
  RuntimeCancelResult,
  RuntimeCancelSessionRequest,
  RuntimeGetSessionRequest,
  RuntimeHealth,
  RuntimeInitializeRequest,
  RuntimeInitializeResult,
  RuntimeManifestResult,
  RuntimeModeDescriptor,
  RuntimeProvider,
  RuntimeRootDescriptor,
  RuntimeSessionHandle,
  RuntimeSessionSnapshot,
  RuntimeSubscribeSessionRequest,
  RuntimeRegisterPolicyRequest,
  RuntimeRegisterPolicyResult,
  RuntimeUnregisterPolicyRequest,
  RuntimeUnregisterPolicyResult,
  RuntimeGetPolicyRequest,
  RuntimeListPoliciesRequest,
  RuntimePolicyDescriptor,
  SessionLifecycleEvent
} from '../contracts/runtime';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { CircuitBreaker } from './circuit-breaker';
import { buildMetadata, fromAck, fromEnvelope, fromSessionMetadata, getClientMethod } from './grpc-helpers';
import { RuntimeCredentialResolverService } from './runtime-credential-resolver.service';

export interface GrpcCallOptions {
  deadline?: Date;
}

/**
 * Observer-only Rust runtime provider.
 *
 * **Invariants (direct-agent-auth.md §Invariants):**
 *  - Never calls `Send`. Agents emit their own envelopes directly against the runtime.
 *  - Never allocates a sessionId. The control-plane allocates at POST /runs; the initiator
 *    agent calls SessionStart with its own Bearer token.
 *  - `subscribeSession()` attaches a read-only bidi `StreamSession`. Per RFC-MACP-0006 §3.2
 *    the control-plane writes exactly one passive-subscribe frame
 *    (`{subscribeSessionId, afterSequence}`, no envelope) to bind the stream to the
 *    session's broadcast channel and request history replay, then closes the write side.
 *    It never writes an envelope (no SessionStart, no SessionWatch).
 *
 * The previously-shipped `openSession()` / `startSession()` / `send()` / `chooseInitiator()`
 * paths were deleted in CP-3 because they violated §2, §3, and §5 of the plan's invariants.
 */
@Injectable()
export class RustRuntimeProvider implements RuntimeProvider, OnModuleInit {
  readonly kind = 'rust';
  private readonly logger = new Logger(RustRuntimeProvider.name);
  private client!: any;
  private serviceConstructor!: any;
  private runtimeAddress!: string;
  private channelCreds!: grpc.ChannelCredentials;
  private circuitBreaker!: CircuitBreaker;

  constructor(
    private readonly config: AppConfigService,
    private readonly credentialResolver: RuntimeCredentialResolverService,
    private readonly instrumentation: InstrumentationService
  ) {}

  getCircuitBreakerState() {
    return this.circuitBreaker.getState();
  }

  getCircuitBreakerHistory(since?: string) {
    return this.circuitBreaker.getHistory(since);
  }

  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  onModuleInit(): void {
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: this.config.runtimeCircuitBreakerThreshold,
      resetTimeoutMs: this.config.runtimeCircuitBreakerResetMs,
      instrumentation: this.instrumentation,
      isExpectedError: (error: unknown) => {
        const code = (error as grpc.ServiceError)?.code;
        return code === grpc.status.NOT_FOUND || code === grpc.status.PERMISSION_DENIED;
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { protoDir } = require('@multiagentcoordinationprotocol/proto');
    const packageDefinition = protoLoader.loadSync(
      [
        path.join(protoDir, 'macp/v1/core.proto'),
        path.join(protoDir, 'macp/v1/envelope.proto'),
        path.join(protoDir, 'macp/v1/policy.proto')
      ],
      {
        keepCase: false,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [protoDir]
      }
    );
    const descriptor = grpc.loadPackageDefinition(packageDefinition) as any;
    this.serviceConstructor = descriptor.macp.v1.MACPRuntimeService;
    this.runtimeAddress = this.config.runtimeAddress;
    this.channelCreds = this.config.runtimeTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
    this.client = this.createClient();
  }

  /** Create a fresh gRPC channel to the runtime. */
  private createClient(): any {
    return new this.serviceConstructor(this.runtimeAddress, this.channelCreds);
  }

  async initialize(req: RuntimeInitializeRequest, opts?: GrpcCallOptions): Promise<RuntimeInitializeResult> {
    const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
    const response = await this.unary(
      'Initialize',
      {
        supportedProtocolVersions: ['1.0'],
        clientInfo: {
          name: req.clientName,
          title: req.clientName,
          version: req.clientVersion,
          description: 'MACP Control Plane (observer)',
          websiteUrl: ''
        },
        capabilities: {
          sessions: { stream: true },
          cancellation: { cancelSession: true },
          progress: { progress: true },
          manifest: { getManifest: true },
          modeRegistry: { listModes: true, listChanged: false },
          roots: { listRoots: true, listChanged: false },
          policyRegistry: { registerPolicy: true, listPolicies: true, listChanged: false },
          experimental: { features: {} }
        }
      },
      buildMetadata(creds.metadata),
      opts
    );

    return {
      selectedProtocolVersion: response.selectedProtocolVersion,
      runtimeInfo: {
        name: response.runtimeInfo?.name ?? 'macp-runtime',
        title: response.runtimeInfo?.title,
        version: response.runtimeInfo?.version,
        description: response.runtimeInfo?.description,
        websiteUrl: response.runtimeInfo?.websiteUrl
      },
      supportedModes: response.supportedModes ?? [],
      instructions: response.instructions || undefined,
      capabilities: response.capabilities
        ? {
            sessions: response.capabilities.sessions,
            cancellation: response.capabilities.cancellation,
            progress: response.capabilities.progress,
            manifest: response.capabilities.manifest,
            modeRegistry: response.capabilities.modeRegistry,
            roots: response.capabilities.roots,
            policyRegistry: response.capabilities.policyRegistry
          }
        : undefined
    };
  }

  subscribeSession(req: RuntimeSubscribeSessionRequest): RuntimeSessionHandle {
    // Event-driven async queue for the read-only stream
    const buffer: RawRuntimeEvent[] = [];
    let resolveWait: (() => void) | null = null;
    let ended = false;
    let streamFailure: Error | null = null;
    let grpcCall: any = null;

    const notify = () => {
      if (resolveWait) {
        const r = resolveWait;
        resolveWait = null;
        r();
      }
    };

    const waitForItem = (): Promise<void> =>
      new Promise<void>((r) => {
        if (buffer.length > 0 || ended) {
          r();
        } else {
          resolveWait = r;
        }
      });

    const launch = async () => {
      try {
        const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
        const metadata = buildMetadata(creds.metadata);
        const streamMethod = getClientMethod(this.client, 'StreamSession');
        grpcCall = streamMethod.call(this.client, metadata);

        grpcCall.on('data', (chunk: any) => {
          const receivedAt = new Date().toISOString();

          const responseBody = chunk.response ?? chunk;
          if (responseBody.error) {
            const inlineError = responseBody.error;
            buffer.push({
              kind: 'stream-inline-error',
              receivedAt,
              inlineError: {
                code: inlineError.code ?? 'UNKNOWN',
                message: inlineError.message ?? '',
                sessionId: inlineError.sessionId ?? '',
                messageId: inlineError.messageId ?? ''
              }
            });
            notify();
            return;
          }

          const rawEnvelope = responseBody.envelope ?? chunk.envelope;
          if (!rawEnvelope) return;

          // Filter to the session we're observing. Runtime may broadcast across sessions
          // on a shared stream; we only care about `req.runtimeSessionId`.
          const envelope = fromEnvelope(rawEnvelope);
          if (envelope.sessionId && envelope.sessionId !== req.runtimeSessionId) return;

          buffer.push({ kind: 'stream-envelope', receivedAt, envelope });
          notify();
        });

        grpcCall.on('error', (error: Error) => {
          streamFailure = error;
          ended = true;
          notify();
        });

        grpcCall.on('end', () => {
          ended = true;
          notify();
        });

        // RFC-MACP-0006 §3.2: write a passive-subscribe frame so the runtime binds
        // this stream to the session's broadcast channel and replays accepted
        // history from `afterSequence` onwards.
        //
        // We deliberately do NOT half-close the write side here. The runtime's
        // StreamSession loop treats client half-close as "client is done with
        // the stream entirely" and breaks after draining queued envelopes —
        // dropping every envelope broadcast after the half-close. Keeping the
        // bidi stream open lets the runtime continue forwarding live envelopes
        // (Vote, Commitment, etc.) for the session's full lifetime.
        try {
          grpcCall.write({
            subscribeSessionId: req.runtimeSessionId,
            afterSequence: req.afterSequence ?? 0
          });
        } catch (error) {
          streamFailure = error instanceof Error ? error : new Error(String(error));
          ended = true;
          notify();
          return;
        }
      } catch (error) {
        streamFailure = error instanceof Error ? error : new Error(String(error));
        ended = true;
        notify();
      }
    };

    void launch();

    const events: AsyncIterable<RawRuntimeEvent> = {
      [Symbol.asyncIterator]() {
        let started = false;
        return {
          async next(): Promise<IteratorResult<RawRuntimeEvent>> {
            if (!started) {
              started = true;
              return {
                done: false,
                value: {
                  kind: 'stream-status',
                  receivedAt: new Date().toISOString(),
                  streamStatus: { status: 'opened' }
                }
              };
            }

            while (true) {
              if (buffer.length > 0) {
                return { done: false, value: buffer.shift()! };
              }
              if (ended) {
                if (streamFailure) throw streamFailure;
                return { done: true, value: undefined };
              }
              await waitForItem();
            }
          },
          async return(): Promise<IteratorResult<RawRuntimeEvent>> {
            if (grpcCall) {
              try {
                grpcCall.cancel();
              } catch {
                /* ignore */
              }
            }
            return { done: true, value: undefined };
          }
        };
      }
    };

    return {
      events,
      abort: () => {
        ended = true;
        if (grpcCall) {
          try {
            grpcCall.cancel();
          } catch {
            /* ignore */
          }
        }
        notify();
      }
    };
  }

  async getSession(req: RuntimeGetSessionRequest): Promise<RuntimeSessionSnapshot> {
    const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
    const response = await this.unary('GetSession', { sessionId: req.runtimeSessionId }, buildMetadata(creds.metadata));
    return fromSessionMetadata(response.metadata);
  }

  async cancelSession(req: RuntimeCancelSessionRequest): Promise<RuntimeCancelResult> {
    const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
    const response = await this.unary(
      'CancelSession',
      { sessionId: req.runtimeSessionId, reason: req.reason ?? 'cancelled by control plane' },
      buildMetadata(creds.metadata)
    );
    return { ack: fromAck(response.ack) };
  }

  async getManifest(): Promise<RuntimeManifestResult> {
    const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
    const response = await this.unary('GetManifest', { agentId: '' }, buildMetadata(creds.metadata));
    return {
      agentId: response.manifest?.agentId ?? 'macp-runtime',
      title: response.manifest?.title,
      description: response.manifest?.description,
      supportedModes: response.manifest?.supportedModes ?? [],
      metadata: response.manifest?.metadata ?? {}
    };
  }

  async listModes(): Promise<RuntimeModeDescriptor[]> {
    const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
    const response = await this.unary('ListModes', {}, buildMetadata(creds.metadata));
    return (response.modes ?? []).map((mode: any) => ({
      mode: mode.mode,
      modeVersion: mode.modeVersion,
      title: mode.title,
      description: mode.description,
      determinismClass: mode.determinismClass,
      participantModel: mode.participantModel,
      messageTypes: mode.messageTypes ?? [],
      terminalMessageTypes: mode.terminalMessageTypes ?? [],
      schemaUris: mode.schemaUris ?? {}
    }));
  }

  async listRoots(): Promise<RuntimeRootDescriptor[]> {
    const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
    const response = await this.unary('ListRoots', {}, buildMetadata(creds.metadata));
    return (response.roots ?? []).map((root: any) => ({ uri: root.uri, name: root.name }));
  }

  async health(): Promise<RuntimeHealth> {
    try {
      const manifest = await this.getManifest();
      return {
        ok: true,
        runtimeKind: this.kind,
        manifest,
        detail: `connected to ${this.config.runtimeAddress}`
      };
    } catch (error) {
      return {
        ok: false,
        runtimeKind: this.kind,
        detail: error instanceof Error ? error.message : 'runtime unavailable'
      };
    }
  }

  // ── Session lifecycle observation ─────────────────────────────────

  async listSessions(): Promise<RuntimeSessionSnapshot[]> {
    const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
    const response = await this.unary('ListSessions', {}, buildMetadata(creds.metadata));
    return (response.sessions ?? []).map((s: any) => fromSessionMetadata(s));
  }

  watchSessions(): AsyncIterable<SessionLifecycleEvent> {
    // Capture instance deps before the closure so the `this` alias lint rule is satisfied.
    const credentialResolver = this.credentialResolver;
    const client = this.client;
    const kind = this.kind;

    return {
      [Symbol.asyncIterator]() {
        let grpcCall: any = null;
        const buffer: SessionLifecycleEvent[] = [];
        let resolveWait: (() => void) | null = null;
        let ended = false;
        let streamError: Error | null = null;

        const notify = () => {
          if (resolveWait) {
            const r = resolveWait;
            resolveWait = null;
            r();
          }
        };

        const launch = async () => {
          try {
            const creds = await credentialResolver.resolve({ runtimeKind: kind });
            const metadata = buildMetadata(creds.metadata);
            const method = getClientMethod(client, 'WatchSessions');
            grpcCall = method.call(client, {}, metadata);

            grpcCall.on('data', (chunk: any) => {
              const event = chunk.event;
              if (!event) return;
              const eventTypeRaw = event.eventType ?? event.event_type ?? '';
              let eventType: 'created' | 'resolved' | 'expired' = 'created';
              if (eventTypeRaw === 'EVENT_TYPE_RESOLVED' || eventTypeRaw === 1) eventType = 'resolved';
              else if (eventTypeRaw === 'EVENT_TYPE_EXPIRED' || eventTypeRaw === 2) eventType = 'expired';
              else if (eventTypeRaw === 'EVENT_TYPE_CREATED' || eventTypeRaw === 0) eventType = 'created';

              buffer.push({
                eventType,
                session: fromSessionMetadata(event.session),
                observedAtUnixMs: event.observedAtUnixMs ? Number(event.observedAtUnixMs) : Date.now()
              });
              notify();
            });

            grpcCall.on('error', (err: Error) => {
              streamError = err;
              ended = true;
              notify();
            });
            grpcCall.on('end', () => {
              ended = true;
              notify();
            });
          } catch (err) {
            streamError = err instanceof Error ? err : new Error(String(err));
            ended = true;
            notify();
          }
        };

        void launch();

        return {
          async next(): Promise<IteratorResult<SessionLifecycleEvent>> {
            while (true) {
              if (buffer.length > 0) return { done: false, value: buffer.shift()! };
              if (ended) {
                if (streamError) throw streamError;
                return { done: true, value: undefined };
              }
              await new Promise<void>((r) => {
                if (buffer.length > 0 || ended) r();
                else resolveWait = r;
              });
            }
          },
          async return(): Promise<IteratorResult<SessionLifecycleEvent>> {
            if (grpcCall) {
              try {
                grpcCall.cancel();
              } catch {
                /* ignore */
              }
            }
            return { done: true, value: undefined };
          }
        };
      }
    };
  }

  /**
   * Subscribe to the runtime's WatchSignals stream. Mirrors the watchSessions
   * pattern: long-lived async iterable that yields a RawRuntimeEvent per Signal
   * or Progress envelope, with auto-cancel on consumer return().
   */
  watchSignals(): AsyncIterable<RawRuntimeEvent> {
    const credentialResolver = this.credentialResolver;
    const client = this.client;
    const kind = this.kind;

    return {
      [Symbol.asyncIterator]() {
        let grpcCall: any = null;
        const buffer: RawRuntimeEvent[] = [];
        let resolveWait: (() => void) | null = null;
        let ended = false;
        let streamError: Error | null = null;

        const notify = () => {
          if (resolveWait) {
            const r = resolveWait;
            resolveWait = null;
            r();
          }
        };

        const launch = async () => {
          try {
            const creds = await credentialResolver.resolve({ runtimeKind: kind });
            const metadata = buildMetadata(creds.metadata);
            const method = getClientMethod(client, 'WatchSignals');
            grpcCall = method.call(client, {}, metadata);

            grpcCall.on('data', (chunk: any) => {
              const receivedAt = new Date().toISOString();
              const rawEnvelope = chunk.envelope ?? chunk.signal ?? chunk;
              if (!rawEnvelope || (!rawEnvelope.messageType && !rawEnvelope.message_type)) return;
              const envelope = fromEnvelope(rawEnvelope);
              buffer.push({ kind: 'stream-envelope', receivedAt, envelope });
              notify();
            });

            grpcCall.on('error', (err: Error) => {
              streamError = err;
              ended = true;
              notify();
            });
            grpcCall.on('end', () => {
              ended = true;
              notify();
            });
          } catch (err) {
            streamError = err instanceof Error ? err : new Error(String(err));
            ended = true;
            notify();
          }
        };

        void launch();

        return {
          async next(): Promise<IteratorResult<RawRuntimeEvent>> {
            while (true) {
              if (buffer.length > 0) return { done: false, value: buffer.shift()! };
              if (ended) {
                if (streamError) throw streamError;
                return { done: true, value: undefined };
              }
              await new Promise<void>((r) => {
                if (buffer.length > 0 || ended) r();
                else resolveWait = r;
              });
            }
          },
          async return(): Promise<IteratorResult<RawRuntimeEvent>> {
            if (grpcCall) {
              try {
                grpcCall.cancel();
              } catch {
                /* ignore */
              }
            }
            return { done: true, value: undefined };
          }
        };
      }
    };
  }

  // ── Governance policy lifecycle (RFC-MACP-0012) ──────────────────

  async registerPolicy(req: RuntimeRegisterPolicyRequest): Promise<RuntimeRegisterPolicyResult> {
    const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
    const descriptor = req.descriptor;
    const response = await this.unary(
      'RegisterPolicy',
      {
        policyDescriptor: {
          policyId: descriptor.policyId,
          mode: descriptor.mode,
          description: descriptor.description,
          rules: typeof descriptor.rules === 'string' ? Buffer.from(descriptor.rules) : descriptor.rules,
          schemaVersion: descriptor.schemaVersion
        }
      },
      buildMetadata(creds.metadata)
    );
    return { ok: response.ok ?? false, error: response.error || undefined };
  }

  async unregisterPolicy(req: RuntimeUnregisterPolicyRequest): Promise<RuntimeUnregisterPolicyResult> {
    const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
    const response = await this.unary('UnregisterPolicy', { policyId: req.policyId }, buildMetadata(creds.metadata));
    return { ok: response.ok ?? false, error: response.error || undefined };
  }

  async getPolicy(req: RuntimeGetPolicyRequest): Promise<RuntimePolicyDescriptor> {
    const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
    const response = await this.unary('GetPolicy', { policyId: req.policyId }, buildMetadata(creds.metadata));
    const d = response.policyDescriptor ?? response.descriptor;
    return {
      policyId: d.policyId,
      mode: d.mode,
      description: d.description,
      rules: d.rules,
      schemaVersion: d.schemaVersion ?? 1,
      registeredAtUnixMs: d.registeredAtUnixMs ? Number(d.registeredAtUnixMs) : undefined
    };
  }

  async listPolicies(req?: RuntimeListPoliciesRequest): Promise<RuntimePolicyDescriptor[]> {
    const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
    const response = await this.unary('ListPolicies', { mode: req?.mode ?? '' }, buildMetadata(creds.metadata));
    return (response.descriptors ?? []).map((d: any) => ({
      policyId: d.policyId,
      mode: d.mode,
      description: d.description,
      rules: d.rules,
      schemaVersion: d.schemaVersion ?? 1,
      registeredAtUnixMs: d.registeredAtUnixMs ? Number(d.registeredAtUnixMs) : undefined
    }));
  }

  private async unary(
    method: string,
    request: unknown,
    metadata?: grpc.Metadata,
    opts?: GrpcCallOptions
  ): Promise<any> {
    const start = Date.now();
    try {
      const result = await this.circuitBreaker.execute(() => {
        const clientMethod = getClientMethod(this.client, method);
        const deadline = opts?.deadline ?? new Date(Date.now() + this.config.runtimeRequestTimeoutMs);
        return new Promise((resolve, reject) => {
          const callback = (error: grpc.ServiceError | null, response: any) => {
            if (error) return reject(error);
            resolve(response);
          };
          if (metadata) {
            clientMethod.call(this.client, request, metadata, { deadline }, callback);
          } else {
            clientMethod.call(this.client, request, { deadline }, callback);
          }
        });
      });
      this.instrumentation.grpcCallDuration.observe({ method, status: 'ok' }, (Date.now() - start) / 1000);
      return result;
    } catch (error) {
      const grpcErr = error as grpc.ServiceError;
      this.logger.error(`gRPC ${method} failed: code=${grpcErr.code} details="${grpcErr.details ?? grpcErr.message}"`);
      this.instrumentation.grpcCallDuration.observe({ method, status: 'error' }, (Date.now() - start) / 1000);
      throw error;
    }
  }
}
