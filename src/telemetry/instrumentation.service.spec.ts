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
  // Metric instances are defined
  // ===========================================================================
  describe('metric instances', () => {
    it('should define httpRequestDuration histogram', () => {
      expect(service.httpRequestDuration).toBeDefined();
    });

    it('should define httpRequestsTotal counter', () => {
      expect(service.httpRequestsTotal).toBeDefined();
    });

    it('should define activeSseConnections gauge', () => {
      expect(service.activeSseConnections).toBeDefined();
    });

    it('should define activeStreams gauge', () => {
      expect(service.activeStreams).toBeDefined();
    });

    it('should define runStateTotal counter', () => {
      expect(service.runStateTotal).toBeDefined();
    });

    it('should define grpcCallDuration histogram', () => {
      expect(service.grpcCallDuration).toBeDefined();
    });

    it('should define circuitBreakerState gauge', () => {
      expect(service.circuitBreakerState).toBeDefined();
    });

    it('should define circuitBreakerFailuresTotal counter', () => {
      expect(service.circuitBreakerFailuresTotal).toBeDefined();
    });

    it('should define circuitBreakerSuccessTotal counter', () => {
      expect(service.circuitBreakerSuccessTotal).toBeDefined();
    });

    it('should define outboundMessagesTotal counter', () => {
      expect(service.outboundMessagesTotal).toBeDefined();
    });

    it('should define inboundMessagesTotal counter', () => {
      expect(service.inboundMessagesTotal).toBeDefined();
    });

    it('should define signalsTotal counter', () => {
      expect(service.signalsTotal).toBeDefined();
    });

    it('should define streamReconnectsTotal counter', () => {
      expect(service.streamReconnectsTotal).toBeDefined();
    });

    it('should define recoveryTotal counter', () => {
      expect(service.recoveryTotal).toBeDefined();
    });

    it('should define webhookDeliveriesTotal counter', () => {
      expect(service.webhookDeliveriesTotal).toBeDefined();
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
