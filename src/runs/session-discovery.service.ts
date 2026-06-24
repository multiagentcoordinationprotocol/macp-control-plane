import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RunDescriptor } from '../contracts/control-plane';
import { SessionLifecycleEvent, RuntimeSessionSnapshot } from '../contracts/runtime';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { RunManagerService } from './run-manager.service';
import { StreamConsumerService } from './stream-consumer.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { AppConfigService } from '../config/app-config.service';

/**
 * Subscribes to the runtime's WatchSessions stream and auto-creates run
 * records for discovered sessions. This enables the CP to observe sessions
 * that were started by external launchers (not via POST /runs).
 */
@Injectable()
export class SessionDiscoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionDiscoveryService.name);
  private aborted = false;
  private loopPromise?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectResolve?: () => void;
  private readonly knownSessions = new Set<string>();

  constructor(
    private readonly providerRegistry: RuntimeProviderRegistry,
    private readonly runManager: RunManagerService,
    private readonly streamConsumer: StreamConsumerService,
    private readonly instrumentation: InstrumentationService,
    private readonly config: AppConfigService
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.sessionDiscoveryEnabled) {
      this.logger.log('Session discovery disabled (SESSION_DISCOVERY_ENABLED=false)');
      return;
    }
    this.loopPromise = this.startDiscoveryLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.aborted = true;
    // Cancel any in-flight reconnect sleep so shutdown doesn't block for 5s.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.reconnectResolve) this.reconnectResolve();
    // Await the discovery loop — including any in-flight handleSessionCreated
    // DB writes — before returning so the pool isn't closed under them.
    if (this.loopPromise) await this.loopPromise.catch(() => undefined);
  }

  private async startDiscoveryLoop(): Promise<void> {
    this.logger.log('Starting session discovery via WatchSessions');

    while (!this.aborted) {
      try {
        await this.consumeWatchStream();
      } catch (error) {
        if (this.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`WatchSessions stream ended: ${message}. Reconnecting in 5s...`);
        await new Promise<void>((resolve) => {
          this.reconnectResolve = resolve;
          this.reconnectTimer = setTimeout(resolve, 5000);
        });
        this.reconnectTimer = undefined;
        this.reconnectResolve = undefined;
      }
    }
  }

  private async consumeWatchStream(): Promise<void> {
    const provider = this.providerRegistry.get('rust');
    const stream = provider.watchSessions();

    for await (const event of stream) {
      if (this.aborted) return;

      const sessionId = event.session?.sessionId;
      if (!sessionId) continue;

      if (event.eventType === 'created') {
        await this.handleSessionCreated(event, provider);
      } else if (event.eventType === 'resolved') {
        await this.handleSessionTerminal(sessionId, 'completed');
      } else if (event.eventType === 'expired') {
        await this.handleSessionTerminal(sessionId, 'failed');
      } else if (event.eventType === 'cancelled') {
        // macp-proto 0.1.3: cancellation now arrives as its own lifecycle event
        // (previously surfaced as `expired`). Map to the run's `cancelled` status.
        await this.handleSessionTerminal(sessionId, 'cancelled');
      } else if (event.eventType === 'suspended') {
        await this.handleSessionPaused(sessionId, 'suspended');
      } else if (event.eventType === 'resumed') {
        await this.handleSessionPaused(sessionId, 'resumed');
      }
    }
  }

  private async handleSessionCreated(
    event: SessionLifecycleEvent,
    provider: ReturnType<RuntimeProviderRegistry['get']>
  ): Promise<void> {
    const session = event.session;
    if (this.knownSessions.has(session.sessionId)) return;
    this.knownSessions.add(session.sessionId);

    const existing = await this.runManager.findBySessionId(session.sessionId);
    if (existing) {
      this.logger.debug(`Session ${session.sessionId} already has run ${existing.id}`);
      return;
    }

    const descriptor = this.buildRunDescriptor(session);
    const run = await this.runManager.createRun(descriptor, session.sessionId, session.sessionId);

    this.logger.log(
      `Auto-discovered session ${session.sessionId} → run ${run.id} (mode=${session.mode}, initiator=${session.initiator})`
    );

    try {
      await this.runManager.markStarted(run.id, descriptor);
      await this.runManager.bindSession(run.id, descriptor, {
        runtimeSessionId: session.sessionId,
        initiator: session.initiator ?? '',
        ack: { sessionState: session.state }
      });
      await this.runManager.markRunning(run.id, session.sessionId);
    } catch (err) {
      // Keep the WatchSessions loop alive. Subscribing and consuming the stream
      // below is the point of session discovery — state-machine drift for a
      // single run must not abort discovery for every other session.
      this.logger.warn(
        `Failed to sync run state for discovered session ${session.sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    const handle = provider.subscribeSession({
      runId: run.id,
      runtimeSessionId: session.sessionId
    });

    void this.streamConsumer.start({
      runId: run.id,
      execution: descriptor,
      runtimeKind: 'rust',
      runtimeSessionId: session.sessionId,
      subscriberId: `discovery-${run.id}`,
      sessionHandle: handle
    });
  }

  private async handleSessionTerminal(
    sessionId: string,
    status: 'completed' | 'failed' | 'cancelled'
  ): Promise<void> {
    const run = await this.runManager.findBySessionId(sessionId);
    if (!run) return;

    if (['completed', 'failed', 'cancelled'].includes(run.status)) return;

    if (status === 'completed') {
      await this.runManager.markCompleted(run.id);
    } else if (status === 'cancelled') {
      await this.runManager.markCancelled(run.id);
    } else {
      await this.runManager.markFailed(run.id, new Error('session expired'));
    }
    this.logger.log(`Session ${sessionId} → run ${run.id} marked ${status}`);
  }

  /**
   * macp-proto 0.1.3: SUSPENDED/RESUMED are non-terminal. Reflect the paused
   * state on the run without finalizing it.
   */
  private async handleSessionPaused(sessionId: string, transition: 'suspended' | 'resumed'): Promise<void> {
    const run = await this.runManager.findBySessionId(sessionId);
    if (!run) return;

    // A terminal run never re-enters a paused state.
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return;

    if (transition === 'suspended') {
      await this.runManager.markSuspended(run.id);
    } else {
      await this.runManager.markResumed(run.id);
    }
    this.logger.log(`Session ${sessionId} → run ${run.id} ${transition}`);
  }

  private buildRunDescriptor(session: RuntimeSessionSnapshot): RunDescriptor {
    return {
      mode: 'live',
      runtime: { kind: 'rust' },
      session: {
        sessionId: session.sessionId,
        modeName: session.mode,
        modeVersion: session.modeVersion ?? '1.0.0',
        configurationVersion: session.configurationVersion ?? 'config.default',
        policyVersion: session.policyVersion,
        ttlMs:
          session.expiresAtUnixMs && session.startedAtUnixMs
            ? session.expiresAtUnixMs - session.startedAtUnixMs
            : 300000,
        participants: [],
        metadata: {
          source: 'session-discovery',
          discoveredAt: new Date().toISOString(),
          initiator: session.initiator
        }
      }
    };
  }
}
