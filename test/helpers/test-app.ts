import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as express from 'express';
import * as promClient from 'prom-client';
import { AppModule } from '../../src/app.module';
import { GlobalExceptionFilter } from '../../src/errors/exception.filter';
import { RustRuntimeProvider } from '../../src/runtime/rust-runtime.provider';
import { RuntimeProviderRegistry } from '../../src/runtime/runtime-provider.registry';
import { StreamConsumerService } from '../../src/runs/stream-consumer.service';
import { runMigrations } from '../../src/db/migrate';
import {
  RuntimeScript,
  ScriptedMockRuntimeProvider
} from './scripted-mock-runtime.provider';
import { TestClient } from './test-client';
import { truncateAll } from './test-db';
import { DatabaseService } from '../../src/db/database.service';

export interface TestAppContext {
  app: INestApplication;
  url: string;
  client: TestClient;
  /** The mock runtime — only available when INTEGRATION_RUNTIME=mock (default) */
  mockRuntime: ScriptedMockRuntimeProvider;
  module: TestingModule;
  cleanup: () => Promise<void>;
  /** Which runtime mode is active */
  runtimeMode: 'mock' | 'docker' | 'remote';
}

const DEFAULT_SCRIPT: RuntimeScript = {
  supportedModes: [
    'macp.mode.decision.v1',
    'macp.mode.task.v1',
    'macp.mode.proposal.v1',
    'macp.mode.handoff.v1',
    'macp.mode.quorum.v1'
  ],
  events: [
    {
      event: {
        kind: 'stream-status',
        receivedAt: new Date().toISOString(),
        streamStatus: { status: 'opened' }
      }
    }
  ]
};

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/macp_control_plane_test';

/**
 * Boot a real NestJS application for integration testing.
 *
 * Runtime mode is controlled by INTEGRATION_RUNTIME env var:
 *   - "mock"   (default) — uses ScriptedMockRuntimeProvider, no gRPC
 *   - "docker" — uses real RustRuntimeProvider, expects runtime at RUNTIME_ADDRESS
 *   - "remote" — uses real RustRuntimeProvider, expects runtime at RUNTIME_ADDRESS
 */
export async function createTestApp(
  script?: RuntimeScript
): Promise<TestAppContext> {
  const runtimeMode = (process.env.INTEGRATION_RUNTIME ?? 'mock') as
    | 'mock'
    | 'docker'
    | 'remote';

  // Set environment for the test app
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_API_KEYS = 'test-key-integration';
  process.env.OTEL_ENABLED = 'false';
  process.env.LOG_LEVEL = 'warn';
  process.env.RUNTIME_ALLOW_INSECURE = 'true';
  process.env.RUN_RECOVERY_ENABLED = 'false';

  if (!process.env.RUNTIME_ADDRESS) {
    process.env.RUNTIME_ADDRESS = '127.0.0.1:50051';
  }

  // Clear Prometheus registry to avoid duplicate metric errors across test suites
  promClient.register.clear();

  // Run migrations
  await runMigrations(TEST_DB_URL);

  let mockRuntime: ScriptedMockRuntimeProvider;
  let moduleRef: TestingModule;

  if (runtimeMode === 'mock') {
    // ── Mock mode: override RustRuntimeProvider with scripted mock ──
    mockRuntime = new ScriptedMockRuntimeProvider(script ?? DEFAULT_SCRIPT);

    moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(RustRuntimeProvider)
      .useValue(mockRuntime)
      .compile();

    // Register the mock in the provider registry
    const registry = moduleRef.get(RuntimeProviderRegistry);
    registry.register(mockRuntime);
  } else {
    // ── Docker/Remote mode: use real RustRuntimeProvider ──
    // The real provider connects via gRPC to RUNTIME_ADDRESS
    mockRuntime = null as any; // Not available in real mode

    moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    }).compile();
  }

  const app = moduleRef.createNestApplication();

  // Apply same configuration as main.ts
  app.use(express.json({ limit: '1mb' }));
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableCors({ origin: '*', credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false
    })
  );

  await app.listen(0);
  const url = await app.getUrl();

  const client = new TestClient(url, 'test-key-integration');

  const cleanup = async () => {
    // Stop all active stream consumers before truncating to prevent
    // race conditions where async events reference deleted runs
    const streamConsumer = moduleRef.get(StreamConsumerService);
    await streamConsumer.onModuleDestroy();

    const dbService = moduleRef.get(DatabaseService);

    // Use a dedicated short-lived connection (not the app pool, which may be
    // exhausted by background executor operations) to force-terminate active runs,
    // then truncate. This prevents cleanup from hanging.
    const { Client } = require('pg');
    const client = new Client({ connectionString: TEST_DB_URL });
    try {
      await client.connect();
      // Force all in-progress runs to 'failed' so background operations stop
      await client.query(
        `UPDATE runs SET status = 'failed', error_code = 'TEST_CLEANUP', error_message = 'force-terminated by test cleanup', ended_at = now() WHERE status NOT IN ('completed','failed','cancelled','queued')`
      );
      // Brief pause for background operations to notice the state change
      await new Promise((r) => setTimeout(r, runtimeMode === 'mock' ? 300 : 1000));
    } catch {
      // Best-effort; proceed to truncate
    } finally {
      await client.end().catch(() => {});
    }

    await truncateAll(dbService.pool);
  };

  return {
    app,
    url,
    client,
    mockRuntime,
    module: moduleRef,
    cleanup,
    runtimeMode
  };
}
