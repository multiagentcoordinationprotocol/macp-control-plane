import { ArtifactService } from './artifact.service';
import { ArtifactRepository } from '../storage/artifact.repository';

describe('ArtifactService', () => {
  let service: ArtifactService;
  let mockRepo: { create: jest.Mock; listByRunId: jest.Mock };

  beforeEach(() => {
    mockRepo = {
      create: jest.fn(),
      listByRunId: jest.fn(),
    };
    service = new ArtifactService(mockRepo as unknown as ArtifactRepository);
  });

  describe('register', () => {
    it('delegates to repository.create and returns the result', async () => {
      const input = {
        runId: 'run-1',
        kind: 'json' as const,
        label: 'test-artifact',
        uri: 'https://example.com/artifact.json',
      };
      const expected = {
        ...input,
        id: 'a1a1a1a1-b2b2-c3c3-d4d4-e5e5e5e5e5e5',
        createdAt: '2026-04-07T00:00:00.000Z',
      };
      mockRepo.create.mockResolvedValue(expected);

      const result = await service.register(input);

      expect(mockRepo.create).toHaveBeenCalledWith(input);
      expect(mockRepo.create).toHaveBeenCalledTimes(1);
      expect(result).toEqual(expected);
    });

    it('passes inline data through to repository', async () => {
      const input = {
        runId: 'run-2',
        kind: 'report' as const,
        label: 'inline-report',
        inline: { summary: 'all good', score: 42 },
      };
      const expected = {
        ...input,
        id: 'b1b1b1b1-c2c2-d3d3-e4e4-f5f5f5f5f5f5',
        createdAt: '2026-04-07T00:00:01.000Z',
      };
      mockRepo.create.mockResolvedValue(expected);

      const result = await service.register(input);

      expect(mockRepo.create).toHaveBeenCalledWith(input);
      expect(result).toEqual(expected);
    });

    it('propagates repository errors', async () => {
      mockRepo.create.mockRejectedValue(new Error('db write failed'));

      await expect(
        service.register({ runId: 'run-1', kind: 'log' as const, label: 'x' }),
      ).rejects.toThrow('db write failed');
    });
  });

  describe('list', () => {
    it('delegates to repository.listByRunId and returns the result', async () => {
      const artifacts = [
        { id: 'a1', runId: 'run-1', kind: 'json', label: 'first', uri: null, inline: null, createdAt: '2026-01-01T00:00:00Z' },
        { id: 'a2', runId: 'run-1', kind: 'trace', label: 'second', uri: null, inline: null, createdAt: '2026-01-01T00:01:00Z' },
      ];
      mockRepo.listByRunId.mockResolvedValue(artifacts);

      const result = await service.list('run-1');

      expect(mockRepo.listByRunId).toHaveBeenCalledWith('run-1');
      expect(mockRepo.listByRunId).toHaveBeenCalledTimes(1);
      expect(result).toEqual(artifacts);
    });

    it('returns empty array when no artifacts exist', async () => {
      mockRepo.listByRunId.mockResolvedValue([]);

      const result = await service.list('run-no-artifacts');

      expect(mockRepo.listByRunId).toHaveBeenCalledWith('run-no-artifacts');
      expect(result).toEqual([]);
    });

    it('propagates repository errors', async () => {
      mockRepo.listByRunId.mockRejectedValue(new Error('db read failed'));

      await expect(service.list('run-1')).rejects.toThrow('db read failed');
    });
  });
});
