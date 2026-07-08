import { SignalConsumerService } from './signal-consumer.service';
import { AppConfigService } from '../config/app-config.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { RunRepository } from '../storage/run.repository';
import { EventNormalizerService } from '../events/event-normalizer.service';
import { RunEventService } from '../events/run-event.service';
import { ProtoRegistryService } from '../runtime/proto-registry.service';
import { RawRuntimeEvent, RuntimeEnvelope } from '../contracts/runtime';

function makeEnvelopeEvent(
  overrides: Partial<RuntimeEnvelope> = {},
  kind: RawRuntimeEvent['kind'] = 'stream-envelope'
): RawRuntimeEvent {
  return {
    kind,
    receivedAt: new Date().toISOString(),
    envelope: {
      macpVersion: '1.0',
      mode: 'decision',
      messageType: 'macp.signal.v1.SignalPayload',
      messageId: 'msg-1',
      sessionId: '',
      sender: 'agent-1',
      timestampUnixMs: Date.now(),
      payload: Buffer.from('proto-bytes'),
      ...overrides
    }
  };
}

async function* scriptedStream(events: RawRuntimeEvent[]) {
  for (const ev of events) yield ev;
}

describe('SignalConsumerService', () => {
  let service: SignalConsumerService;
  let mockConfig: Partial<AppConfigService>;
  let mockRegistry: { get: jest.Mock };
  let mockProvider: { watchSignals: jest.Mock };
  let mockRunRepo: { findByRuntimeSessionId: jest.Mock };
  let mockNormalizer: { normalize: jest.Mock };
  let mockEventService: { persistRawAndCanonical: jest.Mock };
  let mockProtoRegistry: { decodeKnown: jest.Mock };

  const canonicalSentinel = [{ type: 'signal.emitted' }];

  beforeEach(() => {
    mockConfig = { sessionDiscoveryEnabled: true };
    mockProvider = { watchSignals: jest.fn() };
    mockRegistry = { get: jest.fn().mockReturnValue(mockProvider) };
    mockRunRepo = {
      findByRuntimeSessionId: jest.fn().mockResolvedValue({ id: 'run-1', status: 'running' })
    };
    mockNormalizer = { normalize: jest.fn().mockReturnValue(canonicalSentinel) };
    mockEventService = { persistRawAndCanonical: jest.fn().mockResolvedValue(undefined) };
    mockProtoRegistry = { decodeKnown: jest.fn().mockReturnValue(null) };

    service = new SignalConsumerService(
      mockRegistry as unknown as RuntimeProviderRegistry,
      mockRunRepo as unknown as RunRepository,
      mockNormalizer as unknown as EventNormalizerService,
      mockEventService as unknown as RunEventService,
      mockProtoRegistry as unknown as ProtoRegistryService,
      mockConfig as AppConfigService
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('skips consume loop when SESSION_DISCOVERY_ENABLED=false', async () => {
    const disabled = new SignalConsumerService(
      mockRegistry as unknown as RuntimeProviderRegistry,
      mockRunRepo as unknown as RunRepository,
      mockNormalizer as unknown as EventNormalizerService,
      mockEventService as unknown as RunEventService,
      mockProtoRegistry as unknown as ProtoRegistryService,
      { sessionDiscoveryEnabled: false } as AppConfigService
    );
    await disabled.onModuleInit();
    expect(mockRegistry.get).not.toHaveBeenCalled();
    expect(mockProvider.watchSignals).not.toHaveBeenCalled();
  });

  it('routes an envelope with envelope.sessionId to the matching run and persists it', async () => {
    const raw = makeEnvelopeEvent({ sessionId: 'session-abc' });
    mockProvider.watchSignals.mockReturnValue(scriptedStream([raw]));

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunRepo.findByRuntimeSessionId).toHaveBeenCalledWith('session-abc');
    expect(mockNormalizer.normalize).toHaveBeenCalledWith(
      'run-1',
      raw,
      expect.objectContaining({ runtimeSessionId: 'session-abc' })
    );
    expect(mockEventService.persistRawAndCanonical).toHaveBeenCalledWith('run-1', raw, canonicalSentinel);
    // No decode needed when the envelope is session-scoped
    expect(mockProtoRegistry.decodeKnown).not.toHaveBeenCalled();
  });

  it('falls back to decoded correlationSessionId when envelope.sessionId is empty', async () => {
    const raw = makeEnvelopeEvent({ sessionId: '' });
    mockProtoRegistry.decodeKnown.mockReturnValue({ correlationSessionId: 'session-corr' });
    mockProvider.watchSignals.mockReturnValue(scriptedStream([raw]));

    await service.onModuleInit();
    await flushAsync();

    expect(mockProtoRegistry.decodeKnown).toHaveBeenCalledWith(
      'macp.v1',
      'macp.signal.v1.SignalPayload',
      raw.envelope!.payload
    );
    expect(mockRunRepo.findByRuntimeSessionId).toHaveBeenCalledWith('session-corr');
    expect(mockEventService.persistRawAndCanonical).toHaveBeenCalledWith('run-1', raw, canonicalSentinel);
  });

  it('accepts snake_case correlation_session_id from the decoded payload', async () => {
    const raw = makeEnvelopeEvent({ sessionId: '' });
    mockProtoRegistry.decodeKnown.mockReturnValue({ correlation_session_id: 'session-snake' });
    mockProvider.watchSignals.mockReturnValue(scriptedStream([raw]));

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunRepo.findByRuntimeSessionId).toHaveBeenCalledWith('session-snake');
    expect(mockEventService.persistRawAndCanonical).toHaveBeenCalled();
  });

  it('drops silently when payload decode throws', async () => {
    const raw = makeEnvelopeEvent({ sessionId: '' });
    mockProtoRegistry.decodeKnown.mockImplementation(() => {
      throw new Error('unknown message type');
    });
    mockProvider.watchSignals.mockReturnValue(scriptedStream([raw]));

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunRepo.findByRuntimeSessionId).not.toHaveBeenCalled();
    expect(mockEventService.persistRawAndCanonical).not.toHaveBeenCalled();
  });

  it('drops when no sessionId is resolvable from envelope or payload', async () => {
    const raw = makeEnvelopeEvent({ sessionId: '' });
    mockProtoRegistry.decodeKnown.mockReturnValue({ signalType: 'llm.call.completed' });
    mockProvider.watchSignals.mockReturnValue(scriptedStream([raw]));

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunRepo.findByRuntimeSessionId).not.toHaveBeenCalled();
    expect(mockEventService.persistRawAndCanonical).not.toHaveBeenCalled();
  });

  it('drops when no run matches the session without calling the normalizer', async () => {
    mockRunRepo.findByRuntimeSessionId.mockResolvedValue(null);
    mockProvider.watchSignals.mockReturnValue(
      scriptedStream([makeEnvelopeEvent({ sessionId: 'session-unknown' })])
    );

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunRepo.findByRuntimeSessionId).toHaveBeenCalledWith('session-unknown');
    expect(mockNormalizer.normalize).not.toHaveBeenCalled();
    expect(mockEventService.persistRawAndCanonical).not.toHaveBeenCalled();
  });

  it('ignores non-envelope raw events (stream-status, session-snapshot)', async () => {
    const statusEvent: RawRuntimeEvent = {
      kind: 'stream-status',
      receivedAt: new Date().toISOString(),
      streamStatus: { status: 'opened' }
    };
    const snapshotEvent: RawRuntimeEvent = {
      kind: 'session-snapshot',
      receivedAt: new Date().toISOString()
    };
    mockProvider.watchSignals.mockReturnValue(scriptedStream([statusEvent, snapshotEvent]));

    await service.onModuleInit();
    await flushAsync();

    expect(mockRunRepo.findByRuntimeSessionId).not.toHaveBeenCalled();
    expect(mockEventService.persistRawAndCanonical).not.toHaveBeenCalled();
  });

  it('catches persistRawAndCanonical rejection and keeps consuming the stream', async () => {
    mockEventService.persistRawAndCanonical
      .mockRejectedValueOnce(new Error('db write failed'))
      .mockResolvedValueOnce(undefined);
    mockProvider.watchSignals.mockReturnValue(
      scriptedStream([
        makeEnvelopeEvent({ sessionId: 'session-1', messageId: 'msg-a' }),
        makeEnvelopeEvent({ sessionId: 'session-2', messageId: 'msg-b' })
      ])
    );

    await service.onModuleInit();
    await flushAsync();

    // Both envelopes were attempted — the first rejection was contained per-envelope
    expect(mockEventService.persistRawAndCanonical).toHaveBeenCalledTimes(2);
    expect(mockRunRepo.findByRuntimeSessionId).toHaveBeenNthCalledWith(1, 'session-1');
    expect(mockRunRepo.findByRuntimeSessionId).toHaveBeenNthCalledWith(2, 'session-2');
  });

  it('reconnects after a stream error and resumes consuming', async () => {
    const failingStream = (async function* () {
      await Promise.resolve();
      throw new Error('stream broke');
    })();
    mockProvider.watchSignals
      .mockReturnValueOnce(failingStream)
      .mockReturnValueOnce(scriptedStream([makeEnvelopeEvent({ sessionId: 'session-after-reconnect' })]));

    await service.onModuleInit();

    // Wait until the loop parks in its 5s reconnect sleep, then cancel it to
    // fast-forward instead of waiting the full backoff.
    for (let i = 0; i < 50 && !(service as unknown as { reconnectResolve?: () => void }).reconnectResolve; i++) {
      await flushAsync();
    }
    (service as unknown as { reconnectResolve?: () => void }).reconnectResolve?.();
    await flushAsync();
    await flushAsync();

    expect(mockProvider.watchSignals.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockRunRepo.findByRuntimeSessionId).toHaveBeenCalledWith('session-after-reconnect');
    expect(mockEventService.persistRawAndCanonical).toHaveBeenCalled();
  });

  it('onModuleDestroy cancels a pending reconnect and awaits the loop promise', async () => {
    const failingStream = (async function* () {
      await Promise.resolve();
      throw new Error('stream broke');
    })();
    mockProvider.watchSignals.mockReturnValueOnce(failingStream);

    await service.onModuleInit();

    // Park the loop in its reconnect sleep
    for (let i = 0; i < 50 && !(service as unknown as { reconnectResolve?: () => void }).reconnectResolve; i++) {
      await flushAsync();
    }
    expect((service as unknown as { reconnectResolve?: () => void }).reconnectResolve).toBeDefined();

    await service.onModuleDestroy();
    await flushAsync();

    // The aborted loop must not resubscribe after destroy
    expect(mockProvider.watchSignals).toHaveBeenCalledTimes(1);
    expect((service as unknown as { reconnectTimer?: unknown }).reconnectTimer).toBeUndefined();
  });
});

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}
