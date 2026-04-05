import { DashboardController } from './dashboard.controller';
import { DashboardService } from '../dashboard/dashboard.service';

describe('DashboardController', () => {
  let controller: DashboardController;
  let mockService: { getOverview: jest.Mock; getAgentMetrics: jest.Mock };

  beforeEach(() => {
    mockService = {
      getOverview: jest.fn(),
      getAgentMetrics: jest.fn()
    };
    controller = new DashboardController(
      mockService as unknown as DashboardService
    );
  });

  describe('getOverview', () => {
    it('returns overview with default 24h range', async () => {
      const overview = {
        kpis: {
          totalRuns: 10, activeRuns: 2, completedRuns: 7, failedRuns: 1,
          cancelledRuns: 0, totalSignals: 5, totalTokens: 1500, totalCostUsd: 0.05,
          avgDurationMs: 5000
        },
        recentRuns: [{ id: 'run-1', status: 'completed', runtimeKind: 'rust', createdAt: '2026-04-04T00:00:00Z' }],
        runtimeHealth: { ok: true, runtimeKind: 'rust' },
        charts: {
          runVolume: { labels: ['2026-04-04T00:00:00Z'], data: [10] },
          latency: { labels: ['2026-04-04T00:00:00Z'], data: [500] },
          signalVolume: { labels: [], data: [] },
          errorClasses: { labels: ['RUNTIME_TIMEOUT'], data: [1] }
        }
      };
      mockService.getOverview.mockResolvedValue(overview);

      const result = await controller.getOverview({ range: undefined });

      expect(mockService.getOverview).toHaveBeenCalledWith('24h');
      expect(result).toEqual(overview);
      expect(result.kpis.totalTokens).toBe(1500);
      expect(result.kpis.totalCostUsd).toBe(0.05);
      expect(result.recentRuns).toHaveLength(1);
      expect(result.runtimeHealth.ok).toBe(true);
    });

    it('passes 7d range to service', async () => {
      mockService.getOverview.mockResolvedValue({ kpis: {}, charts: {} });
      await controller.getOverview({ range: '7d' });
      expect(mockService.getOverview).toHaveBeenCalledWith('7d');
    });

    it('passes 30d range to service', async () => {
      mockService.getOverview.mockResolvedValue({ kpis: {}, charts: {} });
      await controller.getOverview({ range: '30d' });
      expect(mockService.getOverview).toHaveBeenCalledWith('30d');
    });
  });

  describe('getAgentMetrics', () => {
    it('returns array of per-agent metrics', async () => {
      const metrics = [
        { participantId: 'fraud-agent', runs: 42, messages: 100, signals: 18, averageConfidence: 0.85 },
        { participantId: 'growth-agent', runs: 38, messages: 85, signals: 12, averageConfidence: 0.9 }
      ];
      mockService.getAgentMetrics.mockResolvedValue(metrics);

      const result = await controller.getAgentMetrics();

      expect(mockService.getAgentMetrics).toHaveBeenCalled();
      expect(result).toEqual(metrics);
      expect(result).toHaveLength(2);
    });

    it('returns empty array when no agents have participated', async () => {
      mockService.getAgentMetrics.mockResolvedValue([]);

      const result = await controller.getAgentMetrics();

      expect(result).toEqual([]);
    });
  });
});
