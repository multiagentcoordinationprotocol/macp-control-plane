import * as client from 'prom-client';
import { InstrumentationService } from './instrumentation.service';

// Mock prom-client so we don't pollute the global registry across tests
jest.mock('prom-client', () => {
  const mockHistogram = jest.fn().mockImplementation(() => ({
    observe: jest.fn(),
    labels: jest.fn().mockReturnThis(),
    startTimer: jest.fn(),
  }));
  const mockCounter = jest.fn().mockImplementation(() => ({
    inc: jest.fn(),
    labels: jest.fn().mockReturnThis(),
  }));
  const mockGauge = jest.fn().mockImplementation(() => ({
    set: jest.fn(),
    inc: jest.fn(),
    dec: jest.fn(),
    labels: jest.fn().mockReturnThis(),
  }));

  return {
    Histogram: mockHistogram,
    Counter: mockCounter,
    Gauge: mockGauge,
    collectDefaultMetrics: jest.fn(),
    register: {
      metrics: jest.fn().mockResolvedValue('# HELP fake_metric\nfake_metric 1'),
      contentType: 'text/plain; version=0.0.4; charset=utf-8',
    },
  };
});

describe('InstrumentationService', () => {
  let service: InstrumentationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InstrumentationService();
  });

  // ===========================================================================
  // onModuleInit
  // ===========================================================================
  describe('onModuleInit', () => {
    it('should call collectDefaultMetrics', () => {
      service.onModuleInit();

      expect(client.collectDefaultMetrics).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // getMetrics
  // ===========================================================================
  describe('getMetrics', () => {
    it('should return a string from the registry', async () => {
      const result = await service.getMetrics();

      expect(typeof result).toBe('string');
      expect(client.register.metrics).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // getContentType
  // ===========================================================================
  describe('getContentType', () => {
    it('should return the registry content type string', () => {
      const result = service.getContentType();

      expect(typeof result).toBe('string');
      expect(result).toContain('text/plain');
    });
  });

  // ===========================================================================
  // Metric instances are defined with correct type and (for counters/histograms)
  // can round-trip an observation / increment.
  // ===========================================================================
  describe('metric instances', () => {
    /** Helper — assert the metric has the expected methods for its type. */
    function assertMetricShape(metric: unknown, type: 'counter' | 'histogram' | 'gauge') {
      expect(metric).toBeDefined();
      const m = metric as Record<string, unknown>;
      if (type === 'counter') {
        expect(typeof m.inc).toBe('function');
      } else if (type === 'histogram') {
        expect(typeof m.observe).toBe('function');
      } else if (type === 'gauge') {
        expect(typeof m.inc).toBe('function');
        expect(typeof m.dec).toBe('function');
        expect(typeof m.set).toBe('function');
      }
    }

    it('httpRequestDuration is a histogram and observes', () => {
      assertMetricShape(service.httpRequestDuration, 'histogram');
      expect(() =>
        service.httpRequestDuration.observe({ method: 'GET', status_code: '200' }, 0.1),
      ).not.toThrow();
    });

    it('httpRequestsTotal is a counter and increments', () => {
      assertMetricShape(service.httpRequestsTotal, 'counter');
      expect(() => service.httpRequestsTotal.inc({ method: 'GET', status_code: '200' })).not.toThrow();
    });

    it('activeSseConnections is a gauge and inc/dec', () => {
      assertMetricShape(service.activeSseConnections, 'gauge');
      expect(() => service.activeSseConnections.inc()).not.toThrow();
      expect(() => service.activeSseConnections.dec()).not.toThrow();
    });

    it('activeStreams is a gauge', () => {
      assertMetricShape(service.activeStreams, 'gauge');
    });

    it('runStateTotal is a counter with status label', () => {
      assertMetricShape(service.runStateTotal, 'counter');
      expect(() => service.runStateTotal.inc({ status: 'queued' })).not.toThrow();
    });

    it('grpcCallDuration is a histogram with method + status labels', () => {
      assertMetricShape(service.grpcCallDuration, 'histogram');
      expect(() =>
        service.grpcCallDuration.observe({ method: 'Initialize', status: 'ok' }, 0.05),
      ).not.toThrow();
    });

    it('circuitBreakerState is a gauge', () => {
      assertMetricShape(service.circuitBreakerState, 'gauge');
    });

    it('circuitBreakerFailuresTotal is a counter', () => {
      assertMetricShape(service.circuitBreakerFailuresTotal, 'counter');
    });

    it('circuitBreakerSuccessTotal is a counter', () => {
      assertMetricShape(service.circuitBreakerSuccessTotal, 'counter');
    });

    it('outboundMessagesTotal is a counter with category + status labels', () => {
      assertMetricShape(service.outboundMessagesTotal, 'counter');
      expect(() =>
        service.outboundMessagesTotal.inc({ category: 'observer', status: 'subscribed' }),
      ).not.toThrow();
    });

    it('inboundMessagesTotal is a counter', () => {
      assertMetricShape(service.inboundMessagesTotal, 'counter');
    });

    it('signalsTotal is a counter with signal_type label', () => {
      assertMetricShape(service.signalsTotal, 'counter');
      expect(() => service.signalsTotal.inc({ signal_type: 'progress' })).not.toThrow();
    });

    it('streamReconnectsTotal is a counter', () => {
      assertMetricShape(service.streamReconnectsTotal, 'counter');
    });

    it('recoveryTotal is a counter with status label', () => {
      assertMetricShape(service.recoveryTotal, 'counter');
      expect(() => service.recoveryTotal.inc({ status: 'success' })).not.toThrow();
    });

    it('webhookDeliveriesTotal is a counter with event + status labels', () => {
      assertMetricShape(service.webhookDeliveriesTotal, 'counter');
    });
  });

  // ===========================================================================
  // Metric constructors called with correct names
  // ===========================================================================
  describe('metric registration names', () => {
    it('should register httpRequestDuration with correct name', () => {
      expect(client.Histogram).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'http_request_duration_seconds' }),
      );
    });

    it('should register httpRequestsTotal with correct name', () => {
      expect(client.Counter).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'http_requests_total' }),
      );
    });

    it('should register grpcCallDuration with correct name', () => {
      expect(client.Histogram).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'grpc_call_duration_seconds' }),
      );
    });

    it('should register activeSseConnections with correct name', () => {
      expect(client.Gauge).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'active_sse_connections' }),
      );
    });

    it('should register activeStreams with correct name', () => {
      expect(client.Gauge).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'active_runtime_streams' }),
      );
    });

    it('should register circuitBreakerState with correct name', () => {
      expect(client.Gauge).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'circuit_breaker_state' }),
      );
    });
  });
});
