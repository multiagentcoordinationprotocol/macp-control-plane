// ---------------------------------------------------------------------------
// Mock @opentelemetry/api — all mock references live inside the factory
// so they are available when Jest hoists the mock call.
// We expose handles via a shared mutable object.
// ---------------------------------------------------------------------------
const otelMocks = {
  end: jest.fn(),
  setAttribute: jest.fn(),
  setStatus: jest.fn(),
  recordException: jest.fn(),
  spanContext: jest.fn().mockReturnValue({ traceId: 'trace-abc-123' }),
  startSpan: jest.fn(),
  with: jest.fn(),
  active: jest.fn().mockReturnValue({}),
  setSpan: jest.fn().mockReturnValue({})
};

// Build the span object that startSpan returns
function makeSpan() {
  return {
    end: otelMocks.end,
    setAttribute: otelMocks.setAttribute,
    setStatus: otelMocks.setStatus,
    recordException: otelMocks.recordException,
    spanContext: otelMocks.spanContext
  };
}

otelMocks.startSpan.mockReturnValue(makeSpan());
otelMocks.with.mockImplementation((_ctx: any, fn: any) => fn());

jest.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: jest.fn().mockReturnValue({ startSpan: otelMocks.startSpan }),
    setSpan: otelMocks.setSpan
  },
  context: {
    with: otelMocks.with,
    active: otelMocks.active
  },
  SpanStatusCode: {
    OK: 1,
    ERROR: 2
  }
}));

// Import AFTER mock is set up
import { TraceService } from './trace.service';
import { SpanStatusCode } from '@opentelemetry/api';

describe('TraceService', () => {
  let service: TraceService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-wire default implementations after clearAllMocks
    otelMocks.startSpan.mockReturnValue(makeSpan());
    otelMocks.with.mockImplementation((_ctx: any, fn: any) => fn());
    otelMocks.spanContext.mockReturnValue({ traceId: 'trace-abc-123' });
    otelMocks.active.mockReturnValue({});
    otelMocks.setSpan.mockReturnValue({});

    service = new TraceService();
  });

  // ===========================================================================
  // withSpan
  // ===========================================================================
  describe('withSpan', () => {
    it('calls the function and returns its result', async () => {
      const result = await service.withSpan('test.op', { key: 'value' }, async () => 42);

      expect(result).toBe(42);
      expect(otelMocks.startSpan).toHaveBeenCalledWith('test.op');
      expect(otelMocks.setAttribute).toHaveBeenCalledWith('key', 'value');
      expect(otelMocks.end).toHaveBeenCalledTimes(1);
    });

    it('sets multiple attributes on the span', async () => {
      await service.withSpan('multi.attr', { a: 'alpha', b: 123, c: true }, async () => 'ok');

      expect(otelMocks.setAttribute).toHaveBeenCalledWith('a', 'alpha');
      expect(otelMocks.setAttribute).toHaveBeenCalledWith('b', 123);
      expect(otelMocks.setAttribute).toHaveBeenCalledWith('c', true);
    });

    it('skips undefined attribute values', async () => {
      await service.withSpan('skip.undef', { defined: 'yes', missing: undefined }, async () => 'ok');

      expect(otelMocks.setAttribute).toHaveBeenCalledWith('defined', 'yes');
      expect(otelMocks.setAttribute).not.toHaveBeenCalledWith('missing', expect.anything());
    });

    it('records exception and sets ERROR status on failure', async () => {
      const error = new Error('boom');
      otelMocks.with.mockImplementationOnce((_ctx: any, _fn: any) => {
        throw error;
      });

      await expect(
        service.withSpan('fail.op', {}, async () => {
          throw error;
        })
      ).rejects.toThrow('boom');

      expect(otelMocks.recordException).toHaveBeenCalledWith(error);
      expect(otelMocks.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'boom'
      });
      expect(otelMocks.end).toHaveBeenCalledTimes(1);
    });

    it('handles non-Error thrown values', async () => {
      otelMocks.with.mockImplementationOnce(() => {
        throw 'string-error';
      });

      await expect(service.withSpan('fail.string', {}, async () => 'unreachable')).rejects.toBe('string-error');

      expect(otelMocks.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'string-error'
      });
      expect(otelMocks.end).toHaveBeenCalledTimes(1);
    });

    it('always ends the span even on error', async () => {
      otelMocks.with.mockImplementationOnce(() => {
        throw new Error('fail');
      });

      await expect(service.withSpan('always.end', {}, async () => 'x')).rejects.toThrow('fail');

      expect(otelMocks.end).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // startRunTrace
  // ===========================================================================
  describe('startRunTrace', () => {
    it('returns a traceId and stores the span', () => {
      const traceId = service.startRunTrace('run-1', { mode: 'decision' });

      expect(traceId).toBe('trace-abc-123');
      expect(otelMocks.startSpan).toHaveBeenCalledWith('run.lifecycle');
      expect(otelMocks.setAttribute).toHaveBeenCalledWith('run_id', 'run-1');
      expect(otelMocks.setAttribute).toHaveBeenCalledWith('mode', 'decision');
    });

    it('skips undefined attributes', () => {
      service.startRunTrace('run-2', { present: 'yes', absent: undefined });

      expect(otelMocks.setAttribute).toHaveBeenCalledWith('present', 'yes');
      expect(otelMocks.setAttribute).not.toHaveBeenCalledWith('absent', expect.anything());
    });
  });

  // ===========================================================================
  // endRunTrace
  // ===========================================================================
  describe('endRunTrace', () => {
    it('ends span with OK status for completed runs', () => {
      service.startRunTrace('run-1', {});
      jest.clearAllMocks();

      service.endRunTrace('run-1', 'completed');

      expect(otelMocks.setAttribute).toHaveBeenCalledWith('run.terminal_status', 'completed');
      expect(otelMocks.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
      expect(otelMocks.end).toHaveBeenCalledTimes(1);
    });

    it('ends span with OK status for cancelled runs', () => {
      service.startRunTrace('run-2', {});
      jest.clearAllMocks();

      service.endRunTrace('run-2', 'cancelled');

      expect(otelMocks.setAttribute).toHaveBeenCalledWith('run.terminal_status', 'cancelled');
      expect(otelMocks.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
      expect(otelMocks.end).toHaveBeenCalledTimes(1);
    });

    it('ends span with ERROR status for failed runs', () => {
      service.startRunTrace('run-3', {});
      jest.clearAllMocks();

      service.endRunTrace('run-3', 'failed', 'runtime crashed');

      expect(otelMocks.setAttribute).toHaveBeenCalledWith('run.terminal_status', 'failed');
      expect(otelMocks.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'runtime crashed'
      });
      expect(otelMocks.recordException).toHaveBeenCalledWith(new Error('runtime crashed'));
      expect(otelMocks.end).toHaveBeenCalledTimes(1);
    });

    it('uses default error message when error string is not provided for failed runs', () => {
      service.startRunTrace('run-4', {});
      jest.clearAllMocks();

      service.endRunTrace('run-4', 'failed');

      expect(otelMocks.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: 'run failed'
      });
      // No recordException when error string is undefined
      expect(otelMocks.recordException).not.toHaveBeenCalled();
    });

    it('does nothing for unknown runId', () => {
      service.endRunTrace('unknown-run', 'completed');

      expect(otelMocks.setAttribute).not.toHaveBeenCalled();
      expect(otelMocks.setStatus).not.toHaveBeenCalled();
      expect(otelMocks.end).not.toHaveBeenCalled();
    });

    it('removes span from internal map after ending', () => {
      service.startRunTrace('run-5', {});
      service.endRunTrace('run-5', 'completed');
      jest.clearAllMocks();

      // Second call should be a no-op (span already removed)
      service.endRunTrace('run-5', 'completed');

      expect(otelMocks.end).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // withRunSpan (§6a)
  // ===========================================================================
  describe('withRunSpan', () => {
    it('creates child span parented to stored run span', async () => {
      service.startRunTrace('run-x', {});
      jest.clearAllMocks();
      otelMocks.startSpan.mockReturnValue(makeSpan());
      otelMocks.with.mockImplementation((_ctx: any, fn: any) => fn());

      const result = await service.withRunSpan('run-x', 'child.op', { a: 1 }, async () => 'ok');

      expect(result).toBe('ok');
      expect(otelMocks.startSpan).toHaveBeenCalledWith('child.op', undefined, expect.any(Object));
      expect(otelMocks.setAttribute).toHaveBeenCalledWith('run_id', 'run-x');
      expect(otelMocks.setAttribute).toHaveBeenCalledWith('a', 1);
      expect(otelMocks.end).toHaveBeenCalledTimes(1);
    });

    it('falls back to withSpan when run span is unknown', async () => {
      otelMocks.startSpan.mockReturnValue(makeSpan());

      const result = await service.withRunSpan('run-missing', 'child.op', {}, async () => 'fallback');

      expect(result).toBe('fallback');
      expect(otelMocks.startSpan).toHaveBeenCalledWith('child.op');
    });

    it('records exception and rethrows on failure', async () => {
      service.startRunTrace('run-err', {});
      jest.clearAllMocks();
      otelMocks.startSpan.mockReturnValue(makeSpan());
      otelMocks.with.mockImplementation((_ctx: any, fn: any) => fn());

      const boom = new Error('boom');
      await expect(
        service.withRunSpan('run-err', 'child.fail', {}, async () => {
          throw boom;
        })
      ).rejects.toBe(boom);

      expect(otelMocks.recordException).toHaveBeenCalledWith(boom);
      expect(otelMocks.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'boom' });
      expect(otelMocks.end).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // addRunSpanEvent + getRunTraceContext (§6c, §6d)
  // ===========================================================================
  describe('addRunSpanEvent', () => {
    it('adds span event to stored run span', () => {
      const addEvent = jest.fn();
      otelMocks.startSpan.mockReturnValueOnce({
        ...makeSpan(),
        addEvent
      } as any);

      service.startRunTrace('run-e', {});
      service.addRunSpanEvent('run-e', 'signal.emitted', { name: 'anomaly', seq: 3, skip: undefined });

      expect(addEvent).toHaveBeenCalledWith('signal.emitted', { name: 'anomaly', seq: 3 });
    });

    it('no-ops if run span is unknown', () => {
      expect(() => service.addRunSpanEvent('nope', 'x')).not.toThrow();
    });
  });

  describe('getRunTraceContext', () => {
    it('returns traceId + spanId for known run', () => {
      otelMocks.spanContext.mockReturnValue({ traceId: 'trace-1', spanId: 'span-1' });
      service.startRunTrace('run-ctx', {});
      const ctx = service.getRunTraceContext('run-ctx');
      expect(ctx).toEqual({ traceId: 'trace-1', spanId: 'span-1' });
    });

    it('returns undefined for unknown run', () => {
      expect(service.getRunTraceContext('unknown')).toBeUndefined();
    });
  });
});
