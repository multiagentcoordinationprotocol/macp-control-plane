import * as grpc from '@grpc/grpc-js';
import { RustRuntimeProvider } from './rust-runtime.provider';
import { AppConfigService } from '../config/app-config.service';
import { RuntimeCredentialResolverService } from './runtime-credential-resolver.service';
import { RuntimeJwtMinterService } from './runtime-jwt-minter.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { RawRuntimeEvent, RuntimeSubscribeSessionRequest } from '../contracts/runtime';
import { CircuitBreaker } from './circuit-breaker';
import { AppException } from '../errors/app-exception';

/**
 * Focused unit tests for the RFC-MACP-0006 §3.2 passive-subscribe behavior
 * added to RustRuntimeProvider.subscribeSession(): the control-plane writes
 * exactly one frame ({subscribeSessionId, afterSequence}) on the bidi stream
 * and then deliberately keeps the write side open (README invariant 6) —
 * half-closing would signal "client is done" and stop live-envelope
 * broadcast. Full gRPC plumbing (proto loading, real channel) is bypassed by
 * stubbing the gRPC client directly.
 */

interface FakeStream {
  on: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
  cancel: jest.Mock;
  emit: (event: 'data' | 'error' | 'end', payload?: unknown) => void;
}

function makeFakeStream(): FakeStream {
  const handlers: Record<string, Array<(p: unknown) => void>> = {};
  const stream: FakeStream = {
    on: jest.fn((event: string, cb: (p: unknown) => void) => {
      (handlers[event] ||= []).push(cb);
      return stream;
    }),
    write: jest.fn(),
    end: jest.fn(),
    cancel: jest.fn(),
    emit: (event: 'data' | 'error' | 'end', payload?: unknown) => {
      for (const h of handlers[event] ?? []) h(payload);
    }
  };
  return stream;
}

/** Minimal jest-mocked shape of the two listSessions() metrics on InstrumentationService. */
interface FakeListSessionsInstrumentation {
  macpRuntimeListSessionsPages: { observe: jest.Mock };
  macpRuntimeListSessionsTruncatedTotal: { inc: jest.Mock };
}

function makeProvider(
  streamFactory: () => unknown,
  configOverrides: Record<string, unknown> = {},
  watchSignalsStreamFactory?: () => unknown
): {
  provider: RustRuntimeProvider;
  resolver: RuntimeCredentialResolverService;
  instrumentation: FakeListSessionsInstrumentation;
} {
  const config = {
    runtimeDevAgentId: 'control-plane',
    runtimeBearerToken: 'obs-token',
    runtimeUseDevHeader: false,
    runtimeCircuitBreakerThreshold: 5,
    runtimeCircuitBreakerResetMs: 30_000,
    runtimeRequestTimeoutMs: 30_000,
    runtimeListSessionsPageSize: 100,
    runtimeListSessionsMaxPages: 200,
    runtimeListSessionsTimeoutMs: 60_000,
    ...configOverrides
  } as unknown as AppConfigService;

  const jwtMinter = {
    isEnabled: () => false,
    getToken: () => Promise.reject(new Error('jwt disabled in unit test'))
  } as unknown as RuntimeJwtMinterService;
  const resolver = new RuntimeCredentialResolverService(config, jwtMinter);
  const instrumentation = {
    macpRuntimeListSessionsPages: { observe: jest.fn() },
    macpRuntimeListSessionsTruncatedTotal: { inc: jest.fn() }
  } as unknown as FakeListSessionsInstrumentation;
  const provider = new RustRuntimeProvider(config, resolver, instrumentation as unknown as InstrumentationService);

  // Bypass onModuleInit() — proto loading is unnecessary for these tests.
  // Stub the gRPC client so getClientMethod(client, 'StreamSession') returns
  // a function that yields our fake bidi stream.
  const fakeStreamSession = jest.fn(() => streamFactory());
  (provider as unknown as { client: unknown }).client = {
    StreamSession: fakeStreamSession,
    ...(watchSignalsStreamFactory ? { WatchSignals: jest.fn(() => watchSignalsStreamFactory()) } : {})
  };

  return { provider, resolver, instrumentation };
}

async function drain(events: AsyncIterable<RawRuntimeEvent>, max = 10): Promise<RawRuntimeEvent[]> {
  const collected: RawRuntimeEvent[] = [];
  let i = 0;
  for await (const ev of events) {
    collected.push(ev);
    if (++i >= max) break;
  }
  return collected;
}

describe('RustRuntimeProvider.subscribeSession — passive-subscribe frame (RFC-MACP-0006 §3.2)', () => {
  const baseReq: RuntimeSubscribeSessionRequest = {
    runId: 'run-1',
    runtimeSessionId: 'sess-abc'
  };

  it('writes a single passive-subscribe frame with afterSequence=0 (default) and keeps the write side open', async () => {
    const stream = makeFakeStream();
    const { provider } = makeProvider(() => stream);

    const handle = provider.subscribeSession(baseReq);

    // Allow the launch microtask (credentials resolve + write) to settle.
    await new Promise((r) => setImmediate(r));

    expect(stream.write).toHaveBeenCalledTimes(1);
    expect(stream.write).toHaveBeenCalledWith({
      subscribeSessionId: 'sess-abc',
      afterSequence: 0
    });
    // Observer must not half-close: the runtime's StreamSession loop treats
    // client half-close as "done with the stream" and stops forwarding
    // envelopes. The bidi stream stays open for the session's lifetime.
    expect(stream.end).not.toHaveBeenCalled();

    handle.abort();
  });

  it('forwards the caller-supplied afterSequence for replay resume', async () => {
    const stream = makeFakeStream();
    const { provider } = makeProvider(() => stream);

    const handle = provider.subscribeSession({ ...baseReq, afterSequence: 42 });
    await new Promise((r) => setImmediate(r));

    expect(stream.write).toHaveBeenCalledWith({
      subscribeSessionId: 'sess-abc',
      afterSequence: 42
    });
    handle.abort();
  });

  it('never emits an envelope frame (Send is forbidden — observer-only)', async () => {
    const stream = makeFakeStream();
    const { provider } = makeProvider(() => stream);

    const handle = provider.subscribeSession(baseReq);
    await new Promise((r) => setImmediate(r));

    for (const call of stream.write.mock.calls) {
      const arg = call[0] as Record<string, unknown>;
      expect(arg).not.toHaveProperty('envelope');
      expect(arg).not.toHaveProperty('messageType');
      expect(arg).not.toHaveProperty('payload');
    }
    handle.abort();
  });

  it('surfaces an iterator failure when the subscribe-frame write throws synchronously', async () => {
    const stream = makeFakeStream();
    stream.write.mockImplementation(() => {
      throw new Error('write failed: channel closed');
    });
    const { provider } = makeProvider(() => stream);

    const handle = provider.subscribeSession(baseReq);
    const it = handle.events[Symbol.asyncIterator]();

    // First yielded event is always the synthetic 'opened' status frame.
    const opened = await it.next();
    expect(opened.done).toBe(false);
    expect((opened.value as RawRuntimeEvent).kind).toBe('stream-status');

    await expect(it.next()).rejects.toThrow(/write failed/);
    expect(stream.end).not.toHaveBeenCalled();
  });

  it('emits a synthetic stream-status "opened" event before any data frames', async () => {
    const stream = makeFakeStream();
    const { provider } = makeProvider(() => stream);

    const handle = provider.subscribeSession(baseReq);
    const it = handle.events[Symbol.asyncIterator]();

    const first = await it.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      kind: 'stream-status',
      streamStatus: { status: 'opened' }
    });

    handle.abort();
  });

  it('filters incoming envelopes whose sessionId differs from the subscriber', async () => {
    const stream = makeFakeStream();
    const { provider } = makeProvider(() => stream);

    const handle = provider.subscribeSession(baseReq);
    await new Promise((r) => setImmediate(r));

    // Other-session envelope (must be dropped).
    stream.emit('data', {
      envelope: {
        sessionId: 'other-session',
        messageType: 'Decision',
        messageId: 'm1',
        sender: 'agent-1',
        payload: Buffer.from(''),
        timestampUnixMs: 1
      }
    });
    // Same-session envelope (must be delivered).
    stream.emit('data', {
      envelope: {
        sessionId: 'sess-abc',
        messageType: 'Decision',
        messageId: 'm2',
        sender: 'agent-1',
        payload: Buffer.from(''),
        timestampUnixMs: 2
      }
    });
    stream.emit('end');

    const events = await drain(handle.events);
    const envelopeEvents = events.filter((e) => e.kind === 'stream-envelope');
    expect(envelopeEvents).toHaveLength(1);
    expect(envelopeEvents[0].envelope?.messageId).toBe('m2');
  });

  it('drops an envelope with an empty sessionId on the per-session StreamSession and logs a warning', async () => {
    const stream = makeFakeStream();
    const { provider } = makeProvider(() => stream);
    const warnSpy = jest.spyOn((provider as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn');

    const handle = provider.subscribeSession(baseReq);
    await new Promise((r) => setImmediate(r));

    // Empty sessionId (e.g. malformed/ambient-shaped envelope arriving on the
    // per-session stream) must NOT pass the filter — the old `envelope.sessionId &&`
    // short-circuit let this through and silently advanced the resume ordinal.
    stream.emit('data', {
      envelope: {
        sessionId: '',
        messageType: 'Signal',
        messageId: 'sig-1',
        sender: 'agent-1',
        payload: Buffer.from(''),
        timestampUnixMs: 1
      }
    });
    // Absent sessionId (undefined) must also be dropped.
    stream.emit('data', {
      envelope: {
        messageType: 'Signal',
        messageId: 'sig-2',
        sender: 'agent-1',
        payload: Buffer.from(''),
        timestampUnixMs: 2
      }
    });
    // Same-session envelope still delivered.
    stream.emit('data', {
      envelope: {
        sessionId: 'sess-abc',
        messageType: 'Decision',
        messageId: 'm2',
        sender: 'agent-1',
        payload: Buffer.from(''),
        timestampUnixMs: 3
      }
    });
    stream.emit('end');

    const events = await drain(handle.events);
    const envelopeEvents = events.filter((e) => e.kind === 'stream-envelope');
    expect(envelopeEvents).toHaveLength(1);
    expect(envelopeEvents[0].envelope?.messageId).toBe('m2');
    expect(warnSpy).toHaveBeenCalledTimes(2);
    // Both calls share the "mismatched or empty sessionId" prefix, so pin down the
    // interpolated envelopeSessionId to prove each drop was logged for the right
    // envelope — not just that *some* warning containing "empty sessionId" fired.
    expect(warnSpy.mock.calls[0][0]).toEqual(
      expect.stringContaining('envelopeSessionId="", messageType=Signal, messageId=sig-1')
    );
    expect(warnSpy.mock.calls[1][0]).toEqual(
      expect.stringContaining('envelopeSessionId="undefined", messageType=Signal, messageId=sig-2')
    );
  });

  it('does not leak the empty-sessionId drop into watchSignals() — ambient Signal envelopes with empty sessionId are still delivered', async () => {
    const signalStream = makeFakeStream();
    const { provider } = makeProvider(
      () => makeFakeStream(),
      {},
      () => signalStream
    );

    const iterable = provider.watchSignals();
    const collected = drain(iterable);
    await new Promise((r) => setImmediate(r));

    // Ambient Signal envelopes always carry an empty sessionId (correlation
    // happens via `correlation_session_id` in the decoded payload instead —
    // see SignalConsumerService). watchSignals() has no session filter at all,
    // and must keep delivering these unmodified by the StreamSession-only fix.
    signalStream.emit('data', {
      envelope: {
        sessionId: '',
        messageType: 'Signal',
        messageId: 'sig-1',
        sender: 'agent-1',
        payload: Buffer.from(''),
        timestampUnixMs: 1
      }
    });
    signalStream.emit('end');

    const events = await collected;
    const envelopeEvents = events.filter((e) => e.kind === 'stream-envelope');
    expect(envelopeEvents).toHaveLength(1);
    expect(envelopeEvents[0].envelope?.sessionId).toBe('');
    expect(envelopeEvents[0].envelope?.messageId).toBe('sig-1');
  });
});

describe('RustRuntimeProvider.listSessions — pagination, bounds, and truth-in-contract (Phase 2, 0.7.0)', () => {
  function spyUnary(provider: RustRuntimeProvider) {
    return jest.spyOn(provider as unknown as { unary: (...a: unknown[]) => Promise<unknown> }, 'unary');
  }

  it('follows next_page_token across pages, concatenates sessions, and reports complete:true', async () => {
    const stream = makeFakeStream();
    const { provider } = makeProvider(() => stream, { runtimeListSessionsPageSize: 100 });

    const unary = spyUnary(provider)
      .mockImplementationOnce(async () => ({
        sessions: [{ sessionId: 's1', state: 'SESSION_STATE_OPEN' }],
        nextPageToken: 'page-2'
      }))
      .mockImplementationOnce(async () => ({
        sessions: [{ sessionId: 's2', state: 'SESSION_STATE_OPEN' }],
        nextPageToken: ''
      }));

    const result = await provider.listSessions();

    expect(result.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(result.complete).toBe(true);
    expect(result.pagesFetched).toBe(2);
    expect(unary).toHaveBeenCalledTimes(2);
    // First call sends an empty page token plus the configured page size;
    // second echoes the server's token and keeps the same page size.
    expect(unary.mock.calls[0][1]).toEqual({ pageToken: '', pageSize: 100 });
    expect(unary.mock.calls[1][1]).toEqual({ pageToken: 'page-2', pageSize: 100 });
  });

  it('returns complete:true, pagesFetched:1 after a single call when next_page_token is empty', async () => {
    const stream = makeFakeStream();
    const { provider, instrumentation } = makeProvider(() => stream);

    const unary = spyUnary(provider).mockResolvedValue({
      sessions: [{ sessionId: 's1', state: 'SESSION_STATE_OPEN' }],
      nextPageToken: ''
    });

    const result = await provider.listSessions();

    expect(result.sessions).toHaveLength(1);
    expect(result.complete).toBe(true);
    expect(result.pagesFetched).toBe(1);
    expect(unary).toHaveBeenCalledTimes(1);
    expect(instrumentation.macpRuntimeListSessionsTruncatedTotal.inc).not.toHaveBeenCalled();
    expect(instrumentation.macpRuntimeListSessionsPages.observe).toHaveBeenCalledWith(1);
  });

  it('stops at RUNTIME_LIST_SESSIONS_MAX_PAGES against a server that never clears next_page_token, returning the collected prefix with complete:false', async () => {
    const stream = makeFakeStream();
    const { provider, instrumentation } = makeProvider(() => stream, { runtimeListSessionsMaxPages: 3 });

    const unary = spyUnary(provider).mockImplementation(async () => ({
      sessions: [{ sessionId: 'sX', state: 'SESSION_STATE_OPEN' }],
      nextPageToken: 'always-more'
    }));

    const result = await provider.listSessions();

    expect(result.complete).toBe(false);
    expect(result.pagesFetched).toBe(3);
    expect(result.sessions).toHaveLength(3);
    expect(unary).toHaveBeenCalledTimes(3);
    expect(instrumentation.macpRuntimeListSessionsTruncatedTotal.inc).toHaveBeenCalledTimes(1);
    expect(instrumentation.macpRuntimeListSessionsPages.observe).toHaveBeenCalledWith(3);
  });

  it('stops when the overall RUNTIME_LIST_SESSIONS_TIMEOUT_MS budget is exceeded, returning complete:false', async () => {
    const stream = makeFakeStream();
    const { provider, instrumentation } = makeProvider(() => stream, {
      runtimeListSessionsTimeoutMs: 10,
      runtimeListSessionsMaxPages: 50
    });

    // Each page "arrives" slower than the whole drain's timeout budget, so the
    // deadline check at the top of the next loop iteration trips before a
    // second page is ever requested.
    const unary = spyUnary(provider).mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve({ sessions: [{ sessionId: 'sX', state: 'SESSION_STATE_OPEN' }], nextPageToken: 'more' }),
            50
          );
        })
    );

    const result = await provider.listSessions();

    expect(result.complete).toBe(false);
    expect(result.pagesFetched).toBe(1);
    expect(unary).toHaveBeenCalledTimes(1);
    expect(instrumentation.macpRuntimeListSessionsTruncatedTotal.inc).toHaveBeenCalledTimes(1);
  });

  it('halves the page size and retries the same page on RESOURCE_EXHAUSTED, then succeeds', async () => {
    const stream = makeFakeStream();
    const { provider } = makeProvider(() => stream, { runtimeListSessionsPageSize: 200 });

    const resourceExhausted = Object.assign(new Error('received message larger than max'), {
      metadata: { grpcCode: grpc.status.RESOURCE_EXHAUSTED }
    });

    const unary = spyUnary(provider)
      .mockRejectedValueOnce(resourceExhausted)
      .mockResolvedValueOnce({ sessions: [{ sessionId: 's1', state: 'SESSION_STATE_OPEN' }], nextPageToken: '' });

    const result = await provider.listSessions();

    expect(result.complete).toBe(true);
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(unary).toHaveBeenCalledTimes(2);
    // Same page (empty pageToken) retried with a halved page size.
    expect(unary.mock.calls[0][1]).toEqual({ pageToken: '', pageSize: 200 });
    expect(unary.mock.calls[1][1]).toEqual({ pageToken: '', pageSize: 100 });
  });

  it('rethrows RESOURCE_EXHAUSTED once the page size is already at the floor of 1', async () => {
    const stream = makeFakeStream();
    const { provider } = makeProvider(() => stream, { runtimeListSessionsPageSize: 1 });

    const resourceExhausted = Object.assign(new Error('received message larger than max'), {
      metadata: { grpcCode: grpc.status.RESOURCE_EXHAUSTED }
    });

    const unary = spyUnary(provider).mockRejectedValue(resourceExhausted);

    await expect(provider.listSessions()).rejects.toThrow('received message larger than max');
    expect(unary).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-RESOURCE_EXHAUSTED error and discards already-collected pages (unlike page-cap truncation)', async () => {
    const stream = makeFakeStream();
    const { provider, instrumentation } = makeProvider(() => stream);

    const unavailable = Object.assign(new Error('runtime unavailable'), {
      metadata: { grpcCode: grpc.status.UNAVAILABLE }
    });

    const unary = spyUnary(provider)
      .mockImplementationOnce(async () => ({
        sessions: [{ sessionId: 's1', state: 'SESSION_STATE_OPEN' }],
        nextPageToken: 'page-2'
      }))
      .mockRejectedValueOnce(unavailable);

    await expect(provider.listSessions()).rejects.toThrow('runtime unavailable');
    expect(unary).toHaveBeenCalledTimes(2);
    // No truncation signal is emitted for a hard failure — this is a thrown
    // error, not a labeled partial result.
    expect(instrumentation.macpRuntimeListSessionsTruncatedTotal.inc).not.toHaveBeenCalled();
  });

  it('bounds RESOURCE_EXHAUSTED halving to MAX_PAGE_SIZE_HALVINGS (GAP 1): rethrows on the 3rd attempt even though pageSize is still > 1', async () => {
    const stream = makeFakeStream();
    const { provider } = makeProvider(() => stream, { runtimeListSessionsPageSize: 200 });

    const resourceExhausted = Object.assign(new Error('received message larger than max'), {
      metadata: { grpcCode: grpc.status.RESOURCE_EXHAUSTED }
    });

    const unary = spyUnary(provider).mockRejectedValue(resourceExhausted);

    await expect(provider.listSessions()).rejects.toThrow('received message larger than max');
    // 200 -> 100 -> 50: 1 initial attempt + MAX_PAGE_SIZE_HALVINGS (2) retries
    // = 3 attempts, then rethrow even though pageSize (50) is still > 1 — the
    // halving *budget*, not the floor of 1, is what stops the ladder here.
    expect(unary).toHaveBeenCalledTimes(3);
    expect(unary.mock.calls[0][1]).toEqual({ pageToken: '', pageSize: 200 });
    expect(unary.mock.calls[1][1]).toEqual({ pageToken: '', pageSize: 100 });
    expect(unary.mock.calls[2][1]).toEqual({ pageToken: '', pageSize: 50 });
  });

  it('returns complete:false with the collected prefix when DEADLINE_EXCEEDED surfaces after the overall budget has expired mid-page (GAP 2)', async () => {
    const stream = makeFakeStream();
    const { provider, instrumentation } = makeProvider(() => stream, {
      runtimeListSessionsTimeoutMs: 20,
      runtimeListSessionsMaxPages: 50
    });

    // Real post-mapGrpcError shape (see isDeadlineExceeded's comment):
    // metadata.grpcCode, not a raw grpc.ServiceError .code.
    const deadlineExceeded = Object.assign(new Error('Deadline exceeded'), {
      metadata: { grpcCode: grpc.status.DEADLINE_EXCEEDED }
    });

    const unary = spyUnary(provider)
      .mockImplementationOnce(async () => ({
        sessions: [{ sessionId: 's1', state: 'SESSION_STATE_OPEN' }],
        nextPageToken: 'page-2'
      }))
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            // Longer than the 20ms overall budget, so by the time this
            // rejects, Date.now() >= deadlineAt — simulating the CP's own
            // per-call deadline clamp firing mid-page, not a slow runtime.
            setTimeout(() => reject(deadlineExceeded), 40);
          })
      );

    const result = await provider.listSessions();

    expect(result.complete).toBe(false);
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(result.pagesFetched).toBe(1);
    expect(unary).toHaveBeenCalledTimes(2);
    expect(instrumentation.macpRuntimeListSessionsTruncatedTotal.inc).toHaveBeenCalledTimes(1);
  });

  it('rethrows DEADLINE_EXCEEDED when the runtime is merely slow and the overall budget has NOT expired (GAP 2)', async () => {
    const stream = makeFakeStream();
    const { provider } = makeProvider(() => stream, { runtimeListSessionsTimeoutMs: 60_000 });

    const deadlineExceeded = Object.assign(new Error('Deadline exceeded'), {
      metadata: { grpcCode: grpc.status.DEADLINE_EXCEEDED }
    });

    const unary = spyUnary(provider).mockRejectedValue(deadlineExceeded);

    await expect(provider.listSessions()).rejects.toThrow('Deadline exceeded');
    expect(unary).toHaveBeenCalledTimes(1);
  });
});

describe('RustRuntimeProvider.listSessions — RESOURCE_EXHAUSTED ladder vs. the real CircuitBreaker (GAP 1 regression)', () => {
  it('makes exactly 3 attempts, rethrows the RESOURCE_EXHAUSTED-derived error (not "Circuit breaker is OPEN"), and leaves the breaker CLOSED at the default threshold of 5', async () => {
    // Unlike every test above, this one does NOT `jest.spyOn(provider,
    // 'unary')` — that bypasses `unary()` (and the CircuitBreaker it wraps)
    // entirely, which is exactly why GAP 1 slipped through review. Instead,
    // stub one level lower: the gRPC client method `unary()` calls.
    const config = {
      runtimeDevAgentId: 'control-plane',
      runtimeBearerToken: 'obs-token',
      runtimeUseDevHeader: false,
      runtimeCircuitBreakerThreshold: 5,
      runtimeCircuitBreakerResetMs: 30_000,
      runtimeRequestTimeoutMs: 30_000,
      runtimeListSessionsPageSize: 200,
      runtimeListSessionsMaxPages: 200,
      runtimeListSessionsTimeoutMs: 60_000
    } as unknown as AppConfigService;

    const jwtMinter = {
      isEnabled: () => false,
      getToken: () => Promise.reject(new Error('jwt disabled in unit test'))
    } as unknown as RuntimeJwtMinterService;
    const resolver = new RuntimeCredentialResolverService(config, jwtMinter);
    const instrumentation = {
      macpRuntimeListSessionsPages: { observe: jest.fn() },
      macpRuntimeListSessionsTruncatedTotal: { inc: jest.fn() },
      grpcCallDuration: { observe: jest.fn() },
      circuitBreakerSuccessTotal: { inc: jest.fn() },
      circuitBreakerFailuresTotal: { inc: jest.fn() },
      circuitBreakerState: { set: jest.fn() }
    } as unknown as InstrumentationService;

    const provider = new RustRuntimeProvider(config, resolver, instrumentation);

    // Install the SAME circuit breaker onModuleInit() builds — via the
    // extracted `buildCircuitBreaker()` — without running proto loading or
    // opening a real gRPC channel.
    (provider as unknown as { circuitBreaker: CircuitBreaker }).circuitBreaker = (
      provider as unknown as { buildCircuitBreaker: () => CircuitBreaker }
    ).buildCircuitBreaker();

    const client = {
      ListSessions: jest.fn(
        (
          _request: unknown,
          _metadata: unknown,
          _opts: unknown,
          callback: (error: unknown, response: unknown) => void
        ) => {
          // A raw grpc.ServiceError-shaped rejection — exactly what
          // @grpc/grpc-js hands unary()'s callback. The real `mapGrpcError()`
          // inside the real `unary()` does the translation to metadata.grpcCode.
          const serviceError = Object.assign(new Error('received message larger than max'), {
            code: grpc.status.RESOURCE_EXHAUSTED,
            details: 'received message larger than max'
          });
          callback(serviceError, null);
        }
      )
    };
    (provider as unknown as { client: unknown }).client = client;

    let thrown: unknown;
    try {
      await provider.listSessions();
    } catch (error) {
      thrown = error;
    }

    // 200 -> 100 -> 50: exactly 3 attempts (1 initial + MAX_PAGE_SIZE_HALVINGS).
    expect(client.ListSessions).toHaveBeenCalledTimes(3);
    // Rethrows the RESOURCE_EXHAUSTED-derived AppException, NOT a
    // "Circuit breaker is OPEN" error — this is the whole point of the gap.
    expect(thrown).toBeInstanceOf(AppException);
    expect((thrown as Error).message).toBe('received message larger than max');
    expect((thrown as Error).message).not.toMatch(/circuit breaker/i);
    expect((thrown as AppException).metadata).toEqual({ grpcCode: grpc.status.RESOURCE_EXHAUSTED });
    // With the default threshold of 5, a 3-attempt ladder must not trip the breaker.
    expect(provider.getCircuitBreakerState()).toBe('CLOSED');
    expect(provider.getCircuitBreakerState()).not.toBe('OPEN');
  });
});
