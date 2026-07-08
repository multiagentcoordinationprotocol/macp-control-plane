import { InlineArtifactStorageProvider } from './inline-artifact-storage.provider';
import { ArtifactRepository } from '../storage/artifact.repository';

describe('InlineArtifactStorageProvider', () => {
  let provider: InlineArtifactStorageProvider;
  let mockRepo: { findById: jest.Mock };

  beforeEach(() => {
    mockRepo = {
      findById: jest.fn()
    };
    provider = new InlineArtifactStorageProvider(mockRepo as unknown as ArtifactRepository);
  });

  it('exposes kind "inline"', () => {
    expect(provider.kind).toBe('inline');
  });

  describe('store', () => {
    it('returns an inline://{runId}/{artifactId} URI', async () => {
      const result = await provider.store({
        runId: 'run-1',
        artifactId: 'artifact-9',
        label: 'summary',
        data: { hello: 'world' }
      });

      expect(result).toEqual({ uri: 'inline://run-1/artifact-9' });
      // Inline storage never round-trips through the repository on store
      expect(mockRepo.findById).not.toHaveBeenCalled();
    });
  });

  describe('retrieve', () => {
    it('parses the URI and returns the inline payload as a JSON buffer', async () => {
      const inline = { summary: 'all good', score: 42 };
      mockRepo.findById.mockResolvedValue({ id: 'artifact-9', runId: 'run-1', inline });

      const result = await provider.retrieve('inline://run-1/artifact-9');

      expect(mockRepo.findById).toHaveBeenCalledWith('artifact-9');
      expect(result).not.toBeNull();
      expect(result!.contentType).toBe('application/json');
      expect(Buffer.isBuffer(result!.data)).toBe(true);
      expect(JSON.parse(result!.data.toString('utf8'))).toEqual(inline);
    });

    it('returns null for a malformed URI', async () => {
      expect(await provider.retrieve('s3://bucket/key')).toBeNull();
      expect(await provider.retrieve('inline://only-one-segment')).toBeNull();
      expect(await provider.retrieve('inline://a/b/c')).toBeNull();
      expect(mockRepo.findById).not.toHaveBeenCalled();
    });

    it('returns null when the artifact is not found', async () => {
      mockRepo.findById.mockResolvedValue(null);

      const result = await provider.retrieve('inline://run-1/missing-artifact');

      expect(mockRepo.findById).toHaveBeenCalledWith('missing-artifact');
      expect(result).toBeNull();
    });

    it('returns null when the artifact has no inline payload', async () => {
      mockRepo.findById.mockResolvedValue({
        id: 'artifact-uri-only',
        runId: 'run-1',
        uri: 'https://example.com/x.json',
        inline: null
      });

      const result = await provider.retrieve('inline://run-1/artifact-uri-only');

      expect(result).toBeNull();
    });
  });
});
