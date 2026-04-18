import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Observable } from 'rxjs';
import { CanonicalEvent, RunStateProjection } from '../contracts/control-plane';
import { StreamHubStrategy } from './stream-hub.interface';

export const STREAM_HUB_STRATEGY = 'STREAM_HUB_STRATEGY';

export interface StreamHubMessage {
  event: string;
  data: unknown;
}

@Injectable()
export class StreamHubService implements OnModuleDestroy {
  constructor(@Inject(STREAM_HUB_STRATEGY) private readonly strategy: StreamHubStrategy) {}

  onModuleDestroy(): void {
    if ('destroy' in this.strategy && typeof this.strategy.destroy === 'function') {
      this.strategy.destroy();
    }
  }

  publishEvent(event: CanonicalEvent): void {
    this.strategy.publishEvent(event);
  }

  publishSnapshot(runId: string, snapshot: RunStateProjection): void {
    this.strategy.publishSnapshot(runId, snapshot);
  }

  complete(runId: string): void {
    this.strategy.complete(runId);
  }

  stream(runId: string): Observable<StreamHubMessage> {
    return this.strategy.stream(runId);
  }
}
