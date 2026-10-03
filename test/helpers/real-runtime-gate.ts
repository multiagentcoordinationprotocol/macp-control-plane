/**
 * Gate for specs that must run ONLY against a real macp-runtime, never the
 * mock. This is the inverse of the gate every other integration spec uses
 * (e.g. `test/integration/stream-gap.integration.spec.ts`, which does
 * `isRealRuntime ? describe.skip : describe` — skip when real, because that
 * spec depends on `ScriptedMockRuntimeProvider` scripting). Specs that
 * instead need to observe genuine runtime wire behavior (e.g. multi-page
 * `ListSessions` pagination) need the opposite: run only when
 * `INTEGRATION_RUNTIME` selects a real gRPC runtime, skip under the default
 * mock so `npm run test:integration` stays green with no runtime running.
 *
 * IMPORTANT — this polarity MUST match `test/helpers/test-app.ts:68`
 * (`const runtimeMode = (process.env.INTEGRATION_RUNTIME ?? 'mock') as ...`)
 * and `test/helpers/runtime-kind.ts` (`mode === 'mock' ? 'scripted-mock' :
 * 'rust'`): both treat *anything other than* `'mock'` as "real
 * RustRuntimeProvider connected via gRPC". Previously this file instead
 * allowlisted exactly `'docker' | 'remote'`, so a value like
 * `INTEGRATION_RUNTIME=REMOTE` (case mismatch) or any future third mode name
 * would boot the real provider in `test-app.ts` while this gate silently
 * `describe.skip`s — the spec never runs against the live runtime it thinks
 * it's skipping, with no failure to signal the mismatch. Keep this as
 * "not mock" (case-insensitively), not an allowlist, so the two helpers agree on
 * every value that differs only by the mode NAME. (They are not identical: this
 * gate lowercases, while `test-app.ts` and `runtime-kind.ts` compare
 * case-sensitively, so `INTEGRATION_RUNTIME=MOCK` boots the real provider while
 * this gate skips. That direction is safe — a skip, never a false run — but it
 * is a real residual difference, not a guarantee of equivalence.)
 */
export const isRealRuntime = (process.env.INTEGRATION_RUNTIME ?? 'mock').toLowerCase() !== 'mock';

/**
 * `describe` that runs only when a real runtime is configured, and
 * `describe.skip`s (not fails) otherwise — so the suite is green by default
 * and operators opt in with `INTEGRATION_RUNTIME=remote npm run test:integration`.
 */
export const describeWithRealRuntime: jest.Describe = isRealRuntime ? describe : describe.skip;

/**
 * Why a spec that needs a hand-managed LOCAL runtime (configured auth-tokens
 * file + a binary the spec can SIGINT and relaunch) cannot run here, or
 * `undefined` when it can. The compose runtime (`INTEGRATION_RUNTIME=docker`)
 * runs in dev-auth mode, where the bearer string itself becomes the sender, so
 * per-agent token identities cannot exist, and its port is owned by Docker's
 * forwarder rather than the runtime process. Requires:
 *   INTEGRATION_RUNTIME=remote
 *   MACP_RUNTIME_AUTH_TOKENS_FILE=<existing tokens file>
 *   a runtime binary at $MACP_RUNTIME_DIR/target/debug/macp-runtime
 */
export function localRuntimeSkipReason(): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  if (!isRealRuntime) return 'INTEGRATION_RUNTIME is mock';
  if ((process.env.INTEGRATION_RUNTIME ?? '').toLowerCase() !== 'remote') {
    return 'needs INTEGRATION_RUNTIME=remote (a restartable local runtime), not the docker-compose runtime';
  }
  const tokensFile = process.env.MACP_RUNTIME_AUTH_TOKENS_FILE;
  if (!tokensFile || !fs.existsSync(tokensFile)) {
    return 'needs MACP_RUNTIME_AUTH_TOKENS_FILE pointing at an existing auth-tokens file';
  }
  const runtimeDir = process.env.MACP_RUNTIME_DIR ?? path.resolve(__dirname, '../../../macp-runtime');
  if (!fs.existsSync(path.join(runtimeDir, 'target/debug/macp-runtime'))) {
    return `needs a built runtime binary at ${runtimeDir}/target/debug/macp-runtime`;
  }
  return undefined;
}

const localRuntimeReason = localRuntimeSkipReason();
if (isRealRuntime && localRuntimeReason) {
  // eslint-disable-next-line no-console
  console.warn(`[real-runtime-gate] local-runtime specs skipped: ${localRuntimeReason}`);
}

/** `describe` for specs that need the hand-managed local runtime above; `describe.skip` otherwise. */
export const describeWithLocalRuntime: jest.Describe = localRuntimeReason ? describe.skip : describe;
