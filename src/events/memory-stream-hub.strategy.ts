import { Observable, Subject } from 'rxjs';
import { CanonicalEvent, RunStateProjection } from '../contracts/control-plane';
import { StreamHubStrategy } from './stream-hub.interface';
import { StreamHubMessage } from './stream-hub.service';

/**
 * In-memory StreamHub strategy using RxJS Subjects.
 * Suitable for single-instance deployments.
 */
export class MemoryStreamHubStrategy implements StreamHubStrategy {
  private readonly subjects = new Map<string, Subject<StreamHubMessage>>();
  private readonly subscriberCounts = new Map<string, number>();
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  destroy(): void {
    for (const [, timer] of this.cleanupTimers) {
      clearTimeout(timer);
    }
    for (const [, subject] of this.subjects) {
      subject.complete();
    }
    this.subjects.clear();
    this.subscriberCounts.clear();
    this.cleanupTimers.clear();
  }

  publishEvent(event: CanonicalEvent): void {
    this.getSubject(event.runId).next({ event: 'canonical_event', data: event });
  }

  publishSnapshot(runId: string, snapshot: RunStateProjection): void {
    this.getSubject(runId).next({ event: 'snapshot', data: snapshot });
  }

  complete(runId: string): void {
    const subject = this.subjects.get(runId);
    if (subject) {
      subject.complete();
      this.subjects.delete(runId);
      this.subscriberCounts.delete(runId);
    }
    const timer = this.cleanupTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(runId);
    }
  }

  stream(runId: string): Observable<StreamHubMessage> {
    const timer = this.cleanupTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(runId);
    }

    const subject = this.getSubject(runId);
    this.subscriberCounts.set(runId, (this.subscriberCounts.get(runId) ?? 0) + 1);

    return new Observable<StreamHubMessage>((subscriber) => {
      const subscription = subject.subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        const count = (this.subscriberCounts.get(runId) ?? 1) - 1;
        this.subscriberCounts.set(runId, count);
        if (count <= 0) {
          this.scheduleCleanup(runId);
        }
      };
    });
  }

  private scheduleCleanup(runId: string): void {
    const existing = this.cleanupTimers.get(runId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.cleanupTimers.delete(runId);
      const count = this.subscriberCounts.get(runId) ?? 0;
      if (count <= 0) {
        const subject = this.subjects.get(runId);
        if (subject) {
          subject.complete();
          this.subjects.delete(runId);
          this.subscriberCounts.delete(runId);
        }
      }
    }, 60_000);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();

    this.cleanupTimers.set(runId, timer);
  }

  private getSubject(runId: string): Subject<StreamHubMessage> {
    let subject = this.subjects.get(runId);
    if (!subject) {
      subject = new Subject<StreamHubMessage>();
      this.subjects.set(runId, subject);
    }
    return subject;
  }
}
