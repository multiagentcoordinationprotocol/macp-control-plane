import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { RunRepository } from '../storage/run.repository';
import { EventNormalizerService } from '../events/event-normalizer.service';
import { RunEventService } from '../events/run-event.service';
import { ProtoRegistryService } from '../runtime/proto-registry.service';
import { AppConfigService } from '../config/app-config.service';
import type { NormalizeContext } from '../contracts/runtime';

/**
 * Subscribes to the runtime's WatchSignals stream (separate from per-session
 * StreamSession). The runtime broadcasts ambient Signal/Progress envelopes on
 * a dedicated bus; this service routes each envelope to the matching run by
 * `envelope.sessionId` and persists it through the same normalizer +
 * RunEventService pipeline used by the per-session stream consumer.
 *
 * Without this service, agent-emitted Signal/Progress envelopes (including the
 * `llm.call.completed` signals carrying token usage) are invisible to CP.
 */
@Injectable()
export class SignalConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SignalConsumerService.name);
  private aborted = false;
  private loopPromise?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectResolve?: () => void;

  constructor(
    private readonly providerRegistry: RuntimeProviderRegistry,
    private readonly runRepository: RunRepository,
    private readonly normalizer: EventNormalizerService,
    private readonly eventService: RunEventService,
    private readonly protoRegistry: ProtoRegistryService,
    private readonly config: AppConfigService
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.sessionDiscoveryEnabled) {
      this.logger.log('Signal consumer disabled (gated on SESSION_DISCOVERY_ENABLED)');
      return;
    }
    this.loopPromise = this.startConsumeLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.aborted = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.reconnectResolve) this.reconnectResolve();
    // Await the consume loop so in-flight persistRawAndCanonical calls finish
    // before the DB pool closes.
    if (this.loopPromise) await this.loopPromise.catch(() => undefined);
  }

  private async startConsumeLoop(): Promise<void> {
    this.logger.log('Starting WatchSignals consumer');

    while (!this.aborted) {
      try {
        await this.consumeSignalStream();
      } catch (error) {
        if (this.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`WatchSignals stream ended: ${message}. Reconnecting in 5s...`);
        await new Promise<void>((resolve) => {
          this.reconnectResolve = resolve;
          this.reconnectTimer = setTimeout(resolve, 5000);
        });
        this.reconnectTimer = undefined;
        this.reconnectResolve = undefined;
      }
    }
  }

  private async consumeSignalStream(): Promise<void> {
    const provider = this.providerRegistry.get('rust');
    const stream = provider.watchSignals();

    for await (const raw of stream) {
      if (this.aborted) return;
      if (raw.kind !== 'stream-envelope' || !raw.envelope) continue;

      // Signal envelopes are ambient (envelope.sessionId always empty per
      // RFC-MACP-0001 §x); the session correlation lives in the decoded
      // payload's `correlation_session_id`. Progress envelopes may be
      // session-scoped or ambient. Try both sources, ambient first.
      let sessionId = raw.envelope.sessionId ?? '';
      if (!sessionId && raw.envelope.payload) {
        try {
          const decoded = this.protoRegistry.decodeKnown(
            'macp.v1',
            raw.envelope.messageType ?? '',
            raw.envelope.payload
          ) as Record<string, unknown> | null;
          if (decoded) {
            sessionId =
              (decoded.correlationSessionId as string | undefined) ??
              (decoded.correlation_session_id as string | undefined) ??
              '';
          }
        } catch {
          /* decode failed — drop silently */
        }
      }
      if (!sessionId) continue;

      try {
        const run = await this.runRepository.findByRuntimeSessionId(sessionId);
        if (!run) {
          // Ambient signal for an unknown session — drop silently.
          this.logger.debug(`Signal for unknown session ${sessionId}; dropping`);
          continue;
        }

        const ctx: NormalizeContext = {
          knownParticipants: new Set<string>(),
          execution: undefined as unknown as NormalizeContext['execution'],
          runtimeSessionId: sessionId
        };

        const canonical = this.normalizer.normalize(run.id, raw, ctx);
        await this.eventService.persistRawAndCanonical(run.id, raw, canonical);
      } catch (err) {
        this.logger.warn(
          `Failed to persist signal for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}
