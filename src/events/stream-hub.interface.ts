import { Observable } from 'rxjs';
import { CanonicalEvent, RunStateProjection } from '../contracts/control-plane';
import { StreamHubMessage } from './stream-hub.service';

export interface StreamHubStrategy {
  publishEvent(event: CanonicalEvent): void;
  publishSnapshot(runId: string, snapshot: RunStateProjection): void;
  complete(runId: string): void;
  stream(runId: string): Observable<StreamHubMessage>;
  destroy?(): void;
}
