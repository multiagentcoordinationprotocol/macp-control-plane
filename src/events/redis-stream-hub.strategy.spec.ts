import { RedisStreamHubStrategy } from './redis-stream-hub.strategy';
import { StreamHubMessage } from './stream-hub.service';
import { CanonicalEvent } from '../contracts/control-plane';

// ioredis is an optional peer dependency and is NOT installed — the strategy
// lazy-requires it inside connect(). Provide a virtual mock so the require
// resolves to our fake client.
class MockRedisClient {
  publish = jest.fn().mockResolvedValue(1);
  quit = jest.fn().mockResolvedValue('OK');
  handlers = new Map<string, (...args: unknown[]) => void>();
  subscribe = jest.fn((_channel: string, cb?: (err: Error | null) => void) => cb?.(null));
  on = jest.fn((event: string, cb: (...args: unknown[]) => void) => {
    this.handlers.set(event, cb);
  });
}

const mockCreatedClients: MockRedisClient[] = [];

jest.mock(
  'ioredis',
  () =>
    jest.fn().mockImplementation(() => {
      const client = new MockRedisClient();
      mockCreatedClients.push(client);
      return client;
    }),
  { virtual: true }
);

describe('RedisStreamHubStrategy', () => {
  let strategy: RedisStreamHubStrategy;
  let publisher: MockRedisClient;
  let subscriber: MockRedisClient;

  const makeEvent = (runId: string, seq = 1): CanonicalEvent => ({
    id: `evt-${seq}`,
    runId,
    seq,
    ts: new Date().toISOString(),
    type: 'message.sent',
    source: { kind: 'runtime', name: 'test-runtime' },
    data: { content: `event-${seq}` }
  });

  beforeEach(() => {
    mockCreatedClients.length = 0;
    strategy = new RedisStreamHubStrategy('redis://localhost:6379');
    // connect() runs synchronously up to its first await (there is none before
    // the client construction), so both clients exist immediately.
    [publisher, subscriber] = mockCreatedClients;
  });

  afterEach(() => {
    strategy.destroy();
  });

  it('connects a publisher and a subscriber and subscribes to the hub channel', () => {
    expect(mockCreatedClients).toHaveLength(2);
    expect(subscriber.subscribe).toHaveBeenCalledWith('macp:stream-hub', expect.any(Function));
    expect(subscriber.handlers.has('message')).toBe(true);
  });

  it('publishEvent publishes JSON with _runId and event=canonical_event to macp:stream-hub and emits locally', () => {
    const received: StreamHubMessage[] = [];
    const sub = strategy.stream('run-1').subscribe((msg) => received.push(msg));

    const event = makeEvent('run-1');
    strategy.publishEvent(event);

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const [channel, message] = publisher.publish.mock.calls[0];
    expect(channel).toBe('macp:stream-hub');
    const parsed = JSON.parse(message as string);
    expect(parsed._runId).toBe('run-1');
    expect(parsed.event).toBe('canonical_event');
    expect(parsed.data.id).toBe(event.id);

    // Local emit happens regardless of Redis
    expect(received).toHaveLength(1);
    expect(received[0].event).toBe('canonical_event');
    expect(received[0].data).toBe(event);

    sub.unsubscribe();
  });

  it('stream(runId) filters out events for other runIds', () => {
    const received: StreamHubMessage[] = [];
    const sub = strategy.stream('run-1').subscribe((msg) => received.push(msg));

    strategy.publishEvent(makeEvent('run-1', 1));
    strategy.publishEvent(makeEvent('run-2', 2));

    expect(received).toHaveLength(1);
    expect((received[0].data as CanonicalEvent).runId).toBe('run-1');

    sub.unsubscribe();
  });

  it('delivers remote events from the subscriber message callback to local stream() subscribers', () => {
    const received: StreamHubMessage[] = [];
    const sub = strategy.stream('run-remote').subscribe((msg) => received.push(msg));

    const remoteMsg = JSON.stringify({
      _runId: 'run-remote',
      event: 'canonical_event',
      data: { id: 'evt-remote' }
    });
    subscriber.handlers.get('message')!('macp:stream-hub', remoteMsg);

    expect(received).toHaveLength(1);
    expect(received[0].event).toBe('canonical_event');
    expect((received[0].data as { id: string }).id).toBe('evt-remote');

    sub.unsubscribe();
  });

  it('registers a remote complete message in completedRuns', () => {
    const remoteMsg = JSON.stringify({
      _runId: 'run-done',
      event: 'complete',
      data: { runId: 'run-done' }
    });
    subscriber.handlers.get('message')!('macp:stream-hub', remoteMsg);

    const completedRuns = (strategy as unknown as { completedRuns: Set<string> }).completedRuns;
    expect(completedRuns.has('run-done')).toBe(true);
  });

  it('logs malformed JSON on the channel without throwing', () => {
    const received: StreamHubMessage[] = [];
    const sub = strategy.stream('run-1').subscribe((msg) => received.push(msg));

    expect(() => subscriber.handlers.get('message')!('macp:stream-hub', '{not-json')).not.toThrow();
    expect(received).toHaveLength(0);

    // Hub still functional afterwards
    strategy.publishEvent(makeEvent('run-1'));
    expect(received).toHaveLength(1);

    sub.unsubscribe();
  });

  it('swallows publisher.publish rejections and still emits locally', async () => {
    publisher.publish.mockRejectedValue(new Error('redis down'));

    const received: StreamHubMessage[] = [];
    const sub = strategy.stream('run-1').subscribe((msg) => received.push(msg));

    expect(() => strategy.publishEvent(makeEvent('run-1'))).not.toThrow();
    // Let the rejected publish promise settle through its .catch handler
    await Promise.resolve();
    await Promise.resolve();

    expect(received).toHaveLength(1);

    sub.unsubscribe();
  });

  it('still emits locally when Redis is unavailable (client construction throws)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RedisCtor = require('ioredis') as jest.Mock;
    RedisCtor.mockImplementationOnce(() => {
      throw new Error("Cannot find module 'ioredis'");
    });

    const offline = new RedisStreamHubStrategy('redis://unreachable:6379');
    const received: StreamHubMessage[] = [];
    const sub = offline.stream('run-1').subscribe((msg) => received.push(msg));

    expect(() => offline.publishEvent(makeEvent('run-1'))).not.toThrow();
    expect(received).toHaveLength(1);

    sub.unsubscribe();
    offline.destroy();
  });

  it('destroy() completes the local subject and quits both connections', () => {
    let completed = false;
    const sub = strategy.stream('run-1').subscribe({
      complete: () => {
        completed = true;
      }
    });

    strategy.destroy();

    expect(completed).toBe(true);
    expect(publisher.quit).toHaveBeenCalledTimes(1);
    expect(subscriber.quit).toHaveBeenCalledTimes(1);

    const completedRuns = (strategy as unknown as { completedRuns: Set<string> }).completedRuns;
    expect(completedRuns.size).toBe(0);

    sub.unsubscribe();
  });
});
