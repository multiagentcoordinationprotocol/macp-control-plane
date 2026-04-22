import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { ThrottleByUserGuard } from './auth/throttle-by-user.guard';
import { AppConfigService } from './config/app-config.service';
import { ConfigModule } from './config/config.module';
import { AdminController } from './controllers/admin.controller';
import { DashboardController } from './controllers/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { AuditController } from './controllers/audit.controller';
import { HealthController } from './controllers/health.controller';
import { MetricsController } from './controllers/metrics.controller';
import { EventsController } from './controllers/events.controller';
import { ObservabilityController } from './controllers/observability.controller';
import { RunInsightsController } from './controllers/run-insights.controller';
import { RunsController } from './controllers/runs.controller';
import { RuntimeController } from './controllers/runtime.controller';
import { DatabaseModule } from './db/database.module';
import { ArtifactService } from './artifacts/artifact.service';
import { AuditService } from './audit/audit.service';
import { EventNormalizerService } from './events/event-normalizer.service';
import { RunEventService } from './events/run-event.service';
import { MemoryStreamHubStrategy } from './events/memory-stream-hub.strategy';
import { RedisStreamHubStrategy } from './events/redis-stream-hub.strategy';
import { StreamHubService, STREAM_HUB_STRATEGY } from './events/stream-hub.service';
import { MetricsService } from './metrics/metrics.service';
import { CorrelationIdMiddleware } from './middleware/correlation-id.middleware';
import { RequestLoggerMiddleware } from './middleware/request-logger.middleware';
import { ProjectionService } from './projection/projection.service';
import { ReplayService } from './replay/replay.service';
import { ProtoRegistryService } from './runtime/proto-registry.service';
import { RuntimeCredentialResolverService } from './runtime/runtime-credential-resolver.service';
import { RuntimeProviderRegistry } from './runtime/runtime-provider.registry';
import { RustRuntimeProvider } from './runtime/rust-runtime.provider';
import { EventRepository } from './storage/event.repository';
import { ArtifactRepository } from './storage/artifact.repository';
import { MetricsRepository } from './storage/metrics.repository';
import { ProjectionRepository } from './storage/projection.repository';
import { OutboundMessageRepository } from './storage/outbound-message.repository';
import { RunRepository } from './storage/run.repository';
import { RuntimeSessionRepository } from './storage/runtime-session.repository';
import { InstrumentationService } from './telemetry/instrumentation.service';
import { RedactionService } from './telemetry/redaction.service';
import { TraceService } from './telemetry/trace.service';
import { RunInsightsService } from './insights/run-insights.service';
import { RunExecutorService } from './runs/run-executor.service';
import { RunManagerService } from './runs/run-manager.service';
import { RunRecoveryService } from './runs/run-recovery.service';
import { StreamConsumerService } from './runs/stream-consumer.service';
import { SessionDiscoveryService } from './runs/session-discovery.service';
import { SignalConsumerService } from './runs/signal-consumer.service';
import { WebhookController } from './controllers/webhook.controller';
import { WebhookDeliveryRepository } from './webhooks/webhook-delivery.repository';
import { WebhookRepository } from './webhooks/webhook.repository';
import { DataRetentionService } from './retention/data-retention.service';
import { WebhookService } from './webhooks/webhook.service';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuthModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => [
        {
          ttl: config.throttleTtlMs,
          limit: config.throttleLimit
        }
      ]
    })
  ],
  controllers: [
    RunsController,
    RunInsightsController,
    RuntimeController,
    ObservabilityController,
    HealthController,
    MetricsController,
    AdminController,
    AuditController,
    WebhookController,
    DashboardController,
    EventsController
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ThrottleByUserGuard },
    InstrumentationService,
    TraceService,
    RedactionService,
    ProtoRegistryService,
    RuntimeCredentialResolverService,
    RustRuntimeProvider,
    RuntimeProviderRegistry,
    RunRepository,
    RuntimeSessionRepository,
    EventRepository,
    ProjectionRepository,
    ArtifactRepository,
    MetricsRepository,
    OutboundMessageRepository,
    {
      provide: STREAM_HUB_STRATEGY,
      useFactory: (config: AppConfigService) => {
        if (config.streamHubStrategy === 'redis' && config.redisUrl) {
          return new RedisStreamHubStrategy(config.redisUrl);
        }
        return new MemoryStreamHubStrategy();
      },
      inject: [AppConfigService]
    },
    StreamHubService,
    EventNormalizerService,
    ProjectionService,
    MetricsService,
    ArtifactService,
    AuditService,
    RunEventService,
    ReplayService,
    RunManagerService,
    StreamConsumerService,
    SessionDiscoveryService,
    SignalConsumerService,
    RunExecutorService,
    RunRecoveryService,
    RunInsightsService,
    DataRetentionService,
    WebhookRepository,
    WebhookDeliveryRepository,
    WebhookService,
    DashboardService
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware, RequestLoggerMiddleware).forRoutes('*');
  }
}
