import { execSync } from 'node:child_process';
import { Client } from 'pg';

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5433/macp_control_plane_test';

export default async function globalSetup(): Promise<void> {
  const runtimeMode = process.env.INTEGRATION_RUNTIME ?? 'mock';

  // If not in CI, start the test containers via docker compose
  if (!process.env.CI) {
    try {
      if (runtimeMode === 'docker') {
        // Start both postgres and runtime containers
        execSync(
          'docker compose -f docker-compose.test.yml --profile with-runtime up -d --wait',
          { stdio: 'inherit', cwd: process.cwd() }
        );
      } else {
        // Start only postgres
        execSync(
          'docker compose -f docker-compose.test.yml up -d postgres-test --wait',
          { stdio: 'inherit', cwd: process.cwd() }
        );
      }
    } catch {
      console.warn(
        'Could not start docker compose. Assuming services are already running.'
      );
    }
  }

  // Wait for postgres to be ready
  let retries = 20;
  while (retries > 0) {
    try {
      const client = new Client({ connectionString: TEST_DB_URL });
      await client.connect();
      await client.end();
      break;
    } catch {
      retries--;
      if (retries === 0) throw new Error('Test database not reachable');
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Store the DB URL for tests to pick up
  process.env.DATABASE_URL = TEST_DB_URL;

  console.log('Integration test global setup complete.');
}
