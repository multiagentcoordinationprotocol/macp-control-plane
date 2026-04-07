/* eslint-disable @typescript-eslint/no-explicit-any -- gRPC dynamic proto loading returns untyped objects */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { ExecutionRequest, ParticipantRef } from '../contracts/control-plane';
import {
  RawRuntimeEvent,
  RuntimeAck,
  RuntimeCancelResult,
  RuntimeCancelSessionRequest,
  RuntimeEnvelope,
  RuntimeGetSessionRequest,
  RuntimeHealth,
  RuntimeInitializeRequest,
  RuntimeInitializeResult,
  RuntimeManifestResult,
  RuntimeModeDescriptor,
  RuntimeOpenSessionRequest,
  RuntimeProvider,
  RuntimeRootDescriptor,
  RuntimeSendRequest,
  RuntimeSendResult,
  RuntimeSessionHandle,
  RuntimeSessionSnapshot,
  RuntimeStartSessionRequest,
  RuntimeStartSessionResult,
  RuntimeStreamSessionRequest,
  RuntimeRegisterPolicyRequest,
  RuntimeRegisterPolicyResult,
  RuntimeUnregisterPolicyRequest,
  RuntimeUnregisterPolicyResult,
  RuntimeGetPolicyRequest,
  RuntimeListPoliciesRequest,
  RuntimePolicyDescriptor
} from '../contracts/runtime';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { CircuitBreaker } from './circuit-breaker';
import { ProtoRegistryService } from './proto-registry.service';
import { RuntimeCredentialResolverService } from './runtime-credential-resolver.service';

export interface GrpcCallOptions {
  deadline?: Date;
}

@Injectable()
export class RustRuntimeProvider implements RuntimeProvider, OnModuleInit {
  readonly kind = 'rust';
  private readonly logger = new Logger(RustRuntimeProvider.name);
  private client!: any;
  private circuitBreaker!: CircuitBreaker;

  constructor(
    private readonly config: AppConfigService,
    private readonly credentialResolver: RuntimeCredentialResolverService,
    private readonly protoRegistry: ProtoRegistryService
  ) {}

  getCircuitBreakerState() {
    return this.circuitBreaker.getState();
  }

  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  onModuleInit(): void {
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: this.config.runtimeCircuitBreakerThreshold,
      resetTimeoutMs: this.config.runtimeCircuitBreakerResetMs
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { protoDir } = require('@macp/proto');
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
    const address = this.config.runtimeAddress;
    const creds = this.config.runtimeTls
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();
    this.client = new descriptor.macp.v1.MACPRuntimeService(address, creds);
  }

  async initialize(req: RuntimeInitializeRequest, opts?: GrpcCallOptions): Promise<RuntimeInitializeResult> {
    const response = await this.unary('Initialize', {
      supportedProtocolVersions: ['1.0'],
      clientInfo: {
        name: req.clientName,
        title: req.clientName,
        version: req.clientVersion,
        description: 'MACP Control Plane',
        websiteUrl: ''
      },
      capabilities: {
        sessions: { stream: true },
        cancellation: { cancelSession: true },
        progress: { progress: true },
        manifest: { getManifest: true },
        modeRegistry: { listModes: true, listChanged: true },
        roots: { listRoots: true, listChanged: true },
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
        roots: response.capabilities.roots
      } : undefined
    };
  }

  async startSession(req: RuntimeStartSessionRequest, opts?: GrpcCallOptions): Promise<RuntimeStartSessionResult> {
    const initiator = this.chooseInitiator(req.execution);
    const participant = this.findParticipant(req.execution, initiator);
    const creds = await this.credentialResolver.resolve({
      runtimeKind: this.kind,
      requester: req.execution.execution?.requester,
      participant,
      fallbackSender: initiator
    });

    const runtimeSessionId = randomUUID();
    const payload = this.protoRegistry.encodeMessage('macp.v1.SessionStartPayload', {
      intent: req.execution.session.metadata?.intent ?? '',
      participants: req.execution.session.participants.map((item) => item.id),
      mode_version: req.execution.session.modeVersion,
      configuration_version: req.execution.session.configurationVersion,
      policy_version: req.execution.session.policyVersion ?? '',
      ttl_ms: req.execution.session.ttlMs,
      context: this.protoRegistry.encodeSessionContext(
        req.execution.session.context,
        req.execution.session.contextEnvelope
      ),
      roots: (req.execution.session.roots ?? []).map((root) => ({ uri: root.uri, name: root.name ?? '' }))
    });

    const envelope = this.buildEnvelope({
      mode: req.execution.session.modeName,
      messageType: 'SessionStart',
      messageId: randomUUID(),
      sessionId: runtimeSessionId,
      sender: creds.sender,
      payload
    });

    const response = await this.unary(
      'Send',
      { envelope: this.toGrpcEnvelope(envelope) },
      this.buildMetadata(creds.metadata),
      opts
    );

    const ack = this.fromAck(response.ack);
    if (!ack.ok && ack.error) {
      if (ack.error.code === 'INVALID_SESSION_ID') {
        throw new AppException(
          ErrorCode.INVALID_SESSION_ID,
          `Runtime rejected SessionStart: [${ack.error.code}] ${ack.error.message}`,
          400
        );
      }
      throw new AppException(
        ErrorCode.RUNTIME_UNAVAILABLE,
        `Runtime rejected SessionStart: [${ack.error.code}] ${ack.error.message}`,
        502
      );
    }
    return {
      runtimeSessionId: ack.sessionId || runtimeSessionId,
      initiator: creds.sender,
      ack
    };
  }

  openSession(req: RuntimeOpenSessionRequest): RuntimeSessionHandle {
    const initiator = this.chooseInitiator(req.execution);
    const participant = this.findParticipant(req.execution, initiator);
    const runtimeSessionId = randomUUID();

    const payload = this.protoRegistry.encodeMessage('macp.v1.SessionStartPayload', {
      intent: req.execution.session.metadata?.intent ?? '',
      participants: req.execution.session.participants.map((item) => item.id),
      mode_version: req.execution.session.modeVersion,
      configuration_version: req.execution.session.configurationVersion,
      policy_version: req.execution.session.policyVersion ?? '',
      ttl_ms: req.execution.session.ttlMs,
      context: this.protoRegistry.encodeSessionContext(
        req.execution.session.context,
        req.execution.session.contextEnvelope
      ),
      roots: (req.execution.session.roots ?? []).map((root) => ({ uri: root.uri, name: root.name ?? '' }))
    });

    const sessionStartEnvelope = this.buildEnvelope({
      mode: req.execution.session.modeName,
      messageType: 'SessionStart',
      messageId: randomUUID(),
      sessionId: runtimeSessionId,
      sender: '',
      payload
    });

    // Event-driven async queue for the bidirectional stream
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

    // Session ack promise — resolved when we receive the SessionStart echo
    let resolveSessionAck: (result: RuntimeStartSessionResult) => void;
    let rejectSessionAck: (err: Error) => void;
    const sessionAck = new Promise<RuntimeStartSessionResult>((resolve, reject) => {
      resolveSessionAck = resolve;
      rejectSessionAck = reject;
    });

    let sessionAckSettled = false;

    // Launch the bidirectional stream asynchronously
    const launch = async () => {
      try {
        const creds = await this.credentialResolver.resolve({
          runtimeKind: this.kind,
          requester: req.execution.execution?.requester,
          participant,
          fallbackSender: initiator
        });

        const metadata = this.buildMetadata(creds.metadata);
        const streamMethod = this.getClientMethod('StreamSession');
        grpcCall = streamMethod.call(this.client, metadata);

        grpcCall.on('data', (chunk: any) => {
          const receivedAt = new Date().toISOString();

          // StreamSessionResponse oneof: response.envelope | response.error
          const responseBody = chunk.response ?? chunk;
          if (responseBody.error) {
            // Inline MACPError — non-terminal, stream stays open
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

          const envelope = this.fromEnvelope(rawEnvelope);
          const event: RawRuntimeEvent = {
            kind: 'stream-envelope',
            receivedAt,
            envelope
          };

          // First envelope back is the SessionStart echo — resolve the ack
          if (!sessionAckSettled && envelope.messageType === 'SessionStart') {
            sessionAckSettled = true;
            resolveSessionAck({
              runtimeSessionId: envelope.sessionId || runtimeSessionId,
              initiator: creds.sender,
              ack: {
                ok: true,
                duplicate: false,
                messageId: envelope.messageId,
                sessionId: envelope.sessionId || runtimeSessionId,
                acceptedAtUnixMs: envelope.timestampUnixMs,
                sessionState: 'SESSION_STATE_OPEN'
              }
            });
          }

          buffer.push(event);
          notify();
        });

        grpcCall.on('error', (error: Error) => {
          streamFailure = error;
          ended = true;
          if (!sessionAckSettled) {
            sessionAckSettled = true;
            rejectSessionAck(error);
          }
          notify();
        });

        grpcCall.on('end', () => {
          ended = true;
          if (!sessionAckSettled) {
            sessionAckSettled = true;
            rejectSessionAck(new Error('stream ended before SessionStart ack'));
          }
          notify();
        });

        // Write the SessionStart envelope as the first frame
        grpcCall.write({ envelope: this.toGrpcEnvelope(sessionStartEnvelope) });

      } catch (error) {
        ended = true;
        if (!sessionAckSettled) {
          sessionAckSettled = true;
          rejectSessionAck(error instanceof Error ? error : new Error(String(error)));
        }
        notify();
      }
    };

    void launch();

    // Build the async iterable for events
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

    const handle: RuntimeSessionHandle = {
      send: (envelope: RuntimeEnvelope) => {
        if (grpcCall && !ended) {
          grpcCall.write({ envelope: this.toGrpcEnvelope(envelope) });
        }
      },
      events,
      closeWrite: () => {
        if (grpcCall && !ended) {
          grpcCall.end();
        }
      },
      abort: () => {
        ended = true;
        if (grpcCall) {
          try { grpcCall.cancel(); } catch { /* ignore */ }
        }
        notify();
      },
      sessionAck
    };

    return handle;
  }

  async send(req: RuntimeSendRequest): Promise<RuntimeSendResult> {
    const participant = { id: req.from } as ParticipantRef;
    const creds = await this.credentialResolver.resolve({
      runtimeKind: this.kind,
      participant,
      fallbackSender: req.from
    });

    const envelope = this.buildEnvelope({
      mode: req.modeName,
      messageType: req.messageType,
      messageId: randomUUID(),
      sessionId: req.runtimeSessionId,
      sender: creds.sender,
      payload: req.payload
    });

    const response = await this.unary(
      'Send',
      { envelope: this.toGrpcEnvelope(envelope) },
      this.buildMetadata(creds.metadata)
    );

    const ack = this.fromAck(response.ack);
    if (!ack.ok && ack.error) {
      if (ack.error.code === 'INVALID_SESSION_ID') {
        throw new AppException(
          ErrorCode.INVALID_SESSION_ID,
          `Runtime rejected message: [${ack.error.code}] ${ack.error.message}`,
          400
        );
      }
      throw new AppException(
        ErrorCode.RUNTIME_UNAVAILABLE,
        `Runtime rejected message: [${ack.error.code}] ${ack.error.message}`,
        502
      );
    }
    return { ack, envelope };
  }

  async *streamSession(_req: RuntimeStreamSessionRequest): AsyncIterable<RawRuntimeEvent> {
    // SessionWatch / passive attach is no longer part of the base protocol.
    // Reconnection now uses getSession() polling in StreamConsumerService.
    throw new AppException(
      ErrorCode.INTERNAL_ERROR,
      'streamSession() is deprecated — reconnection uses getSession() polling',
      500
    );
  }

  async getSession(req: RuntimeGetSessionRequest): Promise<RuntimeSessionSnapshot> {
    const creds = await this.credentialResolver.resolve({
      runtimeKind: this.kind,
      fallbackSender: req.requesterId ?? this.config.runtimeDevAgentId
    });
    const response = await this.unary(
      'GetSession',
      { sessionId: req.runtimeSessionId },
      this.buildMetadata(creds.metadata)
    );
    return this.fromSessionMetadata(response.metadata);
  }

  async cancelSession(req: RuntimeCancelSessionRequest): Promise<RuntimeCancelResult> {
    const creds = await this.credentialResolver.resolve({
      runtimeKind: this.kind,
      fallbackSender: req.requesterId ?? this.config.runtimeDevAgentId
    });
    const response = await this.unary(
      'CancelSession',
      { sessionId: req.runtimeSessionId, reason: req.reason ?? 'cancelled by control plane' },
      this.buildMetadata(creds.metadata)
    );
    return { ack: this.fromAck(response.ack) };
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
    return this.circuitBreaker.execute(() => {
      const clientMethod = this.getClientMethod(method);
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
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  private getClientMethod(method: string): Function {
    const direct = this.client[method];
    if (typeof direct === 'function') return direct;
    const lowerCamel = method.charAt(0).toLowerCase() + method.slice(1);
    const fallback = this.client[lowerCamel];
    if (typeof fallback === 'function') return fallback;
    throw new Error(`runtime gRPC method '${method}' is not available on client`);
  }

  private chooseInitiator(execution: ExecutionRequest): string {
    const explicit = execution.session.initiatorParticipantId;
    if (explicit) return explicit;
    const kickoffSender = execution.kickoff?.[0]?.from;
    if (kickoffSender) return kickoffSender;
    const requester = execution.execution?.requester?.actorId;
    if (requester) return requester;
    const first = execution.session.participants[0];
    return first.transportIdentity ?? first.id;
  }

  private findParticipant(execution: ExecutionRequest, sender: string): ParticipantRef | undefined {
    return execution.session.participants.find(
      (participant) => participant.id === sender || participant.transportIdentity === sender
    );
  }

  private buildEnvelope(input: {
    mode: string;
    messageType: string;
    messageId: string;
    sessionId: string;
    sender: string;
    payload: Buffer;
  }) {
    return {
      macpVersion: '1.0',
      mode: input.mode,
      messageType: input.messageType,
      messageId: input.messageId,
      sessionId: input.sessionId,
      sender: input.sender,
      timestampUnixMs: Date.now(),
      payload: input.payload
    };
  }

  private toGrpcEnvelope(envelope: {
    macpVersion: string;
    mode: string;
    messageType: string;
    messageId: string;
    sessionId: string;
    sender: string;
    timestampUnixMs: number;
    payload: Buffer;
  }) {
    return {
      macpVersion: envelope.macpVersion,
      mode: envelope.mode,
      messageType: envelope.messageType,
      messageId: envelope.messageId,
      sessionId: envelope.sessionId,
      sender: envelope.sender,
      timestampUnixMs: String(envelope.timestampUnixMs),
      payload: envelope.payload
    };
  }

  private fromEnvelope(envelope: any) {
    return {
      macpVersion: envelope.macpVersion,
      mode: envelope.mode,
      messageType: envelope.messageType,
      messageId: envelope.messageId,
      sessionId: envelope.sessionId,
      sender: envelope.sender,
      timestampUnixMs: Number(envelope.timestampUnixMs ?? Date.now()),
      payload: Buffer.isBuffer(envelope.payload)
        ? envelope.payload
        : Buffer.from(envelope.payload ?? '')
    };
  }

  private fromAck(ack: any, trailingMetadata?: grpc.Metadata): RuntimeAck {
    let reasons: string[] | undefined;

    // Parse structured reasons from error details bytes
    if (ack?.error?.details) {
      try {
        const parsed = JSON.parse(Buffer.from(ack.error.details).toString('utf-8'));
        if (Array.isArray(parsed.reasons)) reasons = parsed.reasons;
      } catch { /* ignore parse errors */ }
    }

    // Also check gRPC trailing metadata for POLICY_DENIED binary details
    if (!reasons && trailingMetadata) {
      const detailsBin = trailingMetadata.get('macp-error-details-bin');
      if (detailsBin && detailsBin.length > 0) {
        try {
          const parsed = JSON.parse(Buffer.from(detailsBin[0] as Buffer).toString('utf-8'));
          if (Array.isArray(parsed.reasons)) reasons = parsed.reasons;
        } catch { /* ignore parse errors */ }
      }
    }

    return {
      ok: Boolean(ack?.ok),
      duplicate: Boolean(ack?.duplicate),
      messageId: ack?.messageId ?? '',
      sessionId: ack?.sessionId ?? '',
      acceptedAtUnixMs: Number(ack?.acceptedAtUnixMs ?? Date.now()),
      sessionState: (ack?.sessionState ?? 'SESSION_STATE_UNSPECIFIED') as RuntimeAck['sessionState'],
      error: ack?.error
        ? {
            code: ack.error.code,
            message: ack.error.message,
            sessionId: ack.error.sessionId,
            messageId: ack.error.messageId,
            detailsBase64: ack.error.details
              ? Buffer.from(ack.error.details).toString('base64')
              : undefined,
            details: ack.error.details ? Buffer.from(ack.error.details) : undefined,
            reasons
          }
        : undefined
    };
  }

  private fromSessionMetadata(metadata: any): RuntimeSessionSnapshot {
    return {
      sessionId: metadata?.sessionId ?? '',
      mode: metadata?.mode ?? '',
      state: metadata?.state ?? 'SESSION_STATE_UNSPECIFIED',
      startedAtUnixMs: metadata?.startedAtUnixMs ? Number(metadata.startedAtUnixMs) : undefined,
      expiresAtUnixMs: metadata?.expiresAtUnixMs ? Number(metadata.expiresAtUnixMs) : undefined,
      modeVersion: metadata?.modeVersion,
      configurationVersion: metadata?.configurationVersion,
      policyVersion: metadata?.policyVersion,
      initiator: metadata?.initiator ?? undefined
    };
  }

  private buildMetadata(metadataInput: Record<string, string>): grpc.Metadata {
    const metadata = new grpc.Metadata();
    for (const [key, value] of Object.entries(metadataInput)) {
      if (value) metadata.set(key, value);
    }
    return metadata;
  }
}
