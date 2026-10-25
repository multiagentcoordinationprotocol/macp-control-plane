import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { DatabaseService } from '../db/database.service';
import { AppConfigService } from '../config/app-config.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { RustRuntimeProvider } from '../runtime/rust-runtime.provider';
import { StreamConsumerService } from '../runs/stream-consumer.service';

@ApiTags('health')
@Controller()
@Public()
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
    private readonly runtimeRegistry: RuntimeProviderRegistry,
    private readonly rustRuntimeProvider: RustRuntimeProvider,
    private readonly streamConsumer: StreamConsumerService
  ) {}

  // Liveness: always 200 while the process answers. `ok` is informational only —
  // a DB outage or the sticky pool `hasFatalError` flag is not fixed by a restart
  // (the pool replaces broken clients), and a wedged event loop already fails the
  // probe by timing out. Orchestrators that need "can serve" use /readyz.
  @Get('healthz')
  @ApiOperation({ summary: 'Liveness probe. Always 200 while the process is up; `ok` is informational.' })
  async healthz() {
    let dbOk = true;
    try {
      await this.database.pool.query('SELECT 1');
    } catch {
      dbOk = false;
    }
    const ok = dbOk && !this.database.hasFatalError;
    return { ok, service: 'macp-control-plane' };
  }

  @Get('readyz')
  @ApiOperation({
    summary: 'Readiness probe checking Postgres and runtime connectivity. 503 with the same body when ok is false.'
  })
  async readyz(@Res({ passthrough: true }) res: Response) {
    let dbOk = false;
    try {
      const db = await this.database.pool.query('select 1 as ok');
      dbOk = Boolean(db.rows[0]?.ok);
    } catch {
      dbOk = false;
    }

    let runtime;
    try {
      runtime = await this.runtimeRegistry.get(this.config.runtimeKind).health();
    } catch (error) {
      runtime = {
        ok: false,
        runtimeKind: this.config.runtimeKind,
        detail: error instanceof Error ? error.message : String(error)
      };
    }

    const streamHealthy = this.streamConsumer.isHealthy();

    const circuitBreaker = this.rustRuntimeProvider.getCircuitBreakerState();

    const ok = dbOk && runtime.ok && streamHealthy && circuitBreaker !== 'OPEN';
    // Compose `service_healthy`, Kubernetes and load balancers read only the status code.
    if (!ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);

    return {
      ok,
      database: dbOk ? 'ok' : 'unhealthy',
      runtime,
      streamConsumer: streamHealthy ? 'ok' : 'unhealthy',
      circuitBreaker
    };
  }
}
