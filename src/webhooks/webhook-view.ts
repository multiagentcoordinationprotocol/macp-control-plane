import type { webhooks } from '../db/schema';

type WebhookRow = typeof webhooks.$inferSelect;

/**
 * A webhook subscription as the API returns it (#140).
 *
 * The HMAC signing secret is write-only: it is accepted on create and update, used to sign
 * deliveries, and never returned. `hasSecret` says whether one is stored.
 */
export interface WebhookView {
  /** @format uuid */
  id: string;
  url: string;
  /** Event types the subscription receives. Empty = all events. */
  events: string[];
  active: boolean;
  /** Postgres timestamptz text, e.g. `2026-11-01 12:34:56.789+00`. */
  createdAt: string;
  /** Postgres timestamptz text, e.g. `2026-11-01 12:34:56.789+00`. */
  updatedAt: string;
  /** True when a signing secret is stored. The secret itself is never returned. */
  hasSecret: boolean;
}

/** The one mapping from a stored `webhooks` row to an API response. Every webhook route returns through it. */
export function toWebhookView(row: WebhookRow): WebhookView {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasSecret: row.secret.length > 0
  };
}
