import { Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { filter } from 'rxjs/operators';
import { CanonicalEvent, RunStateProjection } from '../contracts/control-plane';
import { StreamHubStrategy } from './stream-hub.interface';
import { StreamHubMessage } from './stream-hub.service';

interface RedisHubMessage extends StreamHubMessage {
  _runId: string;
}

/**
 * Redis pub/sub StreamHub strategy for horizontal scaling.
 * Publishes events to a Redis channel and subscribes to receive
 * events from other control-plane instances.
 *
 * Requires `ioredis` as an optional peer dependency.
 */
export class RedisStreamHubStrategy implements StreamHubStrategy {
  private readonly logger = new Logger(RedisStreamHubStrategy.name);
  private readonly localSubject = new Subject<RedisHubMessage>();
  private readonly completedRuns = new Set<string>();
  private publisher: {
    publish: (channel: string, message: string) => Promise<number>;
    quit: () => Promise<string>;
  } | null = null;
  private subscriber: {
    subscribe: (channel: string, cb?: (err: Error | null) => void) => void;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    quit: () => Promise<string>;
  } | null = null;
  private readonly channel = 'macp:stream-hub';

  constructor(redisUrl: string) {
    void this.connect(redisUrl);
  }

  private async connect(redisUrl: string): Promise<void> {
    try {
      // Dynamic import — ioredis is an optional peer dependency
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Redis = require('ioredis');
      this.publisher = new Redis(redisUrl);
      this.subscriber = new Redis(redisUrl);

      this.subscriber!.subscribe(this.channel, (err: Error | null) => {
        if (err) {
          this.logger.error(`Failed to subscribe to Redis channel: ${err.message}`);
        } else {
          this.logger.log('Connected to Redis stream hub');
        }
      });

      this.subscriber!.on('message', (_channel: unknown, message: unknown) => {
        try {
          const parsed = JSON.parse(message as string) as RedisHubMessage;
          this.localSubject.next(parsed);
          // Track remote completions
          if (parsed.event === 'complete') {
            this.completedRuns.add(parsed._runId);
          }
        } catch (err) {
          this.logger.warn(`Failed to parse Redis message: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    } catch (err) {
      this.logger.error(`Failed to connect to Redis: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  publishEvent(event: CanonicalEvent): void {
    const msg: RedisHubMessage = {
      _runId: event.runId,
      event: 'canonical_event',
      data: event
    };
    this.publish(msg);
  }

  publishSnapshot(runId: string, snapshot: RunStateProjection): void {
    const msg: RedisHubMessage = {
      _runId: runId,
      event: 'snapshot',
      data: snapshot
    };
    this.publish(msg);
  }

  complete(runId: string): void {
    this.completedRuns.add(runId);
    const msg: RedisHubMessage = {
      _runId: runId,
      event: 'complete',
      data: { runId }
    };
    this.publish(msg);
  }

  stream(runId: string): Observable<StreamHubMessage> {
    return this.localSubject.asObservable().pipe(filter((msg) => msg._runId === runId));
  }

  destroy(): void {
    this.localSubject.complete();
    this.completedRuns.clear();
    if (this.publisher) {
      void this.publisher.quit().catch(() => {});
    }
    if (this.subscriber) {
      void this.subscriber.quit().catch(() => {});
    }
  }

  private publish(msg: RedisHubMessage): void {
    if (this.publisher) {
      this.publisher.publish(this.channel, JSON.stringify(msg)).catch((err: Error) => {
        this.logger.warn(`Failed to publish to Redis: ${err.message}`);
      });
    }
    // Also emit locally for same-instance subscribers
    this.localSubject.next(msg);
  }
}
