import * as http from 'node:http';
import { AddressInfo } from 'node:net';

export interface ReceivedWebhookRequest {
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  json: Record<string, unknown> | null;
  receivedAt: string;
}

/**
 * Tiny HTTP server for webhook delivery integration tests.
 *
 * - Listens on an ephemeral port (port 0) — read `receiver.url` after `start()`.
 * - Records `{headers, rawBody, json, receivedAt}` for every incoming request.
 * - Per-request scripted status codes via `respondWith([500, 200])`; once the
 *   queue is exhausted, responds with `defaultStatus` (200 unless overridden).
 * - `waitForRequests(n)` polls until at least n requests were received.
 */
export class WebhookReceiver {
  readonly requests: ReceivedWebhookRequest[] = [];

  private server: http.Server | null = null;
  private statusQueue: number[] = [];
  private defaultStatus = 200;
  private baseUrl = '';

  /** URL of the receiver (e.g. `http://127.0.0.1:54321/hook`). Valid after start(). */
  get url(): string {
    return this.baseUrl;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        let json: Record<string, unknown> | null = null;
        try {
          json = JSON.parse(body) as Record<string, unknown>;
        } catch {
          json = null;
        }
        this.requests.push({
          headers: req.headers,
          rawBody: body,
          json,
          receivedAt: new Date().toISOString()
        });
        const status = this.statusQueue.shift() ?? this.defaultStatus;
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: status < 400 }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });

    const address = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}/hook`;
    return this.baseUrl;
  }

  /** Queue scripted status codes for the next incoming requests, in order. */
  respondWith(statuses: number[]): void {
    this.statusQueue.push(...statuses);
  }

  /** Change the status returned once the scripted queue is exhausted. */
  setDefaultStatus(status: number): void {
    this.defaultStatus = status;
  }

  /** Wait until at least `count` requests have been received. */
  async waitForRequests(count: number, timeoutMs = 15000): Promise<ReceivedWebhookRequest[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.requests.length >= count) return this.requests.slice(0, count);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      `WebhookReceiver: timed out after ${timeoutMs}ms waiting for ${count} requests (got ${this.requests.length})`
    );
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
      // Sever keep-alive connections so close() doesn't hang.
      this.server!.closeAllConnections?.();
    });
    this.server = null;
  }
}
