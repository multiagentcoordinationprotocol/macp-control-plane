import * as http from 'node:http';

export interface SSEEvent {
  type: string;
  data: unknown;
  id?: string;
  raw: string;
}

/**
 * Lightweight SSE client for integration tests.
 * Connects to GET /runs/:id/stream and collects events.
 */
export class TestSSEClient {
  readonly events: SSEEvent[] = [];

  private request: http.ClientRequest | null = null;
  private closed = false;
  private waiters: Array<{
    predicate: (event: SSEEvent) => boolean;
    resolve: (event: SSEEvent) => void;
    reject: (err: Error) => void;
  }> = [];
  private completionWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string
  ) {}

  /**
   * Connect to the SSE stream for a given run.
   */
  connect(
    runId: string,
    opts?: {
      afterSeq?: number;
      includeSnapshot?: boolean;
      heartbeatMs?: number;
      /** Extra request headers (e.g. `Last-Event-Id` for resume). */
      headers?: Record<string, string>;
      /**
       * Override the request path (default `/runs/:id/stream`). May include a
       * query string (e.g. `/runs/:id/replay/stream?mode=instant`).
       */
      path?: string;
    }
  ): void {
    const url = new URL(opts?.path ?? `/runs/${runId}/stream`, this.baseUrl);
    if (opts?.afterSeq !== undefined)
      url.searchParams.set('afterSeq', String(opts.afterSeq));
    if (opts?.includeSnapshot !== undefined)
      url.searchParams.set('includeSnapshot', String(opts.includeSnapshot));
    if (opts?.heartbeatMs !== undefined)
      url.searchParams.set('heartbeatMs', String(opts.heartbeatMs));

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...(opts?.headers ?? {})
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    this.request = http.get(url.toString(), { headers }, (res) => {
      let buffer = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();

        // Parse SSE events from the buffer
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? ''; // Keep the incomplete last part

        for (const part of parts) {
          const event = this.parseSSEBlock(part);
          if (event) {
            this.events.push(event);
            this.checkWaiters(event);
          }
        }
      });

      res.on('end', () => {
        this.closed = true;
        // Parse any remaining data
        if (buffer.trim()) {
          const event = this.parseSSEBlock(buffer);
          if (event) {
            this.events.push(event);
            this.checkWaiters(event);
          }
        }
        // Resolve completion waiters
        for (const w of this.completionWaiters) {
          w.resolve();
        }
        this.completionWaiters = [];
        // Reject any pending event waiters
        for (const w of this.waiters) {
          w.reject(new Error('SSE stream ended'));
        }
        this.waiters = [];
      });

      res.on('error', (err) => {
        for (const w of this.waiters) {
          w.reject(err);
        }
        for (const w of this.completionWaiters) {
          w.reject(err);
        }
      });
    });

    this.request.on('error', () => {
      /* connection errors handled above */
    });
  }

  /**
   * Wait for an SSE event matching the given type.
   */
  waitForEvent(type: string, timeoutMs = 30000): Promise<SSEEvent> {
    // Check already-received events
    const existing = this.events.find((e) => e.type === type);
    if (existing) return Promise.resolve(existing);

    return this.waitFor((e) => e.type === type, timeoutMs);
  }

  /**
   * Wait for N events of any type (excluding heartbeats).
   */
  waitForEvents(count: number, timeoutMs = 30000): Promise<SSEEvent[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Timeout waiting for ${count} events (got ${this.events.filter((e) => e.type !== 'heartbeat').length})`
          )
        );
      }, timeoutMs);

      const check = () => {
        const nonHeartbeat = this.events.filter((e) => e.type !== 'heartbeat');
        if (nonHeartbeat.length >= count) {
          clearTimeout(timer);
          resolve(nonHeartbeat.slice(0, count));
          return true;
        }
        return false;
      };

      if (check()) return;

      // Poll via waiters
      const interval = setInterval(() => {
        if (check()) clearInterval(interval);
      }, 100);

      setTimeout(() => clearInterval(interval), timeoutMs);
    });
  }

  /**
   * Wait for the SSE stream to close.
   */
  waitForCompletion(timeoutMs = 30000): Promise<void> {
    if (this.closed) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timeout waiting for SSE stream completion'));
      }, timeoutMs);

      this.completionWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /**
   * Get events of a specific type.
   */
  getEventsByType(type: string): SSEEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  /**
   * Close the SSE connection.
   */
  close(): void {
    this.closed = true;
    this.request?.destroy();
    this.request = null;
  }

  // ── Internal ───────────────────────────────────────────────────

  private waitFor(
    predicate: (event: SSEEvent) => boolean,
    timeoutMs: number
  ): Promise<SSEEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`Timeout waiting for SSE event (${timeoutMs}ms)`));
      }, timeoutMs);

      this.waiters.push({
        predicate,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  private checkWaiters(event: SSEEvent): void {
    const matched: typeof this.waiters = [];
    this.waiters = this.waiters.filter((w) => {
      if (w.predicate(event)) {
        matched.push(w);
        return false;
      }
      return true;
    });
    for (const w of matched) {
      w.resolve(event);
    }
  }

  private parseSSEBlock(block: string): SSEEvent | null {
    const lines = block.split('\n');
    let type = 'message';
    let data = '';
    let id: string | undefined;

    for (const line of lines) {
      if (line.startsWith('event:')) {
        type = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data += line.slice(5).trim();
      } else if (line.startsWith('id:')) {
        id = line.slice(3).trim();
      }
    }

    if (!data && type === 'message') return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = data;
    }

    return { type, data: parsed, id, raw: block };
  }
}
