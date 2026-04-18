import { EventsController } from './events.controller';
import { EventRepository } from '../storage/event.repository';

describe('EventsController (§4.1)', () => {
  let controller: EventsController;
  let mockRepo: { listCanonicalFiltered: jest.Mock };

  beforeEach(() => {
    mockRepo = {
      listCanonicalFiltered: jest.fn().mockResolvedValue({
        data: [{ id: 'e1', runId: 'r1', seq: 1, type: 'signal.emitted' }],
        total: 1
      })
    };
    controller = new EventsController(mockRepo as unknown as EventRepository);
  });

  it('returns { data, total, limit, nextCursor } shape', async () => {
    const result = await controller.listEvents({});

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.limit).toBe(500);
  });

  it('splits comma-separated type filter into array', async () => {
    await controller.listEvents({ type: 'signal.emitted, signal.acknowledged , policy.denied' } as any);

    expect(mockRepo.listCanonicalFiltered).toHaveBeenCalledWith(
      expect.objectContaining({
        types: ['signal.emitted', 'signal.acknowledged', 'policy.denied']
      })
    );
  });

  it('passes scenarioRef, runId, time bounds, and afterSeq through', async () => {
    await controller.listEvents({
      scenarioRef: 'fraud@1.0',
      runId: 'r-123',
      afterSeq: 100,
      afterTs: '2026-04-13T00:00:00Z',
      beforeTs: '2026-04-14T00:00:00Z',
      limit: 50
    } as any);

    expect(mockRepo.listCanonicalFiltered).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioRef: 'fraud@1.0',
        runId: 'r-123',
        afterSeq: 100,
        afterTs: '2026-04-13T00:00:00Z',
        beforeTs: '2026-04-14T00:00:00Z',
        limit: 50
      })
    );
  });

  it('sets nextCursor only when page is full (data.length === limit)', async () => {
    mockRepo.listCanonicalFiltered.mockResolvedValueOnce({
      data: Array.from({ length: 50 }, (_, i) => ({ seq: i + 1 })),
      total: 120
    });

    const result = await controller.listEvents({ limit: 50 } as any);

    expect(result.nextCursor).toBe(50);
  });

  it('omits nextCursor when page is not full', async () => {
    mockRepo.listCanonicalFiltered.mockResolvedValueOnce({
      data: [{ seq: 1 }, { seq: 2 }],
      total: 2
    });

    const result = await controller.listEvents({ limit: 500 } as any);

    expect(result.nextCursor).toBeUndefined();
  });
});
