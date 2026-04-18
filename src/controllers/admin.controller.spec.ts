import { AdminController } from './admin.controller';
import { RustRuntimeProvider } from '../runtime/rust-runtime.provider';

describe('AdminController', () => {
  let controller: AdminController;
  let mockRustRuntime: {
    resetCircuitBreaker: jest.Mock;
    getCircuitBreakerState: jest.Mock;
    getCircuitBreakerHistory: jest.Mock;
  };

  beforeEach(() => {
    mockRustRuntime = {
      resetCircuitBreaker: jest.fn(),
      getCircuitBreakerState: jest.fn().mockReturnValue('CLOSED'),
      getCircuitBreakerHistory: jest
        .fn()
        .mockReturnValue([{ state: 'CLOSED', enteredAt: '2026-04-13T00:00:00Z', reason: 'initial' }])
    };

    controller = new AdminController(mockRustRuntime as unknown as RustRuntimeProvider);
  });

  describe('resetCircuitBreaker', () => {
    it('should call rustRuntime.resetCircuitBreaker', () => {
      controller.resetCircuitBreaker();

      expect(mockRustRuntime.resetCircuitBreaker).toHaveBeenCalledTimes(1);
    });

    it('should return { status: "ok", state: "CLOSED" }', () => {
      const result = controller.resetCircuitBreaker();

      expect(result).toEqual({ status: 'ok', state: 'CLOSED' });
    });
  });

  describe('getCircuitBreakerHistory (§5.3)', () => {
    it('returns the current state and history with no filter', () => {
      const result = controller.getCircuitBreakerHistory();

      expect(mockRustRuntime.getCircuitBreakerHistory).toHaveBeenCalledWith(undefined);
      expect(result).toEqual({
        state: 'CLOSED',
        history: [{ state: 'CLOSED', enteredAt: '2026-04-13T00:00:00Z', reason: 'initial' }]
      });
    });

    it('passes the since cutoff through to the provider', () => {
      const since = '2026-04-13T06:00:00Z';
      controller.getCircuitBreakerHistory(undefined, since);

      expect(mockRustRuntime.getCircuitBreakerHistory).toHaveBeenCalledWith(since);
    });

    it('translates named window to ISO cutoff', () => {
      controller.getCircuitBreakerHistory('1h');

      expect(mockRustRuntime.getCircuitBreakerHistory).toHaveBeenCalledWith(
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      );
    });

    it('ignores unknown window names', () => {
      controller.getCircuitBreakerHistory('all-time');

      expect(mockRustRuntime.getCircuitBreakerHistory).toHaveBeenCalledWith(undefined);
    });
  });
});
