import { createHmac } from 'node:crypto';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionModeRequest, decisionHappyScript } from '../fixtures/decision-mode';
import { WebhookReceiver } from '../helpers/webhook-receiver';
import { waitFor } from '../helpers/wait-for';
import { DatabaseService } from '../../src/db/database.service';

/**
 * Webhook delivery pipeline (outbox pattern + HMAC-SHA256 + retry).
 *
 * Verified against src/webhooks/webhook.service.ts:
 *  - headers: `X-MACP-Event`, `X-MACP-Signature` (hex HMAC-SHA256 of the raw body)
 *  - retry: max 3 attempts, backoff 1s then 2s
 *  - delivery rows: webhook_deliveries.status pending → delivered | failed
 */
describe('Webhook Delivery (integration)', () => {
  let ctx: TestAppContext;
  let receiver: WebhookReceiver;

  beforeAll(async () => {
    ctx = await createTestApp(decisionHappyScript());
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
    receiver = new WebhookReceiver();
    await receiver.start();
  });

  afterEach(async () => {
    // Drain in-flight webhook retry timers before teardown. Delivery backoff uses
    // raw setTimeout (1s then 2s) that is NOT tracked by the shutdown drain, so a
    // retry pending when the app/pool closes would fire markFailed against a dead
    // pool and leak a "Failed query" into the next suite. Wait (receiver still up)
    // until no delivery row is pending, then close.
    await waitFor(
      async () => {
        const rows = await deliveryRows();
        return rows.every((r: any) => r.status !== 'pending') ? rows : null;
      },
      { timeoutMs: 15000, intervalMs: 100, label: 'webhook deliveries settled' },
    ).catch(() => undefined);
    await receiver.close();
  });

  function deliveryRows(webhookId?: string) {
    const db = ctx.module.get(DatabaseService);
    return db.pool
      .query(
        webhookId
          ? { text: 'SELECT * FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at', values: [webhookId] }
          : { text: 'SELECT * FROM webhook_deliveries ORDER BY created_at', values: [] }
      )
      .then((r) => r.rows);
  }

  async function registerWebhook(events: string[], secret = 'integration-secret') {
    const webhook = (await ctx.client.request('POST', '/webhooks', {
      body: { url: receiver.url, events, secret },
    })) as any;
    expect(webhook.id).toBeDefined();
    return webhook;
  }

  async function runToCompletion(): Promise<string> {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return r.status === 'completed' ? r : null;
      },
      { timeoutMs: 10000, label: 'run completed' },
    );
    return runId;
  }

  it('wildcard webhook receives run.started and run.completed with X-MACP-Event header', async () => {
    await registerWebhook([]);
    const runId = await runToCompletion();

    const requests = await receiver.waitForRequests(2);
    const eventHeaders = requests.map((r) => r.headers['x-macp-event']);
    expect(eventHeaders).toContain('run.started');
    expect(eventHeaders).toContain('run.completed');

    for (const req of requests) {
      expect(req.json?.runId).toBe(runId);
      expect(req.headers['content-type']).toBe('application/json');
      expect(typeof req.headers['x-macp-signature']).toBe('string');
    }
  });

  it('X-MACP-Signature is the HMAC-SHA256 of the exact received body', async () => {
    const secret = 'sig-check-secret';
    await registerWebhook(['run.completed'], secret);
    await runToCompletion();

    const [req] = await receiver.waitForRequests(1);
    const expected = createHmac('sha256', secret).update(req.rawBody).digest('hex');
    expect(req.headers['x-macp-signature']).toBe(expected);
  });

  it('records a delivered webhook_deliveries row with the response status', async () => {
    const webhook = await registerWebhook(['run.completed']);
    const runId = await runToCompletion();

    const row = await waitFor(
      async () => {
        const rows = await deliveryRows(webhook.id);
        return rows.find((r: any) => r.status === 'delivered') ?? null;
      },
      { timeoutMs: 10000, label: 'delivered delivery row' },
    );
    expect(row.event).toBe('run.completed');
    expect(row.run_id).toBe(runId);
    expect(row.response_status).toBe(200);
  });

  it('retries after a 500 (1s backoff) and ends delivered', async () => {
    receiver.respondWith([500, 200]);
    const webhook = await registerWebhook(['run.completed']);
    await runToCompletion();

    const requests = await receiver.waitForRequests(2);
    expect(requests.length).toBe(2);

    const row = await waitFor(
      async () => {
        const rows = await deliveryRows(webhook.id);
        return rows.find((r: any) => r.status === 'delivered') ?? null;
      },
      { timeoutMs: 10000, label: 'delivered after retry' },
    );
    expect(row.response_status).toBe(200);
  });

  it("webhook filtered to ['run.completed'] receives only that event", async () => {
    await registerWebhook(['run.completed']);
    await runToCompletion();

    const requests = await receiver.waitForRequests(1);
    expect(requests[0].headers['x-macp-event']).toBe('run.completed');
    expect(requests[0].json?.event).toBe('run.completed');

    // No second delivery for run.started: the only delivery rows are run.completed.
    const rows = await deliveryRows();
    expect(rows.every((r: any) => r.event === 'run.completed')).toBe(true);
    expect(receiver.requests.every((r) => r.headers['x-macp-event'] === 'run.completed')).toBe(true);
  });

  it('webhook toggled active=false via PATCH receives nothing', async () => {
    // Control webhook on a second receiver proves deliveries flow; the
    // deactivated webhook must stay silent for the same run.
    const controlReceiver = new WebhookReceiver();
    await controlReceiver.start();
    try {
      const inactive = await registerWebhook([]);
      const patched = (await ctx.client.request('PATCH', `/webhooks/${inactive.id}`, {
        body: { active: false },
      })) as any;
      expect(patched.active).toBe(false);

      const control = (await ctx.client.request('POST', '/webhooks', {
        body: { url: controlReceiver.url, events: [], secret: 'control-secret' },
      })) as any;

      await runToCompletion();
      await controlReceiver.waitForRequests(2);

      expect(receiver.requests.length).toBe(0);
      const rows = await deliveryRows(inactive.id);
      expect(rows.length).toBe(0);
      const controlRows = await deliveryRows(control.id);
      expect(controlRows.length).toBeGreaterThanOrEqual(2);
    } finally {
      await controlReceiver.close();
    }
  });

  it('always-500 receiver: delivery ends failed after 3 attempts', async () => {
    receiver.setDefaultStatus(500);
    const webhook = await registerWebhook(['run.completed']);
    await runToCompletion();

    // 3 attempts with 1s + 2s backoff ≈ 3s total.
    const row = await waitFor(
      async () => {
        const rows = await deliveryRows(webhook.id);
        return rows.find((r: any) => r.status === 'failed') ?? null;
      },
      { timeoutMs: 15000, intervalMs: 200, label: 'failed delivery row' },
    );
    expect(row.attempts).toBe(3);
    expect(String(row.error_message)).toContain('500');
    expect(receiver.requests.length).toBeGreaterThanOrEqual(3);
  });
});
