import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RustRuntimeProvider } from '../runtime/rust-runtime.provider';

@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly rustRuntime: RustRuntimeProvider) {}

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
}

function windowToIso(window?: string): string | undefined {
  if (!window) return undefined;
  const hours: Record<string, number> = { '1h': 1, '6h': 6, '24h': 24, '7d': 7 * 24 };
  const h = hours[window];
  if (!h) return undefined;
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}
