/**
 * Real-SDK span test for the macp-semconv/0.1 names (spec
 * `schemas/otel/macp-semconv.json`, `docs/opentelemetry.md`) and for the
 * single-traceparent rule on outgoing gRPC calls.
 *
 * Unlike trace.service.spec.ts this does NOT mock @opentelemetry/api: spans go
 * through a real tracer provider into an in-memory exporter, and the gRPC calls
 * hit a real in-process grpc-js server that records the metadata it received.
 */
import * as grpc from '@grpc/grpc-js';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { GrpcInstrumentation } from '@opentelemetry/instrumentation-grpc';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMetadata, isGrpcClientAutoInstrumented } from '../runtime/grpc-helpers';
import { StreamConsumerService } from '../runs/stream-consumer.service';
import {
  LEGACY_ATTRIBUTE_ALIASES,
  LEGACY_SPAN_EVENT_ATTRIBUTE_ALIASES,
  MACP_ATTR,
  MACP_CP_ATTR,
  OTEL_ATTR
} from './semconv';
import { TraceService } from './trace.service';

// Vendored verbatim from the spec repo's schemas/otel/macp-semconv.json (spec @ 50ae62e),
// as docs/opentelemetry.md asks implementations to do. Re-copy when the spec bumps it.
const SEMCONV = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/otel/macp-semconv.json'), 'utf8')) as {
  schema: string;
  groups: Array<{ id: string; attributes?: Array<{ id?: string; ref?: string }> }>;
};
const REGISTRY_IDS = new Set(
  SEMCONV.groups
    .filter((g) => g.id === 'registry.macp' || g.id === 'registry.macp.reused')
    .flatMap((g) => (g.attributes ?? []).map((a) => a.id ?? a.ref))
);

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  propagation.disable();
  context.disable();
});

beforeEach(() => exporter.reset());

function spanNamed(name: string): ReadableSpan {
  const span = exporter.getFinishedSpans().find((s) => s.name === name);
  if (!span) throw new Error(`no finished span '${name}'`);
  return span;
}

describe('macp-semconv/0.1 span attributes', () => {
  it('every registry name this code emits is in the vendored macp-semconv/0.1 registry', () => {
    expect(SEMCONV.schema).toBe('macp-semconv/0.1');
    for (const name of [...Object.values(MACP_ATTR), ...Object.values(OTEL_ATTR)]) {
      expect(REGISTRY_IDS.has(name)).toBe(true);
    }
    // ...and every macp.cp.* name stays out of the registry namespace proper.
    for (const name of Object.values(MACP_CP_ATTR)) {
      expect(name.startsWith('macp.cp.')).toBe(true);
      expect(REGISTRY_IDS.has(name)).toBe(false);
    }
  });

  it('stream.handle_raw_event carries the registry names, the macp.cp.* names, and the legacy aliases', async () => {
    const traceService = new TraceService();
    const service = new StreamConsumerService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      traceService
    );
    jest.spyOn(service as never, 'handleRawEventInner').mockResolvedValue(undefined as never);

    traceService.startRunTrace('run-1', { [MACP_CP_ATTR.RUNTIME_KIND]: 'rust' });
    await (service as any).handleRawEvent(
      'run-1',
      {
        kind: 'stream-envelope',
        receivedAt: new Date().toISOString(),
        envelope: {
          macpVersion: '1.0',
          mode: 'macp.mode.decision.v1',
          messageType: 'Commitment',
          messageId: 'msg-1',
          sessionId: 'sess-1',
          sender: 'agent://planner',
          timestampUnixMs: 0,
          payload: Buffer.from('{"reason":"secret rationale","action":"deploy"}')
        }
      },
      {},
      'sess-1',
      {}
    );
    traceService.endRunTrace('run-1', 'completed');

    const attrs = spanNamed('stream.handle_raw_event').attributes;
    expect(attrs).toMatchObject({
      [MACP_ATTR.SESSION_ID]: 'sess-1',
      [MACP_ATTR.MESSAGE_TYPE]: 'Commitment',
      [MACP_ATTR.MESSAGE_ID]: 'msg-1',
      [MACP_ATTR.SENDER_ID]: 'agent://planner',
      [MACP_ATTR.MODE_ID]: 'macp.mode.decision.v1',
      [MACP_CP_ATTR.RUN_ID]: 'run-1',
      [MACP_CP_ATTR.RAW_EVENT_KIND]: 'stream-envelope',
      // one-release dual emission
      'macp.session_id': 'sess-1',
      session_id: 'sess-1',
      'macp.message_type': 'Commitment',
      run_id: 'run-1',
      'macp.raw_kind': 'stream-envelope'
    });
    // Identifiers and types only: no payload bytes or free text in any value.
    for (const value of Object.values(attrs)) {
      expect(String(value)).not.toMatch(/secret rationale|deploy/);
    }
    // Every non-legacy key is a vendored-registry name or under macp.cp.*.
    const legacy = new Set(Object.values(LEGACY_ATTRIBUTE_ALIASES).flat());
    for (const key of Object.keys(attrs).filter((k) => !legacy.has(k))) {
      expect(REGISTRY_IDS.has(key) || key.startsWith('macp.cp.')).toBe(true);
    }

    const lifecycle = spanNamed('run.lifecycle').attributes;
    expect(lifecycle).toMatchObject({
      [MACP_CP_ATTR.RUN_ID]: 'run-1',
      [MACP_CP_ATTR.RUNTIME_KIND]: 'rust',
      [MACP_CP_ATTR.RUN_TERMINAL_STATUS]: 'completed',
      runtime_kind: 'rust',
      'run.terminal_status': 'completed'
    });
  });

  it('run-span annotations use the new names and dual-emit the old ones', () => {
    const traceService = new TraceService();
    traceService.startRunTrace('run-2', {});
    traceService.addRunSpanEvent('run-2', 'signal.acknowledged', {
      [MACP_CP_ATTR.EVENT_SEQ]: 4,
      [MACP_CP_ATTR.SIGNAL_ID]: 'sig-1',
      [MACP_ATTR.SENDER_ID]: 'agent://a',
      [OTEL_ATTR.ERROR_TYPE]: undefined
    });
    traceService.endRunTrace('run-2', 'completed');
    const event = spanNamed('run.lifecycle').events.find((e) => e.name === 'signal.acknowledged');
    expect(event?.attributes).toEqual({
      'macp.cp.event.seq': 4,
      seq: 4,
      'macp.cp.signal.id': 'sig-1',
      signalId: 'sig-1',
      'macp.sender.id': 'agent://a',
      sender: 'agent://a'
    });
    const legacy = new Set(Object.values(LEGACY_SPAN_EVENT_ATTRIBUTE_ALIASES).flat());
    for (const key of Object.keys(event!.attributes!).filter((k) => !legacy.has(k))) {
      expect(REGISTRY_IDS.has(key) || key.startsWith('macp.cp.')).toBe(true);
    }
  });

  it('withSpan maps the mode and session onto macp.mode.id / macp.session.id', async () => {
    const traceService = new TraceService();
    await traceService.withSpan(
      'runtime.await_session_open',
      { [MACP_ATTR.MODE_ID]: 'macp.mode.task.v1', [MACP_ATTR.SESSION_ID]: 's-9', ignored: undefined },
      async () => undefined
    );
    const attrs = spanNamed('runtime.await_session_open').attributes;
    expect(attrs).toEqual({
      'macp.mode.id': 'macp.mode.task.v1',
      mode_name: 'macp.mode.task.v1',
      'macp.session.id': 's-9',
      session_id: 's-9',
      'macp.session_id': 's-9'
    });
  });
});

// ---------------------------------------------------------------------------
// One traceparent per outgoing call.
// ---------------------------------------------------------------------------

const ECHO_SERVICE: grpc.ServiceDefinition = {
  Echo: {
    path: '/test.Echo/Echo',
    requestStream: false,
    responseStream: false,
    requestSerialize: (b: Buffer) => b,
    requestDeserialize: (b: Buffer) => b,
    responseSerialize: (b: Buffer) => b,
    responseDeserialize: (b: Buffer) => b
  }
};

describe('traceparent injection on outgoing gRPC calls', () => {
  let server: grpc.Server;
  let address: string;
  let received: string[][];

  beforeAll(async () => {
    server = new grpc.Server();
    server.addService(ECHO_SERVICE, {
      Echo: (call: grpc.ServerUnaryCall<Buffer, Buffer>, cb: grpc.sendUnaryData<Buffer>) => {
        received.push(call.metadata.get('traceparent').map(String));
        cb(null, call.request);
      }
    });
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) =>
        err ? reject(err) : resolve(p)
      )
    );
    address = `127.0.0.1:${port}`;
  });

  afterAll(() => server.forceShutdown());
  beforeEach(() => (received = []));

  async function callEcho(Client: grpc.ServiceClientConstructor): Promise<string> {
    const client = new Client(address, grpc.credentials.createInsecure()) as unknown as grpc.Client & {
      Echo: (req: Buffer, md: grpc.Metadata, cb: (e: Error | null) => void) => void;
    };
    const span = trace.getTracer('test').startSpan('caller');
    try {
      await context.with(trace.setSpan(context.active(), span), async () => {
        // buildMetadata runs inside the caller span, exactly as RustRuntimeProvider uses it.
        const md = buildMetadata({ authorization: 'Bearer t' });
        await new Promise<void>((resolve, reject) =>
          client.Echo(Buffer.from('x'), md, (e) => (e ? reject(e) : resolve()))
        );
      });
    } finally {
      span.end();
      client.close();
    }
    return span.spanContext().spanId;
  }

  it('without gRPC auto-instrumentation, buildMetadata is the one injector', async () => {
    expect(isGrpcClientAutoInstrumented()).toBe(false);
    const Client = grpc.makeGenericClientConstructor(ECHO_SERVICE, 'Echo');
    const callerSpanId = await callEcho(Client);

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(1);
    // parent-id in the header is the caller span: we injected it.
    expect(received[0][0].split('-')[2]).toBe(callerSpanId);
  });

  // macp-sdk-typescript >= 0.20 injects traceparent itself, but only inside `MacpClient.send`
  // (its CLIENT `send` span). The control plane talks to the runtime through RustRuntimeProvider,
  // never MacpClient, and loading the SDK patches nothing, so buildMetadata stays the one injector
  // (docs/opentelemetry.md in the spec repo: exactly one traceparent per call).
  it('loading macp-sdk-typescript adds no second injector, and src/ never constructs a MacpClient', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('macp-sdk-typescript');
    expect(isGrpcClientAutoInstrumented()).toBe(false);
    const callerSpanId = await callEcho(grpc.makeGenericClientConstructor(ECHO_SERVICE, 'Echo'));
    expect(received).toEqual([[expect.stringContaining(`-${callerSpanId}-`)]]);

    const offenders = sourceFiles(join(__dirname, '..')).filter((f) =>
      /\bnew\s+MacpClient\b|\bMacpClient\s*\(/.test(readFileSync(f, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  // Note what this proves. Both injectors use Metadata.set and the instrumentation
  // writes last, so even a double injection would put one header on the wire
  // naming the client span. The change under test is the `probe` assertion:
  // inside an active span, buildMetadata leaves traceparent to the instrumentation.
  it('with gRPC auto-instrumentation, buildMetadata injects nothing and the instrumentation is the one injector', async () => {
    const instrumentation = new GrpcInstrumentation();
    instrumentation.setTracerProvider(provider);
    // Jest's module registry bypasses require-in-the-middle, so apply the
    // instrumentation's own grpc-js patch to the loaded module directly.
    const definitions = (instrumentation as any).init() as Array<{
      patch?: (m: unknown, v?: string) => unknown;
      unpatch?: (m: unknown, v?: string) => void;
    }>;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const version = require('@grpc/grpc-js/package.json').version as string;
    definitions.forEach((d) => d.patch?.(grpc, version));
    try {
      expect(isGrpcClientAutoInstrumented()).toBe(true);
      const probe = trace.getTracer('test').startSpan('probe');
      context.with(trace.setSpan(context.active(), probe), () => {
        expect(buildMetadata({ authorization: 'Bearer t' }).get('traceparent')).toEqual([]);
      });
      probe.end();

      const Client = grpc.makeGenericClientConstructor(ECHO_SERVICE, 'Echo');
      const callerSpanId = await callEcho(Client);

      expect(received).toHaveLength(1);
      expect(received[0]).toHaveLength(1);
      // parent-id is the instrumentation's client span (a child of the caller), not the caller.
      const clientSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name === 'grpc.test.Echo/Echo' && s.parentSpanId === callerSpanId);
      expect(clientSpan).toBeDefined();
      expect(received[0][0].split('-')[2]).toBe(clientSpan!.spanContext().spanId);
    } finally {
      definitions.forEach((d) => d.unpatch?.(grpc, version));
    }
    expect(isGrpcClientAutoInstrumented()).toBe(false);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [p] : [];
  });
}
