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
  RuntimePolicyDescriptor
} from '../contracts/runtime';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { CircuitBreaker } from './circuit-breaker';
import {
  buildMetadata,
  fromAck,
  fromEnvelope,
  fromSessionMetadata,
  getClientMethod,
} from './grpc-helpers';
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
 *  - `subscribeSession()` attaches a read-only bidi `StreamSession` — the control-plane
 *    only reads; it does not write the first frame (no SessionStart, no SessionWatch).
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
      instrumentation: this.instrumentation
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
    this.channelCreds = this.config.runtimeTls
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();
    this.client = this.createClient();
  }

  /** Create a fresh gRPC channel to the runtime. */
  private createClient(): any {
    return new this.serviceConstructor(this.runtimeAddress, this.channelCreds);
  }

  async initialize(req: RuntimeInitializeRequest, opts?: GrpcCallOptions): Promise<RuntimeInitializeResult> {
    const response = await this.unary('Initialize', {
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
    }, undefined, opts);

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
      capabilities: response.capabilities ? {
        sessions: response.capabilities.sessions,
        cancellation: response.capabilities.cancellation,
        progress: response.capabilities.progress,
        manifest: response.capabilities.manifest,
        modeRegistry: response.capabilities.modeRegistry,
        roots: response.capabilities.roots,
        policyRegistry: response.capabilities.policyRegistry
      } : undefined
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

        // Observer stream: end the write side immediately — we only read.
        // This tells the runtime the client is a passive subscriber.
        try { grpcCall.end(); } catch { /* some gRPC impls no-op on empty streams */ }

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
              try { grpcCall.cancel(); } catch { /* ignore */ }
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
          try { grpcCall.cancel(); } catch { /* ignore */ }
        }
        notify();
      }
    };
  }

  async getSession(req: RuntimeGetSessionRequest): Promise<RuntimeSessionSnapshot> {
    const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
    const response = await this.unary(
      'GetSession',
      { sessionId: req.runtimeSessionId },
      buildMetadata(creds.metadata)
    );
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
    const response = await this.unary('GetManifest', { agentId: '' });
    return {
      agentId: response.manifest?.agentId ?? 'macp-runtime',
      title: response.manifest?.title,
      description: response.manifest?.description,
      supportedModes: response.manifest?.supportedModes ?? [],
      metadata: response.manifest?.metadata ?? {}
    };
  }

  async listModes(): Promise<RuntimeModeDescriptor[]> {
    const response = await this.unary('ListModes', {});
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
    const response = await this.unary('ListRoots', {});
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

  // ── Governance policy lifecycle (RFC-MACP-0012) ──────────────────

  async registerPolicy(req: RuntimeRegisterPolicyRequest): Promise<RuntimeRegisterPolicyResult> {
    const descriptor = req.descriptor;
    const response = await this.unary('RegisterPolicy', {
      policyDescriptor: {
        policyId: descriptor.policyId,
        mode: descriptor.mode,
        description: descriptor.description,
        rules: typeof descriptor.rules === 'string' ? Buffer.from(descriptor.rules) : descriptor.rules,
        schemaVersion: descriptor.schemaVersion
      }
    });
    return { ok: response.ok ?? false, error: response.error || undefined };
  }

  async unregisterPolicy(req: RuntimeUnregisterPolicyRequest): Promise<RuntimeUnregisterPolicyResult> {
    const response = await this.unary('UnregisterPolicy', { policyId: req.policyId });
    return { ok: response.ok ?? false, error: response.error || undefined };
  }

  async getPolicy(req: RuntimeGetPolicyRequest): Promise<RuntimePolicyDescriptor> {
    const response = await this.unary('GetPolicy', { policyId: req.policyId });
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
    const response = await this.unary('ListPolicies', { mode: req?.mode ?? '' });
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
      this.instrumentation.grpcCallDuration.observe(
        { method, status: 'ok' },
        (Date.now() - start) / 1000
      );
      return result;
    } catch (error) {
      this.instrumentation.grpcCallDuration.observe(
        { method, status: 'error' },
        (Date.now() - start) / 1000
      );
      throw error;
    }
  }

}
