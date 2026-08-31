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
  RuntimeCapabilities,
  RuntimeManifestResult,
  RuntimeModeDescriptor,
  RuntimeProvider,
  RuntimeResumeResult,
  RuntimeResumeSessionRequest,
  RuntimeRootDescriptor,
  RuntimeSessionHandle,
  RuntimeSessionSnapshot,
  RuntimeSubscribeSessionRequest,
  RuntimeSuspendResult,
  RuntimeSuspendSessionRequest,
  RuntimeRegisterPolicyRequest,
  RuntimeRegisterPolicyResult,
  RuntimeUnregisterPolicyRequest,
  RuntimeUnregisterPolicyResult,
  RuntimeGetPolicyRequest,
  RuntimeListPoliciesRequest,
  RuntimeListSessionsResult,
  RuntimePolicyDescriptor,
  SessionLifecycleEvent
} from '../contracts/runtime';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { CircuitBreaker } from './circuit-breaker';
import {
  buildMetadata,
  fromAck,
  fromEnvelope,
  fromSessionMetadata,
  getClientMethod,
  mapGrpcError
} from './grpc-helpers';
import { RuntimeCredentialResolverService } from './runtime-credential-resolver.service';

export interface GrpcCallOptions {
  deadline?: Date;
}

/**
 * Bound on how many times `listSessions()` will halve `pageSize` and retry the
 * same page after a RESOURCE_EXHAUSTED response, across the *whole* drain (not
 * per page). Every retry goes through `unary()` → the shared `CircuitBreaker`,
 * and `isExpectedError` does NOT exempt RESOURCE_EXHAUSTED (see the comment on
 * `onModuleInit()` — exempting it would silence a genuine backpressure/
 * rate-limit signal for every other caller, not just this drain). With the
 * default `runtimeCircuitBreakerThreshold` of 5, a ladder of N consecutive
 * RESOURCE_EXHAUSTED responses trips the breaker on attempt 5 — poisoning
 * unrelated calls (GetSession polling, /runtime/health, cancel/suspend/resume)
 * for `runtimeCircuitBreakerResetMs` (30s default). 2 is chosen so the ladder
 * makes at most 3 attempts total, comfortably under that default threshold.
 *
 * Honesty check: an operator who sets `RUNTIME_CIRCUIT_BREAKER_THRESHOLD`
 * below 3 can still trip the breaker via this ladder. That is correct, not a
 * bug — 3 consecutive genuine runtime errors *should* open a threshold-2
 * breaker; this constant only protects the *default* configuration from a
 * self-inflicted trip.
 */
const MAX_PAGE_SIZE_HALVINGS = 2;

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
  /** Runtime capabilities cached from the most recent Initialize response. */
  capabilities?: RuntimeCapabilities;

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
    this.circuitBreaker = this.buildCircuitBreaker();

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

  /**
   * Build the shared circuit breaker wrapping every unary gRPC call. Extracted
   * from `onModuleInit()` so unit tests can install a real `CircuitBreaker`
   * (identical to production) without running proto loading / opening a real
   * gRPC channel — see `rust-runtime.provider.spec.ts`'s GAP-1 regression test.
   */
  private buildCircuitBreaker(): CircuitBreaker {
    return new CircuitBreaker({
      failureThreshold: this.config.runtimeCircuitBreakerThreshold,
      resetTimeoutMs: this.config.runtimeCircuitBreakerResetMs,
      instrumentation: this.instrumentation,
      isExpectedError: (error: unknown) => {
        const code = (error as grpc.ServiceError)?.code;
        return code === grpc.status.NOT_FOUND || code === grpc.status.PERMISSION_DENIED;
      }
    });
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

    const capabilities = response.capabilities
      ? {
          sessions: response.capabilities.sessions,
          cancellation: response.capabilities.cancellation,
          progress: response.capabilities.progress,
          manifest: response.capabilities.manifest,
          modeRegistry: response.capabilities.modeRegistry,
          roots: response.capabilities.roots,
          policyRegistry: response.capabilities.policyRegistry
        }
      : undefined;

    // Cache the runtime's advertised capabilities so callers (e.g. the policy
    // controller) can short-circuit a write against a read-only registry
    // (MACP_POLICIES_DIR, runtime v0.5.0) instead of round-tripping to a
    // FAILED_PRECONDITION.
    if (capabilities) this.capabilities = capabilities;

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
      capabilities
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

  async suspendSession(req: RuntimeSuspendSessionRequest): Promise<RuntimeSuspendResult> {
    const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
    const response = await this.unary(
      'SuspendSession',
      { sessionId: req.runtimeSessionId, reason: req.reason ?? 'suspended by control plane' },
      buildMetadata(creds.metadata)
    );
    return { ack: fromAck(response.ack) };
  }

  async resumeSession(req: RuntimeResumeSessionRequest): Promise<RuntimeResumeResult> {
    const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
    const response = await this.unary(
      'ResumeSession',
      { sessionId: req.runtimeSessionId, reason: req.reason ?? 'resumed by control plane' },
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

  async listSessions(): Promise<RuntimeListSessionsResult> {
    // ListSessions is paginated: the response carries `next_page_token` when
    // more results exist; pass it back verbatim as `page_token`. Phase 1 of
    // the runtime v0.7.0 absorption proved live that the multi-page path is
    // real against a real runtime: against a 150-session store, page 1
    // returned 100 sessions with a NON-EMPTY token and page 2 returned the
    // remaining 50 with an empty token (see
    // test/integration/list-sessions-pagination.integration.spec.ts). The old
    // comment here claiming the token "always comes back empty against
    // v0.5.0" was never re-verified after that landed and is corrected.
    //
    // The drain is bounded two ways: `RUNTIME_LIST_SESSIONS_MAX_PAGES` (guards
    // a buggy/looping server that never clears next_page_token) and
    // `RUNTIME_LIST_SESSIONS_TIMEOUT_MS` (bounds the *whole* drain — without
    // it, maxPages pages each with their own fresh per-call deadline is an
    // unbounded worst case). Either limit being hit returns a truthful
    // `complete: false` with the collected prefix rather than throwing or
    // silently truncating — see `RuntimeListSessionsResult`.
    const creds = await this.credentialResolver.resolve({ runtimeKind: this.kind });
    const metadata = buildMetadata(creds.metadata);
    const snapshots: RuntimeSessionSnapshot[] = [];
    let pageToken = '';
    let pageSize = this.config.runtimeListSessionsPageSize;
    const maxPages = this.config.runtimeListSessionsMaxPages;
    const deadlineAt = Date.now() + this.config.runtimeListSessionsTimeoutMs;
    let pagesFetched = 0;
    let pageSizeHalvings = 0;

    while (pagesFetched < maxPages) {
      // Single check for both the "budget already gone between pages" case
      // and the once-cheap-to-miss race where Date.now() ticks past
      // deadlineAt between an earlier check and here: remainingMs <= 0 is the
      // one truthful condition, computed once, so there's no gap in which a
      // call could be issued with an already-past deadline.
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        return this.finishListSessions(snapshots, false, pagesFetched, 'overall timeout exceeded');
      }

      // Per-call deadline is the smaller of the usual gRPC request timeout
      // and whatever remains of the overall drain budget.
      const deadline = new Date(Date.now() + Math.min(remainingMs, this.config.runtimeRequestTimeoutMs));

      let response: any;
      try {
        response = await this.unary('ListSessions', { pageToken, pageSize }, metadata, { deadline });
      } catch (error) {
        // A DEADLINE_EXCEEDED that surfaces *after* the overall drain budget
        // has expired is the CP's own per-call deadline clamp (above) firing,
        // not a runtime failure — the runtime may have been about to reply.
        // Returning the truthful complete:false prefix here (instead of
        // rethrowing and discarding every page collected so far) is what
        // makes the "overall timeout" guarantee hold in the more likely case
        // where the budget expires *during* a page rather than between pages.
        // If the budget has NOT expired, this DEADLINE_EXCEEDED came from
        // `runtimeRequestTimeoutMs` instead (a genuinely slow runtime) and
        // must still propagate like any other hard failure.
        if (this.isDeadlineExceeded(error) && Date.now() >= deadlineAt) {
          return this.finishListSessions(snapshots, false, pagesFetched, 'overall timeout exceeded (mid-page)');
        }

        // RESOURCE_EXHAUSTED is the other error worth special-casing: it
        // means this specific page was too large to receive (see the
        // page-size comment on AppConfigService.runtimeListSessionsPageSize),
        // and retrying identically will fail identically. Halve the page
        // size and retry the SAME page (down to a floor of 1), bounded by
        // MAX_PAGE_SIZE_HALVINGS for the whole drain — see that constant's
        // comment for why the bound exists (the shared CircuitBreaker) and
        // what it does and doesn't guarantee. Once the halving budget (or the
        // floor) is exhausted, rethrow. Every other gRPC error (and a
        // circuit-breaker trip) propagates unchanged and discards the
        // collected pages — a partial result from a *failing* runtime is not
        // trustworthy the way a page-capped result is, so this asymmetry
        // (special-case two errors, propagate the rest) is deliberate, not an
        // oversight.
        if (this.isResourceExhausted(error) && pageSize > 1 && pageSizeHalvings < MAX_PAGE_SIZE_HALVINGS) {
          pageSizeHalvings++;
          pageSize = Math.max(1, Math.floor(pageSize / 2));
          this.logger.warn(`ListSessions page too large (RESOURCE_EXHAUSTED); retrying with pageSize=${pageSize}`);
          continue;
        }
        throw error;
      }

      pagesFetched++;
      for (const s of response.sessions ?? []) {
        snapshots.push(fromSessionMetadata(s));
      }
      const nextPageToken: string = response.nextPageToken ?? response.next_page_token ?? '';
      if (!nextPageToken) {
        return this.finishListSessions(snapshots, true, pagesFetched);
      }
      pageToken = nextPageToken;
    }

    return this.finishListSessions(snapshots, false, pagesFetched, `exceeded ${maxPages} pages`);
  }

  /** Narrow a thrown listSessions() error down to a RESOURCE_EXHAUSTED gRPC status. */
  private isResourceExhausted(error: unknown): boolean {
    const grpcCode =
      (error as { metadata?: { grpcCode?: number } })?.metadata?.grpcCode ?? (error as { code?: number })?.code;
    return grpcCode === grpc.status.RESOURCE_EXHAUSTED;
  }

  /**
   * Narrow a thrown listSessions() error down to a DEADLINE_EXCEEDED gRPC
   * status. Mirrors `isResourceExhausted()`: `unary()` throws
   * `mapGrpcError(error, method) ?? error`, and `mapGrpcError` DOES map
   * DEADLINE_EXCEEDED (to an `AppException` with HTTP 504 / `RUNTIME_TIMEOUT`
   * and `metadata.grpcCode` set to the original gRPC status — see
   * `grpc-helpers.ts` `GRPC_STATUS_TO_HTTP`), so `metadata.grpcCode` is the
   * real, post-translation shape this needs to match. The `.code` fallback
   * covers a raw, untranslated `grpc.ServiceError` reaching here directly.
   */
  private isDeadlineExceeded(error: unknown): boolean {
    const grpcCode =
      (error as { metadata?: { grpcCode?: number } })?.metadata?.grpcCode ?? (error as { code?: number })?.code;
    return grpcCode === grpc.status.DEADLINE_EXCEEDED;
  }

  /** Finalize a listSessions() drain: record metrics/logs and build the result. */
  private finishListSessions(
    sessions: RuntimeSessionSnapshot[],
    complete: boolean,
    pagesFetched: number,
    truncationReason?: string
  ): RuntimeListSessionsResult {
    this.instrumentation.macpRuntimeListSessionsPages.observe(pagesFetched);
    if (!complete) {
      this.instrumentation.macpRuntimeListSessionsTruncatedTotal.inc();
      this.logger.warn(
        `ListSessions drain stopped early (${truncationReason}); returning ${sessions.length} sessions ` +
          `(pagesFetched=${pagesFetched}, complete=false)`
      );
    }
    return { sessions, complete, pagesFetched };
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
              // proto-loader is configured with `enums: String`, so eventType arrives
              // as the enum name; the numeric fallbacks mirror the macp-proto 0.1.3
              // EventType ordinals (CREATED=1, RESOLVED=2, EXPIRED=3, SUSPENDED=4,
              // RESUMED=5, CANCELLED=6).
              const eventTypeRaw = event.eventType ?? event.event_type ?? '';
              let eventType: SessionLifecycleEvent['eventType'] = 'created';
              if (eventTypeRaw === 'EVENT_TYPE_RESOLVED' || eventTypeRaw === 2) eventType = 'resolved';
              else if (eventTypeRaw === 'EVENT_TYPE_EXPIRED' || eventTypeRaw === 3) eventType = 'expired';
              else if (eventTypeRaw === 'EVENT_TYPE_SUSPENDED' || eventTypeRaw === 4) eventType = 'suspended';
              else if (eventTypeRaw === 'EVENT_TYPE_RESUMED' || eventTypeRaw === 5) eventType = 'resumed';
              else if (eventTypeRaw === 'EVENT_TYPE_CANCELLED' || eventTypeRaw === 6) eventType = 'cancelled';
              else if (eventTypeRaw === 'EVENT_TYPE_CREATED' || eventTypeRaw === 1) eventType = 'created';

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
      // Translate the gRPC status into a meaningful HTTP status (403/404/409/…)
      // so REST clients see the real cause instead of an opaque 500. Non-gRPC
      // errors (e.g. circuit-breaker-open) are rethrown unchanged.
      throw mapGrpcError(error, method) ?? error;
    }
  }
}
