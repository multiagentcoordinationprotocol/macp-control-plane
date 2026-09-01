# PROGRESS — absorb-runtime-v0.7.0

Plan: `plans/absorb-runtime-v0.7.0.md`
Started: 2026-08-31 (via `/drive`)

## Phase log

_(one checkpoint per phase; `/implement` appends)_

| Phase | Status | Rounds | Verifier | Commit | PR |
|---|---|---|---|---|---|
| P1 live harness + ListSessions ground truth | **DONE** | 3 (GAPS→GAPS→PASS) | Opus | `716fa9b` | **merged #61** |
| P2 truth-in-contract for `listSessions` | **DONE** | 2 (GAPS→PASS) + ship-gate 1 (GAPS→fixed) | Opus | `f6702e2` | **merged #62** |
| P3 ordinal correctness + invariant-6 comments | **DONE** | 1 (PASS + 4 findings closed) | Opus | (head of `absorb-runtime-v0.7.0-p3`) | — |
| P4 cross-process envelope-ordinal resume | **DONE** | 1 (PASS) + 2 live-driven prod fixes | **Fable** (one-way door) | (head of `absorb-runtime-v0.7.0-p4`) | — |
| P5 live B2 re-verification | **DONE** | live, 3/3 criteria proven | — | (same branch — ships with P4) | — |
| P6 RFC-MACP-0013 supersedes alignment | **DONE** | 2 (GAPS→fixed) | Opus | (head of `absorb-runtime-v0.7.0-p6`) | — |
| P7 docs accuracy sweep (proto bump landed via #60) | TODO | — | — | — | — |

## Repo map (gathered during planning — do not re-scan)

> **Anchor by symbol, not by line.** Line numbers below are correct as of the P3 merge but rot
> every time a phase inserts code — this map has already been wrong twice (P2 shifted the
> provider ~32 lines, P3 shifted it ~16 more). Grep for the quoted symbol; treat the `:N` as a
> hint, and re-grep before trusting it.

### Runtime / gRPC boundary
- `src/runtime/rust-runtime.provider.ts` — the gRPC provider. Grep these symbols (line hints as of P3):
  `async listSessions(` **:500** (rewritten in P2); `const MAX_PAGE_SIZE_HALVINGS` **:72**;
  `private buildCircuitBreaker(): ` **:160**; `subscribeSession(req` **:233** (handle gate in
  consumeLoop at `stream-consumer.service.ts:209`); the single passive-subscribe frame
  `grpcCall.write({` **:333**; the session filter `if (!envelope.sessionId ||` **:298** (P3 — drops
  empty/absent too); `// We deliberately do NOT half-close` **:326** and the class header comment
  **:81-87**, both correctly stating the write side is **kept open** (P3 fixed both); **no `.end()`
  anywhere in this file**; `private async unary(` **:882** (already took an optional
  `GrpcCallOptions` on `main` — P2 did **not** change its signature); `keepCase: false` **:134**.
- `src/contracts/runtime.ts` — `RuntimeProvider` interface. `listSessions` declared **:279**, returning `RuntimeListSessionsResult` (**:107-112**); the false "fully drains" comment was corrected in P2. Policy types from **:300**.
- `src/runtime/proto-registry.service.ts` — `MESSAGE_TYPE_MAP` at **:5-47** (`Commitment → macp.v1.CommitmentPayload` at :8); loads 8 protos at **:65-83** via raw protobufjs; `decodeMessage` at **:155-161**.
- `src/runtime/observer-invariant.spec.ts` — grep-based invariant lint (90 lines). Forbidden patterns **:13-38**; walks `src/` at **:40-52**; comment stripping **:66-77**. **Must not be weakened.**
- `src/runtime/rust-runtime.provider.spec.ts` — frame-semantics tests **:103-233** (`.end()` not called asserted at **:126**, again at **:177**); pagination/bounds tests **:235-460**; the real-`CircuitBreaker` RESOURCE_EXHAUSTED-ladder regression test **:462+**. **Stale file-doc comment at :11-12.**
- `src/runtime/runtime-credential-resolver.service.ts` — JWT mint → static bearer → dev bearer (**:53-58**).

### Stream / run orchestration
- `src/runs/stream-consumer.service.ts` — the per-session consume loop. Grep these symbols
  (line hints as of P3): `resumeFromEnvelopeOrdinal` param **:74**, consumed **:84**;
  `emitStreamGap` **:160-181**; the compacted-error classifier **:150-153**; resubscribe-with-ordinal
  **:245-249**; `persistRawAndCanonical(runId` **:380**; `marker.envelopeOrdinal += 1` **:405**
  (P3 moved it to **after** the persist); `updateStreamCursor(` **:415** — still guarded by
  `lastProcessedSeq > 0`, which can make the persisted ordinal **LAG**; that guard is P4's hazard,
  and P4 should grep `updateStreamCursor` rather than trust this number. No message-id dedup.
- `src/runs/run-executor.service.ts` — first subscribe (no `afterSequence`) at **:348**, **:353**.
- `src/runs/session-discovery.service.ts` — `WatchSessions` only, never `listSessions`. Loop **:52-67**, dispatch **:73-92**, subscribe **:138-143**. Unbounded `knownSessions` Set at **:22**.
- `src/runs/run-recovery.service.ts` — calls `streamConsumer.start({...})` at **:123-131** with `pollOnly: true` at **:130**, NO `sessionHandle`, and NO `RuntimeProviderRegistry` in its constructor (**:16-24**) — P4 must inject the registry and subscribe; computes `resumeFromSeq` from `lastStreamCursor` at **:121**. **This is where P4 wires the ordinal.**
- `src/runs/signal-consumer.service.ts` — ambient `WatchSignals`; does **not** touch the envelope ordinal.

### Events / projection
- `src/events/event-normalizer.service.ts` — `Commitment → decision.finalized` at **:401**; attaches whole decoded payload as `data.decodedPayload`.
- `src/projection/projection.service.ts` — `decision.finalized` reducer **:413-450** (`extractSupersedes` called **:426**, spread **:438**); `extractSupersedes` **:716-723**; `historyGap` set **:173-177**.
- `src/contracts/control-plane.ts` — `CommitmentSupersedes` **:284-287**; `decision.current.supersedes` **:301-302**; `historyGap` **:245**.

### Storage / config / telemetry
- `src/db/schema.ts` — `lastEnvelopeOrdinal` **:71**; `lastStreamCursor` **:65**; canonical-event unique key `(run_id, seq)` **:102**.
- `src/storage/runtime-session.repository.ts` — `updateStreamCursor(runId, cursor, envelopeOrdinal?)` **:47-59**.
- `src/config/app-config.service.ts` — the **only** place `process.env` may be read. `runtimeRequestTimeoutMs` **:71**; `streamResumeEnabled` **:127**. New list-sessions knobs go here.
- `src/telemetry/instrumentation.service.ts` — the **only** place Prometheus metrics may be constructed (17 fields, **:6-100**; `streamResumeGapTotal` **:87** is the pattern to mirror).
- `src/errors/error-codes.ts` — flat string enum **:1-30**.
- `src/errors/app-exception.ts` — **:4-26**.

### Tests
- Unit: `jest.config.ts`, `rootDir: src`, colocated `*.spec.ts`. `npm test`.
- Integration: `test/integration/*.integration.spec.ts` (21 files), `test/jest.integration.config.ts`, Postgres on **5433**, `maxWorkers: 1`, 60s timeout.
- `test/helpers/test-app.ts` — `INTEGRATION_RUNTIME` read at **:68**; mock override **:106-108** *and* registry register **:112** (both needed); real-runtime address **:87**.
- `test/helpers/scripted-mock-runtime.provider.ts` — the only mock. `listSessions` stub returns `{sessions: [], complete: true, pagesFetched: 0}` at **:333**; re-implements the `after_sequence` skip rule at **:150-161** (so resume tests validate the CP against the CP's own model, not the runtime).
- `test/integration/stream-gap.integration.spec.ts` — gap path, mock-only, skipped when `INTEGRATION_RUNTIME` is docker/remote.
- `src/runs/stream-consumer.service.spec.ts:338-484` — the 4 ordinal/resume unit tests.
- `src/projection/projection.service.spec.ts:436-468` — the supersedes tests.

### Upstream (read-only reference)
- Runtime binary: `../macp-runtime/target/debug/macp-runtime` (v0.7.0, boots).
  `MACP_ALLOW_INSECURE=1 MACP_BIND_ADDR=127.0.0.1:50051 ./target/debug/macp-runtime`
- `../macp-runtime/.macp-data/sessions/` — 131 persisted sessions, but **ALL are terminal and are evicted at startup**
  (`evicted stale sessions from memory ... count=131`, eviction logic `../macp-runtime/src/runtime.rs:1200-1237`).
  They are invisible to `ListSessions`/`GetSession`. **Live open sessions must be seeded** for any pagination test.
- `../macp-runtime/src/server.rs:1275-1345` — `list_sessions` handler.
- `../macp-runtime/src/pagination.rs` — opaque `base64url("v1:" + last_id)` token, max 1024 chars.
- `../macp-runtime/crates/macp-auth/src/security.rs:53-58` — page-size default 100 / max 1000.
- `../macp-runtime/crates/macp-modes/src/mode/util.rs:44-91` — the tightened supersedes check.
- `../macp-runtime/crates/macp-core/src/commitment_hash.rs:44` — `commitment_hash()`, **zero production callers**.
- `../macp-runtime/docs/change-review-phases-a-e.md:248-250, 619-623` — the two passages naming this repo.

## Phase checkpoints

### P1 — DONE (2026-08-31)
- **Verdict:** PASS. Rounds: **implement-gate** round 1 GAPS (state leak via `createTestApp`;
  vacuous-green empty-string env; false "131 sessions suffice" claim; gate polarity mismatch) →
  round 2 PASS. **ship-gate** round 1 GAPS (plan self-contradiction on whether the committed spec
  ran; five stale proto-0.1.9 claims after PR #60 landed on main; header status; stale commit SHA;
  P6 AC3 contradiction; pre-P2 page-size false-green) → round 2 GAPS (P7 body still instructed
  performing the already-done bump) → round 3 PASS.
- **Verifier tier:** Opus (test+docs only, no one-way door — Fable not warranted).
- **Files:** `test/integration/list-sessions-pagination.integration.spec.ts` (new),
  `test/helpers/real-runtime-gate.ts` (new), `docs/TROUBLESHOOTING.md`, `.gitignore`,
  `plans/absorb-runtime-v0.7.0.md` (§7 evidence), `PROGRESS.md`, `ASSUMPTIONS.md`.
- **Commit:** single squashed commit at the head of `absorb-runtime-v0.7.0`, rebased onto
  `origin/main` @ `0b5ceab`. (Deliberately not citing a SHA here — the file is inside the commit,
  so any SHA written into it is invalidated by the amend that writes it.) **PR:** shipping independently, per the verifier's explicit call — zero
  production code, CI pins `mock` so the new spec skips there, and `deploy.yml` is
  `workflow_dispatch`-only so a merge triggers no deployment.
- **Live-verified:** multi-page drain, non-empty then empty token, uniqueness, ascending order,
  CP's own `listSessions()`, spec passes remote / skips mock.
- **Blocked:** `npm run test:integration` cannot complete on this host (corrupted Docker storage;
  Postgres 5433 accepts TCP but hangs). Not repaired — see `ASSUMPTIONS.md`.
- **PR:** #61 — https://github.com/multiagentcoordinationprotocol/macp-control-plane/pull/61
  — all CI green (test, typecheck, lint, build, audit, conventions, CodeQL, docker,
  **integration-test**), squash-merged as `716fa9b`. Note `integration-test` passed in CI,
  where Postgres works — the blocker is local-only.
- **Next:** P2 (truth-in-contract `listSessions`), on branch `absorb-runtime-v0.7.0-p2`.

### P2 — DONE (2026-08-31)
- **Verdict:** PASS. Rounds: round 1 **GAPS** (6 items) → round 2 **PASS**.
- **Verifier tier:** Opus both rounds (no one-way door — the interface change has zero
  production callers, independently verified twice, so it is cheaply reversible).
- **Round 1 gap summary:** (1) the RESOURCE_EXHAUSTED page-size-halving ladder ran up to 8
  consecutive attempts through the **shared** circuit breaker (default threshold 5), tripping
  it OPEN on attempt 5 and disabling every unrelated runtime RPC for 30s — with zero coverage,
  because every existing test stubbed `unary()` and bypassed the breaker; (2) a mid-page
  `DEADLINE_EXCEEDED` from the CP's own clamped deadline discarded all collected pages,
  breaking AC3; (3) `RUNTIME_LIST_SESSIONS_TIMEOUT_MS` had no startup validation, so `0` (or a
  blank `.env` entry) yielded a permanently empty result with zero RPCs; (4) "positive integer"
  was only enforced as `> 0`, admitting floats into a proto `int32`; (5) `docs/TROUBLESHOOTING.md`
  stale and actively misleading post-P2; (6) the plan's AC6 wording was factually false.
- **Round 2:** all six CLOSED. The re-verifier proved the new GAP-1 regression test is
  discriminating by raising `MAX_PAGE_SIZE_HALVINGS` back to 8 and confirming it fails with
  5 client calls and the breaker OPEN, then restoring the file.
- **Notable non-finding:** the `isResourceExhausted` predicate was suspected of matching only a
  raw grpc error rather than the post-`mapGrpcError` `AppException`. Verified correct — the real
  thrown error carries `.metadata.grpcCode`, which is exactly the first arm of the predicate.
- **Files:** `src/contracts/runtime.ts`, `src/runtime/rust-runtime.provider.ts`(+spec),
  `src/config/app-config.service.ts`(+spec), `src/telemetry/instrumentation.service.ts`(+spec),
  `test/helpers/scripted-mock-runtime.provider.ts`,
  `test/integration/list-sessions-pagination.integration.spec.ts`, `.env.example`,
  `docs/INTEGRATION.md`, `docs/TROUBLESHOOTING.md`, `CLAUDE.md` (untracked — gitignored at
  `.gitignore:11`, so its env-table update does not ship; `docs/INTEGRATION.md` is the tracked
  equivalent), plus `plans/`, `PROGRESS.md`, `ASSUMPTIONS.md`.
- **Tests:** 55 suites / **752** tests green (from 725 at P1). Lint, build, and both tsc
  projects clean. `observer-invariant.spec.ts` untouched, 4/4.
- **Live-verified** against a real macp-runtime v0.7.0 on `127.0.0.1:50051`: multi-page drain
  with `pagesFetched > 1` and `complete === true`, unique + ascending IDs; skips correctly under
  `INTEGRATION_RUNTIME=mock`. Re-run *after* the gap fixes, not only before.
- **Static-only (not live-verified):** the RESOURCE_EXHAUSTED halving ladder and the mid-page
  timeout conversion — both are unit-tested (the ladder against the real `CircuitBreaker`), but
  no live runtime was made to emit either condition.
- **Blocked:** `npm run test:integration` still cannot complete on this host (corrupted Docker
  storage; Postgres 5433 hangs). Live specs were run through an equivalent config with a no-op
  globalSetup — see `ASSUMPTIONS.md`. CI runs the suite normally.
- **Next:** ship P2 as its own PR (both verifiers called it independently shippable — a
  signature change is cheapest to land before P3–P7 pile onto the same files), then P3.

### P3 — DONE (2026-08-31)
- **Verdict:** PASS on all 5 acceptance criteria, first round, plus 4 non-blocking findings
  which were closed rather than shipped.
- **Verifier tier:** Opus (no one-way door — comment/filter/ordering changes, all reversible).
- **What landed:** (a) the envelope ordinal now increments *after* a successful persist, so a
  mid-stream persist failure no longer leaves the in-memory marker ahead of what was written —
  pre-fix, the resubscribe skipped the failed envelope permanently, with no gap event and no way
  to detect it; (b) the per-session `StreamSession` filter now drops empty/absent-`sessionId`
  envelopes (the old `envelope.sessionId &&` short-circuit let them through to be yielded *and*
  to advance the ordinal), logged at `warn`; (c) three false comments corrected.
- **The log-flood concern I raised was disproven with evidence**, not waved off: the runtime's
  stream bus is strictly per-session and empty-`session_id` envelopes cannot be published to it,
  so both new branches are unreachable against a conforming runtime and `warn` is the correct
  level. Downgrading it would suppress a signal that should never fire even once.
- **Ambient-signal scoping verified independently:** the drop is confined to
  `subscribeSession()`'s data handler and cannot reach `fromEnvelope()` or `watchSignals()`.
  This mattered — ambient Signal envelopes *always* carry an empty `sessionId` and correlate via
  `correlation_session_id`, so lifting the filter into shared code would have silently killed
  all token-usage and cost accounting. Guarded by a new regression test.
- **Tests:** 55 suites / **757** (from 752 at P2). The verifier mutation-tested the new specs —
  reverting the source while keeping the tests fails 3 of 4, so they are genuine regression
  tests rather than tests written to fit the code.
- **Live-verified:** nothing new in this phase — it is unit-level only. The runtime-side claims
  (per-session bus, empty-`session_id` impossible on `StreamSession`) were verified by **reading
  `../macp-runtime` source**, not by observing a live runtime.
- **Ship gate:** 1 round, **GAPS** — 3 items, none in `src/` behavior: (G1) the `PROGRESS.md` repo
  map carried false line references *again*, including `:393` for the ordinal increment (actually
  `:405`) — the exact pointer P4 follows. Rather than patch the numbers a third time, the map is
  now **anchored on greppable symbols** with line numbers demoted to hints. (G2) the new
  post-commit test asserted "the transaction already committed" but the mocked `db.transaction`
  had no commit semantics — the gate proved it by mutation (moving metrics/publish *inside* the
  transaction still passed). (G3) the newly-accepted duplicate-append failure mode was missing
  from `ASSUMPTIONS.md`. All three closed before merge.
- **Next:** P4 (cross-process envelope-ordinal resume) — the plan's riskiest phase. Note the
  `lastProcessedSeq > 0` guard on `updateStreamCursor` can make the *persisted* ordinal lag; that
  is P4's central hazard.

### P4 + P5 — DONE (2026-08-31), shipping together

**Why together:** Fable's one-way-door analysis rejected both hedges — reordering P5 first is
incoherent (its cross-restart assertion *exercises* P4's code), and flipping the
`STREAM_RESUME_ENABLED` default to false would regress the already-shipped in-process resume for
everyone to de-risk an unshipped feature. So P4 merges only with P5's live evidence attached.

**P4 verdict:** PASS from **Fable** (one-way door: changes production restart behavior by default;
failure modes are duplicate or silently-lost events in an append-only log with no message-id dedup).
Fable verified by execution, not inspection: it rendered the actual SQL to confirm the column
interpolates as a real column reference rather than a stale bound parameter, checked `afterSequence`
off-by-one against the runtime's own log store, and mutation-tested both changes (reverting the SQL
fails 3 tests, reverting the seeding fails 4, disjoint).

**What P4 actually fixed** — note the plan's stated mechanism was wrong for the *third* time in this
absorption: zero-canonical-event envelopes are unreachable (the normalizer always emits
`message.received`, and the consumer's increment predicate is its exact complement). The real bug
Fable found instead: recovery never seeded the envelope ordinal, so the marker started at 0 and the
first poll cycle blind-wrote that 0 over the stored value — `last_envelope_ordinal` was not merely
unread across restarts, it was **destroyed on every one**, and AC2 as written would have enshrined
it. Fixed with a `GREATEST` floor in SQL plus seeding on every recovery path.

**Two production bugs that only live testing could find.** This is the phase's most important
outcome and the whole justification for the runtime's change-review request:
1. **The compacted-resume safety net did not exist.** `is_stream_terminal_error`
   (`../macp-runtime/src/server.rs:745-755`) omits `FailedPrecondition`, so the runtime delivers a
   compacted-history rejection as a **non-terminal inline frame** with the stream left open — not
   the stream-ending error our README, the plan, and Fable's *static* read all assumed. Our
   detection lived only in the stream-error catch, so it never fired.
2. **Underneath that, every inline frame was silently dropped.** With `oneofs: true`, proto-loader
   sets `chunk.response` to a discriminant **string**; `chunk.response ?? chunk` therefore yielded
   `'error'` and `('error').error` was `undefined`. Envelopes survived only by an accidental
   `?? chunk.envelope` fallback. Consequence beyond this plan: the inline-error →
   `message.send_failed` path documented in `CLAUDE.md` had **never fired in production**.

   The lesson worth keeping: fix #1 was correct, unit-tested and mutation-verified, and would still
   have been inert in production because the layer beneath it discarded the input. Static reading
   (including Fable's) got #1 backwards; only real frames through the real provider found either.

**Live evidence (all against a real macp-runtime v0.7.0, independently re-run by the orchestrator,
exit 0):** exactly-once ingestion across a forced runtime restart; invariant 6 (envelopes emitted
after the subscribe frame still delivered); and the full compacted-resume path — inline frame
decoded, `session.stream.gap` emitted, projection `historyGap` set, poll-only degrade, with
`subscribeSession` called exactly `[0, 1]` and the run still reaching its true terminal state.

**Getting there required environment work the plan never anticipated**, all of it real deployment
contract for the observer role: `GetSession` requires `is_observer` (or initiator/participant);
`is_observer: true` comes **only** from a configured token, and the dev-auth path hardcodes it
`false`; a configured bearer's identity must equal every envelope's `sender`; and compaction runs
only on **terminal** sessions, reachable via the `CancelSession` **RPC** (a `SessionCancel`
envelope returns `Forbidden`). Queued for P7's docs sweep.

**Also unblocked:** the local integration suite, dead all session (corrupted Docker, hung Postgres
on 5433). Rather than `chown` the user's own Postgres data dir with sudo, stood up an isolated
throwaway cluster on port 5455 with the same Homebrew binaries and the repo's programmatic
migrator. Full suite now green locally — 21 suites / 103 tests — which also retroactively closed
Fable's one un-runnable P4 check (the `GREATEST` SQL executing against real Postgres).

**Tests:** 56 suites / **772** unit (from 757 at P3); integration 21 suites / 103 green in mock;
lint, build, both tsc projects clean; `observer-invariant.spec.ts` 4/4 and unmodified throughout.

**Ship gate (Fable):** PASS, 5 non-blocking findings. It independently grepped every proto to
confirm `StreamSessionResponse.response` is the **only** `oneof` in the package (so there is no
third instance of the decode bug in `watchSignals`/`watchSessions`), reproduced all three mutation
checks exactly, and cite-checked every runtime claim in the tracked prose against `macp-runtime`
source. It also surfaced a **new latent bug the decode fix just made reachable**: the normalizer
keys `policy.denied` enrichment on `err.code === 'POLICY_DENIED'`, but the runtime sets inline-frame
`code` to `status.message()` (`"PolicyDenied"`), so that companion event can never fire against a
real runtime. Findings recorded in `ASSUMPTIONS.md`; the stale `docs/ARCHITECTURE.md` section was
fixed in this PR since it was written here and omitted this PR's own headline finding.

**Next:** P6 (RFC-MACP-0013 supersedes) and P7 (docs sweep — now carrying the observer-auth
findings above, plus the three deferred gate findings).

### P6 — DONE (2026-08-31)
- **Verdict:** GAPS (1 blocking + 4 non-blocking) → all closed. **Verifier tier:** Opus (additive,
  reversible, no schema or behavioral change).
- **What landed:** a derived `supersedes.canonical` badge mirroring the runtime's check exactly
  (`/^sha256:[0-9a-f]{64}$/` ↔ `util.rs:76-89`, lowercase-hex only, no trim, no case-fold), with the
  tolerant passthrough preserved — non-canonical refs are still surfaced, never dropped. The CP
  observes; it does not adjudicate. `PROJECTION_SCHEMA_VERSION` deliberately **not** bumped (it is
  dual-purpose and `3` is separately hardcoded in `db/schema.ts` and `event.repository.ts`).
- **The blocking finding is the interesting one.** The troubleshooting entry — the phase's headline
  deliverable — confidently named `SESSION_POLL_TIMEOUT_MS` as the timeout operators would see. That
  variable is read only inside `pollForOpenSession`, called **once, before `bindSession`**, so it
  cannot fire for this symptom at all. The entry also claimed no terminal transition and no
  error-looking event; in fact the run reaches `failed` with `polling exhausted without terminal
  session state`, which is a red herring pointing at the stream rather than the rejected commitment.
  Rewritten around `STREAM_IDLE_TIMEOUT_MS` / `STREAM_MAX_RETRIES` and the real finalization path.
- **AC4 was also wrong and the docs record the fact instead:** the CP does not see the rejection as
  `message.send_failed` — it sees nothing, because the inline error goes only to the sender's own
  stream while the session broadcast carries accepted envelopes only. Third time this plan's
  premises have been wrong about runtime behavior; every instance was caught by source-level or
  live checking, none by tests.
- **Test hole closed:** the suite pinned the trailing `$` but not the leading `^` (dropping `^`
  passed 60/60). Leading-whitespace and leading-garbage cases now fail it — verified by mutation.
- **Tests:** 56 suites / **780** unit (from 772); integration 21 suites / 103 green; lint, build,
  both tsc projects clean; `observer-invariant.spec.ts` 4/4 and unmodified.
- **Next:** ship P6 alone (both verifiers agree it is independently shippable and P7 lists it as a
  dependency), then P7 — the docs sweep, now carrying the observer-auth contract findings and the
  three deferred ship-gate items from P4/P5.

## Assumptions / decisions log

See `ASSUMPTIONS.md` (created by `/implement` as phases land) and `plans/absorb-runtime-v0.7.0.md` §8.

PR #62 opened: https://github.com/multiagentcoordinationprotocol/macp-control-plane/pull/62 (pushed absorb-runtime-v0.7.0-p2 f2ed6be; CI all green incl. integration-test)
merged #62 as `f6702e2` — all 11 checks green (test, typecheck, lint, build, audit,
conventions, CodeQL, analyze, docker, check-env-secrets, **integration-test**).
Ship gate returned GAPS on two record-level items (docs/INTEGRATION.md documented the
pre-fix 'floor of 1' retry ladder; PROGRESS.md's repo map still pointed P3 at `:62` for a
comment that moved to `:84`). Both fixed in `1cd9800` before merge, CI re-run green.
**Next:** P3 — ordinal correctness + the two invariant-6-contradicting comments
(`rust-runtime.provider.ts:84`, `rust-runtime.provider.spec.ts:11-12`), on branch
`absorb-runtime-v0.7.0-p3`.
