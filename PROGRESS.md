# PROGRESS — absorb-runtime-v0.7.0

Plan: `plans/absorb-runtime-v0.7.0.md`
Started: 2026-08-31 (via `/drive`)

## Phase log

_(one checkpoint per phase; `/implement` appends)_

| Phase | Status | Rounds | Verifier | Commit | PR |
|---|---|---|---|---|---|
| P1 live harness + ListSessions ground truth | **DONE** | 3 (GAPS→GAPS→PASS) | Opus | `716fa9b` | **merged #61** |
| P2 truth-in-contract for `listSessions` | **DONE** | 2 (GAPS→PASS) | Opus | (head of `absorb-runtime-v0.7.0-p2`) | — |
| P3 ordinal correctness + invariant-6 comments | TODO | — | — | — | — |
| P4 cross-process envelope-ordinal resume | TODO | — | — | — | — |
| P5 live B2 re-verification | TODO | — | — | — | — |
| P6 RFC-MACP-0013 supersedes alignment | TODO | — | — | — | — |
| P7 docs accuracy sweep (proto bump landed via #60) | TODO | — | — | — | — |

## Repo map (gathered during planning — do not re-scan)

### Runtime / gRPC boundary
- `src/runtime/rust-runtime.provider.ts` — the gRPC provider. `listSessions` at **:484+** (rewritten in P2; `MAX_PAGE_SIZE_HALVINGS` at **:72**, `buildCircuitBreaker()` at **:158-171**); `subscribeSession` at **:199-355** (handle gate in consumeLoop at `stream-consumer.service.ts:209`) (single frame written at **:285-288**, session filter at **:257**, no `.end()` anywhere in the file, rationale comment at **:274-283**); `unary()` helper at **:866-900** (per-call deadline at **:876**, circuit breaker at **:874**; already accepted an optional `GrpcCallOptions` on `main` — P2 did **not** change its signature); proto-loader options at **:110-124** (`keepCase: false`); Initialize response version read at **:189**. **Stale comment at :62** claims the write side is closed (P3 fixes).
- `src/contracts/runtime.ts` — `RuntimeProvider` interface. `listSessions` declared **:279**, returning `RuntimeListSessionsResult` (**:107-112**); the false "fully drains" comment was corrected in P2. Policy types from **:280**.
- `src/runtime/proto-registry.service.ts` — `MESSAGE_TYPE_MAP` at **:5-47** (`Commitment → macp.v1.CommitmentPayload` at :8); loads 8 protos at **:65-83** via raw protobufjs; `decodeMessage` at **:155-161**.
- `src/runtime/observer-invariant.spec.ts` — grep-based invariant lint (90 lines). Forbidden patterns **:13-38**; walks `src/` at **:40-52**; comment stripping **:66-77**. **Must not be weakened.**
- `src/runtime/rust-runtime.provider.spec.ts` — frame-semantics tests **:82-211** (`.end()` not called asserted at **:105**, again at **:156**); pagination tests **:214-252** (assert exact request bodies — will break when `pageSize` is added). **Stale file-doc comment at :11-12.**
- `src/runtime/runtime-credential-resolver.service.ts` — JWT mint → static bearer → dev bearer (**:53-58**).

### Stream / run orchestration
- `src/runs/stream-consumer.service.ts` — the per-session consume loop. `resumeFromEnvelopeOrdinal` param **:74**, consumed **:84**; compacted-error classifier **:150-153**; `emitStreamGap` **:160-181**; resume-disabled break **:230**; gap break **:236**; resubscribe with ordinal **:245-249**; poll fallback **:255+**; **ordinal increment :384**; `persistRawAndCanonical` **:388**; cursor persist **:396-397** (guarded by `lastProcessedSeq > 0` — can make the ordinal LAG, see P4). No message-id dedup (**:146-148**, **:206-207**).
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

## Assumptions / decisions log

See `ASSUMPTIONS.md` (created by `/implement` as phases land) and `plans/absorb-runtime-v0.7.0.md` §8.
