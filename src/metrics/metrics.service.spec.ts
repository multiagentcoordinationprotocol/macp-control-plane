import { MetricsService } from './metrics.service';
import { MetricsRepository } from '../storage/metrics.repository';
import { CanonicalEvent } from '../contracts/control-plane';

function makeEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    id: 'evt-1',
    runId: 'run-1',
    seq: 1,
    ts: '2026-01-01T00:00:00.000Z',
    type: 'message.sent',
    source: { kind: 'control-plane', name: 'test' },
    data: {},
    ...overrides
  };
}

describe('MetricsService', () => {
  let service: MetricsService;
  let mockRepo: { get: jest.Mock; upsert: jest.Mock };

  beforeEach(() => {
    mockRepo = {
      get: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation((_runId, patch) => Promise.resolve(patch))
    };
    service = new MetricsService(mockRepo as unknown as MetricsRepository);
  });

  describe('recordEvents', () => {
    it('counts event types correctly', async () => {
      const events = [
        makeEvent({ type: 'message.sent' }),
        makeEvent({ type: 'message.received' }),
        makeEvent({ type: 'signal.emitted' }),
        makeEvent({ type: 'proposal.created' }),
        makeEvent({ type: 'tool.called' }),
        makeEvent({ type: 'decision.finalized' })
      ];

      const result = await service.recordEvents('run-1', events);

      expect(result.eventCount).toBe(6);
      expect(result.messageCount).toBe(2);
      expect(result.signalCount).toBe(1);
      expect(result.proposalCount).toBe(1);
      expect(result.toolCallCount).toBe(1);
      expect(result.decisionCount).toBe(1);
    });

    it('extracts token usage from event data.metadata.tokenUsage', async () => {
      const events = [
        makeEvent({
          type: 'message.sent',
          data: {
            metadata: {
              tokenUsage: {
                promptTokens: 100,
                completionTokens: 50,
                model: 'gpt-4o-mini'
              }
            }
          }
        })
      ];

      const result = await service.recordEvents('run-1', events);

      expect(result.promptTokens).toBe(100);
      expect(result.completionTokens).toBe(50);
      expect(result.totalTokens).toBe(150);
      expect(result.estimatedCostUsd).toBeGreaterThan(0);
    });

    it('extracts token usage from event data.tokenUsage (direct)', async () => {
      const events = [
        makeEvent({
          type: 'message.received',
          data: {
            tokenUsage: {
              promptTokens: 200,
              completionTokens: 100
            }
          }
        })
      ];

      const result = await service.recordEvents('run-1', events);

      expect(result.promptTokens).toBe(200);
      expect(result.completionTokens).toBe(100);
      expect(result.totalTokens).toBe(300);
    });

    it('extracts token usage from event data.decodedPayload.tokenUsage', async () => {
      const events = [
        makeEvent({
          type: 'proposal.updated',
          data: {
            decodedPayload: {
              tokenUsage: {
                prompt_tokens: 75,
                completion_tokens: 25
              }
            }
          }
        })
      ];

      const result = await service.recordEvents('run-1', events);

      expect(result.promptTokens).toBe(75);
      expect(result.completionTokens).toBe(25);
      expect(result.totalTokens).toBe(100);
    });

    it('accumulates tokens across multiple events', async () => {
      const events = [
        makeEvent({
          type: 'message.sent',
          data: { metadata: { tokenUsage: { promptTokens: 100, completionTokens: 50 } } }
        }),
        makeEvent({
          type: 'message.sent',
          data: { metadata: { tokenUsage: { promptTokens: 200, completionTokens: 100 } } }
        })
      ];

      const result = await service.recordEvents('run-1', events);

      expect(result.promptTokens).toBe(300);
      expect(result.completionTokens).toBe(150);
      expect(result.totalTokens).toBe(450);
    });

    it('accumulates onto existing metrics', async () => {
      mockRepo.get.mockResolvedValue({
        runId: 'run-1',
        eventCount: 5,
        messageCount: 3,
        signalCount: 1,
        proposalCount: 0,
        toolCallCount: 0,
        decisionCount: 0,
        streamReconnectCount: 0,
        promptTokens: 500,
        completionTokens: 200,
        totalTokens: 700,
        estimatedCostUsd: '0.01',
        counters: {},
        updatedAt: '2026-01-01T00:00:00Z'
      });

      const events = [
        makeEvent({
          type: 'message.sent',
          data: { metadata: { tokenUsage: { promptTokens: 100, completionTokens: 50 } } }
        })
      ];

      const result = await service.recordEvents('run-1', events);

      expect(result.promptTokens).toBe(600);
      expect(result.completionTokens).toBe(250);
      expect(result.totalTokens).toBe(850);
      expect(result.eventCount).toBe(6);
    });

    it('ignores events without token usage', async () => {
      const events = [
        makeEvent({ type: 'run.created', data: { status: 'queued' } }),
        makeEvent({ type: 'session.bound', data: { sessionId: 'abc' } })
      ];

      const result = await service.recordEvents('run-1', events);

      expect(result.promptTokens).toBe(0);
      expect(result.completionTokens).toBe(0);
      expect(result.totalTokens).toBe(0);
      expect(result.estimatedCostUsd).toBe(0);
    });

    it('estimates cost using model-specific rates', async () => {
      const events = [
        makeEvent({
          type: 'message.sent',
          data: {
            metadata: {
              tokenUsage: {
                promptTokens: 1_000_000,
                completionTokens: 1_000_000,
                model: 'gpt-4o-mini'
              }
            }
          }
        })
      ];

      const result = await service.recordEvents('run-1', events);

      // gpt-4o-mini: $0.15/1M prompt + $0.60/1M completion = $0.75
      expect(result.estimatedCostUsd).toBeCloseTo(0.75, 1);
    });

    it('uses default rates for unknown model', async () => {
      const events = [
        makeEvent({
          type: 'message.sent',
          data: {
            tokenUsage: {
              promptTokens: 1_000_000,
              completionTokens: 1_000_000
            }
          }
        })
      ];

      const result = await service.recordEvents('run-1', events);

      // default: $1.00/1M prompt + $3.00/1M completion = $4.00
      expect(result.estimatedCostUsd).toBeCloseTo(4.0, 1);
    });

    it('tracks session state changes', async () => {
      const events = [
        makeEvent({
          type: 'session.state.changed',
          data: { state: 'SESSION_STATE_RESOLVED' }
        })
      ];

      const result = await service.recordEvents('run-1', events);

      expect(result.sessionState).toBe('SESSION_STATE_RESOLVED');
    });

    it('tracks stream reconnection count', async () => {
      const events = [
        makeEvent({
          type: 'session.stream.opened',
          data: { status: 'reconnecting' }
        })
      ];

      const result = await service.recordEvents('run-1', events);

      expect(result.streamReconnectCount).toBe(1);
    });
  });

  describe('get', () => {
    it('returns null when no metrics exist', async () => {
      mockRepo.get.mockResolvedValue(null);
      const result = await service.get('run-1');
      expect(result).toBeNull();
    });

    it('returns metrics with token fields', async () => {
      mockRepo.get.mockResolvedValue({
        runId: 'run-1',
        eventCount: 10,
        messageCount: 5,
        signalCount: 2,
        proposalCount: 1,
        toolCallCount: 0,
        decisionCount: 1,
        streamReconnectCount: 0,
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        estimatedCostUsd: '0.05',
        firstEventAt: '2026-01-01T00:00:00Z',
        lastEventAt: '2026-01-01T00:01:00Z',
        durationMs: 60000,
        sessionState: 'SESSION_STATE_RESOLVED'
      });

      const result = await service.get('run-1');

      expect(result).not.toBeNull();
      expect(result!.promptTokens).toBe(1000);
      expect(result!.completionTokens).toBe(500);
      expect(result!.totalTokens).toBe(1500);
      expect(result!.estimatedCostUsd).toBe(0.05);
    });
  });
});
