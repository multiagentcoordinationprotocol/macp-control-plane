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

## P3 — post-commit metrics/publish failure now duplicates events instead of losing them
- **Plan:** `plans/absorb-runtime-v0.7.0.md` (Phase 3, divergence note 4)
- **Assumed:** It is acceptable to leave `persistRawAndCanonical` (`src/events/run-event.service.ts`)
  committing its drizzle transaction (raw + canonical rows + projection) and only *then* calling
  `metricsService.recordEvents` and `streamHub.publishEvent`/`publishSnapshot` outside that
  transaction, rather than restructuring so the whole thing is atomic.
- **Chose:** Leave the ordering as-is and accept the resulting failure mode: if `recordEvents` or
  either `publish*` call throws, the promise from `persistRawAndCanonical` rejects. In
  `StreamConsumerService.handleRawEventInner` (`src/runs/stream-consumer.service.ts:379-406`) the
  `marker.envelopeOrdinal` increment and the `updateStreamCursor` persist both sit *after* that
  call resolves, so neither happens — the in-process resubscribe (and, once P4 lands, a
  cross-process restart) requests `afterSequence: marker.envelopeOrdinal` again and the runtime
  redelivers the same envelope. Verified this actually duplicates rather than getting deduped:
  `EventRepository.appendRaw`/`appendCanonical` (`src/storage/event.repository.ts`) call
  `.onConflictDoNothing()`, but the only unique indexes are `run_events_raw_run_seq_unique` and
  `run_events_canonical_run_seq_unique` on `(run_id, seq)` (`src/db/schema.ts:102,130`) — and the
  redelivered envelope gets a fresh `randomUUID()` id and a freshly-`allocateSequence`'d `seq`
  (`run-event.service.ts:117-121`), so the conflict target never matches and a second, distinct
  row is inserted. Pre-P3 the same post-commit failure instead advanced the ordinal unconditionally
  and caused silent, permanent **loss** of the envelope; duplication-over-loss is the trade this
  phase chose, matching the plan's own framing at `plans/absorb-runtime-v0.7.0.md:283-286` and
  `:396-397,410`.
- **Alternatives:** (a) Move `metricsService.recordEvents`/`streamHub.publish*` inside the
  transaction callback — rejected: couples row durability to a metrics-backend or in-memory
  StreamHub failure (an unrelated subsystem outage would roll back durable event persistence) and
  lengthens the transaction. G2's regression test
  (`src/events/run-event.service.spec.ts`, `persistRawAndCanonical` describe block) now fails if
  this is done. (b) Decouple the ordinal/cursor advance from metrics+publish success — i.e. advance
  once the transaction commits, and let a metrics/publish failure only log rather than block
  redelivery — judged out of scope for this phase: it removes the automatic retry that currently
  makes a transient metrics-backend blip self-healing, and was not attempted here.
- **Blast radius if wrong:** Confirmed by reading the code (not guessed): both
  `MetricsService.recordEvents` (`src/metrics/metrics.service.ts:118-139`, unconditional
  `eventCount += 1` etc. per event, no id-based dedup) and `ProjectionService.applyEvents`
  (`src/projection/projection.service.ts:93-105`, unconditional `timeline.totalEvents += 1` per
  event, no id-based dedup) would double-count a redelivered duplicate if they are re-invoked for
  it — i.e. `run_metrics` counters (`eventCount`, `messageCount`, `signalCount`, token/cost totals)
  and `run_projections.timeline` inflate for the affected run, and any dashboard/export aggregate
  built from those tables inherits the inflation. What this analysis could **not** cheaply confirm:
  whether metrics specifically double-counts in the exact failure ordering exercised by this path
  (if `recordEvents` itself is the call that throws, its own write may not have landed the first
  time, so the redelivery's successful `recordEvents` call could be the *only* one that counts that
  batch — the double-count risk is clearest when `publishEvent`/`publishSnapshot` is the one that
  throws *after* `recordEvents` already succeeded) — this would need a live/integration
  reproduction to pin down precisely, and none was run. Scope is one affected run per occurrence;
  this is not a systemic corruption path.
- **Caveat (raised by the phase verifier):** "the runtime redelivers" is specifically the
  **resubscribe** path (`stream-consumer.service.ts:244-256`). If `STREAM_RESUME_ENABLED=false`, or
  the stream retry budget (`STREAM_MAX_RETRIES`) is exhausted, the consumer degrades to poll-only
  (`:230,239`) instead of resubscribing — the poll path re-fetches a `getSession` snapshot, not the
  missed envelope, so in that case the envelope is **not** redelivered and the pre-P3 loss outcome
  can still occur.
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

## P4 — monotonic (GREATEST) stream-cursor persist instead of a blind set
- **Plan:** `plans/absorb-runtime-v0.7.0.md` (Phase 4)
- **Assumed:** `last_stream_cursor` and `last_envelope_ordinal` are both strictly monotonic per run
  by their own semantics (the CP seq comes from `allocateSequence`; the runtime ordinal is 1-based,
  exclusive and compaction-stable — verified in `../macp-runtime/crates/macp-storage/src/log_store.rs`),
  so flooring the write with `GREATEST` is a no-op on the happy path.
- **Chose:** Make `RuntimeSessionRepository.updateStreamCursor` monotonic in SQL. This was chosen
  over relying on the (true but incidental) proof that no envelope normalizes to zero canonical
  events: that proof rests on the normalizer and the stream consumer's increment predicate staying
  in lockstep across two separate files, and any future normalizer filter would silently break it.
  A SQL floor makes the entire clobber class structurally impossible instead.
- **Alternatives:** Persist the two columns independently (unnecessary — one monotonic write covers
  both). Remove the `lastProcessedSeq > 0` guard (buys nothing; the marker is always >0 by the first
  persist because the provider synthesizes a `stream-status: 'opened'` frame first). Fold the cursor
  write into `persistRawAndCanonical`'s transaction (larger change; deferred — see below).
- **Blast radius if wrong:** If either value were ever legitimately non-monotonic, the floor would
  silently refuse to move it backwards and the stored resume point would stick high — which is the
  *silent* failure direction (a too-high resume returns `Ok(empty)` from the runtime with no gap
  event and live envelopes still flowing). Mitigation: the values are monotonic by construction, and
  `recoverRun` already treats the cursor as a floor via `Math.max`.
- **Status:** UNCONFIRMED

## P4 — deliberate bias toward duplicate events over silent loss
- **Plan:** `plans/absorb-runtime-v0.7.0.md` (Phase 4)
- **Assumed:** Resuming too LOW (duplicates into an append-only log) is strictly preferable to
  resuming too HIGH (silent loss). Verified in the runtime: `get_incoming_after` returns `Ok(empty)`
  for both an out-of-range ordinal and a missing/evicted log, and the live broadcast is attached
  before replay — so a too-high resume has **no observable symptom even in principle**.
- **Chose:** Bias the design toward too-low everywhere (the `GREATEST` floor, seeding the ordinal on
  every recovery path). Duplicates are at least detectable after the fact — duplicate `messageId`s in
  the raw log, inflated `run_metrics` and `timeline.totalEvents` — and this matches the choice
  already made in P3 (duplication over loss).
- **Alternatives:** Add message-id dedup so a resume-from-0 is safe — rejected as a much larger
  change (new index, new column, ingest-path rewrite) that this absorption does not need; the
  ordinal path is what the runtime's B2 contract was designed for.
- **Blast radius if wrong:** Duplicate canonical/raw rows inflate per-run aggregates. Not cleanly
  reversible per-run.
- **Status:** UNCONFIRMED

## P4 — cursor write remains outside the persist transaction
- **Plan:** `plans/absorb-runtime-v0.7.0.md` (Phase 4)
- **Assumed:** A crash in the window between `persistRawAndCanonical`'s commit and the
  `updateStreamCursor` write lags the stored ordinal by exactly 1, causing exactly one duplicated
  envelope on restart.
- **Chose:** Leave it. Folding a `runtime_sessions` update into the hot-path event transaction is a
  larger change than Phase 4 needs, and the failure is bounded at one envelope and lands on the
  preferred (duplicate, not loss) side.
- **Alternatives:** Move the cursor write inside the transaction — deferred, not rejected on merit.
- **Blast radius if wrong:** One duplicate envelope per crash in a narrow window. **Consequence for
  P5:** its exactly-once assertion must target a *clean* stream break; a `kill -9` mid-persist can
  legitimately produce one duplicate and the live test must not be written to flake on that.
- **Status:** UNCONFIRMED

## P4 — legacy `last_envelope_ordinal = 0` rows are seeded as-is, not reconstructed
- **Plan:** `plans/absorb-runtime-v0.7.0.md` (Phase 4)
- **Assumed:** Production databases already contain `runtime_sessions` rows whose
  `last_envelope_ordinal` was clobbered to 0 by a pre-P4 restart (pre-P4 `recoverRun` seeded the
  marker at 0 and the blind `.set()` wrote it back). After this phase deploys, the **first** restart
  while such a run is still active resubscribes with `afterSequence: 0` — which the runtime accepts
  as legitimate, being indistinguishable from a fresh run — and replays the whole session history as
  duplicate rows.
- **Chose:** Seed them as-is and **document the exposure** rather than reconstruct the ordinal.
  Rejected the obvious reconstruction — flooring the seed with
  `count(*) FROM run_events_raw WHERE run_id = ? AND kind = 'stream-envelope'` — because that count
  includes any duplicate rows already written (by the P3 post-commit window, or by an earlier
  re-ingest), so it can **overshoot** the true delivered ordinal. Overshooting resumes too high,
  and a too-high resume is the one failure this phase exists to prevent: the runtime returns
  `Ok(empty)` and attaches the live broadcast anyway, so the skipped range vanishes with no error,
  no gap event, and no symptom even in principle. Trading detectable duplication for undetectable
  loss is the wrong direction, and a `count(DISTINCT message_id)` variant is a larger change than
  this phase warrants.
- **Alternatives:** A one-off backfill migration reconstructing ordinals from distinct raw
  message ids — deferred; it needs its own verification and is not required for correctness, only
  to avoid a bounded one-time duplication.
- **Blast radius if wrong:** Bounded to runs that are (a) active across the deploy boundary **and**
  (b) had already survived at least one restart. Those re-ingest their history once, inflating
  `run_metrics` and `timeline.totalEvents` for the affected runs. Lands on the detectable side of
  the deliberate duplicate-over-loss bias. Steady state is unaffected — the `GREATEST` floor plus
  seeding means the clobber cannot recur after this deploys.
- **Status:** UNCONFIRMED

## P5 — inline compacted-history detection matches on message text
- **Plan:** `plans/absorb-runtime-v0.7.0.md` (Phase 4/5)
- **Assumed:** There is no machine-readable way to identify a compacted-history rejection on the
  stream. The runtime builds the inline frame with `code: status.message().to_string()`
  (`../macp-runtime/src/server.rs:608-628`), so `code` carries the prose message, not a status
  name — and `FailedPrecondition` is deliberately absent from `is_stream_terminal_error`
  (`:745-755`), so it never arrives as a typed gRPC status either.
- **Chose:** Reuse the existing `isCompactedHistoryError` predicate, which matches `/compact/i`
  against the message text (live text: `session history before ordinal N was compacted; resume
  with after_sequence >= N or re-read state via GetSession`), and comment the fragility at both
  the call site and the predicate.
- **Alternatives:** Ask upstream for a stable machine-readable code on inline frames — the right
  long-term fix, but it needs a runtime change and this absorption cannot block on one.
- **Blast radius if wrong:** If the runtime reworks that string, detection silently stops matching
  and the gap path goes quiet again — back to an open stream that replayed nothing. The live spec
  `test/integration/stream-resume-live.integration.spec.ts` asserts the end-to-end behavior against
  a real runtime, so it fails loudly if the contract drifts — but only when run against a live
  runtime, which CI does not do (CI pins `INTEGRATION_RUNTIME=mock`).
- **Status:** UNCONFIRMED

## P5 — full integration suite under a live runtime needs per-spec auth
- **Plan:** `plans/absorb-runtime-v0.7.0.md` (Phase 5)
- **Assumed:** Running the *entire* integration suite with `INTEGRATION_RUNTIME=remote` against an
  auth-configured runtime fails 8 unrelated suites with `UNAUTHENTICATED`, because those specs were
  written for a dev-mode runtime that accepts any bearer, while only the new live spec knows to set
  `RUNTIME_BEARER_TOKEN` to a configured observer token.
- **Chose:** Leave those specs alone. They are green in their intended mode (`INTEGRATION_RUNTIME=mock`,
  which is what CI pins), and the failure is an environment mismatch, not a regression — verified by
  running the full suite in mock mode (21 suites / 103 tests green) after the change.
- **Alternatives:** Teach every integration spec to resolve a configured token — real work, and it
  belongs with a decision about whether the live suite should run in CI at all, not with this phase.
- **Blast radius if wrong:** Anyone running the whole suite against a live auth-configured runtime
  sees 8 confusing failures. Documented here and in the live spec's header.
- **Status:** UNCONFIRMED
