import { Pool } from 'pg';
import { testDatabaseUrl } from './test-db-url';

/**
 * Truncate all tables to ensure clean state between test suites.
 * Uses CASCADE to handle foreign key relationships.
 * Retries on deadlock since background async operations may still be settling.
 */
export async function truncateAll(pool?: Pool): Promise<void> {
  // Guarded even when a pool is passed in: never truncate unless the configured target is the
  // test database (see test-db-url.ts).
  const url = testDatabaseUrl();
  const p = pool ?? new Pool({ connectionString: url });
  const ownPool = !pool;

  const maxRetries = 3;
  try {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await p.query(`
          TRUNCATE
            webhook_deliveries,
            webhooks,
            run_outbound_messages,
            run_metrics,
            run_artifacts,
            run_projections,
            run_events_canonical,
            run_events_raw,
            runtime_sessions,
            audit_log,
            runs
          CASCADE
        `);
        return;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '40P01' && attempt < maxRetries - 1) {
          // 40P01 = deadlock_detected — wait and retry
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  } finally {
    if (ownPool) {
      await p.end();
    }
  }
}

/**
 * Create a fresh pool connection to the test database.
 */
export function createTestPool(): Pool {
  return new Pool({
    connectionString: testDatabaseUrl(),
    max: 5
  });
}
