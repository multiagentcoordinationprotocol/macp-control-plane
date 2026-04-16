import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { RunDescriptor } from '../contracts/control-plane';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';
import { RunEventService } from '../events/run-event.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { RunRepository } from '../storage/run.repository';
import { RuntimeSessionRepository } from '../storage/runtime-session.repository';
import { RunManagerService } from './run-manager.service';
import { StreamConsumerService } from './stream-consumer.service';

@Injectable()
export class RunRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RunRecoveryService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly database: DatabaseService,
    private readonly runRepository: RunRepository,
    private readonly runtimeSessionRepository: RuntimeSessionRepository,
    private readonly runManager: RunManagerService,
    private readonly streamConsumer: StreamConsumerService,
    private readonly eventService: RunEventService,
    private readonly instrumentation: InstrumentationService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.runRecoveryEnabled) {
      this.logger.log('run recovery disabled');
      return;
    }
    await this.recoverActiveRuns();
  }

  async recoverActiveRuns(): Promise<{ recovered: string[]; failed: Array<{ runId: string; error: string }> }> {
    const activeRuns = await this.runRepository.listActiveRuns();
    if (activeRuns.length === 0) {
      this.logger.log('no active runs to recover');
      return { recovered: [], failed: [] };
    }
    this.logger.log(`recovering ${activeRuns.length} active run(s)`);

    const recovered: string[] = [];
    const failed: Array<{ runId: string; error: string }> = [];

    for (const run of activeRuns) {
      try {
        // Distributed lock: prevent multiple CP instances from recovering the same run
        const lockKey = `run-recovery:${run.id}`;
        const acquired = await this.database.tryAdvisoryLock(lockKey);
        if (!acquired) {
          this.logger.log(`skipping run ${run.id} — another instance holds the recovery lock`);
          continue;
        }
        try {
          await this.recoverRun(run);
          this.instrumentation.recoveryTotal.inc({ status: 'success' });
          recovered.push(run.id);
        } finally {
          await this.database.advisoryUnlock(lockKey);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.instrumentation.recoveryTotal.inc({ status: 'failed' });
        this.logger.error(`failed to recover run ${run.id}: ${errorMessage}`);
        failed.push({ runId: run.id, error: errorMessage });
        try {
          await this.runManager.markFailed(run.id, error);
        } catch (markError) {
          this.logger.error(
            `failed to mark run ${run.id} as failed: ${markError instanceof Error ? markError.message : String(markError)}`
          );
        }
      }
    }

    this.logger.log(`recovery summary: ${recovered.length} recovered, ${failed.length} failed`);
    return { recovered, failed };
  }

  private async recoverRun(run: {
    id: string;
    status: string;
    runtimeKind: string;
    runtimeSessionId: string | null;
    lastEventSeq: number;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    const executionRequest = run.metadata?.executionRequest as RunDescriptor | undefined;
    if (!executionRequest) {
      throw new Error('missing executionRequest in run metadata');
    }

    const session = await this.runtimeSessionRepository.findByRunId(run.id);
    const runtimeSessionId = run.runtimeSessionId ?? session?.runtimeSessionId;
    if (!runtimeSessionId) {
      throw new Error('no runtime session ID available for recovery');
    }

    // Observer mode: the initiator sender is whatever the runtime's session metadata said
    // at bind time (stored in runtime_sessions.initiator_participant_id). The control-plane
    // no longer chooses an initiator from the descriptor.
    const subscriberId = session?.initiatorParticipantId ?? 'control-plane';

    // Promote binding_session → running if needed
    if (run.status === 'binding_session') {
      await this.runManager.markRunning(run.id, runtimeSessionId);
    }

    await this.eventService.emitControlPlaneEvents(run.id, [
      {
        ts: new Date().toISOString(),
        type: 'session.stream.opened',
        source: { kind: 'control-plane', name: 'run-recovery' },
        subject: { kind: 'session', id: runtimeSessionId },
        data: { status: 'recovered', detail: 'stream resumed after restart' }
      }
    ]);

    // Use the persisted stream cursor if available, otherwise fall back to run's lastEventSeq
    const resumeFromSeq = Math.max(session?.lastStreamCursor ?? 0, run.lastEventSeq);

    await this.streamConsumer.start({
      runId: run.id,
      execution: executionRequest,
      runtimeKind: run.runtimeKind,
      runtimeSessionId,
      subscriberId,
      resumeFromSeq,
      pollOnly: true
    });

    this.logger.log(`recovered run ${run.id} from seq ${run.lastEventSeq}`);
  }
}
