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
