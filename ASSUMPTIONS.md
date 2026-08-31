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

## P2 — `listSessions()` returns a result object instead of a bare array
- **Plan:** `plans/absorb-runtime-v0.7.0.md` (Phase 2)
- **Assumed:** Changing a `RuntimeProvider` interface method's return type is acceptable now
  because `listSessions()` has **zero production callers** — independently verified twice
  (repo-wide grep finds only the interface declaration, the two implementations, their specs,
  the config knobs, the metrics and the docs; `SessionDiscoveryService` uses `WatchSessions`
  exclusively).
- **Chose:** `RuntimeListSessionsResult { sessions, complete, pagesFetched }`. A truncated
  drain is now labeled rather than indistinguishable from a complete one. Rejected: throwing
  on truncation (makes the method useless at exactly the scale it exists for — an observer UI
  can usefully render "showing first N"), and keeping the bare array plus a louder log (a log
  is not reachable by the caller, which *is* the defect).
- **Alternatives:** Defer the signature change until a caller exists — rejected: every later
  phase touching this file widens the blast radius and the rebase surface. This is the
  cheapest moment it will ever be.
- **Blast radius if wrong:** Two implementations and their specs. No production behavior
  changes today because nothing calls it.
- **Status:** UNCONFIRMED

## P2 — page size defaults to 200, not the runtime's max of 1000
- **Plan:** `plans/absorb-runtime-v0.7.0.md` (Phase 2)
- **Assumed:** A 1000-item page can approach grpc-js's default 4 MB
  `max_receive_message_length`, because the gRPC client is constructed with no channel options
  and `SessionMetadata` carries repeated participants/activities/extension keys (up to 1000
  participants per session).
- **Chose:** Default `RUNTIME_LIST_SESSIONS_PAGE_SIZE=200`, which keeps a worst-case page well
  under the limit while still halving round-trips versus the server default of 100. This is a
  reasoned bound, **not** measured against a real 1000-participant session.
- **Alternatives:** Raise `grpc.max_receive_message_length` explicitly on the client (the
  root-cause fix) — deliberately deferred: it changes receive behavior for *every* RPC
  including the long-lived `StreamSession`, which is a bigger change than this phase's scope
  and belongs in its own phase with its own memory reasoning.
- **Blast radius if wrong:** If 200 still overflows, the halving ladder (below) recovers at
  the cost of extra round-trips; if 200 is needlessly conservative, the only cost is more
  pages.
- **Status:** UNCONFIRMED

## P2 — the RESOURCE_EXHAUSTED halving ladder is capped at 2 retries
- **Plan:** `plans/absorb-runtime-v0.7.0.md` (Phase 2)
- **Assumed:** A size-probe sequence must not be able to trip the **shared** circuit breaker.
  Verified empirically by the phase verifier: the original unbounded ladder (200→…→1, 8
  attempts) opened a default-threshold-5 breaker on attempt 5, which both aborted the drain
  with the wrong error and disabled every unrelated runtime RPC for 30s.
- **Chose:** `MAX_PAGE_SIZE_HALVINGS = 2` (3 attempts total), deliberately below the default
  `RUNTIME_CIRCUIT_BREAKER_THRESHOLD` of 5, with a regression test that runs the **real**
  `CircuitBreaker` rather than stubbing `unary()`.
- **Alternatives:** Add `RESOURCE_EXHAUSTED` to the breaker's `isExpectedError` — rejected:
  the repo maps that status to `RATE_LIMITED`/429, so exempting it would globally stop a real
  backpressure signal from ever opening the breaker. Add a breaker-bypass option to `unary()`
  — rejected: weakens the protection for every caller to fix one method.
- **Blast radius if wrong:** An operator who sets `RUNTIME_CIRCUIT_BREAKER_THRESHOLD` below 3
  can still trip the breaker with this ladder. That is judged **correct** — 3 consecutive
  genuine runtime errors *should* open a threshold-2 breaker — and is documented in-code.
- **Status:** UNCONFIRMED
