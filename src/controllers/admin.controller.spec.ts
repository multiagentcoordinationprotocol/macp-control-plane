import { AdminController } from './admin.controller';
import { RustRuntimeProvider } from '../runtime/rust-runtime.provider';

describe('AdminController', () => {
  let controller: AdminController;
  let mockRustRuntime: {
    resetCircuitBreaker: jest.Mock;
  };

  beforeEach(() => {
    mockRustRuntime = {
      resetCircuitBreaker: jest.fn(),
    };

    controller = new AdminController(
      mockRustRuntime as unknown as RustRuntimeProvider,
    );
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
});
