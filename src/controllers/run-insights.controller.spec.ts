import { RunInsightsController } from './run-insights.controller';
import { RunInsightsService } from '../insights/run-insights.service';
import { RunExecutorService } from '../runs/run-executor.service';
import { RunManagerService } from '../runs/run-manager.service';

describe('RunInsightsController', () => {
  let controller: RunInsightsController;
  let mockInsightsService: {
    exportRun: jest.Mock;
    exportRunJsonl: jest.Mock;
    compareRuns: jest.Mock;
  };
  let mockRunExecutor: {
    cancel: jest.Mock;
  };
  let mockRunManager: {
    archiveRun: jest.Mock;
    deleteRun: jest.Mock;
  };

  beforeEach(() => {
    mockInsightsService = {
      exportRun: jest.fn(),
      exportRunJsonl: jest.fn(),
      compareRuns: jest.fn()
    };
    mockRunExecutor = {
      cancel: jest.fn()
    };
    mockRunManager = {
      archiveRun: jest.fn(),
      deleteRun: jest.fn()
    };
    controller = new RunInsightsController(
      mockInsightsService as unknown as RunInsightsService,
      mockRunExecutor as unknown as RunExecutorService,
      mockRunManager as unknown as RunManagerService
    );
  });

  describe('exportRun', () => {
    it('delegates to insightsService.exportRun with options', async () => {
      const bundle = { run: { id: 'run-1' }, exportedAt: '2026-01-01T00:00:00Z' };
      mockInsightsService.exportRun.mockResolvedValue(bundle);

      const query = { includeCanonical: true, includeRaw: false, eventLimit: 500 };
      const result = await controller.exportRun('run-1', query as any);

      expect(mockInsightsService.exportRun).toHaveBeenCalledWith('run-1', {
        includeCanonical: true,
        includeRaw: false,
        eventLimit: 500
      });
      expect(result).toEqual(bundle);
    });

    it('passes undefined options when query is empty', async () => {
      mockInsightsService.exportRun.mockResolvedValue({});

      await controller.exportRun('run-1', {} as any);

      expect(mockInsightsService.exportRun).toHaveBeenCalledWith('run-1', {
        includeCanonical: undefined,
        includeRaw: undefined,
        eventLimit: undefined
      });
    });

    it('delegates to exportRunJsonl when format is jsonl', async () => {
      const jsonl = '{"type":"header"}\n';
      mockInsightsService.exportRunJsonl.mockResolvedValue(jsonl);

      const query = { includeCanonical: true, includeRaw: false, eventLimit: 500, format: 'jsonl' as const };
      const result = await controller.exportRun('run-1', query as any);

      expect(mockInsightsService.exportRunJsonl).toHaveBeenCalledWith('run-1', {
        includeCanonical: true,
        includeRaw: false,
        eventLimit: 500
      });
      expect(result).toBe(jsonl);
    });
  });

  describe('compareRuns', () => {
    it('delegates to insightsService.compareRuns', async () => {
      const comparison = { statusMatch: true, left: {}, right: {} };
      mockInsightsService.compareRuns.mockResolvedValue(comparison);

      const body = { leftRunId: 'run-1', rightRunId: 'run-2' };
      const result = await controller.compareRuns(body as any);

      expect(mockInsightsService.compareRuns).toHaveBeenCalledWith('run-1', 'run-2');
      expect(result).toEqual(comparison);
    });
  });

  describe('batchCancel', () => {
    it('cancels multiple runs and returns results', async () => {
      mockRunExecutor.cancel.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('not found'));

      const result = await controller.batchCancel({ runIds: ['run-1', 'run-2'] });

      expect(result).toEqual([
        { runId: 'run-1', status: 'cancelled', error: undefined },
        { runId: 'run-2', status: 'failed', error: 'not found' }
      ]);
      expect(mockRunExecutor.cancel).toHaveBeenCalledWith('run-1', 'batch cancel');
      expect(mockRunExecutor.cancel).toHaveBeenCalledWith('run-2', 'batch cancel');
    });
  });

  describe('batchExport', () => {
    it('exports multiple runs and returns bundles', async () => {
      const bundle1 = { run: { id: 'run-1' }, exportedAt: '2026-01-01T00:00:00Z' };
      const bundle2 = { run: { id: 'run-2' }, exportedAt: '2026-01-01T00:00:00Z' };
      mockInsightsService.exportRun.mockResolvedValueOnce(bundle1).mockResolvedValueOnce(bundle2);

      const result = await controller.batchExport({ runIds: ['run-1', 'run-2'] });

      expect(result).toEqual([bundle1, bundle2]);
      expect(mockInsightsService.exportRun).toHaveBeenCalledWith('run-1', {
        includeCanonical: true,
        includeRaw: false
      });
      expect(mockInsightsService.exportRun).toHaveBeenCalledWith('run-2', {
        includeCanonical: true,
        includeRaw: false
      });
    });
  });

  describe('batchArchive', () => {
    it('archives multiple runs and returns results', async () => {
      mockRunManager.archiveRun.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('not found'));

      const result = await controller.batchArchive({ runIds: ['run-1', 'run-2'] });

      expect(result).toEqual([
        { runId: 'run-1', status: 'archived', error: undefined },
        { runId: 'run-2', status: 'failed', error: 'not found' }
      ]);
      expect(mockRunManager.archiveRun).toHaveBeenCalledWith('run-1');
      expect(mockRunManager.archiveRun).toHaveBeenCalledWith('run-2');
    });
  });

  describe('batchDelete', () => {
    it('deletes multiple runs and returns results', async () => {
      mockRunManager.deleteRun.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('run is not terminal'));

      const result = await controller.batchDelete({ runIds: ['run-1', 'run-2'] });

      expect(result).toEqual([
        { runId: 'run-1', status: 'deleted', error: undefined },
        { runId: 'run-2', status: 'failed', error: 'run is not terminal' }
      ]);
      expect(mockRunManager.deleteRun).toHaveBeenCalledWith('run-1');
      expect(mockRunManager.deleteRun).toHaveBeenCalledWith('run-2');
    });
  });
});
