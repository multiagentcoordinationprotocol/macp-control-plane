import type { Response } from 'express';
import { HealthController } from './health.controller';
import { DatabaseService } from '../db/database.service';
import { AppConfigService } from '../config/app-config.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { RustRuntimeProvider } from '../runtime/rust-runtime.provider';
import { StreamConsumerService } from '../runs/stream-consumer.service';

describe('HealthController', () => {
  let controller: HealthController;
  let mockPool: { query: jest.Mock };
  let mockDatabase: Partial<DatabaseService>;
  let mockConfig: Partial<AppConfigService>;
  let mockRuntimeRegistry: { get: jest.Mock };
  let mockRustProvider: { getCircuitBreakerState: jest.Mock };
  let mockStreamConsumer: { isHealthy: jest.Mock };
  let mockRes: { status: jest.Mock };

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    mockDatabase = {
      pool: mockPool as any,
      hasFatalError: false
    };
    mockConfig = {
      runtimeKind: 'rust'
    };
    mockRuntimeRegistry = {
      get: jest.fn()
    };
    mockRustProvider = {
      getCircuitBreakerState: jest.fn().mockReturnValue('CLOSED')
    };
    mockStreamConsumer = {
      isHealthy: jest.fn()
    };
    mockRes = { status: jest.fn() };

    controller = new HealthController(
      mockDatabase as DatabaseService,
      mockConfig as AppConfigService,
      mockRuntimeRegistry as unknown as RuntimeProviderRegistry,
      mockRustProvider as unknown as RustRuntimeProvider,
      mockStreamConsumer as unknown as StreamConsumerService
    );
  });

  // =========================================================================
  // healthz
  // =========================================================================
  describe('healthz', () => {
    it('returns ok:true when db is healthy', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });

      const result = await controller.healthz();

      expect(result).toEqual({ ok: true, service: 'macp-control-plane' });
    });

    it('returns ok:false when db query fails', async () => {
      mockPool.query.mockRejectedValue(new Error('connection refused'));

      const result = await controller.healthz();

      expect(result).toEqual({ ok: false, service: 'macp-control-plane' });
    });

    it('returns ok:false when hasFatalError is true', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
      mockDatabase.hasFatalError = true;

      const result = await controller.healthz();

      expect(result).toEqual({ ok: false, service: 'macp-control-plane' });
    });

    it('returns ok:false when both db fails and hasFatalError', async () => {
      mockPool.query.mockRejectedValue(new Error('boom'));
      mockDatabase.hasFatalError = true;

      const result = await controller.healthz();

      expect(result).toEqual({ ok: false, service: 'macp-control-plane' });
    });
  });

  // =========================================================================
  // readyz
  // =========================================================================
  describe('readyz', () => {
    it('returns ok:true when all checks pass', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ ok: 1 }] });
      const runtimeHealth = { ok: true, runtimeKind: 'rust' };
      mockRuntimeRegistry.get.mockReturnValue({
        health: jest.fn().mockResolvedValue(runtimeHealth)
      });
      mockStreamConsumer.isHealthy.mockReturnValue(true);

      const result = await controller.readyz(mockRes as unknown as Response);

      expect(result).toEqual({
        ok: true,
        database: 'ok',
        runtime: runtimeHealth,
        streamConsumer: 'ok',
        circuitBreaker: 'CLOSED'
      });
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('returns ok:false when db is unhealthy', async () => {
      mockPool.query.mockRejectedValue(new Error('connection refused'));
      const runtimeHealth = { ok: true, runtimeKind: 'rust' };
      mockRuntimeRegistry.get.mockReturnValue({
        health: jest.fn().mockResolvedValue(runtimeHealth)
      });
      mockStreamConsumer.isHealthy.mockReturnValue(true);

      const result = await controller.readyz(mockRes as unknown as Response);

      expect(result.ok).toBe(false);
      expect(result.database).toBe('unhealthy');
      expect(mockRes.status).toHaveBeenCalledWith(503);
    });

    it('returns ok:false when runtime is unhealthy', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ ok: 1 }] });
      const runtimeHealth = { ok: false, runtimeKind: 'rust', detail: 'unreachable' };
      mockRuntimeRegistry.get.mockReturnValue({
        health: jest.fn().mockResolvedValue(runtimeHealth)
      });
      mockStreamConsumer.isHealthy.mockReturnValue(true);

      const result = await controller.readyz(mockRes as unknown as Response);

      expect(result.ok).toBe(false);
      expect(result.runtime).toEqual(runtimeHealth);
      expect(mockRes.status).toHaveBeenCalledWith(503);
    });

    it('returns ok:false when runtime.health() throws', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ ok: 1 }] });
      mockRuntimeRegistry.get.mockReturnValue({
        health: jest.fn().mockRejectedValue(new Error('gRPC unavailable'))
      });
      mockStreamConsumer.isHealthy.mockReturnValue(true);

      const result = await controller.readyz(mockRes as unknown as Response);

      expect(result.ok).toBe(false);
      expect(result.runtime).toEqual(
        expect.objectContaining({
          ok: false,
          runtimeKind: 'rust',
          detail: 'gRPC unavailable'
        })
      );
    });

    it('includes stream consumer health', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ ok: 1 }] });
      const runtimeHealth = { ok: true, runtimeKind: 'rust' };
      mockRuntimeRegistry.get.mockReturnValue({
        health: jest.fn().mockResolvedValue(runtimeHealth)
      });
      mockStreamConsumer.isHealthy.mockReturnValue(false);

      const result = await controller.readyz(mockRes as unknown as Response);

      expect(result.ok).toBe(false);
      expect(result.streamConsumer).toBe('unhealthy');
    });

    it('returns correct structure when all are unhealthy', async () => {
      mockPool.query.mockRejectedValue(new Error('db down'));
      mockRuntimeRegistry.get.mockReturnValue({
        health: jest.fn().mockResolvedValue({ ok: false, runtimeKind: 'rust' })
      });
      mockStreamConsumer.isHealthy.mockReturnValue(false);

      const result = await controller.readyz(mockRes as unknown as Response);

      expect(result.ok).toBe(false);
      expect(result.database).toBe('unhealthy');
      expect(result.runtime.ok).toBe(false);
      expect(result.streamConsumer).toBe('unhealthy');
    });

    it('returns 503 when only the circuit breaker is OPEN', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ ok: 1 }] });
      mockRuntimeRegistry.get.mockReturnValue({
        health: jest.fn().mockResolvedValue({ ok: true, runtimeKind: 'rust' })
      });
      mockStreamConsumer.isHealthy.mockReturnValue(true);
      mockRustProvider.getCircuitBreakerState.mockReturnValue('OPEN');

      const result = await controller.readyz(mockRes as unknown as Response);

      expect(result.ok).toBe(false);
      expect(result.circuitBreaker).toBe('OPEN');
      expect(mockRes.status).toHaveBeenCalledWith(503);
    });
  });
});
