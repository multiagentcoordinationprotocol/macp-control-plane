import { RustRuntimeProvider } from './rust-runtime.provider';
import { AppConfigService } from '../config/app-config.service';
import { RuntimeCredentialResolverService } from './runtime-credential-resolver.service';
import { RuntimeJwtMinterService } from './runtime-jwt-minter.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { RawRuntimeEvent, RuntimeSubscribeSessionRequest } from '../contracts/runtime';

/**
 * Focused unit tests for the RFC-MACP-0006 §3.2 passive-subscribe behavior
 * added to RustRuntimeProvider.subscribeSession(): the control-plane writes
 * exactly one frame ({subscribeSessionId, afterSequence}) on the bidi stream
 * and then half-closes the write side. Full gRPC plumbing (proto loading,
 * real channel) is bypassed by stubbing the gRPC client directly.
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

function makeProvider(streamFactory: () => unknown): {
  provider: RustRuntimeProvider;
  resolver: RuntimeCredentialResolverService;
} {
  const config = {
    runtimeDevAgentId: 'control-plane',
    runtimeBearerToken: 'obs-token',
    runtimeUseDevHeader: false,
    runtimeCircuitBreakerThreshold: 5,
    runtimeCircuitBreakerResetMs: 30_000
  } as unknown as AppConfigService;

  const jwtMinter = {
    isEnabled: () => false,
    getToken: () => Promise.reject(new Error('jwt disabled in unit test'))
  } as unknown as RuntimeJwtMinterService;
  const resolver = new RuntimeCredentialResolverService(config, jwtMinter);
  const instrumentation = {} as InstrumentationService;
  const provider = new RustRuntimeProvider(config, resolver, instrumentation);

  // Bypass onModuleInit() — proto loading is unnecessary for these tests.
  // Stub the gRPC client so getClientMethod(client, 'StreamSession') returns
  // a function that yields our fake bidi stream.
  const fakeStreamSession = jest.fn(() => streamFactory());
  (provider as unknown as { client: unknown }).client = {
    StreamSession: fakeStreamSession
  };

  return { provider, resolver };
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
});
