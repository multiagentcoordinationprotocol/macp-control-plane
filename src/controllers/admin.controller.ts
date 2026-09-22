import { Controller, Get, HttpCode, HttpException, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RustRuntimeProvider } from '../runtime/rust-runtime.provider';
import { RunRepository } from '../storage/run.repository';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { RuntimeListSessionsResult } from '../contracts/runtime';

@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly rustRuntime: RustRuntimeProvider,
    private readonly runRepository: RunRepository
  ) {}

  @Post('circuit-breaker/reset')
  @HttpCode(200)
  @ApiOperation({ summary: 'Manually reset the circuit breaker to CLOSED state.' })
  resetCircuitBreaker() {
    this.rustRuntime.resetCircuitBreaker();
    return { status: 'ok', state: 'CLOSED' };
  }

  @Get('circuit-breaker/history')
  @ApiOperation({ summary: 'Circuit breaker state transition history (§5.3).' })
  @ApiQuery({
    name: 'window',
    enum: ['1h', '6h', '24h', '7d'],
    required: false,
    description: 'Named window; events before the cutoff are excluded.'
  })
  @ApiQuery({ name: 'since', required: false, description: 'ISO-8601 timestamp cutoff (overrides window).' })
  getCircuitBreakerHistory(@Query('window') window?: string, @Query('since') since?: string) {
    const cutoff = since ?? windowToIso(window);
    return {
      state: this.rustRuntime.getCircuitBreakerState(),
      history: this.rustRuntime.getCircuitBreakerHistory(cutoff)
    };
  }

  @Get('runtime/sessions')
  @ApiOperation({
    summary:
      'Drift detection (read-only): diff the live runtime session list against locally-tracked active runs. Does not auto-reconcile.'
  })
  async getRuntimeSessionDrift() {
    let result: RuntimeListSessionsResult;
    try {
      result = await this.rustRuntime.listSessions();
    } catch (error) {
      // `listSessions()` already surfaces a genuine gRPC failure as an
      // `AppException` (see `mapGrpcError`) — let that propagate unchanged so
      // the global exception filter reports it correctly (e.g.
      // RUNTIME_UNAVAILABLE / RUNTIME_TIMEOUT). A circuit-breaker trip is the
      // one failure mode that reaches here as a plain `Error` instead (not a
      // gRPC status), so it needs its own translation — otherwise it would
      // fall through to an opaque 500 instead of the SERVICE_UNAVAILABLE this
      // endpoint's contract requires.
      if (error instanceof HttpException) throw error;
      if (error instanceof Error && error.message.includes('Circuit breaker is OPEN')) {
        throw new AppException(ErrorCode.CIRCUIT_BREAKER_OPEN, error.message, HttpStatus.SERVICE_UNAVAILABLE);
      }
      throw error;
    }

    const activeRuns = await this.runRepository.listActiveRuns();
    const trackedSessionIds = new Set(
      activeRuns.map((run) => run.runtimeSessionId).filter((id): id is string => Boolean(id))
    );
    const runtimeSessionIds = new Set(result.sessions.map((s) => s.sessionId));

    // The genuine gap this endpoint exists to detect: sessions the runtime
    // knows about but this service never recorded as an active run (e.g.
    // created while the control plane was down or mid-reconnect). Sound even
    // under a truncated drain — a session present in the fetched prefix that
    // isn't tracked really is untracked, regardless of what the rest of the
    // (unfetched) prefix might contain.
    const untrackedSessions = result.sessions.filter((s) => !trackedSessionIds.has(s.sessionId));
    // The reverse direction: runs this service still considers active whose
    // bound session the runtime no longer reports at all. Unlike
    // `untrackedSessions`, this direction is NOT sound under a truncated
    // drain: a tracked run's session simply not having been fetched yet
    // would otherwise show up here as a false positive (a run that IS still
    // bound to a session the runtime holds, just one this drain never
    // reached) — report `null` (not computed) rather than let a partial
    // prefix produce a fully-populated but unsound reverse diff.
    const missingFromRuntime = result.complete
      ? activeRuns
          .filter((run) => run.runtimeSessionId && !runtimeSessionIds.has(run.runtimeSessionId))
          .map((run) => ({ runId: run.id, runtimeSessionId: run.runtimeSessionId as string }))
      : null;

    return {
      complete: result.complete,
      runtimeSessionCount: result.sessions.length,
      trackedRunCount: activeRuns.length,
      untrackedSessions,
      missingFromRuntime
    };
  }
}

function windowToIso(window?: string): string | undefined {
  if (!window) return undefined;
  const hours: Record<string, number> = { '1h': 1, '6h': 6, '24h': 24, '7d': 7 * 24 };
  const h = hours[window];
  if (!h) return undefined;
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}
