import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
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

  @Get('healthz')
  @ApiOperation({ summary: 'Liveness probe.' })
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
  @ApiOperation({ summary: 'Readiness probe checking Postgres and runtime connectivity.' })
  async readyz() {
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

    return {
      ok: dbOk && runtime.ok && streamHealthy && circuitBreaker !== 'OPEN',
      database: dbOk ? 'ok' : 'unhealthy',
      runtime,
      streamConsumer: streamHealthy ? 'ok' : 'unhealthy',
      circuitBreaker
    };
  }
}
