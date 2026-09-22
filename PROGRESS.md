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
| P7 docs accuracy sweep (proto bump landed via #60) | **DONE** | 2 (GAPS→fixed) | Opus | (head of `absorb-runtime-v0.7.0-p7`) | — |

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

### P7 — DONE (2026-09-01) — plan COMPLETE
- **Verdict:** GAPS (**5 blocking**, 7 non-blocking) → all closed. Verifier: Opus. Docs-only diff
  (4 tracked files, +156/-2); `npm test` unchanged at 56 suites / 780 tests throughout.
- **Every blocking finding was a factually false operator-facing claim**, which for a docs phase is
  a defect, not a nit. The worst was the billed payoff of the observer-auth section: it described a
  misconfigured credential being swallowed at debug level, retried to `SESSION_POLL_TIMEOUT_MS`,
  and surfacing as a generic `RUNTIME_TIMEOUT`. The truth is the opposite *and better* —
  `mapGrpcError` maps `PERMISSION_DENIED` to an `AppException`, `pollForOpenSession:414` rethrows on
  the **first** attempt, and the run's failure reason reads `FORBIDDEN: session access denied`. The
  doc invented a debugging nightmare that does not exist and would have taught operators to
  distrust an accurate error message.
- Also corrected: `is_observer` is **not** configured-token-only (it also comes from the
  `macp_scopes` claim on a minted JWT — the repo's *preferred* auth mode, so the error pointed at
  the wrong config surface); `StreamSession` does **not** use `authenticate_session_access` (it
  authorizes inline in `process_subscribe_frame`, different denial string); and two false claims
  about what is projected for `policy.denied`.
- **Tooling trap worth remembering:** this shell's `grep` is a ugrep shim that silently skips
  gitignored paths — exactly `plans/` and `CLAUDE.md`, the files this phase audits. The verifier's
  own first sweep returned clean because it scanned nothing, and was redone with `/usr/bin/grep`.
  Second time this run a "verified by grep" claim checked empty air.

### Plan closeout
- **Merged:** #61 (P1), #62 (P2), #63 (P3), #64 (P4+P5), #65 (P6), #76 (P7). Six PRs, seven phases.
- **Reconcile:** 15 `ASSUMPTIONS.md` entries → **12 CONFIRMED, 3 NEEDS-CHANGE, 1 DEFER**; none a
  one-way door, no migration written by any phase, so every choice stays reversible. Outcomes in
  `DECISIONS.md`. Reconcile also corrected **two of my own entries**: the
  `STREAM_RESUME_ENABLED=false` gap-skip is *not* narrow (it is reachable on the normal run path
  for every run, since `run-executor.service.ts:348` subscribes independent of the flag), and the
  P3 post-commit duplication is ×(`STREAM_MAX_RETRIES`+1), not one row.
- **Nine follow-ups filed:** #67-#75.
- **Last open decision, now closed:** `ASSUMPTIONS.md` entry 16 — reconcile proposed a third
  option better than either side of the original debate (derive `canonical` at read time in
  `ProjectionService.get()`, keeping the type required and honest for legacy rows). Recorded in
  `DECISIONS.md` and **implemented** on branch `absorb-runtime-v0.7.0-canonical-derive` (PR #77):
  `deriveMissingCanonical()` backfills `canonical` on read for projections persisted before P6.
  `PROJECTION_SCHEMA_VERSION` untouched; no migration, no rebuild, no tri-state in the exported
  contract. Opus ship gate: PASS (mutation-verified in both directions).

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

## Plan closed — 2026-09-01

`plans/absorb-runtime-v0.7.0.md` is COMPLETE. Every phase merged, every reconcile entry resolved.

| PR | Phase | Merge |
|----|-------|-------|
| #61 | P1 live pagination spec | merged |
| #62 | P2 listSessions truncation visible to callers | merged `f6702e2` |
| #63 | P3 ordinal advances only after a successful persist | merged |
| #64 | P4+P5 stream resume across restart | merged |
| #65 | P6 badge non-canonical supersedes hashes | merged `43ea166` |
| #76 | P7 observer authorization contract + known limitations | merged |
| #77 | reconcile entry 16 — read-time `canonical` derive | merged `6ff0cf4` |

Also merged ahead of the phases: #60 (proto 0.1.9 bump).

Follow-ups filed rather than folded into a phase: #67-#75 (nine issues).

Final regression on `main`: 56 suites / 786 unit tests, 21 suites / 103 integration
(mock, isolated cluster), observer-invariant 4/4, lint + build + tsc clean.
The observer invariant was never weakened — `src/runtime/observer-invariant.spec.ts` is
byte-identical to its pre-plan state across all seven phases.

---

# PROGRESS — absorb-runtime-v0.8.0

Plan: `plans/absorb-runtime-v0.8.0.md`
Started: 2026-09-22 (via `/drive`)
PR strategy: one PR per phase (8 PRs), each referencing the issue(s) it closes in its
commit/PR body. Why: matches this repo's own v0.7.0 absorption precedent (PRs #61-#65,
#76-#78 — one per phase/unit), phases have no cross-phase `Depends on` edges so each is
independently reviewable, and bundling 8 unrelated fixes (CI infra, two stream-pipeline
bugs, a validation tightening, gRPC config, reliability hardening, a new integration test,
a new admin endpoint, a dependency bump) into one PR would make it unreviewable honestly.
Each PR still goes through `/ship` in full (tests → verify gate → commit → PR → CI →
merge) before the next phase starts.

Picks up the "Follow-ups filed rather than folded into a phase: #67-#75" line above —
this plan closes all nine, plus absorbs runtime v0.7.1→v0.8.0.

## Phase log

_(one checkpoint per phase; `/implement` appends)_

| Phase | Status | Rounds | Verifier | Commit | PR |
|---|---|---|---|---|---|
| P1 repoint integration harness (runtime image pin, healthcheck, CI env split, PG timeout) | DONE | 1 | Opus (fresh subagent) | `1690e7b` | merged #81 |
| P2 stream pipeline: policy.denied inline match, compacted-history regex, gap-detection ordering | DONE | 1 (implement) + 1 GAPS→closed (ship-gate) | Opus (fresh subagent, both gates) | `3188017` (squash; pre-squash branch commits `e0e431e`/`965a2bf` are unreachable once `absorb-runtime-v0.8.0-p2` is pruned) | merged #82 |
| P3 tighten schema_version pre-check | DONE | 1 (implement PASS) + 1 (ship-gate PASS) | Opus (fresh subagent, both gates) | `2ac9dc6` | merged #83 |
| P4 explicit gRPC channel options | DONE | 1 (implement PASS) + 1 (ship-gate PASS, 0 gaps) | Opus (fresh subagent, both gates) | `fe6c70d` (squash) | merged #84 |
| P5 non-blocking post-commit publish side effects | DONE | 1 (implement PASS) + 1 (ship-gate PASS, 0 gaps) | Opus (fresh subagent, both gates) | `2a6e1d2` (squash) | merged #85 |
| P6 handoff implicit-accept integration test | DONE | 2 (implement: 1 GAPS→closed + 1 re-verify PASS) | Opus (fresh subagent, both rounds) | (pending) | (none yet — ships via `/ship`) |
| P7 listSessions() admin drift-detection endpoint | TODO | — | — | — | — |
| P8 bump @multiagentcoordinationprotocol/proto to 0.1.10 | DONE (independently, PR #80, pre-dates this plan) | 0 | n/a | 23db607 (#80) | #80 (already merged) |

## Repo map

See `plans/absorb-runtime-v0.8.0.md`'s own repo-map notes inline per phase (Files/Approach
sections cite `file:line` throughout — gathered by four parallel Opus subagents this
session, each grounded in direct source reads across both `macp-control-plane` and
`macp-runtime`). Not duplicated here to avoid drift between two copies; that plan file is
the source of truth for this feature's repo map.

## Cross-repo

- `plans/cross-repo/macp-runtime-docker-tag-trigger.md` — macp-runtime's `docker.yml` tag
  trigger (`v*`) doesn't match release-plz's `macp-runtime-vX.Y.Z` tags, so no versioned
  image has published since the scheme changed. Filed as
  `multiagentcoordinationprotocol/macp-runtime#184`. Phase 1 works around it locally by
  pinning the release commit's SHA tag (`f97fd15` for v0.8.0) rather than blocking on the
  upstream fix.

## Phase checkpoints

### Preflight — 2026-09-22
No existing `absorb-runtime-v0.8.0` plan to resume; `plans/current/` empty. No `.drive.lock`
conflict — lock written. `autoCompactEnabled: true`, `autoCompactWindow: 400000` in
`~/.claude/settings.json` — no manual-compact gate needed. Working tree clean at start.

### Planning — 2026-09-22
Four parallel Opus subagents (general-purpose, `model: opus`) completed grounded analysis:
CI/integration infra; event-normalizer/stream-consumer; runtime-controller/provider/
persistence; handoff-test/listSessions. All findings cite `file:line` in both repos,
cross-verified. Notable correction to the originating research report: the
`docker-compose.test.yml` runtime bump is not a one-line tag swap — see Cross-repo above.
`plans/absorb-runtime-v0.8.0.md` written (8 phases).

### Plan review round 1 — 2026-09-22
Fresh Opus agent, full read of every cited `file:line` in both repos. **Verdict: REVISE**
— 5 blocking findings, 5 `🟠`, several `🟡`. Summary (full detail in the plan's own
"Plan review" section and §9 "Prior decisions consulted"):
- Phase 1 AC2 named `list-sessions-pagination.integration.spec.ts` as proof the docker
  harness works — that spec fails **by design** against an empty runtime (already recorded
  in `plans/absorb-runtime-v0.7.0.md` criterion 5 and `DECISIONS.md:15`). Fixed: AC2 now
  points at `/runtime/manifest`/`/runtime/health` instead, and Phase 1 explicitly scopes
  that it does not deliver a fully green docker-mode suite (16/23 specs are ungated for a
  real, agentless runtime — pre-existing gap, `DECISIONS.md` DEFER #14).
- Phase 3's premise was wrong: the runtime's *admission-time* schema_version check is only
  `!= 0` (`registry.rs:301-303`); the `{1,2,3}` enum is *evaluation-time* only
  (`evaluator.rs:24`). Reclassified from "fail-fast convenience" to "genuine behavior
  change" — this repo's check becomes the only admission-time guard.
- Phase 2's proposed `^`-anchored compaction regex would have broken on grpc-js's real
  `"9 FAILED_PRECONDITION: …"`-prefixed terminal error text, and contradicted
  `DECISIONS.md` entry 13, which the plan hadn't consulted. Fixed: adopted entry 13's
  unanchored form verbatim, added a grpc-prefixed test fixture.
- The cross-repo doc's root-cause claim was wrong: `0.5.0`/`0.5` DO exist on GHCR; the
  dead `:v0.5.0` pin is a local leading-`v` typo, not solely the upstream bug. Fixed in
  `plans/cross-repo/macp-runtime-docker-tag-trigger.md` and via a correction comment on
  the already-filed `macp-runtime#184`; also added the `type=match` metadata-action
  extractor the suggested fix was missing.
- Phase 1 AC1 required running `runtime` and `runtime-src` concurrently — impossible
  (different profiles, same port 50051). Split into two sequential criteria.
- Plus: Phase 7 cited error handling in `admin.controller.ts` that doesn't exist (fixed —
  explicit `AppException`/`HttpStatus.SERVICE_UNAVAILABLE` specified); Phase 4's
  `Number('') === 0` startup-failure trap noted; Phase 5's scope expanded to cover
  `emitControlPlaneEvents`'s identical post-commit pattern and a genuine unhandled-
  rejection process-crash path (`consumeLoop` had no `.catch()`); the impact matrix's
  "closed rule objects already absorbed" claim was unsupported (neither repo enforces it)
  — moved to §6 Out of scope with the correct reasoning instead of a false absorbed claim;
  ~10 minor citation-drift corrections applied throughout.

All findings applied directly to `plans/absorb-runtime-v0.8.0.md` (see its inline
"Correction to an earlier draft of this plan" callouts and new §9) and to the cross-repo
doc.

### Plan review round 2 (final, 2-round cap) — 2026-09-22
Different fresh Opus agent, targeted re-verification of every round-1 fix against current
code in both repos. **Verdict: SOUND.** All five round-1 blocking fixes independently
re-confirmed correct. Four small nits found and applied (Phase 1 AC2 reworded — the
runtime manifest has no version field, so liveness is proven via `supportedModes` instead;
two citation fixes; Phase 5 now names both unprotected `emitControlPlaneEvents` call sites,
`:281` and `:359`; Phase 7 names `ErrorCode.RUNTIME_UNAVAILABLE`/`CIRCUIT_BREAKER_OPEN`
explicitly). Cross-repo doc's suggested-fix snippet corrected (was missing the existing
`branches: [main]` clause) and a follow-up comment posted to `macp-runtime#184`. No
findings required re-planning. **Plan is SOUND — proceeding to `/implement`.**

### Phase 1 — 2026-09-22
**Verdict: PASS**, round 1, fresh Opus verifier (default tier — CI/infra phase, no one-way door,
no auth/schema/contract/prod-access — Fable not warranted per the Autonomy ladder).

Changes: `docker-compose.test.yml` repinned `runtime`/`runtime-src` from `:v0.5.0` to the
`f97fd15` SHA tag (v0.8.0 release commit — no semver tag exists, see Cross-repo above) and
replaced the broken `grpc_health_probe` healthcheck with a TCP check on both services;
`test/setup/global-setup.ts`/`global-teardown.ts` split the single `CI`-gated block into
independent `needPostgres`/`needRuntime` booleans, starting the `runtime` service by name
(not the bare profile) when only the runtime is needed, to avoid colliding with CI's own
Postgres service container on port 5433; added `connectionTimeoutMillis: 5000` to the
Postgres readiness probe (bounds worst-case failure to ~110s, was unbounded/~25min).

**All 5 acceptance criteria independently verified against live containers / the real code
path (by both the executor and the verifier, who re-ran several independently rather than
taking the executor's word):**
- AC1 — both `--profile with-runtime` and `--profile with-runtime-src` booted and reported
  `Healthy` via the new TCP check, run and re-run live.
- AC2 — satisfied in substance, not via a new automated assertion (see the plan's own
  Phase 1 divergence note): `grpcurl` confirmed `GetManifest` returns exactly 6
  `supportedModes` including `ext.multi_round.v1` against the pinned container; separately,
  `INTEGRATION_RUNTIME=docker npm run test:integration:docker` was run against the live
  container and a real-runtime-gated spec (`policy.integration.spec.ts`) passed, proving the
  control plane's own gRPC client reaches it end-to-end.
- AC3 — `CI=true INTEGRATION_RUNTIME=mock` against the real `global-setup.ts`: logged
  `needPostgres=false needRuntime=false`, invoked no docker command.
- AC4 — same harness against a blackhole IP: threw after ~109.5s (bound: ~2min, was ~25min).
- AC5 — `plans/cross-repo/macp-runtime-docker-tag-trigger.md` exists;
  `multiagentcoordinationprotocol/macp-runtime#184` filed and confirmed open.
- Gates: `npm run lint`, `npx tsc --noEmit -p test/tsconfig.test.json`, `npm test`
  (56 suites / 786 tests), `npm run build` all clean.

**Non-blocking findings from the verifier, folded in before commit (cheap, in-scope, closed
real gaps — reproduced live in both the broken and fixed states):**
1. `INTEGRATION_RUNTIME` case sensitivity — `runtimeMode === 'docker'` didn't match
   `Docker`/`DOCKER`, while `test-app.ts`'s case-sensitive "anything but exactly `mock`"
   check would still boot the real gRPC provider for those values — a real trap (documented
   precedent for this exact asymmetry already exists in `real-runtime-gate.ts`). Fixed:
   both `global-setup.ts` and `global-teardown.ts` now lowercase `INTEGRATION_RUNTIME`
   before comparing.
2. Container leak on setup failure — Jest does not call `globalTeardown` when `globalSetup`
   throws; if the Postgres-readiness wait failed *after* a runtime container had already
   started, that container would never be stopped. Fixed: `globalSetup` now does inline
   best-effort cleanup of whatever it started if the Postgres wait subsequently throws.
   Reproduced live: without the fix, a container was left running after a forced failure;
   with the fix, the same scenario leaves zero containers.
3. `global-teardown.ts`'s needRuntime-only branch used two `execSync` calls (`stop` then
   `rm`) — a mid-sequence failure could leave a container stopped-but-not-removed. Fixed:
   collapsed to one `docker compose rm -sf runtime` call (used in both the normal teardown
   path and the new setup-failure cleanup path).
4. Added a comment on the "can't distinguish setup-started vs. already-running" edge case
   the plan itself flagged as worth documenting.

**Deferred, non-blocking (verifier explicitly rated these low-priority/cosmetic; left for a
future cycle rather than expanding this phase further):**
- The needRuntime-only teardown branch doesn't remove the compose network it created
  (cosmetic on ephemeral CI runners; verified the network survives `rm -sf runtime`).
- `KEEP_TEST_DB` now also gates runtime-container teardown despite its DB-specific name —
  a naming quirk, not a behavior bug.
- No retry/backoff around `docker compose up --wait` failing for the runtime container
  (mirroring the Postgres retry loop) — accepted because failure is already loud (gRPC
  errors / hook timeouts in the dependent specs), never a silent false-green.
- Failed-attempt `pg.Client` instances in the retry loop aren't explicitly `.end()`ed — `pg`
  destroys the socket on a connect-timeout regardless, so this is cosmetic.

**Also surfaced by the verifier, not a Phase 1 gap:** running the full docker-mode suite
unseeded shows `policy.integration.spec.ts` — one of the 7 specs this plan's Phase 1 scope
note calls "appropriately gated" — still failing on a 60s `app.close()` timeout from its
observer session-poll loop never resolving. Phase 1 never promised a green docker-mode
suite (see its own Scope note and §6 Out of scope), so this isn't an overclaim, but it's
worth flagging for whoever eventually works the "gate the 16 mock-only specs" backlog item.

No `ASSUMPTIONS.md` entry — Phase 1's scope was unambiguous throughout; the items above
were verifier-identified hardening/nits, not implementation choices made under ambiguity.

Files touched: `docker-compose.test.yml`, `test/setup/global-setup.ts`,
`test/setup/global-teardown.ts`, `plans/absorb-runtime-v0.8.0.md` (Status: DONE + divergence
note), `plans/cross-repo/macp-runtime-docker-tag-trigger.md` (force-added to git, matching
this repo's `/plans/`-is-gitignored-except-finalized-absorption-plans convention — see
`plans/absorb-runtime-v0.5.0.md`/`plans/absorb-runtime-v0.7.0.md` precedent).

**What's next:** commit Phase 1, then Phase 2 (stream pipeline bugs #67/#68/#69).

### Phase 1 — ship-gate round 1 — 2026-09-22
`/ship`'s §0 Orient & sync rebased this branch onto current `origin/main`
(`git fetch origin && git rebase origin/main`) before opening the PR — clean, no
conflicts. This pulled in one unrelated commit already merged to `main`: `23db607`,
an **automated dependency-bump PR (#80)** that bumped
`@multiagentcoordinationprotocol/proto` from `^0.1.9` to `^0.1.10` and resolved
`package-lock.json` to `0.1.10` — merged 2026-09-20, two days before this absorption's
planning started, entirely independent of it. This is **exactly Phase 8's planned work**,
already done. Re-ran the full gate after the rebase (lint/typecheck/786 tests/build) —
all green.

Fresh Opus ship-gate verifier (different subagent from the `/implement`-stage verifier).
**Verdict: GAPS** — code changes rated correct/complete/"better-verified than most phases
reviewed"; all findings were tracked-file/doc staleness, one rated fix-before-merge:

1. **[fixed]** The plan and this file both still described Phase 8 as `TODO`/unstarted
   with `package-lock.json` resolving `0.1.9` — false on this branch's own tree after the
   rebase. Fixed: Phase 8 marked `DONE — landed independently, outside this plan` in
   `plans/absorb-runtime-v0.8.0.md` (impact matrix row + full phase section, original
   Approach/AC preserved inline as historical record), and the phase-log table below.
2. **[fixed]** Case-insensitivity was only applied where `global-setup.ts` read
   `INTEGRATION_RUNTIME`, not written back — `test-app.ts`, `runtime-kind.ts`, and five
   per-spec real-runtime gates all still compare case-sensitively, so
   `INTEGRATION_RUNTIME=Docker` would start a container correctly but some specs would
   still (mis)treat the run as mock, going green having exercised nothing live. Fixed:
   `global-setup.ts` now writes the lowercased value back to
   `process.env.INTEGRATION_RUNTIME`, following the exact pattern already used for
   `DATABASE_URL` in the same file — confirmed live (`Docker` in, `docker` out, read back
   from `process.env` after `globalSetup()` returned).
3. **[fixed]** `stopCommand`'s 3-branch selection logic was duplicated between
   `global-setup.ts` (for its own cleanup-on-throw path) and `global-teardown.ts` — two
   copies that could silently drift. Fixed: `global-teardown.ts` now imports
   `stopCommand` from `global-setup.ts` instead of re-implementing it.
4. **[fixed]** §7 Verification ledger was still the unpopulated template text despite
   Phase 1's own promise to record its local verification runs there. Fixed: populated
   with all 8 live verification runs (the executor's + the two verifiers' independent
   re-runs), matching what's recorded here.
5. **[fixed]** Wording nit — Phase 1's divergence note claimed the live checks were
   "strictly stronger evidence" than the originally-planned assertion; true right now, but
   not in the one dimension the original AC2 had (a repeatable in-suite regression guard).
   Reworded to say so plainly, and noted as a reasonable low-cost follow-up rather than
   something this phase was obligated to add. Also fixed a typo ("delvier" → "deliver").
6. **[deferred to merge]** This row (P1 Commit/PR) still needs the real commit SHA and PR
   number backfilled once the amended commit is made and the PR is opened — noted here so
   it isn't forgotten, not a code gap.

Ship-gate verifier additionally independently re-verified (fresh docker runs, not just
re-reading the executor's claims): the CI-only teardown branch (`rm -sf runtime`, no
`--profile` flag) does correctly resolve and remove a running profiled container under
compose v2.39; `f97fd15` is anonymously pullable from GHCR (neither CI workflow has a
registry login step, so this is load-bearing, not incidental); no doc drift against
`CLAUDE.md` (it documents the 3 `INTEGRATION_RUNTIME` modes and the npm commands, never
the image pin or healthcheck mechanism, so nothing there is now stale); tracked-file
consistency confirmed (Phase 1 `DONE`, Phases 2-7 `TODO` in both the plan and this file —
Phase 8 was the one inconsistency, see item 1).

All fixes re-verified: `npx tsc --noEmit -p test/tsconfig.test.json` clean, `npm run
lint` clean, `npm test` 56/56 suites, 786/786 tests, `npm run build` clean, and the
case-insensitivity + cleanup-on-throw behaviors re-confirmed live against real containers
after the refactor (zero leaked containers, `INTEGRATION_RUNTIME` correctly normalized
and observable via `process.env` after `globalSetup()` returns).

### Phase 1 — ship-gate round 2 (closure check) — 2026-09-22
Fresh Opus subagent, given round 1's 6-item gap list and asked to confirm closure rather
than review cold, per `/ship`'s re-verify loop. **Verdict: PASS.** All 5 fixable items
confirmed closed against current source (item 6, the Commit/PR row, correctly confirmed
still open-but-explicitly-deferred, not silently dropped). Independently re-ran
`npm run lint`/`tsc --noEmit`/`npm test` (56/786)/`npm run build` — all clean. Also
smoke-ran `global-teardown.ts`'s new cross-module import of `stopCommand` at runtime to
confirm it actually resolves, not just that the import statement is present.

pushed absorb-runtime-v0.8.0 7fc96304d445baaad47b5d72e9c2c7ef57a4a159
pushed absorb-runtime-v0.8.0 f8ed39f (checkpoint commit)
PR #81 opened: https://github.com/multiagentcoordinationprotocol/macp-control-plane/pull/81

### Phase 1 — CI + merge — 2026-09-22
All required checks green on PR #81: CodeQL, `check-env-secrets`, `typecheck`, `lint`,
`test`, `conventions`, `audit`, `build`, `docker`, `integration-test` (11 checks). Notably
`integration-test`/`docker` passing in CI is itself a live confirmation of this phase's
own fix — those jobs use `INTEGRATION_RUNTIME=mock` per `ci.yml:132`, so they exercise the
`needPostgres=false needRuntime=false` no-op path in CI, not the docker-mode path (that
stays `workflow_dispatch`-only via `integration-tests.yml`, unchanged by this phase).
`gh pr view` confirmed `MERGEABLE`/`CLEAN`, no branch-protection block.

merged #81: https://github.com/multiagentcoordinationprotocol/macp-control-plane/pull/81
(squash-merged to `main` at `1690e7b`, remote + local feature branch deleted)

**Post-merge deploy:** `.github/workflows/deploy.yml` is `workflow_dispatch`-only (manual,
SSH-based, dormant until `DEPLOY_SSH_*` secrets are configured) — merging to `main` does
**not** trigger an automatic deploy in this repo. No deploy to watch as a result of this
merge; nothing "in flight, unwatched" either — there is simply no CI/CD-triggered deploy
for this repo, by design. Nothing further to verify here.

**Phase 1 fully closed.** Next: Phase 2 (stream pipeline bugs #67/#68/#69).

### Phase 2 — implement + verify — 2026-09-22
Branch `absorb-runtime-v0.8.0-p2` (off `main` at `6a2e880`, post Phase-1-merge). Implemented
all three fixes per plan §Phase 2: `event-normalizer.service.ts:149-152` (#67, inline
`policy.denied` matching against the real `"PolicyDenied"`/`"PolicyDenied: <reasons>"` wire
string, plus new `parsePolicyDenyReasons` helper); `stream-consumer.service.ts:160`
(#68, `COMPACTED_HISTORY_RE = /history before ordinal \d+ was compacted/i`, unanchored per
`DECISIONS.md:37`, split into `isCompactedHistoryTerminalError`/`isCompactedHistoryInlineError`);
`stream-consumer.service.ts:306-321` (#69, gap-detection now checked and recorded before the
`streamResumeEnabled` short-circuit, not after).

**Local verification (round 1, pre-verifier):** lint clean; targeted unit run 62/62; full
`tsc --noEmit -p test/tsconfig.test.json` clean; full `npm test` 792/792 (56/56 suites,
6 new tests); `npm run build` clean; mock-mode `npm run test:integration` 21/21 runnable
suites, 103/103 tests (2 docker-only suites correctly skipped), including the updated
`stream-gap.integration.spec.ts` (2/2) against its corrected fixture (real runtime sentence
`"session history before ordinal 5 was compacted"` instead of the old placeholder
`"resume point compacted"`).

**Verify — fresh Opus subagent, round 1: PASS.** Confirmed all three fixes match `file:line`
exactly as planned; confirmed all 4 acceptance criteria are backed by real tests that
provably fail against the pre-fix code (traced each manually, not just trusted the pass
count); independently re-ran the two changed spec files (62/62) and cross-checked every
`server.rs`/`error.rs` line citation in the new code comments against the actual
`../macp-runtime` sibling checkout — all exact. Also traced the live runtime's actual
control flow (`server.rs:748-756`'s `is_stream_terminal_error`) and confirmed a real
compaction rejection only ever arrives as an *inline* frame today, never a terminal grpc-js
error — so AC3's terminal-path regression guard covers a defensive/future shape, not (yet)
a path the live v0.8.0 runtime exercises; correctly noted this as conformant with the plan
(AC3 was specified verbatim), not a gap. Flagged 6 non-blocking follow-ups, all folded in
before commit rather than deferred:
1. A stale `isCompactedHistoryError (/compact/i)` doc-comment reference in
   `test/integration/stream-resume-live.integration.spec.ts` (drift this phase's rename
   created, in a file outside the plan's own file list) — corrected to name the actual
   `COMPACTED_HISTORY_RE`/`isCompactedHistoryInlineError`.
2. `stream-gap.integration.spec.ts`'s fixture comment overclaimed that it "exercises the
   tightened, sentence-specific regex — not just the `code === 9` fallback"; since the
   fixture keeps `code: 9` alongside the real sentence, the `||` short-circuits and the
   regex branch is never evaluated there in practice (AC3's *unit* test is what actually
   isolates the regex-only path). Comment softened to say so plainly.
3. `CLAUDE.md`'s two "786 tests" mentions (`:25`, `:55`) were stale — updated to 792, then
   793 after the follow-up test below.
4. The two inline-`PolicyDenied` unit-test fixtures used `messageId: 'msg-1'`, contradicting
   the plan's own explicit note that this field is always `""` on the inline path
   (`server.rs:624`). Changed to `messageId: ''` with matching `subject`/`errorCode`
   assertions, so the fixtures read like the real wire shape rather than an unrealistic
   placeholder.
5. `parsePolicyDenyReasons`'s all-empty-after-split fallback branch (input like
   `"PolicyDenied: ; "` → falls back to `[message]`) was genuinely untested — added one more
   unit test for it (793/793 total after this fix, up from 792/792).
6. The pre-existing `emitStreamGap` unguarded-await hazard (an uncaught rejection would crash
   the process) becomes reachable on one additional path via this phase's #69 reorder —
   needed no new action: Phase 5's own plan text already explicitly names this exact call
   site as in scope (see Phase 5 section, "Approach" second paragraph).

Re-ran the full suite after folding in all 6 follow-ups: lint clean, targeted unit run 63/63,
full `npm test` 793/793 (56/56 suites), `tsc --noEmit` clean, `npm run build` clean, and the
full mock-mode integration suite again (103/103, `stream-gap.integration.spec.ts` 2/2) — all
still green with a fresh standalone Postgres container (repo's own `docker-compose.test.yml`
`postgres-test` port 5433 was occupied by an unrelated pre-existing container on this shared
dev machine, same workaround as Phase 1: standalone `postgres:16-alpine` on an alternate host
port, `CI=true` to skip `global-setup.ts`'s own compose invocation).

`plans/absorb-runtime-v0.8.0.md`'s Phase 2 section marked `Status: DONE` with the full
divergence note above. No new `ASSUMPTIONS.md` entries — every judgment call this phase made
was already resolved by the plan itself (the unanchored-regex decision, the split call sites,
the reordering) or by the verifier's non-blocking follow-ups, none of which were ambiguous
enough to need `UNCONFIRMED` tracking.

**What's next:** commit Phase 2, then hand off to `/ship` (PR #2 of the 8-phase, one-PR-per-
phase strategy) before continuing the `/implement` loop to Phase 3.

Committed as `e0e431e` on `absorb-runtime-v0.8.0-p2`.

### Phase 2 — ship-gate round 1 — 2026-09-22
Fresh Opus ship-gate verifier (distinct from the implement-stage verifier above, same diff
`main...HEAD`). **Verdict: GAPS (4 items).** Re-confirmed all three core fixes correct on a
fresh read and independently re-ran `npm test` (793/793) — the gaps were entirely in tracked
docs/records, not code:
- **G1 (the real one — operator-facing doc drift):** `docs/TROUBLESHOOTING.md` still had two
  full sections describing the #67 and #68 bugs as open, with a `**Mitigation:** avoid the
  word "compact" in policy-rule denial reasons` operator workaround that's now actively wrong
  advice. `docs/ARCHITECTURE.md`'s "Stream Resume & Cross-Process Recovery" section also
  described the pre-fix `isCompactedHistoryError`/`/compact/i` behavior and the pre-#69
  resume-flag-before-gap-check ordering. **Fixed:** removed both obsolete TROUBLESHOOTING
  sections outright (no inbound links found); rewrote the two stale ARCHITECTURE paragraphs to
  name the actual `COMPACTED_HISTORY_RE`/`isCompactedHistoryTerminalError`/
  `isCompactedHistoryInlineError`, the tightened-from-`/compact/i` regex history, the
  now-correct gap-before-resume-flag ordering, and refreshed the `server.rs` line citations
  from `745-755`/`608-628` to `748-756`/`611-629` to match what Phase 2's code comments
  already correctly cite.
- **G2:** local-only `CLAUDE.md` (gitignored, so invisible to the PR diff) still said 792
  after the implement-stage follow-up (5) added a 7th test without re-bumping it. Fixed to 793
  at both mentions.
- **G3:** `docs/API.md`'s `policy.denied` section enumerated only two producers (`PolicyDenied`
  messageType envelope; send-ack `POLICY_DENIED`) — the inline stream-error frame this phase
  fixed is a third, and per the now-removed TROUBLESHOOTING analysis the send-ack path is dead
  under the observer invariant, so inline is one of only two paths that actually fire in this
  deployment. Fixed: added the inline case with its `errorCode` prefix-match semantics, its
  always-empty `messageId`/`subject.id`, and its text-based (not `error.reasons`/binary-metadata)
  reason extraction.
- **G4:** the prior checkpoint's "No new `ASSUMPTIONS.md` entries" claim was wrong. The
  ship-gate verifier surfaced one real judgment call: inline `policy.denied`'s `errorCode`
  carries the raw `"PolicyDenied: <reasons>"` wire text (unbounded, operator-authored, emitted
  unredacted into span attributes), where the ack path's `errorCode` is always the fixed
  constant `"POLICY_DENIED"` — so a consumer matching on that constant exactly will silently
  miss inline denials. Low severity (`OTEL_ENABLED` defaults false; the same text already flows
  through `errorMessage` regardless), but it's an accepted trade-off, not a plan-resolved one.
  Logged as a new `ASSUMPTIONS.md` entry, `Status: UNCONFIRMED`.

Also folded in non-blocking note N4 (cheap): refreshed Phase 5's plan-text citation of the
Phase 2 gap-detection call site from `:281` to its actual current line `:317`, with an added
caution to re-verify all citations in that paragraph fresh when Phase 5 starts rather than
trust any of them. Left N1 (PR-description note re: new `session.stream.gap` output for
`STREAM_RESUME_ENABLED=false` deployments — will state in the PR body), N2, N3, N5 as noted
(non-blocking, no tracked-file action needed).

Re-ran after all fixes: `npm test` 793/793 (56/56 suites, unchanged — these were doc/tracked-
file-only edits, no source changed). Landed as a small follow-up commit on the same branch
rather than an amend (the Phase 2 commit is unpushed but `/ship`'s guardrails default against
amending; a short logical sequence is explicitly allowed).

**Ship-gate round 1 closed all 4 gaps. Proceeding to push and open the PR.**

pushed absorb-runtime-v0.8.0-p2 965a2bf
PR #82 opened: https://github.com/multiagentcoordinationprotocol/macp-control-plane/pull/82

### Phase 2 — CI + merge — 2026-09-22
All 11 required checks green on PR #82: CodeQL, `analyze`, `audit`, `build`,
`check-env-secrets`, `conventions`, `docker`, `integration-test`, `lint`, `test`,
`typecheck` (`call / auto-merge` correctly `skipping`, same as Phase 1). Watched the two
live run IDs directly (`gh run watch <id> --exit-status`, run in parallel in the
background) rather than relying solely on `gh pr checks --watch`, per the propagation-lag
lesson from Phase 1 — both exited 0. Cross-confirmed via `gh pr checks 82` afterward.

merged #82: https://github.com/multiagentcoordinationprotocol/macp-control-plane/pull/82
(squash-merged to `main` at `3188017`, remote branch deleted by `gh pr merge`, local
branch fast-forwarded back to `main` and pruned)

**Post-merge deploy:** `.github/workflows/deploy.yml` is still `workflow_dispatch`-only
(manual, SSH-based, dormant until `DEPLOY_SSH_*` secrets are configured) — unchanged since
Phase 1. No deploy triggered by this merge; nothing "in flight, unwatched."

**Phase 2 fully closed.** Next: Phase 3 (tighten the `schema_version` pre-check).

### Phase 3 — implement + verify + ship-gate follow-ups — 2026-09-22
Branch `absorb-runtime-v0.8.0-p3` (off `main` at `620fb3c`, post Phase-2-merge). Implemented
per plan §Phase 3: `src/contracts/runtime.ts:310-311` adds `POLICY_SCHEMA_VERSIONS = [1,2,3]
as const` / `PolicySchemaVersion`, following the `CANONICAL_EVENT_TYPES` pattern, with an
in-code comment recording why this repo's pre-check is deliberately stricter than the
runtime's own admission gate (registry.rs only rejects `== 0`; the `{1,2,3}` enum is
evaluation-time only, in `evaluator.rs`). `runtime.controller.ts:78-79` replaces the old
`< 1` check with a membership test, message derived from the constant so it auto-tracks a
future widening. Response/descriptor-side `schemaVersion: number` left unnarrowed exactly
as the plan required (confirmed load-bearing: `scripted-mock-runtime.provider.ts:318`
returns `schemaVersion: 0` from a mock `getPolicy` and would fail to compile otherwise).

**Local verification:** lint clean; targeted `runtime.controller.spec.ts` run 23/23 (6
schemaVersion-specific cases, including one added beyond the plan's list for the
non-integer `1.5` edge case); full `npx tsc --noEmit -p test/tsconfig.test.json` clean;
full `npm test` 798/798 (56/56 suites, 5 new tests); `npm run build` clean.

**Verify — fresh Opus subagent: PASS.** Confirmed the implementation matches the plan
file:line-for-line; confirmed all 3 acceptance criteria backed by tests that assert on
actual forwarded values (not just "didn't throw" — e.g. AC3 asserts
`registerPolicy` was called with `descriptor: expect.objectContaining({schemaVersion:
1})`); independently probed the `.includes()` cast in a scratch TS file and confirmed it's
compiler-mandated (the readonly-tuple's `includes` signature narrows to `1 | 2 | 3`) and
runtime-safe (the cast is erased at compile time; `Array.prototype.includes` does a real
SameValueZero comparison regardless); independently re-ran the full suite (798/798), lint,
build, typecheck, and the CLAUDE.md convention grep sweeps — all clean. Flagged one
unflagged-but-correct drift (below) and several non-blocking doc/coverage notes.

**Divergence, folded into the plan's own Phase 3 section (see above) rather than repeated
here:** the plan's literal "only the request-side inline body type narrows" instruction
was not followed verbatim — the inline `@Body()` type stayed unnarrowed, with the cast
applied only at the check site — because narrowing the body type would both assert a
compile-time lie about unvalidated network JSON and break the plan's own required
`schemaVersion: 99`/`1.5` test cases from compiling. The verifier confirmed this was the
correct call, just never explicitly called out; now recorded in the plan's divergence note.

**Follow-up folded in before commit:** `docs/API.md`'s `POST /runtime/policies` section
documented `"schemaVersion": 1` in its example body with no mention of the allowed set or
that an out-of-range value is now a `400`, not a silent-later-failure `200` — a real
behavior change with no matching doc update. Added a paragraph stating the `{1,2,3}`
constraint and why this repo's check is stricter than the runtime's own admission gate.
Not folded in (deliberately, low value for a routine phase): a `CANONICAL_EVENT_TYPES`-
style contract-stability spec asserting `POLICY_SCHEMA_VERSIONS`'s exact contents — the
plan didn't require one and the constant is a 3-line literal with no duplication risk;
worth adding only when/if the set actually widens to `{1,2,3,4}`.

`plans/absorb-runtime-v0.8.0.md`'s Phase 3 section marked `Status: DONE` with the full
divergence note. No new `ASSUMPTIONS.md` entries — the one deviation from literal plan
wording was a correctness fix to an internally-inconsistent plan instruction, not an
ambiguous judgment call with a real "wrong" alternative to track.

**What's next:** commit Phase 3, hand off to `/ship` (PR #3 of the one-PR-per-phase
strategy) — PR description must call out the `200→400` behavior change for
out-of-range `schemaVersion` values, per the plan's own instruction — then continue the
`/implement` loop to Phase 4 (explicit gRPC channel options).

### Phase 3 — ship-gate + push — 2026-09-22
Fresh Opus ship-gate verifier (distinct from the implement-stage verifier, same diff
`main...HEAD`): **PASS**, no blocking findings. Independently re-derived correctness of
`POLICY_SCHEMA_VERSIONS`/the membership check, cross-checked the in-code runtime-source
citations directly against `evaluator.rs`/`registry.rs`, swept the whole repo for any
caller sending an out-of-range `schemaVersion` (found none — only
`policy.integration.spec.ts:80` sends one, and it's `1`), and independently re-ran the
full suite (798/798), lint, build, and convention greps. 4 non-blocking notes; 3 folded in
before push (see the commit above): a new `ASSUMPTIONS.md` entry for the real judgment
call (this repo's check is now stricter than the runtime's own admission gate, with no
automated trigger to widen it if the runtime's set grows past `{1,2,3}`); corrected
`PROGRESS.md`'s P2 row to cite the actual squash commit instead of pre-squash branch
commits that become unresolvable once that branch is pruned; and a `docs/API.md` note
that the check is type-strict as well as range-strict (a JSON string `"1"` used to coerce
through and succeed, now rejected). The 4th note — `macp-ui-console`'s client-side policy
form still validates only `> 0`, so an operator entering `4` now gets a server-side `400`
toast instead of the console's own validation catching it — is out of this repo's scope
(cross-repo, not a write this repo makes) and is named in the PR description instead.

pushed absorb-runtime-v0.8.0-p3 4cd4a83
PR #83 opened: https://github.com/multiagentcoordinationprotocol/macp-control-plane/pull/83

### Phase 3 — CI + merge — 2026-09-22
All 11 required checks green on PR #83 (CodeQL, `analyze`, `audit`, `build`,
`check-env-secrets`, `conventions`, `docker`, `integration-test`, `lint`, `test`,
`typecheck`; `call / auto-merge` correctly `skipping`). Watched the two live run IDs
directly in the background, cross-confirmed via `gh pr checks 83`.

merged #83: https://github.com/multiagentcoordinationprotocol/macp-control-plane/pull/83
(squash-merged to `main` at `2ac9dc6`, remote branch deleted, local branch/ref pruned)

**Post-merge deploy:** still `workflow_dispatch`-only, unchanged. No deploy triggered.

**Phase 3 fully closed.** Next: Phase 4 (explicit gRPC channel options).

### Phase 4 — implement + verify — 2026-09-22
Branch `absorb-runtime-v0.8.0-p4` (off `main` at `b2534b9`, post Phase-3-merge). Implemented
per plan §Phase 4: `RUNTIME_MAX_RECEIVE_MESSAGE_BYTES` (default 16 MiB)/
`RUNTIME_MAX_SEND_MESSAGE_BYTES` (default 4 MiB) added to `app-config.service.ts` following
the existing `readNumber` + validation-block pattern (including the blank-string trap
already established for `RUNTIME_LIST_SESSIONS_TIMEOUT_MS`); `rust-runtime.provider.ts`'s
`createClient()` now passes both as `grpc.max_receive_message_length`/
`grpc.max_send_message_length` in a third constructor argument.

**Local verification:** lint clean; targeted `rust-runtime.provider.spec.ts` run 25/25 (22
pre-existing + 3 new, zero pre-existing tests modified — `git diff --numstat` confirms
pure additions); targeted `app-config.service.spec.ts` run 69/69 (11 new); full
`npx tsc --noEmit -p test/tsconfig.test.json` clean; full `npm test` 812/812 (56/56
suites, 14 new tests); `npm run build` clean; mock-mode `npm run test:integration`
103/103 (unaffected as expected — mock mode uses `ScriptedMockRuntimeProvider`, never
touches `RustRuntimeProvider.createClient()`).

**Verify — fresh Opus subagent: PASS.** All 4 acceptance criteria confirmed met,
independently re-ran every gate (25/25, 812/812, lint, typecheck, build, convention
greps — all matching). Gave an unusually candid assessment of AC4 specifically, worth
preserving verbatim in spirit: the byte-size ceiling this phase configures is enforced
inside grpc-js below the `unary()` seam every test in this file stubs, so **no unit test
can directly trip a real ceiling** — AC4 is inherently untestable at this level, and the
added test (honest about this in its own comment) instead proves the halving ladder
survives *two* consecutive `RESOURCE_EXHAUSTED` responses, a genuinely new case beyond
the pre-existing single-halving test. Recorded as a divergence note in the plan rather
than left implicit. 5 non-blocking findings, all folded in before commit: a stale
"gRPC client has no channel options" sentence + missing env-var rows in
`docs/INTEGRATION.md` (the plan's Docs note under-scoped to 3 files, missed this 4th);
a factual fix in `.env.example` (unset ≠ empty-string — only empty-string fails
startup, the original wording conflated the two); a "worst-case"/"typical" wording
mismatch between `.env.example` and `app-config.service.ts` about a 1000-session
`ListSessions` page (resolved in `.env.example`'s favor of `app-config.service.ts`'s
framing); a `(see below)` cross-reference in `app-config.service.ts` fixed to
`(above)`; and a one-clause addition noting the send-side default is a genuine
*tightening* (grpc-js's implicit send default is unlimited, not 4 MB) rather than a
raise like the receive side — practical risk nil, but the original phrasing implied
otherwise. Also renamed the AC4 test's title, which the verifier flagged as
overclaiming relative to its own honest in-body comment.

`plans/absorb-runtime-v0.8.0.md`'s Phase 4 section marked `Status: DONE` with the full
divergence note (the AC4-untestability finding, preserved for future readers rather
than only living in this checkpoint). No new `ASSUMPTIONS.md` entries — every judgment
call (the specific byte-size defaults, the blank-string validation, leaving the
halvings ladder untouched) was already prescribed by the plan itself with clear
reasoning; the AC4 limitation is a testing-methodology fact, not a judgment call with
a real wrong alternative to track.

Committed as `586614a`.

### Phase 4 — ship-gate — 2026-09-22
Fresh Opus ship-gate subagent (distinct from the implement-gate verifier above): **PASS**.
Independently confirmed both grpc-js technical claims against `node_modules/@grpc/grpc-js`
source directly (`DEFAULT_MAX_RECEIVE_MESSAGE_LENGTH = 4 MiB`,
`DEFAULT_MAX_SEND_MESSAGE_LENGTH = -1`), mutation-tested the two new `createClient` tests
by stripping the third constructor argument in production code (both failed as expected,
confirming they exercise the real private method, not a stub bypass; tree restored clean),
re-ran the full gate (lint/typecheck/812 unit tests/build/convention greps, all clean),
confirmed doc drift fully closed and tracked files consistent (plan `Status: DONE` +
divergence note, `PROGRESS.md` matching). No gaps — zero follow-up commit needed before
push, unlike Phases 2 and 3. Three non-blocking observations recorded for later, none
blocking this phase: (1) `ASSUMPTIONS.md`'s v0.7.0 P2 entry still describes the client as
having "no channel options," now stale — correctly noted as `/reconcile`'s job, not this
phase's, per that file's own header; (2) `readNumber` silently falls back to default on a
non-numeric value rather than erroring, a pre-existing repo-wide pattern this phase didn't
introduce; (3) AC4's inherent untestability is correctly and prominently recorded rather
than glossed over.

pushed absorb-runtime-v0.8.0-p4 586614a

PR #84 opened: https://github.com/multiagentcoordinationprotocol/macp-control-plane/pull/84

All 11 required checks green (CodeQL, analyze, audit, build, check-env-secrets,
conventions, docker, integration-test, lint, test, typecheck). merged #84 (squash,
`fe6c70d`, branch deleted). No deploy triggered — this repo's deploy is
`workflow_dispatch`-only, unchanged by this phase.

**Phase 4 fully closed.** Next: Phase 5 (non-blocking post-commit publish side effects —
`run-event.service.ts`/`stream-consumer.service.ts`).

### Phase 5 — implement + verify — 2026-09-22
Branch `absorb-runtime-v0.8.0-p5` (off `main` at `9cf4585`, post-Phase-4-merge). Implemented
per plan §Phase 5: `RunEventService.emitControlPlaneEvents`/`persistRawAndCanonical` both
used to run post-commit side effects (span annotations, metrics recording, SSE publish,
snapshot publish) that could throw and propagate to the caller even though the DB
transaction had already committed — causing `StreamConsumerService` to treat an
already-durable envelope as failed and re-ingest it on reconnect (duplicate rows, since a
redelivered event gets a fresh id/seq and `onConflictDoNothing` can't dedup it). Fixed by
extracting a shared private `runPostCommitSideEffects(runId, events, projection)` helper
that wraps metrics/publish-event/publish-snapshot in three independent try/catch blocks,
logging via a newly-added `Logger` (per CLAUDE.md convention) rather than rethrowing.
`publishEvent` is caught **per event inside its loop**, not once around the whole batch, so
one bad event doesn't suppress publishing its siblings — a small strengthening beyond the
plan's literal wording, in the spirit of its own "one failure doesn't suppress the others"
edge case.

Separately, `StreamConsumerService.consumeLoop`'s launch chain in `start()` had only a
`.finally()`, no `.catch()` — so anything escaping its own per-iteration error handling
(the two unprotected `emitControlPlaneEvents` call sites: `emitStreamGap` and the
poll-fallback's reconnect event) became an unhandled promise rejection that crashes the
whole Node process (pre-existing hazard, not introduced by Phase 2, but explicitly folded
into this phase's scope per the plan). Added a last-resort `.catch()` that logs and marks
the marker `finalized`/`aborted` — deliberately does **not** call `finalizeRun`/`markFailed`
(a second fallible async operation inside the one place that must not throw would risk
recreating the exact hazard being closed); logged as an `UNCONFIRMED` judgment call in
`ASSUMPTIONS.md` (P5) with full blast-radius reasoning, mitigated by
`RunRecoveryService.onApplicationBootstrap()` (gated on `RUN_RECOVERY_ENABLED`, default
`true`) re-attaching non-terminal runs on the next restart.

Also added the Prometheus counter the plan flagged as "a reasonable near-term addition...
if time allows" rather than deferring it: `macp_post_commit_side_effect_failures_total`
(labeled `step`: `metrics`/`publish_event`/`publish_snapshot`) in
`instrumentation.service.ts`, wired into `RunEventService` via constructor injection
(trivial in this repo's single-module DI setup — confirmed via `app.module.ts`, no module
wiring changes needed). Updated the now-stale comment on `envelopeOrdinal` in
`handleRawEventInner` (`stream-consumer.service.ts`) that described the old
duplication-over-loss trade-off, which no longer applies now that post-commit failures
can't throw at all.

**Local verification:** lint clean; full `npx tsc --noEmit -p test/tsconfig.test.json`
clean; full `npm test` 815/815 (56/56 suites, 3 new: 2 in `run-event.service.spec.ts`
covering the twin publish-failure case and `emitControlPlaneEvents`'s own post-commit path,
1 in `stream-consumer.service.spec.ts` proving the new `.catch()` absorbs a rejection that
would otherwise be unhandled — verified load-bearing by temporarily reverting each fix and
confirming the corresponding new test fails); `npm run build` clean; all 3 CI convention
greps empty; mock-mode `npm run test:integration` 103/103 both before and after adding the
`InstrumentationService` constructor dependency (the second run is the meaningful one — a
real Nest app bootstrap under integration test would fail if the new DI dependency weren't
resolvable).

**Verify — fresh Opus subagent: PASS**, with 5 non-blocking nits, all folded in before
commit: (1) the new JSDoc on `runPostCommitSideEffects` claimed "each step is caught... independently"
in a way that read as covering `recordSpanEvents` too, which is intentionally left
unwrapped (pure in-memory annotation, no I/O) — reworded for precision; (2) this very
PROGRESS.md entry was missing at gate time (the plan's Phase 5 section already pointed to
it) — written now; (3) the `ASSUMPTIONS.md` P5 entry's blast-radius section didn't mention
that `streamHub.complete(runId)` also never fires when the safety net trips, leaving a
live SSE client's connection open with no completion signal (bounded, not a leak — the
memory strategy's per-run `Subject` is reaped by the existing subscriber-count cleanup
timer) — added, along with confirming `RUN_RECOVERY_ENABLED`'s default is `true`, not
opt-in; (4) the new counter was undocumented — added a `CLAUDE.md` line (Key Reliability
Features) alongside the existing stream-resume metrics documentation; (5) a candid
observation (not a gap — already covered by the plan's own Rollback section) that a
swallowed metrics failure is now a permanent under-count for that run's token/cost totals,
with the counter + log as the only recovery signal. The verifier also ran two mutation
checks (removing the new `.catch()`, collapsing the per-event publish catch into one
batch-level catch) and confirmed the corresponding new tests fail without the fix, proving
they're load-bearing rather than accidentally green.

`plans/absorb-runtime-v0.8.0.md`'s Phase 5 section marked `Status: DONE` with a divergence
note (shared helper vs. duplicated try/catch, per-event vs. per-batch publish catch, counter
added in-phase rather than deferred). New `ASSUMPTIONS.md` entry: "P5 (v0.8.0) —
consumeLoop's last-resort `.catch()` marks the stream marker finalized/aborted but never
calls `finalizeRun`/`markFailed`" (Status: UNCONFIRMED).

Committed as `69a23dd`.

**What's next:** hand off to `/ship` (PR #5) — no behavior-change callout needed beyond what
the PR description itself will explain (this is an internal reliability fix with no public
API surface change) — then continue the `/implement` loop to Phase 6 (handoff
implicit-accept integration test coverage).

### Phase 5 — ship-gate — 2026-09-22
Fresh Opus ship-gate subagent (distinct from the implement-gate verifier above): **PASS**,
zero gaps. Independently re-ran the full suite (lint/typecheck/815 unit tests/build/3
convention greps, all clean), confirmed the DI wiring is real (not just unit-mocked) by
tracing both `InstrumentationService` and `RunEventService` to the same `app.module.ts`
providers array, checked all 14 call sites of `emitControlPlaneEvents`/
`persistRawAndCanonical` for regressions (none — the HTTP-path caller now correctly
returns 201 instead of a 500 that lied about an already-durable write), and independently
mutation-tested both fixes (deleting the `consumeLoop` `.catch()` and removing the metrics
try/catch each fail their corresponding new test). Confirmed doc drift is genuinely nil —
`docs/` has no metrics inventory to update and no description of the old post-commit
re-ingestion behavior to correct — and confirmed `CLAUDE.md`'s new line + bumped test
counts are present locally. Six non-blocking observations, none requiring action before
ship: (1) the `publish_snapshot` catch is the one of three independent catches with no
dedicated test (structurally identical to its two tested siblings); (2) `recordSpanEvents`
remains the one post-commit step that could still theoretically propagate, already
documented as intentional and practically unreachable; (3) a comment in the new `.catch()`
overstates its own effect slightly (the loop has already exited by the time it runs, so
the marker writes are close to cosmetic) — imprecise wording, zero behavioral impact;
(4) the plan's own §6 "Out of scope" list still describes the Prometheus counter with the
original conditional phrasing ("if time allows") even though the Phase 5 section itself
correctly documents it as shipped in-phase; (5) AC4 has no direct unit test coupling
ordinal-advance to a post-commit failure, same as noted at implement-gate — not fixable at
the unit level, transitively proven by AC1 + existing tests; (6) a **pre-existing**,
unrelated doc inaccuracy in `docs/ARCHITECTURE.md` misattributing which service performs
`updateStreamCursor` — not introduced by this diff, out of scope for this phase.

Following the same precedent as Phase 4's zero-gap ship-gate: no follow-up commit for
non-blocking observations, proceeding straight to push.

pushed absorb-runtime-v0.8.0-p5 c7b6563
PR #85 opened: https://github.com/multiagentcoordinationprotocol/macp-control-plane/pull/85

All 11 required checks green (CodeQL, analyze, audit, build, check-env-secrets,
conventions, docker, integration-test, lint, test, typecheck). merged #85 (squash,
`2a6e1d2`, branch deleted). No deploy triggered — `workflow_dispatch`-only, unchanged.

**Phase 5 fully closed.** Next: Phase 6 (handoff implicit-accept integration test
coverage).

### Phase 6 — implement + verify — 2026-09-22
Branch `absorb-runtime-v0.8.0-p6` (off `main` at `eff8b61`, post-Phase-5-merge). This
phase adds test coverage only — zero `src/` changes. Implemented per plan §Phase 6:

- `test/helpers/scripted-mock-runtime.provider.ts`'s `makeStreamEnvelope` gained an
  optional 6th parameter `opts?: { messageId?: string; payloadBytes?: Buffer }` —
  `payloadBytes`, when supplied, is used verbatim instead of JSON-encoding `payload`,
  letting a fixture send real proto-encoded bytes through the mock runtime. Confirmed
  backward-compatible with all 57 existing positional (≤5-arg) call sites — full
  integration suite green (below).
- `test/fixtures/handoff-mode.ts` gained `handoffImplicitAcceptScript(accept: {
  payloadBytes?, payload?, messageId? })` — one parameterized fixture (not three
  separate functions) covering all three verification cases via the same
  `HandoffOffer` → `HandoffAccept` script shape.
- New `test/integration/handoff-implicit-accept.integration.spec.ts`, gated
  `isRealRuntime ? describe.skip : describe` (mock-only, matching the inline-ternary
  pattern of the other 5 mock-scripting-dependent specs). Loads the real
  `HandoffAcceptPayload` protobuf type via `protobufjs` (same pattern as
  `stream-resume-live.integration.spec.ts`'s `loadPayloadTypes`) and proto-encodes real
  bytes for the primary-branch case. Three cases: (1) proto-encoded `implicit: true` +
  plain-UUID `messageId` → `implicit: true`, reachable only via
  `projection.service.ts:791`; (2) JSON payload (no decodable `implicit` boolean) +
  `messageId: 'implicit-accept:handoff-1'` → `implicit: true`, reachable only via `:792`;
  (3) negative control (JSON payload, random-UUID messageId, same shape as the existing
  `handoffAcceptScript()`'s explicit accept) → `implicit` is `undefined`.

**Mutation-test evidence (AC1 — required, not optional):** ran the new spec twice more
with each branch of `isImplicitAccept` (`projection.service.ts:790-793`) individually
disabled, confirmed the corresponding case fails both times, then reverted (confirmed via
`git diff` showing zero changes to `projection.service.ts` afterward).

*Run 1 — line 791 (primary decode branch) disabled:*
```
FAIL test/integration/handoff-implicit-accept.integration.spec.ts
  ● Handoff implicit-accept (integration, runtime v0.8.0) › badges implicit: true when the
    decoded HandoffAcceptPayload.implicit is true (primary branch, projection.service.ts:791)
    expect(received).toBe(expected)
    Expected: true
    Received: undefined
Test Suites: 1 failed, 1 total
Tests:       1 failed, 2 passed, 3 total
```
Only the primary-branch case failed; corroboration and negative-control cases still passed
(as expected — they don't depend on line 791).

*Run 2 — line 792 (corroboration branch) disabled:*
```
FAIL test/integration/handoff-implicit-accept.integration.spec.ts
  ● Handoff implicit-accept (integration, runtime v0.8.0) › badges implicit: true from the
    implicit-accept: message-id prefix alone when the payload is not a decodable implicit
    boolean (corroboration branch, projection.service.ts:792)
    expect(received).toBe(expected)
    Expected: true
    Received: undefined
Test Suites: 1 failed, 1 total
Tests:       1 failed, 2 passed, 3 total
```
Only the corroboration-branch case failed; primary and negative-control cases still
passed (as expected — they don't depend on line 792). Both mutations confirm the
assertions are load-bearing, not accidentally green.

**Local verification:** full `npx tsc --noEmit -p test/tsconfig.test.json` clean; full
`npm test` 815/815 unchanged (56/56 suites — this phase touches no `src/` file); `npm run
build` clean; `npm run lint` clean (scoped to `src/`, unaffected); full mock-mode `npm run
test:integration` **106/106** (22/24 suites, 2 docker-only skipped — up from 103/103,
21/23, confirming the new suite runs and the 6th-parameter extension didn't regress any
of the 57 existing `makeStreamEnvelope` call sites).

**Verify (round 1) — fresh Opus subagent (`a38a79d22fb8d339a`): GAPS.** Independently
reproduced every claimed test result (typecheck, 815/815 unit, build, lint, 106/106
mock-mode integration, both mutation-test outputs verbatim, plus its own independent
cross-check of the proto round-trip through the real production `decodeKnown` path) and
confirmed the test code itself is sound. Found 2 real gaps and 1 non-blocking nit:
1. **(gap)** The Phase 6 divergence note falsely claimed no "§7 verification ledger"
   section exists — it genuinely exists at `plans/absorb-runtime-v0.8.0.md:413`, with
   Phase 1's own evidence already recorded there as precedent, and AC1 explicitly requires
   the mutation-test outputs to be pasted there. The evidence had only been written into
   this file, not into §7 — meaning AC1 wasn't actually fully met.
2. **(gap)** This very checkpoint had pre-declared `PASS` with "[verifier output
   pending]" before any verifier had actually run.
3. **(nit)** Case 3 (negative control) used a custom `handoffImplicitAcceptScript({
   payload: {...} })` call instead of literally reusing the plan-specified
   `handoffAcceptScript()`, an undeclared drift from the plan's literal instruction.

**Gaps closed:**
1. Added a `**Phase 6 — mutation-check outputs (2026-09-22):**` entry to
   `plans/absorb-runtime-v0.8.0.md`'s §7 (Verification ledger), pasting both mutation-run
   output blocks verbatim (same content as this file's Mutation-test evidence above).
   Corrected the Phase 6 section's own divergence note to drop the false "no §7 exists"
   claim.
2. This checkpoint now records the real round-1 verdict instead of a pre-declared one.
3. `test/integration/handoff-implicit-accept.integration.spec.ts` case 3 now imports and
   calls `handoffAcceptScript()` directly (added to the existing `handoff-mode` import),
   removing the custom-fixture drift.

**Re-verification after fixes:** full suite re-run clean — typecheck clean, `npm test`
815/815 unchanged, `npm run build` clean, `npm run lint` clean, full mock-mode
`npm run test:integration` **106/106** again (case 3's script swap caused no regression),
and both mutation tests (line 791, line 792 of `projection.service.ts`) re-run against the
updated case 3 with identical pass/fail results to round 1, `git diff` confirming zero
residual change to `projection.service.ts` afterward.

`plans/absorb-runtime-v0.8.0.md`'s Phase 6 section marked `Status: DONE` with a corrected
divergence note (one parameterized fixture function used instead of three separate ones;
case 3 reuses `handoffAcceptScript()` directly per the plan's literal instruction). No new
`ASSUMPTIONS.md` entries — the plan was fully prescriptive for this phase (exact line
numbers, exact field names, exact three test cases), leaving no genuine ambiguity to log.

**What's next:** re-verify (round 2) with the prior gap list, then commit Phase 6, hand
off to `/ship` (PR for Phase 6) — no behavior-change callout needed (test-only diff, zero
`src/` changes) — then continue the `/implement` loop to Phase 7 (`listSessions()` admin
drift-detection endpoint).
