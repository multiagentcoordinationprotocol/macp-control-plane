import { Controller, Get, HttpCode, HttpException, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RustRuntimeProvider } from '../runtime/rust-runtime.provider';
import { CIRCUIT_BREAKER_OPEN_MESSAGE } from '../runtime/circuit-breaker';
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
      if (error instanceof Error && error.message.includes(CIRCUIT_BREAKER_OPEN_MESSAGE)) {
        throw new AppException(ErrorCode.CIRCUIT_BREAKER_OPEN, error.message, HttpStatus.SERVICE_UNAVAILABLE);
      }
      throw error;
    }

    const activeRuns = await this.runRepository.listActiveRuns();
    const trackedSessionIds = new Set(
      activeRuns.map((run) => run.runtimeSessionId).filter((id): id is string => Boolean(id))
    );
    // The runtime retains a terminal session (SESSION_STATE_RESOLVED / _EXPIRED /
    // _CANCELLED) for a configurable window after it ends (default 1h —
    // MACP_SESSION_RETENTION_SECS on the runtime side) before sweeping it out of
    // `ListSessions`. `RunEventService`/`StreamConsumerService` finalize the run
    // locally the moment that terminal state is observed, so a resolved session
    // drops out of `listActiveRuns()` immediately — well before the runtime
    // stops reporting it. Diffing against the raw session list would report
    // every recently-completed run as "drift" for up to that whole retention
    // window; restricting both directions of the diff to live states is what
    // makes this endpoint measure actual drift instead of normal turnover.
    const liveSessions = result.sessions.filter(
      (s) => s.state === 'SESSION_STATE_OPEN' || s.state === 'SESSION_STATE_SUSPENDED'
    );
    const runtimeSessionIds = new Set(liveSessions.map((s) => s.sessionId));

    // The genuine gap this endpoint exists to detect: sessions the runtime
    // knows about but this service never recorded as an active run (e.g.
    // created while the control plane was down or mid-reconnect). Sound even
    // under a truncated drain — a session present in the fetched prefix that
    // isn't tracked really is untracked, regardless of what the rest of the
    // (unfetched) prefix might contain.
    const untrackedSessions = liveSessions.filter((s) => !trackedSessionIds.has(s.sessionId));
    // The reverse direction: runs this service still considers active whose
    // bound session the runtime no longer reports as live at all (including a
    // session the runtime has already resolved/expired/cancelled — the CP
    // hasn't caught up with a terminal state, which is real drift, not the
    // retention-window noise `liveSessions` filters out above). Unlike
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
      // Raw count of everything `listSessions()` returned, terminal sessions
      // still inside the runtime's retention window included — diagnostic
      // context, not the basis for the diff below (see `liveSessions` above).
      runtimeSessionCount: result.sessions.length,
      liveRuntimeSessionCount: liveSessions.length,
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
