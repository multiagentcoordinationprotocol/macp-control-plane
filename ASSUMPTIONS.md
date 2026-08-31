# ASSUMPTIONS

Entries are logged by `/implement` as phases land, and closed out by `/reconcile`.

## P1 — live pagination spec is a manual harness, not a CI regression test
- **Plan:** `plans/absorb-runtime-v0.7.0.md` (Phase 1)
- **Assumed:** It is acceptable that `test/integration/list-sessions-pagination.integration.spec.ts`
  runs only when an operator points it at a real runtime that someone has seeded with >100 open
  sessions, and skips silently otherwise.
- **Chose:** Gate it on `INTEGRATION_RUNTIME != mock` and fail loudly (never skip, never vacuously
  pass) when the store is too small. CI pins `mock` (`.github/workflows/ci.yml:132`) so it always
  skips there.
- **Alternatives:** (a) Have the spec seed its own sessions — rejected: seeding requires `Send`, and
  putting `Send`-capable code in this repo would undermine the observer invariant even in `test/`.
  (b) Stand up a dedicated seeded runtime in CI — rejected as out of scope for this absorption.
- **Blast radius if wrong:** The multi-page drain silently loses live coverage as seeded sessions
  expire and are evicted; the spec becomes red-by-default for anyone who did not seed. Cheap to
  reverse (it is one gated spec).
- **Status:** UNCONFIRMED

## P1 — `workflow_dispatch` with `runtime_mode: docker` will now fail
- **Plan:** `plans/absorb-runtime-v0.7.0.md` (Phase 1, AC5)
- **Assumed:** The gate should match `test-app.ts`'s "anything but `mock` is real" rule rather than
  allowlisting `remote`.
- **Chose:** "not mock", because an allowlist lets a value like `REMOTE` boot the real provider while
  the spec silently skips — a false-negative with no signal. The cost is that a *manual*
  `workflow_dispatch` of `integration-tests.yml` with `runtime_mode: docker` starts an ephemeral
  runtime with 0 sessions and this spec fails loudly there.
- **Alternatives:** Allowlist `remote` only — rejected: reintroduces the silent-skip mismatch the
  verifier caught.
- **Blast radius if wrong:** One manual workflow path goes red until either the spec is excluded
  from `docker` mode or that job seeds sessions. Automatic CI is unaffected.
- **Status:** UNCONFIRMED

## P1 — host Docker/Postgres left unrepaired
- **Plan:** `plans/absorb-runtime-v0.7.0.md` (Phase 1)
- **Assumed:** Repairing this machine's corrupted Docker storage / hung test Postgres (5433) is out
  of scope and potentially destructive.
- **Chose:** Leave it alone; make the new spec DB-free so it runs regardless. `npm run test:integration`
  still cannot complete on this host because `test/setup/global-setup.ts` blocks on Postgres.
- **Alternatives:** `docker system prune` / recreating volumes — rejected: destroys unrelated state
  the user may need, without being asked.
- **Blast radius if wrong:** The rest of the integration suite (21 specs) remains unrunnable locally,
  so later phases' integration coverage may go unverified on this machine and must be checked in CI.
- **Status:** UNCONFIRMED

## P1 — live spec runs bypass the integration globalSetup
- **Plan:** `plans/absorb-runtime-v0.7.0.md` (Phase 1)
- **Assumed:** Running the live pagination spec through a jest config that omits
  `globalSetup`/`globalTeardown` is a legitimate way to execute it, rather than a way of
  dodging a real failure.
- **Chose:** Do exactly that. The spec is DB-free by design (it constructs
  `RustRuntimeProvider` directly instead of booting the app), so `test/setup/global-setup.ts:38-47`
  — which waits on Postgres 5433 — is the *only* thing blocking it, and that wait is
  unrelated to anything the spec asserts. Every assertion still runs against a real
  macp-runtime v0.7.0.
- **Alternatives:** Wait for the host's Postgres/Docker to be repaired — rejected: it would
  block the phase indefinitely on an unrelated infrastructure fault. Fake a pass — never.
- **Blast radius if wrong:** If the spec ever acquires a genuine DB dependency, the bypass
  would silently skip setup it actually needs. Guard: the spec must stay DB-free; if that
  changes, this bypass must be removed. `npm run test:integration` on a healthy host runs
  it normally with no bypass.
- **Status:** UNCONFIRMED
