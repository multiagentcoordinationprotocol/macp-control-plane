import { Logger } from '@nestjs/common';
import { InstrumentationService } from '../telemetry/instrumentation.service';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

const STATE_VALUES: Record<CircuitBreakerState, number> = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  onStateChange?: (state: CircuitBreakerState, event: 'success' | 'failure') => void;
  instrumentation?: InstrumentationService;
}

export class CircuitBreaker {
  private readonly logger = new Logger(CircuitBreaker.name);
  private state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;

  constructor(private readonly config: CircuitBreakerConfig) {}

  getState(): CircuitBreakerState {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.logger.log('Circuit breaker transitioned to HALF_OPEN');
        this.reportStateGauge();
      }
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === 'OPEN') {
      throw new Error('Circuit breaker is OPEN — runtime calls are temporarily disabled');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.logger.log('Circuit breaker transitioned to CLOSED after successful probe');
    }
    this.failureCount = 0;
    this.state = 'CLOSED';
    this.config.instrumentation?.circuitBreakerSuccessTotal.inc();
    this.reportStateGauge();
    this.config.onStateChange?.(this.state, 'success');
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'OPEN';
      this.logger.warn(
        `Circuit breaker OPEN after ${this.failureCount} failures (reset in ${this.config.resetTimeoutMs}ms)`
      );
    }
    this.config.instrumentation?.circuitBreakerFailuresTotal.inc();
    this.reportStateGauge();
    this.config.onStateChange?.(this.state, 'failure');
  }

  private reportStateGauge(): void {
    this.config.instrumentation?.circuitBreakerState.set(STATE_VALUES[this.state]);
  }

  reset(): void {
    this.failureCount = 0;
    this.state = 'CLOSED';
    this.reportStateGauge();
    this.logger.log('Circuit breaker manually reset to CLOSED');
  }
}
