import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../db/database.service';
import { webhooks } from '../db/schema';

@Injectable()
export class WebhookRepository {
  constructor(private readonly database: DatabaseService) {}

  async create(input: { url: string; events: string[]; secret: string }) {
    const id = randomUUID();
    await this.database.db.insert(webhooks).values({
      id,
      url: input.url,
      events: input.events,
      secret: input.secret,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    return this.findById(id);
  }

  async findById(id: string) {
    const rows = await this.database.db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async listActive() {
    return this.database.db.select().from(webhooks).where(eq(webhooks.active, true));
  }

  async list() {
    return this.database.db.select().from(webhooks);
  }

  async update(id: string, fields: { url?: string; events?: string[]; secret?: string; active?: boolean }) {
    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (fields.url !== undefined) updates.url = fields.url;
    if (fields.events !== undefined) updates.events = fields.events;
    if (fields.secret !== undefined) updates.secret = fields.secret;
    if (fields.active !== undefined) updates.active = fields.active;

    await this.database.db.update(webhooks).set(updates).where(eq(webhooks.id, id));
    return this.findById(id);
  }

  async delete(id: string) {
    await this.database.db.delete(webhooks).where(eq(webhooks.id, id));
  }
}
