import { execSync } from 'node:child_process';

export default async function globalTeardown(): Promise<void> {
  const runtimeMode = process.env.INTEGRATION_RUNTIME ?? 'mock';

  // If not in CI, stop the test containers
  if (!process.env.CI && !process.env.KEEP_TEST_DB) {
    try {
      if (runtimeMode === 'docker') {
        execSync('docker compose -f docker-compose.test.yml --profile with-runtime down', {
          stdio: 'inherit',
          cwd: process.cwd()
        });
      } else {
        execSync('docker compose -f docker-compose.test.yml down', {
          stdio: 'inherit',
          cwd: process.cwd()
        });
      }
    } catch {
      console.warn('Could not stop docker compose containers.');
    }
  }

  console.log('Integration test global teardown complete.');
}
