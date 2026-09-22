import { execSync } from 'node:child_process';
import { stopCommand } from './global-setup';

export default async function globalTeardown(): Promise<void> {
  // Must agree with global-setup.ts's own lowercasing (see its comment) — a
  // case mismatch here would mean teardown believes it never started a runtime
  // container that setup, in fact, did. globalSetup normalizes
  // process.env.INTEGRATION_RUNTIME in place, and Jest runs globalTeardown in
  // the same process, so this already reads the normalized value in practice;
  // lowercasing again here is a low-cost belt-and-suspenders guard against that
  // coupling ever changing.
  const runtimeMode = (process.env.INTEGRATION_RUNTIME ?? 'mock').toLowerCase();

  // Mirror global-setup's needPostgres/needRuntime split: only tear down what
  // this run could have started. In CI, postgres-test was never started (CI
  // supplies its own Postgres service container), so `needPostgres` is false
  // there and teardown must not attempt to `down` a container this run never
  // brought up. Note this can't distinguish "setup started it" from "it was
  // already running before this job" (global-setup.ts falls into the latter
  // whenever its own `docker compose up` throws) — in that rarer case, teardown
  // may still stop a container this run didn't start; accepted since the
  // common case (this run did start it) is what matters for CI hygiene, and a
  // local dev re-running the suite against already-up containers is expected
  // to just restart them next time.
  const needPostgres = !process.env.CI;
  const needRuntime = runtimeMode === 'docker';
  console.log(
    `Integration test global teardown: needPostgres=${needPostgres} needRuntime=${needRuntime} (CI=${Boolean(process.env.CI)}, runtimeMode=${runtimeMode})`
  );

  if (!process.env.KEEP_TEST_DB && (needPostgres || needRuntime)) {
    try {
      execSync(stopCommand(needPostgres, needRuntime), {
        stdio: 'inherit',
        cwd: process.cwd()
      });
    } catch {
      console.warn('Could not stop docker compose containers.');
    }
  }

  console.log('Integration test global teardown complete.');
}
