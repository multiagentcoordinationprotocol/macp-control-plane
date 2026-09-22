import { HttpStatus } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { RustRuntimeProvider } from '../runtime/rust-runtime.provider';
import { RunRepository } from '../storage/run.repository';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';

describe('AdminController', () => {
  let controller: AdminController;
  let mockRustRuntime: {
    resetCircuitBreaker: jest.Mock;
    getCircuitBreakerState: jest.Mock;
    getCircuitBreakerHistory: jest.Mock;
    listSessions: jest.Mock;
  };
  let mockRunRepository: {
    listActiveRuns: jest.Mock;
  };

  beforeEach(() => {
    mockRustRuntime = {
      resetCircuitBreaker: jest.fn(),
      getCircuitBreakerState: jest.fn().mockReturnValue('CLOSED'),
      getCircuitBreakerHistory: jest
        .fn()
        .mockReturnValue([{ state: 'CLOSED', enteredAt: '2026-04-13T00:00:00Z', reason: 'initial' }]),
      listSessions: jest.fn()
    };
    mockRunRepository = {
      listActiveRuns: jest.fn().mockResolvedValue([])
    };

    controller = new AdminController(
      mockRustRuntime as unknown as RustRuntimeProvider,
      mockRunRepository as unknown as RunRepository
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

  describe('getRuntimeSessionDrift (Phase 7, runtime v0.8.0 absorption)', () => {
    it('reports no drift when every runtime session is tracked and every tracked run is reported', async () => {
      mockRustRuntime.listSessions.mockResolvedValue({
        sessions: [{ sessionId: 'sess-1', mode: 'macp.mode.decision.v1', state: 'SESSION_STATE_OPEN' }],
        complete: true,
        pagesFetched: 1
      });
      mockRunRepository.listActiveRuns.mockResolvedValue([{ id: 'run-1', runtimeSessionId: 'sess-1' }]);

      const result = await controller.getRuntimeSessionDrift();

      expect(result).toEqual({
        complete: true,
        runtimeSessionCount: 1,
        trackedRunCount: 1,
        untrackedSessions: [],
        missingFromRuntime: []
      });
    });

    it('reports a runtime-only session as drift (untracked, not backfilled)', async () => {
      const untracked = { sessionId: 'sess-orphan', mode: 'macp.mode.handoff.v1', state: 'SESSION_STATE_OPEN' };
      mockRustRuntime.listSessions.mockResolvedValue({
        sessions: [untracked],
        complete: true,
        pagesFetched: 1
      });
      mockRunRepository.listActiveRuns.mockResolvedValue([]);

      const result = await controller.getRuntimeSessionDrift();

      expect(result.untrackedSessions).toEqual([untracked]);
      expect(result.missingFromRuntime).toEqual([]);
    });

    it('reports a tracked run missing from the runtime as the reverse-direction drift', async () => {
      mockRustRuntime.listSessions.mockResolvedValue({ sessions: [], complete: true, pagesFetched: 1 });
      mockRunRepository.listActiveRuns.mockResolvedValue([{ id: 'run-2', runtimeSessionId: 'sess-gone' }]);

      const result = await controller.getRuntimeSessionDrift();

      expect(result.missingFromRuntime).toEqual([{ runId: 'run-2', runtimeSessionId: 'sess-gone' }]);
    });

    it('excludes an active run with no bound session yet from the reverse-direction diff', async () => {
      mockRustRuntime.listSessions.mockResolvedValue({ sessions: [], complete: true, pagesFetched: 1 });
      mockRunRepository.listActiveRuns.mockResolvedValue([{ id: 'run-starting', runtimeSessionId: undefined }]);

      const result = await controller.getRuntimeSessionDrift();

      expect(result.missingFromRuntime).toEqual([]);
    });

    it('surfaces complete: false verbatim from a truncated listSessions() drain', async () => {
      mockRustRuntime.listSessions.mockResolvedValue({
        sessions: [],
        complete: false,
        pagesFetched: 200
      });
      mockRunRepository.listActiveRuns.mockResolvedValue([]);

      const result = await controller.getRuntimeSessionDrift();

      expect(result.complete).toBe(false);
    });

    it('reports missingFromRuntime as null (not computed) under a truncated drain, rather than a false-positive-laden array', async () => {
      // A tracked run whose session genuinely still exists on the runtime,
      // just not in the fetched prefix — under truncation this must NOT be
      // reported as "missing from runtime", since the drain simply never
      // reached it.
      mockRustRuntime.listSessions.mockResolvedValue({
        sessions: [],
        complete: false,
        pagesFetched: 200
      });
      mockRunRepository.listActiveRuns.mockResolvedValue([{ id: 'run-3', runtimeSessionId: 'sess-not-yet-fetched' }]);

      const result = await controller.getRuntimeSessionDrift();

      expect(result.complete).toBe(false);
      expect(result.missingFromRuntime).toBeNull();
      // untrackedSessions stays sound (and empty here, correctly) even under truncation.
      expect(result.untrackedSessions).toEqual([]);
    });

    it('propagates an already-translated AppException from listSessions() (e.g. runtime unreachable) unchanged', async () => {
      const runtimeUnavailable = new AppException(
        ErrorCode.RUNTIME_UNAVAILABLE,
        'runtime ListSessions failed',
        HttpStatus.SERVICE_UNAVAILABLE
      );
      mockRustRuntime.listSessions.mockRejectedValue(runtimeUnavailable);

      await expect(controller.getRuntimeSessionDrift()).rejects.toBe(runtimeUnavailable);
      expect(mockRunRepository.listActiveRuns).not.toHaveBeenCalled();
    });

    it('translates a circuit-breaker-open error into AppException(CIRCUIT_BREAKER_OPEN, 503)', async () => {
      mockRustRuntime.listSessions.mockRejectedValue(
        new Error('Circuit breaker is OPEN — runtime calls are temporarily disabled')
      );

      let caught: AppException | undefined;
      try {
        await controller.getRuntimeSessionDrift();
      } catch (error) {
        caught = error as AppException;
      }

      expect(caught).toBeInstanceOf(AppException);
      expect(caught?.errorCode).toBe(ErrorCode.CIRCUIT_BREAKER_OPEN);
      expect(caught?.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(mockRunRepository.listActiveRuns).not.toHaveBeenCalled();
    });

    it('rethrows an unrecognized error unchanged rather than swallowing it as empty drift', async () => {
      const unexpected = new Error('boom');
      mockRustRuntime.listSessions.mockRejectedValue(unexpected);

      await expect(controller.getRuntimeSessionDrift()).rejects.toBe(unexpected);
      expect(mockRunRepository.listActiveRuns).not.toHaveBeenCalled();
    });
  });
});
