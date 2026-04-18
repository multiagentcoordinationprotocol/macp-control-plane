import { Logger } from '@nestjs/common';
import { InstrumentationService } from '../telemetry/instrumentation.service';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

const STATE_VALUES: Record<CircuitBreakerState, number> = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };
const HISTORY_SIZE = 200;

export interface CircuitBreakerStateChange {
  state: CircuitBreakerState;
  enteredAt: string;
  reason?: string;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  onStateChange?: (state: CircuitBreakerState, event: 'success' | 'failure') => void;
  instrumentation?: InstrumentationService;
  isExpectedError?: (error: unknown) => boolean;
}

export class CircuitBreaker {
  private readonly logger = new Logger(CircuitBreaker.name);
  private state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly history: CircuitBreakerStateChange[] = [
    { state: 'CLOSED', enteredAt: new Date().toISOString(), reason: 'initial' }
  ];

  constructor(private readonly config: CircuitBreakerConfig) {}

  /**
   * Return a copy of the ring-buffer of state transitions. Oldest first.
   * Optional `since` filter (ISO timestamp) drops entries before that cutoff.
   */
  getHistory(since?: string): CircuitBreakerStateChange[] {
    if (!since) return [...this.history];
    const cutoff = Date.parse(since);
    if (Number.isNaN(cutoff)) return [...this.history];
    return this.history.filter((entry) => Date.parse(entry.enteredAt) >= cutoff);
  }

  private recordTransition(state: CircuitBreakerState, reason: string): void {
    const last = this.history.at(-1);
    if (last && last.state === state) return; // dedup same-state entries
    this.history.push({ state, enteredAt: new Date().toISOString(), reason });
    while (this.history.length > HISTORY_SIZE) this.history.shift();
  }

  getState(): CircuitBreakerState {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.logger.log('Circuit breaker transitioned to HALF_OPEN');
        this.recordTransition('HALF_OPEN', `reset timeout after ${elapsed}ms`);
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
      if (this.config.isExpectedError?.(error)) {
        throw error;
      }
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    const wasHalfOpen = this.state === 'HALF_OPEN';
    if (wasHalfOpen) {
      this.logger.log('Circuit breaker transitioned to CLOSED after successful probe');
    }
    this.failureCount = 0;
    const previous = this.state;
    this.state = 'CLOSED';
    if (previous !== 'CLOSED') {
      this.recordTransition('CLOSED', wasHalfOpen ? 'half-open probe succeeded' : 'success');
    }
    this.config.instrumentation?.circuitBreakerSuccessTotal.inc();
    this.reportStateGauge();
    this.config.onStateChange?.(this.state, 'success');
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    const previous = this.state;
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'OPEN';
      this.logger.warn(
        `Circuit breaker OPEN after ${this.failureCount} failures (reset in ${this.config.resetTimeoutMs}ms)`
      );
      if (previous !== 'OPEN') {
        this.recordTransition('OPEN', `${this.failureCount} consecutive failures`);
      }
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
    const wasDifferent = this.state !== 'CLOSED';
    this.state = 'CLOSED';
    if (wasDifferent) this.recordTransition('CLOSED', 'manual reset');
    this.reportStateGauge();
    this.logger.log('Circuit breaker manually reset to CLOSED');
  }
}
