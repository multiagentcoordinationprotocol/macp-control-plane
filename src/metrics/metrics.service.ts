import { Injectable } from '@nestjs/common';
import { CanonicalEvent, MetricsSummary } from '../contracts/control-plane';
import { MetricsRepository } from '../storage/metrics.repository';

function safeNumber(val: unknown, fallback = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Extract token usage from a canonical event.
 *
 * Agents include token usage in message payloads or metadata using
 * the convention:
 *   { "tokenUsage": { "promptTokens": N, "completionTokens": N, "model": "..." } }
 *
 * This can appear in:
 *   - event.data.metadata.tokenUsage (sent via POST /runs/:id/messages metadata)
 *   - event.data.decodedPayload.tokenUsage (embedded in proto payload)
 *   - event.data.payloadDescriptor.tokenUsage (from payload descriptor)
 *   - event.data.tokenUsage (direct)
 */
function extractTokenUsage(event: CanonicalEvent): {
  promptTokens: number;
  completionTokens: number;
} | null {
  const data = event.data as Record<string, unknown>;

  // Check multiple possible locations
  const candidates = [
    data.tokenUsage,
    (data.metadata as Record<string, unknown> | undefined)?.tokenUsage,
    (data.decodedPayload as Record<string, unknown> | undefined)?.tokenUsage,
    (data.payloadDescriptor as Record<string, unknown> | undefined)?.tokenUsage
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      const usage = candidate as Record<string, unknown>;
      const prompt = safeNumber(usage.promptTokens ?? usage.prompt_tokens);
      const completion = safeNumber(usage.completionTokens ?? usage.completion_tokens);
      if (prompt > 0 || completion > 0) {
        return { promptTokens: prompt, completionTokens: completion };
      }
    }
  }

  return null;
}

/** Default per-model cost rates (USD per 1M tokens). Configurable via env in future. */
const MODEL_COSTS: Record<string, { prompt: number; completion: number }> = {
  'gpt-4o': { prompt: 2.5, completion: 10.0 },
  'gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
  'gpt-4-turbo': { prompt: 10.0, completion: 30.0 },
  'claude-3-opus': { prompt: 15.0, completion: 75.0 },
  'claude-3-sonnet': { prompt: 3.0, completion: 15.0 },
  'claude-3-haiku': { prompt: 0.25, completion: 1.25 },
  default: { prompt: 1.0, completion: 3.0 }
};

function estimateCost(promptTokens: number, completionTokens: number, model?: string): number {
  const rates = MODEL_COSTS[model ?? ''] ?? MODEL_COSTS.default;
  return (promptTokens * rates.prompt + completionTokens * rates.completion) / 1_000_000;
}

@Injectable()
export class MetricsService {
  constructor(private readonly repository: MetricsRepository) {}

  async recordEvents(runId: string, events: CanonicalEvent[]): Promise<MetricsSummary> {
    const current = (await this.repository.get(runId)) ?? {
      runId,
      eventCount: 0,
      messageCount: 0,
      signalCount: 0,
      proposalCount: 0,
      toolCallCount: 0,
      decisionCount: 0,
      streamReconnectCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: '0',
      counters: {},
      updatedAt: new Date().toISOString()
    };

    let firstEventAt = current.firstEventAt as string | undefined;
    let lastEventAt = current.lastEventAt as string | undefined;
    let eventCount = safeNumber(current.eventCount);
    let messageCount = safeNumber(current.messageCount);
    let signalCount = safeNumber(current.signalCount);
    let proposalCount = safeNumber(current.proposalCount);
    let toolCallCount = safeNumber(current.toolCallCount);
    let decisionCount = safeNumber(current.decisionCount);
    let streamReconnectCount = safeNumber(current.streamReconnectCount);
    let promptTokens = safeNumber(current.promptTokens);
    let completionTokens = safeNumber(current.completionTokens);
    let totalTokens = safeNumber(current.totalTokens);
    let estimatedCostUsd = safeNumber(current.estimatedCostUsd);
    let sessionState = current.sessionState as string | undefined;

    for (const event of events) {
      eventCount += 1;
      firstEventAt ??= event.ts;
      lastEventAt = event.ts;
      if (event.type.startsWith('message.')) messageCount += 1;
      if (event.type === 'signal.emitted') signalCount += 1;
      if (event.type.startsWith('proposal.')) proposalCount += 1;
      if (event.type.startsWith('tool.')) toolCallCount += 1;
      if (event.type === 'decision.finalized' || event.type === 'decision.proposed') decisionCount += 1;
      if (event.type === 'session.stream.opened' && event.data.status === 'reconnecting') streamReconnectCount += 1;
      if (event.type === 'session.state.changed' && typeof event.data.state === 'string') {
        sessionState = event.data.state;
      }

      // Extract token usage from any event that carries it
      const usage = extractTokenUsage(event);
      if (usage) {
        promptTokens += usage.promptTokens;
        completionTokens += usage.completionTokens;
        totalTokens += usage.promptTokens + usage.completionTokens;

        // Extract model name for cost estimation
        const data = event.data as Record<string, unknown>;
        const model =
          (data.tokenUsage as Record<string, unknown> | undefined)?.model ??
          ((data.metadata as Record<string, unknown> | undefined)?.tokenUsage as Record<string, unknown> | undefined)
            ?.model;
        estimatedCostUsd += estimateCost(usage.promptTokens, usage.completionTokens, model ? String(model) : undefined);
      }
    }

    const durationMs =
      firstEventAt && lastEventAt ? new Date(lastEventAt).getTime() - new Date(firstEventAt).getTime() : undefined;

    const persisted = await this.repository.upsert(runId, {
      runId,
      eventCount,
      messageCount,
      signalCount,
      proposalCount,
      toolCallCount,
      decisionCount,
      streamReconnectCount,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCostUsd: String(estimatedCostUsd),
      firstEventAt,
      lastEventAt,
      durationMs,
      sessionState,
      counters: {}
    });

    return this.toSummary(
      runId,
      persisted ?? {
        eventCount,
        messageCount,
        signalCount,
        proposalCount,
        toolCallCount,
        decisionCount,
        streamReconnectCount,
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd: String(estimatedCostUsd),
        firstEventAt,
        lastEventAt,
        durationMs,
        sessionState
      }
    );
  }

  async get(runId: string): Promise<MetricsSummary | null> {
    const persisted = await this.repository.get(runId);
    if (!persisted) return null;
    return this.toSummary(runId, persisted);
  }

  private toSummary(runId: string, row: Record<string, unknown>): MetricsSummary {
    return {
      runId,
      eventCount: safeNumber(row.eventCount),
      messageCount: safeNumber(row.messageCount),
      signalCount: safeNumber(row.signalCount),
      proposalCount: safeNumber(row.proposalCount),
      toolCallCount: safeNumber(row.toolCallCount),
      decisionCount: safeNumber(row.decisionCount),
      streamReconnectCount: safeNumber(row.streamReconnectCount),
      promptTokens: safeNumber(row.promptTokens),
      completionTokens: safeNumber(row.completionTokens),
      totalTokens: safeNumber(row.totalTokens),
      estimatedCostUsd: safeNumber(row.estimatedCostUsd),
      firstEventAt: row.firstEventAt as string | undefined,
      lastEventAt: row.lastEventAt as string | undefined,
      durationMs: row.durationMs as number | undefined,
      sessionState: row.sessionState as MetricsSummary['sessionState']
    };
  }
}
