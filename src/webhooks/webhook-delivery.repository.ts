import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../db/database.service';
import { webhookDeliveries } from '../db/schema';

@Injectable()
export class WebhookDeliveryRepository {
  constructor(private readonly database: DatabaseService) {}

  async create(input: { webhookId: string; event: string; runId: string; payload: Record<string, unknown> }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.database.db.insert(webhookDeliveries).values({
      id,
      webhookId: input.webhookId,
      event: input.event,
      runId: input.runId,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      createdAt: now
    });
    return { id, ...input, status: 'pending', attempts: 0, createdAt: now };
  }

  async markDelivered(id: string, responseStatus: number) {
    const now = new Date().toISOString();
    await this.database.db
      .update(webhookDeliveries)
      .set({
        status: 'delivered',
        responseStatus,
        lastAttemptAt: now,
        deliveredAt: now,
        attempts: 1
      })
      .where(eq(webhookDeliveries.id, id));
  }

  async markFailed(id: string, attempt: number, errorMessage: string, responseStatus?: number) {
    const now = new Date().toISOString();
    await this.database.db
      .update(webhookDeliveries)
      .set({
        status: attempt >= 3 ? 'failed' : 'pending',
        attempts: attempt,
        lastAttemptAt: now,
        errorMessage,
        responseStatus
      })
      .where(eq(webhookDeliveries.id, id));
  }

  async listPending() {
    return this.database.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.status, 'pending'));
  }

  async listByWebhookId(webhookId: string) {
    return this.database.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, webhookId));
  }
}
