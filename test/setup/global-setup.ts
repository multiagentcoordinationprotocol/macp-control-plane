import { execSync } from 'node:child_process';
import { Client } from 'pg';

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/macp_control_plane_test';

function startCommand(needPostgres: boolean, needRuntime: boolean): string {
  if (needPostgres && needRuntime) {
    // Full profile-up starts both postgres-test and the runtime — no port
    // collision here since we're not in CI (nothing else claims 5433/50051).
    return 'docker compose -f docker-compose.test.yml --profile with-runtime up -d --wait';
  }
  if (needRuntime) {
    // CI mode with a real runtime: start ONLY the named runtime service — the
    // bare `--profile with-runtime up` would also bring up postgres-test, which
    // collides with CI's own postgres service container on port 5433.
    return 'docker compose -f docker-compose.test.yml --profile with-runtime up -d --wait runtime';
  }
  // needPostgres only (local, mock/remote mode): start just postgres-test.
  return 'docker compose -f docker-compose.test.yml up -d postgres-test --wait';
}

/**
 * Exported so global-teardown.ts can reuse the exact same command selection —
 * two independent copies of this branching would only need to drift once to
 * leak or over-remove a container.
 */
export function stopCommand(needPostgres: boolean, needRuntime: boolean): string {
  if (needPostgres && needRuntime) {
    return 'docker compose -f docker-compose.test.yml --profile with-runtime down';
  }
  if (needRuntime) {
    // Only the named runtime service was started — stop/remove only it, not
    // postgres-test (never started) or any CI-managed container. `rm -sf` is
    // one call (stop + force-remove), so a mid-sequence failure can't leave
    // the container stopped-but-not-removed.
    return 'docker compose -f docker-compose.test.yml rm -sf runtime';
  }
  return 'docker compose -f docker-compose.test.yml down';
}

/**
 * Jest does NOT invoke `globalTeardown` when `globalSetup` throws — so if we
 * started containers below and then the Postgres-readiness wait fails, nothing
 * else will ever stop them. Best-effort inline cleanup here is what prevents
 * that from leaking a container for the rest of the job/session.
 */
function cleanupAfterFailedSetup(needPostgres: boolean, needRuntime: boolean): void {
  try {
    execSync(stopCommand(needPostgres, needRuntime), {
      stdio: 'inherit',
      cwd: process.cwd()
    });
  } catch {
    console.warn(
      'Cleanup after a failed setup could not stop docker compose containers — they may need manual removal.'
    );
  }
}

export default async function globalSetup(): Promise<void> {
  // Lowercased so `INTEGRATION_RUNTIME=Docker`/`DOCKER` still starts the
  // runtime container — this must agree with `test/helpers/real-runtime-gate.ts`
  // treating anything-but-`mock` (case-insensitively) as "a real runtime is in
  // play." Written back to process.env below so every downstream consumer
  // (test-app.ts, runtime-kind.ts, and the per-spec real-runtime gates) sees
  // the same normalized value instead of only this file's own decision doing
  // so — without that, a case mismatch would start the runtime container here
  // while a case-sensitive consumer elsewhere still treated the run as mock
  // (or vice versa), silently exercising the wrong path.
  const runtimeMode = (process.env.INTEGRATION_RUNTIME ?? 'mock').toLowerCase();
  process.env.INTEGRATION_RUNTIME = runtimeMode;

  // CI supplies its own Postgres service container (see integration-tests.yml) —
  // starting docker-compose's postgres-test on top of it would collide on host
  // port 5433. The runtime container has no CI-provided equivalent: `docker` mode
  // needs one regardless of CI, `mock`/`remote` need none regardless of CI.
  const needPostgres = !process.env.CI;
  const needRuntime = runtimeMode === 'docker';
  console.log(
    `Integration test global setup: needPostgres=${needPostgres} needRuntime=${needRuntime} (CI=${Boolean(process.env.CI)}, runtimeMode=${runtimeMode})`
  );

  let startedContainers = false;
  if (needPostgres || needRuntime) {
    try {
      execSync(startCommand(needPostgres, needRuntime), {
        stdio: 'inherit',
        cwd: process.cwd()
      });
      startedContainers = true;
    } catch {
      // Not started by us (docker compose itself failed) — nothing to clean up
      // if the wait below throws, since we can't distinguish "already running"
      // from "genuinely absent" here.
      console.warn(
        'Could not start docker compose. Assuming services are already running.'
      );
    }
  }

  try {
    // Wait for postgres to be ready. connectionTimeoutMillis bounds each
    // attempt — pg's default is 0 (no timeout), so a dead connection would
    // otherwise inherit the OS TCP timeout (~75s) × 20 retries, hanging the
    // whole job for ~25 minutes instead of failing fast.
    let retries = 20;
    while (retries > 0) {
      try {
        const client = new Client({
          connectionString: TEST_DB_URL,
          connectionTimeoutMillis: 5000
        });
        await client.connect();
        await client.end();
        break;
      } catch {
        retries--;
        if (retries === 0) throw new Error('Test database not reachable');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch (err) {
    if (startedContainers) cleanupAfterFailedSetup(needPostgres, needRuntime);
    throw err;
  }

  // Store the DB URL for tests to pick up
  process.env.DATABASE_URL = TEST_DB_URL;

  console.log('Integration test global setup complete.');
}
