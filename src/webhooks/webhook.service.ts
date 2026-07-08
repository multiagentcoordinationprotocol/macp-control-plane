import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { WebhookDeliveryRepository } from './webhook-delivery.repository';
import { WebhookRepository } from './webhook.repository';

export interface WebhookPayload {
  event: string;
  runId: string;
  status: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

@Injectable()
export class WebhookService implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookService.name);
  // Graceful-drain state (mirrors the stream/session/signal consumers). Delivery
  // uses fire-and-forget async loops with setTimeout backoff; without draining
  // them, a retry can wake after the DB pool is closed and reject against a dead
  // pool. Track in-flight deliveries + pending backoff timers so shutdown can
  // cancel the sleeps and await outstanding work.
  private readonly inFlight = new Set<Promise<void>>();
  private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private shuttingDown = false;

  constructor(
    private readonly webhookRepository: WebhookRepository,
    private readonly deliveryRepository: WebhookDeliveryRepository,
    private readonly instrumentation: InstrumentationService
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    if (this.inFlight.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise((resolve) => setTimeout(resolve, 2000))
      ]);
    }
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));
  }

  async register(input: { url: string; events: string[]; secret: string }) {
    return this.webhookRepository.create(input);
  }

  async list() {
    return this.webhookRepository.list();
  }

  async update(id: string, fields: { url?: string; events?: string[]; secret?: string; active?: boolean }) {
    return this.webhookRepository.update(id, fields);
  }

  async remove(id: string) {
    return this.webhookRepository.delete(id);
  }

  async fireEvent(payload: WebhookPayload): Promise<void> {
    // Callers fire-and-forget via `void webhookService.fireEvent(...)`. Any
    // rejection here (e.g., pool closed during shutdown, transient DB error)
    // would surface as an unhandled rejection and crash the process or fail
    // a test suite. Swallow and log; webhook delivery has its own outbox
    // semantics for durability.
    try {
      const activeWebhooks = await this.webhookRepository.listActive();
      const matching = activeWebhooks.filter((wh) => wh.events.length === 0 || wh.events.includes(payload.event));

      for (const webhook of matching) {
        // Outbox pattern: insert delivery record first, then attempt delivery
        const delivery = await this.deliveryRepository.create({
          webhookId: webhook.id,
          event: payload.event,
          runId: payload.runId,
          payload: payload as unknown as Record<string, unknown>
        });
        this.track(this.deliverWithTracking(delivery.id, webhook.url, webhook.secret, payload));
      }
    } catch (err) {
      this.logger.warn(
        `fireEvent(${payload.event}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async retryPending(): Promise<number> {
    const pending = await this.deliveryRepository.listPending();
    let retried = 0;
    for (const delivery of pending) {
      const webhook = await this.webhookRepository.findById(delivery.webhookId);
      if (!webhook) continue;
      this.track(
        this.deliverWithTracking(
          delivery.id,
          webhook.url,
          webhook.secret,
          delivery.payload as unknown as WebhookPayload,
          delivery.attempts
        )
      );
      retried++;
    }
    return retried;
  }

  private async deliverWithTracking(
    deliveryId: string,
    url: string,
    secret: string,
    payload: WebhookPayload,
    startAttempt = 0
  ): Promise<void> {
    const maxAttempts = 3;
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    for (let attempt = startAttempt + 1; attempt <= maxAttempts; attempt++) {
      if (this.shuttingDown) return;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-MACP-Signature': signature,
            'X-MACP-Event': payload.event
          },
          body,
          signal: AbortSignal.timeout(10_000)
        });

        if (!response.ok) {
          throw new Error(`webhook returned ${response.status}`);
        }

        await this.markDeliveredSafe(deliveryId, response.status);
        this.instrumentation.webhookDeliveriesTotal.inc({ status: 'delivered' });
        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`webhook delivery to ${url} failed (attempt ${attempt}/${maxAttempts}): ${errorMessage}`);
        if (!(await this.markFailedSafe(deliveryId, attempt, errorMessage))) return;
        if (attempt >= maxAttempts) {
          this.instrumentation.webhookDeliveriesTotal.inc({ status: 'failed' });
        }
        if (attempt < maxAttempts) {
          const backoffMs = 1000 * 2 ** (attempt - 1);
          if (!(await this.backoff(backoffMs))) return;
        }
      }
    }
  }

  /** Cancellable backoff sleep. Returns false if shutdown cancelled it. */
  private backoff(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        resolve(!this.shuttingDown);
      }, ms);
      this.pendingTimers.add(timer);
    });
  }

  /** Persist markDelivered, swallowing pool-closed errors during shutdown. */
  private async markDeliveredSafe(deliveryId: string, status: number): Promise<void> {
    try {
      await this.deliveryRepository.markDelivered(deliveryId, status);
    } catch (err) {
      if (!this.shuttingDown) throw err;
    }
  }

  /**
   * Persist markFailed, swallowing pool-closed errors during shutdown. Returns
   * false if the write was skipped (shutting down) so the caller stops retrying.
   */
  private async markFailedSafe(deliveryId: string, attempt: number, message: string): Promise<boolean> {
    try {
      await this.deliveryRepository.markFailed(deliveryId, attempt, message);
      return true;
    } catch (err) {
      if (!this.shuttingDown) throw err;
      return false;
    }
  }
}
