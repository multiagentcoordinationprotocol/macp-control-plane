import { DashboardService } from './dashboard.service';
import { DatabaseService } from '../db/database.service';
import { RunRepository } from '../storage/run.repository';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';

function makeMockDb() {
  const mock = {
    db: {
      execute: jest.fn().mockResolvedValue({ rows: [] })
    }
  };
  return mock as typeof mock & DatabaseService;
}

function makeMockRunRepo(data: Record<string, unknown>[] = []) {
  return {
    list: jest.fn().mockResolvedValue(data)
  } as unknown as RunRepository;
}

function makeMockRuntimeRegistry(health = { ok: true, runtimeKind: 'rust' }) {
  const provider = { health: jest.fn().mockResolvedValue(health) };
  return {
    listKinds: jest.fn().mockReturnValue(['rust']),
    get: jest.fn().mockReturnValue(provider),
    _provider: provider
  } as unknown as RuntimeProviderRegistry & { _provider: { health: jest.Mock } };
}

describe('DashboardService', () => {
  let service: DashboardService;
  let mockDb: ReturnType<typeof makeMockDb>;
  let mockRunRepo: ReturnType<typeof makeMockRunRepo>;
  let mockRuntimeRegistry: ReturnType<typeof makeMockRuntimeRegistry>;

  beforeEach(() => {
    mockDb = makeMockDb();
    mockRunRepo = makeMockRunRepo([
      {
        id: 'run-1',
        status: 'completed',
        runtimeKind: 'rust',
        sourceRef: null,
        startedAt: null,
        endedAt: null,
        createdAt: '2026-04-04T00:00:00Z'
      }
    ]);
    mockRuntimeRegistry = makeMockRuntimeRegistry();
    service = new DashboardService(mockDb, mockRunRepo, mockRuntimeRegistry);
  });

  describe('getOverview', () => {
    beforeEach(() => {
      // Setup: 7 SQL calls in getOverview (3 KPI + runVolume + signalVolume + errorClasses + 2 latency)
      const dbExecute = mockDb.db.execute as jest.Mock;
      dbExecute
        // getKpis: runs
        .mockResolvedValueOnce({
          rows: [{ totalRuns: 10, activeRuns: 2, completedRuns: 7, failedRuns: 1, cancelledRuns: 0 }]
        })
        // getKpis: signals
        .mockResolvedValueOnce({ rows: [{ totalSignals: 5 }] })
        // getKpis: tokens
        .mockResolvedValueOnce({ rows: [{ totalTokens: 1500, totalCostUsd: 0.056 }] })
        // getRunVolume
        .mockResolvedValueOnce({ rows: [{ bucket: '2026-04-04T00:00:00Z', cnt: 10 }] })
        // getSignalVolume
        .mockResolvedValueOnce({ rows: [{ bucket: '2026-04-04T00:00:00Z', cnt: 5 }] })
        // getErrorClasses
        .mockResolvedValueOnce({ rows: [{ class: 'RUNTIME_TIMEOUT', cnt: 1 }] })
        // getLatencyStats: avg
        .mockResolvedValueOnce({ rows: [{ avgDurationMs: 5000 }] })
        // getLatencyStats: series
        .mockResolvedValueOnce({ rows: [{ bucket: '2026-04-04T00:00:00Z', avgMs: 5000 }] });
    });

    it('returns complete overview structure with kpis, recentRuns, runtimeHealth, charts', async () => {
      const result = await service.getOverview({ window: '24h' });

      expect(result).toHaveProperty('kpis');
      expect(result).toHaveProperty('recentRuns');
      expect(result).toHaveProperty('runtimeHealth');
      expect(result).toHaveProperty('charts');
    });

    it('returns KPIs including token and signal metrics', async () => {
      const result = await service.getOverview({ window: '24h' });

      expect(result.kpis.totalRuns).toBe(10);
      expect(result.kpis.activeRuns).toBe(2);
      expect(result.kpis.completedRuns).toBe(7);
      expect(result.kpis.failedRuns).toBe(1);
      expect(result.kpis.cancelledRuns).toBe(0);
      expect(result.kpis.totalSignals).toBe(5);
      expect(result.kpis.totalTokens).toBe(1500);
      expect(result.kpis.totalCostUsd).toBe(0.06); // rounded to 2 decimals
      expect(result.kpis.avgDurationMs).toBe(5000);
    });

    it('rounds totalCostUsd to 2 decimal places', async () => {
      const result = await service.getOverview({ window: '24h' });
      expect(result.kpis.totalCostUsd).toBe(0.06);
    });

    it('returns chart data with labels and data arrays', async () => {
      const result = await service.getOverview({ window: '24h' });

      expect(result.charts.runVolume).toEqual({
        labels: ['2026-04-04T00:00:00Z'],
        data: [10]
      });
      expect(result.charts.signalVolume).toEqual({
        labels: ['2026-04-04T00:00:00Z'],
        data: [5]
      });
      expect(result.charts.errorClasses).toEqual({
        labels: ['RUNTIME_TIMEOUT'],
        data: [1]
      });
      expect(result.charts.latency).toEqual({
        labels: ['2026-04-04T00:00:00Z'],
        data: [5000]
      });
    });

    it('returns recentRuns from repository', async () => {
      const result = await service.getOverview({ window: '24h' });

      expect(result.recentRuns).toHaveLength(1);
      expect(result.recentRuns[0]).toEqual({
        id: 'run-1',
        status: 'completed',
        runtimeKind: 'rust',
        sourceRef: undefined,
        startedAt: undefined,
        endedAt: undefined,
        createdAt: '2026-04-04T00:00:00Z'
      });
    });

    it('returns runtime health', async () => {
      const result = await service.getOverview({ window: '24h' });

      expect(result.runtimeHealth).toEqual({
        ok: true,
        runtimeKind: 'rust',
        detail: undefined
      });
    });

    it('uses 1 hour bucket for 24h range', async () => {
      await service.getOverview({ window: '24h' });
      const execCalls = (mockDb.db.execute as jest.Mock).mock.calls;
      // runVolume query includes bucket parameter
      const runVolumeCall = execCalls[3]; // 4th call
      expect(runVolumeCall).toBeDefined();
    });

    it('uses 1 day bucket for 7d range', async () => {
      await service.getOverview({ window: '7d' });
      expect(mockDb.db.execute).toHaveBeenCalled();
    });
  });

  describe('getOverview with empty data', () => {
    beforeEach(() => {
      const dbExecute = mockDb.db.execute as jest.Mock;
      dbExecute
        .mockResolvedValueOnce({
          rows: [{ totalRuns: 0, activeRuns: 0, completedRuns: 0, failedRuns: 0, cancelledRuns: 0 }]
        })
        .mockResolvedValueOnce({ rows: [{ totalSignals: 0 }] })
        .mockResolvedValueOnce({ rows: [{ totalTokens: 0, totalCostUsd: 0 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{}] }) // avgDurationMs is undefined
        .mockResolvedValueOnce({ rows: [] });
    });

    it('handles zero KPIs gracefully', async () => {
      mockRunRepo = makeMockRunRepo([]);
      service = new DashboardService(mockDb, mockRunRepo, mockRuntimeRegistry);

      const result = await service.getOverview({ window: '24h' });

      expect(result.kpis.totalRuns).toBe(0);
      expect(result.kpis.totalSignals).toBe(0);
      expect(result.kpis.totalTokens).toBe(0);
      expect(result.kpis.totalCostUsd).toBe(0);
      expect(result.kpis.avgDurationMs).toBeNull();
    });

    it('returns empty chart arrays', async () => {
      mockRunRepo = makeMockRunRepo([]);
      service = new DashboardService(mockDb, mockRunRepo, mockRuntimeRegistry);

      const result = await service.getOverview({ window: '24h' });

      expect(result.charts.runVolume).toEqual({ labels: [], data: [] });
      expect(result.charts.signalVolume).toEqual({ labels: [], data: [] });
      expect(result.charts.errorClasses).toEqual({ labels: [], data: [] });
    });
  });

  describe('getOverview with NULL token values', () => {
    beforeEach(() => {
      const dbExecute = mockDb.db.execute as jest.Mock;
      dbExecute
        .mockResolvedValueOnce({ rows: [{ totalRuns: 1 }] })
        .mockResolvedValueOnce({ rows: [{}] }) // totalSignals is undefined
        .mockResolvedValueOnce({ rows: [{}] }) // totalTokens/totalCostUsd undefined
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });
    });

    it('defaults NULL values to 0', async () => {
      const result = await service.getOverview({ window: '24h' });

      expect(result.kpis.totalSignals).toBe(0);
      expect(result.kpis.totalTokens).toBe(0);
      expect(result.kpis.totalCostUsd).toBe(0);
    });
  });

  describe('getAgentMetrics', () => {
    it('returns per-agent metrics from canonical events', async () => {
      mockDb.db.execute.mockResolvedValue({
        rows: [
          { participantId: 'fraud-agent', runs: 42, messages: 100, signals: 18, averageConfidence: 0.85 },
          { participantId: 'growth-agent', runs: 38, messages: 85, signals: 12, averageConfidence: 0.9 }
        ]
      });

      const result = await service.getAgentMetrics();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        participantId: 'fraud-agent',
        runs: 42,
        messages: 100,
        signals: 18,
        averageConfidence: 0.85
      });
    });

    it('returns empty array when no agents have participated', async () => {
      mockDb.db.execute.mockResolvedValue({ rows: [] });

      const result = await service.getAgentMetrics();

      expect(result).toEqual([]);
    });

    it('defaults averageConfidence to 0 when null', async () => {
      mockDb.db.execute.mockResolvedValue({
        rows: [{ participantId: 'agent-a', runs: 1, messages: 1, signals: 0, averageConfidence: null }]
      });

      const result = await service.getAgentMetrics();

      expect(result[0].averageConfidence).toBe(0);
    });

    it('coerces string values to numbers', async () => {
      mockDb.db.execute.mockResolvedValue({
        rows: [{ participantId: 'agent-a', runs: '5', messages: '10', signals: '2', averageConfidence: '0.75' }]
      });

      const result = await service.getAgentMetrics();

      expect(result[0].runs).toBe(5);
      expect(result[0].messages).toBe(10);
      expect(result[0].signals).toBe(2);
      expect(result[0].averageConfidence).toBe(0.75);
    });
  });

  describe('getRuntimeHealth', () => {
    it('returns health from the first registered provider', async () => {
      const dbExecute = mockDb.db.execute as jest.Mock;
      // Setup minimal overview mocks (getRuntimeHealth is called within getOverview)
      dbExecute
        .mockResolvedValueOnce({
          rows: [{ totalRuns: 0, activeRuns: 0, completedRuns: 0, failedRuns: 0, cancelledRuns: 0 }]
        })
        .mockResolvedValueOnce({ rows: [{ totalSignals: 0 }] })
        .mockResolvedValueOnce({ rows: [{ totalTokens: 0, totalCostUsd: 0 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.getOverview({ window: '24h' });

      expect(result.runtimeHealth.ok).toBe(true);
      expect(result.runtimeHealth.runtimeKind).toBe('rust');
    });

    it('returns ok:false when no providers registered', async () => {
      const emptyRegistry = {
        listKinds: jest.fn().mockReturnValue([]),
        get: jest.fn()
      } as unknown as RuntimeProviderRegistry;
      service = new DashboardService(mockDb, mockRunRepo, emptyRegistry);

      const dbExecute = mockDb.db.execute as jest.Mock;
      dbExecute
        .mockResolvedValueOnce({
          rows: [{ totalRuns: 0, activeRuns: 0, completedRuns: 0, failedRuns: 0, cancelledRuns: 0 }]
        })
        .mockResolvedValueOnce({ rows: [{ totalSignals: 0 }] })
        .mockResolvedValueOnce({ rows: [{ totalTokens: 0, totalCostUsd: 0 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.getOverview({ window: '24h' });

      expect(result.runtimeHealth.ok).toBe(false);
      expect(result.runtimeHealth.runtimeKind).toBe('none');
    });

    it('returns ok:false when health check throws', async () => {
      const failingProvider = { health: jest.fn().mockRejectedValue(new Error('unreachable')) };
      const failingRegistry = {
        listKinds: jest.fn().mockReturnValue(['rust']),
        get: jest.fn().mockReturnValue(failingProvider)
      } as unknown as RuntimeProviderRegistry;
      service = new DashboardService(mockDb, mockRunRepo, failingRegistry);

      const dbExecute = mockDb.db.execute as jest.Mock;
      dbExecute
        .mockResolvedValueOnce({
          rows: [{ totalRuns: 0, activeRuns: 0, completedRuns: 0, failedRuns: 0, cancelledRuns: 0 }]
        })
        .mockResolvedValueOnce({ rows: [{ totalSignals: 0 }] })
        .mockResolvedValueOnce({ rows: [{ totalTokens: 0, totalCostUsd: 0 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.getOverview({ window: '24h' });

      expect(result.runtimeHealth.ok).toBe(false);
      expect(result.runtimeHealth.detail).toBe('Runtime unreachable');
    });
  });
});
