import * as http from 'node:http';
import * as https from 'node:https';

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
}

/**
 * Lightweight typed HTTP client for integration tests.
 * Wraps Node.js http module directly — no external dependencies.
 */
export class TestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string
  ) {}

  // ── Run Lifecycle ──────────────────────────────────────────────

  async createRun(body: Record<string, unknown> | object): Promise<{
    runId: string;
    sessionId: string;
    status: string;
    traceId?: string;
  }> {
    return this.request('POST', '/runs', { body });
  }

  async getRun(runId: string): Promise<Record<string, unknown> | object> {
    return this.request('GET', `/runs/${runId}`);
  }

  async getState(runId: string): Promise<Record<string, unknown> | object> {
    return this.request('GET', `/runs/${runId}/state`);
  }

  async listRuns(
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<Record<string, unknown> | object> {
    return this.request('GET', '/runs', { query });
  }

  async cancelRun(
    runId: string,
    reason?: string
  ): Promise<Record<string, unknown> | object> {
    return this.request('POST', `/runs/${runId}/cancel`, {
      body: reason ? { reason } : undefined
    });
  }

  // ── Removed endpoints (direct-agent-auth CP-5/6/7) ─────────────
  // sendMessage / sendSignal / updateContext are deleted. Agents emit envelopes
  // directly via macp-sdk-python / macp-sdk-typescript.

  // ── Events ─────────────────────────────────────────────────────

  async listEvents(
    runId: string,
    afterSeq?: number
  ): Promise<Record<string, unknown> | object[]> {
    const query: Record<string, string> = {
      afterSeq: String(afterSeq ?? 0),
      limit: '200'
    };
    return this.request('GET', `/runs/${runId}/events`, { query });
  }

  // ── Validation ─────────────────────────────────────────────────

  async validateRun(
    body: Record<string, unknown> | object
  ): Promise<Record<string, unknown> | object> {
    return this.request('POST', '/runs/validate', { body });
  }

  // ── Health ─────────────────────────────────────────────────────

  async healthz(): Promise<Record<string, unknown> | object> {
    return this.request('GET', '/healthz');
  }

  async readyz(): Promise<Record<string, unknown> | object> {
    return this.request('GET', '/readyz');
  }

  async metrics(): Promise<string> {
    return this.requestRaw('GET', '/metrics');
  }

  // ── Projection ─────────────────────────────────────────────────

  async rebuildProjection(runId: string): Promise<Record<string, unknown> | object> {
    return this.request('POST', `/runs/${runId}/projection/rebuild`);
  }

  // ── Raw request helper (no auth) ──────────────────────────────

  async requestNoAuth(
    method: string,
    path: string,
    opts?: RequestOptions
  ): Promise<{ status: number; body: unknown }> {
    const url = this.buildUrl(path, opts?.query);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(opts?.headers ?? {})
    };

    const rawBody = opts?.body ? JSON.stringify(opts.body) : undefined;

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.request(
        url,
        { method, headers },
        (res) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = data;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        }
      );
      req.on('error', reject);
      if (rawBody) req.write(rawBody);
      req.end();
    });
  }

  // ── Internal ───────────────────────────────────────────────────

  async request<T = any>(
    method: string,
    path: string,
    opts?: RequestOptions
  ): Promise<T> {
    const url = this.buildUrl(path, opts?.query);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...(opts?.headers ?? {})
    };

    const body = opts?.body ? JSON.stringify(opts.body) : undefined;

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.request(
        url,
        { method, headers },
        (res) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(data as unknown as T);
            }
          });
        }
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  private async requestRaw(
    method: string,
    path: string,
    opts?: RequestOptions
  ): Promise<string> {
    const url = this.buildUrl(path, opts?.query);
    const headers: Record<string, string> = {
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...(opts?.headers ?? {})
    };

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.request(
        url,
        { method, headers },
        (res) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => resolve(data));
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>
  ): string {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }
}
