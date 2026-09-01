# Absorb macp-runtime v0.7.0 (and 0.6.x) + macp-proto 0.1.9

Status: **in progress** (P1–P5 DONE; P6–P7 TODO)
Owner: control-plane maintainers
Upstream inputs: `macp-runtime` v0.7.0 (`CHANGELOG.md` `[0.7.0] — 2026-08-31`, PRs #116 / #108, `docs/change-review-phases-a-e.md`), `@multiagentcoordinationprotocol/proto` 0.1.8 → 0.1.9.

---

## 1. Context

### What this repo is

`macp-control-plane` is a NestJS **observer-only** service. It never calls `Send`
(invariant guarded by `src/runtime/observer-invariant.spec.ts`); agents emit their
own envelopes directly against the runtime. It creates run records, pre-allocates
session IDs, polls `GetSession`, subscribes read-only to `StreamSession`, watches
`WatchSessions`/`WatchSignals`, and normalizes envelopes → canonical events →
projections → SSE.

### The honest current state

The absorption of v0.5.0 (`plans/absorb-runtime-v0.5.0.md`, landed in #37) left
three things that only became load-bearing at 0.7.0, and one that was already
broken and unnoticed:

1. `listSessions()` grew a forward-looking page-drain loop that, against v0.5.0,
   **provably ran exactly once** — the runtime never returned a token. The
   multi-page branch has therefore only ever executed against a `jest.spyOn`
   mock. 0.7.0 makes it real.
2. `MAX_PAGES = 50` was written as a guard against a buggy looping server. With
   0.7.0's real 100-per-page default it is now a **capacity limit at 5,000
   sessions**, after which the method returns a partial array that is
   *indistinguishable from a complete one*.
3. The v0.5.0 stream-resume work (T7) persists `last_envelope_ordinal` but
   **never reads it back** — `resumeFromEnvelopeOrdinal` has zero callers. The
   column is write-only; cross-process resume silently degrades to poll-only.
   This is a pre-existing defect surfaced by re-reading the path for B2, not a
   0.7.0 regression.

### What 0.6.x / 0.7.0 actually contains

0.6.0 and 0.6.1 are **near** maintenance-only. The 0.6.0 CHANGELOG states:
"No changes to the wire protocol, gRPC surface, or mode semantics — a
`Send`/`StreamSession` client built against 0.5.0 interoperates unchanged."
**That claim is slightly under-reported**: 0.6.0 also changed
`InitializeResponse.version` from a hardcoded `"0.4.0"` to
`env!("CARGO_PKG_VERSION")`, so the runtime now truthfully advertises its
version (impact-matrix item 15). 0.6.1 was release-tooling only (its CHANGELOG
body literally reads `_Nothing yet._`). **Nothing in 0.6.x requires code
absorption**, but the version-string change is worth knowing before someone
debugs a dashboard that suddenly stopped saying `0.4.0`.

0.7.0 contains exactly two substantive changes: PR #116 (ListSessions
pagination) and PR #108 (RFC-MACP-0013 commitment hash). Everything else in the
0.7.0 CHANGELOG is CI, deps, or release plumbing.

### Corrections to the framing this plan was commissioned under

Three premises in the task description turned out to be wrong or imprecise, and
the plan is built on the corrected versions:

- **"macp-proto 0.1.8 → 0.1.9 (published). package.json:30 pins ^0.1.8, which
  resolves 0.1.9 automatically — confirm the lockfile actually moved."**
  **At the time this plan was written the lockfile had not moved, and could not
  have:** a committed `package-lock.json` pins the resolved version regardless of
  the caret range. `package.json:30` was `^0.1.8` and both the lockfile and
  `node_modules` were `0.1.8`, while the runtime was already on 0.1.9
  (`macp-runtime/Cargo.toml:65`, `Cargo.lock:1202-1205`).
  **UPDATE (2026-08-31, mid-implementation):** PR **#60** (`0b5ceab`) landed on
  `main` and performed the bump — `package.json:30` is now `^0.1.9`,
  `package-lock.json:2874` resolves `0.1.9`, and `node_modules` is `0.1.9`. It
  touched **only** those two files, with no accompanying code change, which is
  exactly what the documentation-only finding below predicted. The npm package
  0.1.9 therefore **is** published (the earlier `E401` was a local auth gap, not
  an absent release), and the full suite is green against it (725 tests, lint,
  build). **P7's bump is consequently already done; P7 is now a docs-only sweep.**
  Additionally, **0.1.8 → 0.1.9 is a documentation-only diff** — verified by
  diffing the actual crate sources (`~/.cargo/registry/.../macp-proto-0.1.8/proto`
  vs `-0.1.9/proto`): the only changed file is `macp/v1/core.proto` and every
  changed line is a comment. No field, message, service, RPC, or field-number
  change. The npm package name is also `@multiagentcoordinationprotocol/proto`,
  not `@macp/proto` as `CLAUDE.md` states.
- **"Re-verify B2 passive-subscribe sequence semantics."** B2 shipped in
  **v0.5.0**, not 0.7.0, and `docs/change-review-phases-a-e.md` is the *0.5.0-era*
  change review. This is a re-verification of already-absorbed work that the
  0.5.0 plan's own T11 marked "live pass pending" and never completed — not a
  new absorption. Invariant 6 **does still hold** (see §2 item 5).
- **"RFC-MACP-0013 canonical commitment hash … check whether anything here reads
  or displays commitment_hash / supersedes."** It does — `supersedes` is fully
  wired to `decision.current.supersedes`. But PR #108 adds **no new wire field**:
  `commitment_hash()` is a computed function in `macp-core`
  (`crates/macp-core/src/commitment_hash.rs:44`) with no proto counterpart. The
  only wire field is the pre-existing `CommitmentRef.commitment_hash` inside
  `supersedes`. The change is a *validation tightening*, not a new surface.

### Verified upstream facts this plan relies on

- `ListSessions` is a **keyset scan over session IDs in ascending byte order**;
  `next_page_token` carries the last emitted ID (`macp-runtime/src/server.rs:1275-1330`).
- `page_size = 0` → server default; negative → `INVALID_ARGUMENT`; above max →
  clamped. Default **100**, max **1000**
  (`crates/macp-auth/src/security.rs:53-58`), both overridable via
  `MACP_LIST_SESSIONS_DEFAULT_PAGE_SIZE` / `MACP_LIST_SESSIONS_MAX_PAGE_SIZE`.
- **A response is complete only when `next_page_token` is empty — a page may be
  short while more results remain** (`server.rs:1277-1280`). The runtime fetches
  `effective + 1` IDs so the terminal page carries an empty token with no extra
  round trip (`server.rs:1317-1323`). The CP's loop already honors this
  correctly (it stops on empty token, never on a short page).
- An undecodable `page_token` → `INVALID_ARGUMENT` with a deliberately opaque
  message (the token must not be an oracle) (`server.rs:1302-1315`).
- The §7.3.1 supersedes check now requires `sha256:` + exactly 64 **lowercase**
  hex chars, no trimming, **immediate hard reject with no dual-read window**
  (`crates/macp-modes/src/mode/util.rs:44-91`). Failure is
  `MacpError::InvalidPayload`.
- B2 contract: `after_sequence` is the **1-based accepted-envelope ordinal,
  exclusive** (`0` = from start), compaction-stable; resuming below the compacted
  base returns `FAILED_PRECONDITION`
  (`docs/change-review-phases-a-e.md:225-250`).
- `WatchSessions` initial sync is **completely unpaginated** —
  `get_all_sessions()` yields every session as `CREATED`
  (`macp-runtime/src/server.rs:1372-1390`); `WatchSessionsRequest` is an empty
  message with no cursor. This is why `listSessions` has no caller: WatchSessions
  subsumes it.

---

## 2. Impact matrix

Legend: **IMPACT** = change required here; **NO IMPACT** = verified no change needed; **VERIFY** = no code change, but must be proven against a live runtime.

| # | Change | Verdict | Evidence in this repo | Required action |
|---|---|---|---|---|
| 1 | `ListSessions` genuine pagination (#116) | **VERIFY → IMPACT** | `rust-runtime.provider.ts:452-475` drains `next_page_token` correctly (stops only on empty token, matching the runtime's short-page rule) and tolerates camel/snake response keys (`:469`). But it **never sends `pageSize`** (`:465` sends `{ pageToken }` only), so every page is capped at the server default 100. The multi-page branch has only ever run against `jest.spyOn`-level mocks (`rust-runtime.provider.spec.ts:214-252`); `ScriptedMockRuntimeProvider.listSessions` returns `[]` unconditionally (`test/helpers/scripted-mock-runtime.provider.ts:332`), so **no integration test exercises paging at all**. | P1 (live ground truth) + P2 (send explicit `pageSize`). |
| 2 | `MAX_PAGES = 50` now reachable | **IMPACT (the headline item)** | `rust-runtime.provider.ts:462-474`: on exhaustion it `logger.warn`s and **returns the partial array anyway** — no throw, no flag, no metric. Return type is a bare `RuntimeSessionSnapshot[]` with no completeness bit. The interface comment at `src/contracts/runtime.ts:257-258` asserts it "fully drains the runtime's paginated ListSessions RPC", which is **false in exactly that branch**. Compounding: each page gets a *fresh* 30 s deadline (`:730`) with **no overall bound** → worst case 50 × 30 s = **25 minutes** inside one `await`; and each page passes the circuit breaker individually (`:728`), so a mid-drain trip throws and discards every page already collected. | P2 — make the contract honest. See §5. |
| 3 | `listSessions` has no production caller | **context, not a change** | Repo-wide grep: interface (`contracts/runtime.ts:259`), impl, its 2 specs, and the mock stub. No controller, service, dashboard, or health check calls it. **Blast radius today is zero** — which is precisely why now is the cheapest possible moment to fix the signature, before a caller exists to break. | Rationale for P2's approach. |
| 4 | RFC-MACP-0013 commitment hash (#108) | **NO IMPACT (code) / VERIFY** | No new proto field: `commitment_hash()` is runtime-internal (`macp-core/src/commitment_hash.rs:44`); the wire field `CommitmentRef.commitment_hash` predates 0.1.8 and is unchanged in 0.1.9. CP wiring already exists and is correct: `extractSupersedes` (`projection.service.ts:716-723`) tolerantly reads `commitmentHash ?? commitment_hash`, fed at `:426`, spread into `decision.current` at `:438`, typed at `contracts/control-plane.ts:284-302`, tested at `projection.service.spec.ts:436-468`. The CP deliberately does not resolve the chain (`control-plane.ts:281-283`). The tightening rejects malformed refs as `MacpError::InvalidPayload`, which the CP already maps generically to `message.send_failed` via its stream-inline-error path. | P6 — verification + one behavioral consequence to document (accepted commitments on a 0.7.0 runtime now carry canonical hashes; pre-0013 history may not). |
| 5 | B2 passive-subscribe semantics (0.5.0, re-verify) | **VERIFY — invariant 6 holds** | `subscribeSession` writes **exactly one** frame `{subscribeSessionId, afterSequence}` (`rust-runtime.provider.ts:285-288`), there is **no `.end()` anywhere in the file**, and the comment at `:274-283` explains why. Test-enforced: `rust-runtime.provider.spec.ts:87-106` asserts `expect(stream.end).not.toHaveBeenCalled()`. **README invariant 6 (`README.md:24`) is satisfied verbatim.** | P5 (live re-verification). Two **stale comments contradict it** — see item 6. |
| 6 | Stale comments asserting the opposite of invariant 6 | **IMPACT (docs, but dangerous)** | `rust-runtime.provider.ts:62` (class doc): "…then **closes the write side**." `rust-runtime.provider.spec.ts:11-12` (file doc): "…and then **half-closes the write side**" — while the test body at `:104` asserts the exact opposite. A future maintainer "fixing the code to match the comment" would silently kill live-envelope broadcast. | P3 — correct both. |
| 7 | `last_envelope_ordinal` is write-only | **IMPACT (pre-existing defect)** | Persisted at `stream-consumer.service.ts:396-397` via `runtime-session.repository.ts:47-59` into `schema.ts:71`. But `resumeFromEnvelopeOrdinal` (`stream-consumer.service.ts:74`, consumed `:84`) has **zero callers**: `run-executor.service.ts:353`, `session-discovery.service.ts:143`, and `run-recovery.service.ts:123` all omit it (recovery additionally forces `pollOnly: true`). Resume works only within a single live `consumeLoop` via the in-memory marker; **across a restart the ordinal is discarded**. | P4. |
| 8 | Ordinal incremented *before* persistence | **IMPACT (real, reachable bug)** | `stream-consumer.service.ts:384` increments `marker.envelopeOrdinal`, then `:388` calls `persistRawAndCanonical`. If persistence throws, the exception unwinds to the catch at `:221` and `:245-249` resubscribes with the **already-incremented** ordinal — the envelope is counted as delivered but was never stored. Silent, permanent, single-envelope loss on any transient DB error, with no gap event. | P3 — increment only after a successful persist. |
| 9 | Empty-`sessionId` envelopes bypass the filter and are counted | **IMPACT (latent)** | `rust-runtime.provider.ts:257`: `if (envelope.sessionId && envelope.sessionId !== req.runtimeSessionId) return;` — the truthiness guard means an envelope with an absent/empty `sessionId` is **delivered and counted**. `fromEnvelope` (`grpc-helpers.ts:18-29`) applies no default. Under today's one-session-per-stream binding this is latent, but it is the one path where the CP's ordinal can run *ahead* of the runtime's → resume skips envelopes → silent loss with no gap event. | P3 — decide and enforce explicitly. |
| 10 | CP ordinal is entirely self-inferred, never cross-checked | **accepted risk, document** | Nothing in the CP reads a runtime-supplied sequence; `fromEnvelope` carries none. The counter is a local tally that is *assumed* to match the runtime's accepted-envelope ordinal. Combined with **no message-id dedup** (`stream-consumer.service.ts:146-148`; the unique key is `(run_id, seq)` with a CP-allocated monotonic seq, `schema.ts:102`), an over-count loses data and an under-count duplicates it. This is why "never resubscribe from 0" is load-bearing. | P5 proves the tally empirically; documented in §5/§6. |
| 11 | `@…/proto` 0.1.8 → 0.1.9 | **NO IMPACT (hygiene)** | Documentation-only diff (see §1). Pagination fields and `CommitmentRef.commitment_hash` were already in 0.1.8. Not deliverable by Dependabot — `.github/dependabot.yml` explicitly `ignore`s the package; bumps come via `.github/workflows/bump-proto.yml` (`repository_dispatch: proto-released`). **RESOLVED mid-implementation:** npm 0.1.9 is published and landed via PR **#60** (`0b5ceab`), which touched only `package.json` + `package-lock.json` — no code change, confirming the documentation-only finding. Suite green against 0.1.9. | P7 — **bump already done upstream**; P7 reduces to the docs sweep. |
| 12 | 0.6.0 / 0.6.1 | **NO IMPACT** | CHANGELOG: maintenance only. Negative-outcome conformance fixtures are runtime-internal; CP fixtures are hand-written TS mock scripts. One under-reported wire change — see item 15. | None beyond item 15. |
| 15 | `InitializeResponse.version` `"0.4.0"` → real version (0.6.0) | **NO IMPACT (cosmetic)** | The runtime previously hardcoded `"0.4.0"`; 0.6.0 switched it to `env!("CARGO_PKG_VERSION")`, so it now reports `"0.7.0"`. The CP reads it at `rust-runtime.provider.ts:189` (`version: response.runtimeInfo?.version`) into the manifest/session record. **Grep confirms no version gating, comparison, or semver logic anywhere in `src/`** — it is stored and displayed only. Strictly an improvement (the old value was a lie). | None. Documented in P7 so a dashboard change is not mistaken for a regression. |
| 16 | `HandoffAcceptPayload.implicit` — runtime rejects client-submitted `true`; still no synthetic accepts | **NO IMPACT (corrects a v0.5.0 forecast)** | The runtime now rejects any agent-submitted `implicit = true` with `InvalidPayload` (`crates/macp-modes/src/mode/handoff.rs:236-241`), and the implicit-accept timeout still only mutates **internal mode state** (`handoff.rs:284-306`) — it emits **no envelope**. The CP never submits accepts (observer), so the rejection cannot bite it. But this **falsifies item 20 of the v0.5.0 plan**, which forecast that the runtime would emit synthetic HandoffAccept envelopes with `implicit: true` into history; the CP's badge-rendering work has no producer and will not have one at 0.7.0. | None. Correct the stale forecast in P7's docs sweep. |
| 13 | `WatchSessions` initial sync unbounded | **NO IMPACT (flag it)** | The runtime yields every session as `CREATED` on every (re)connect with no pagination available (`server.rs:1372-1390`). `SessionDiscoveryService.knownSessions` (`session-discovery.service.ts:22`) is an **unbounded in-memory `Set<string>`** that is never evicted. Both are pre-existing and out of scope for a 0.7.0 absorption, but they are the real scaling limit — not `listSessions`. | Out of scope; recorded in §6. |
| 14 | Observer invariant test | **must not weaken** | `observer-invariant.spec.ts` is **grep-based**: it strips comments and regex-matches 4 literals (`provider\.send\s*\(`, `openSession\s*\(`, `chooseInitiator\s*\(`, `retryKickoff\s*\(`) per line across `src/`. Large false-negative surface (any receiver not literally named `provider`, bracket dispatch, multi-line calls, `test/`+`scripts/` unscanned, and **`*.spec.ts` excluded** at `:47`). The stronger guarantee is structural: `RuntimeProvider` has **no `send` member**, so `provider.send(...)` is a compile error. | No phase weakens it. P2 changes only `listSessions`' return type. Strengthening it is explicitly **out of scope** (§6). |

---

## 3. Work plan

### Phase 1 — Live 0.7.0 harness + ListSessions ground truth

- **Status:** DONE — *divergence:* the planned fixture (the 131 persisted sessions) turned out to be
  unusable (all terminal, evicted at startup), so 150 live sessions had to be seeded from an
  out-of-repo agent-role client. The spec also dropped `createTestApp()` for a directly-constructed
  `RustRuntimeProvider`: booting the full app against a real runtime made `SessionDiscovery`
  auto-create ~150 runs and ~150 streams via `WatchSessions`' unpaginated initial sync, with no
  `cleanup()`. The direct construction removes that leak *and* removes the DB dependency, which is
  what let the spec actually run on a host whose test Postgres is broken.
- **Delivers:** A reproducible way to run a real macp-runtime 0.7.0 locally against a session store holding >100 sessions, plus a written record of the **actually observed** `ListSessions` wire behavior — replacing the assumption baked into `rust-runtime.provider.ts:453-457`.
- **Depends on:** nothing.
- **Files:** `test/integration/list-sessions-pagination.integration.spec.ts` (new, gated), `test/helpers/real-runtime-gate.ts` (new — the inverse `describe`/`describe.skip` gate), `docs/TROUBLESHOOTING.md` (how to run a local runtime), `.gitignore` (ignore `.drive.lock`), `PROGRESS.md`, `ASSUMPTIONS.md`, `plans/absorb-runtime-v0.7.0.md` §7.
- **Approach:** Verify *before* changing, so P2 is designed against measured behavior rather than inference. **The runtime must be built first — there is no prebuilt binary.** `../macp-runtime/target/` does not exist (a debug binary was observed earlier in this planning session and has since disappeared, so the build state is *not* stable and no phase may assume it). Build with `cargo build` in `../macp-runtime` (toolchain pinned in `rust-toolchain.toml`; MSRV 1.89). **The persisted store is NOT usable as a fixture.** `.macp-data/sessions/` holds 131 sessions, but every one is terminal and the runtime evicts them at startup (`evicted stale sessions from memory ... count=131`, `../macp-runtime/src/runtime.rs:1200-1237`); `ListSessions` and `GetSession` return nothing for them. **>100 live OPEN sessions must be seeded** before this phase can prove anything. Boot:
  ```
  MACP_ALLOW_INSECURE=1 MACP_BIND_ADDR=127.0.0.1:50051 RUST_LOG=info \
    cargo run --bin macp-runtime          # or ./target/debug/macp-runtime once built
  ```
  (`MACP_ALLOW_INSECURE=1` is mandatory — without auth configured the runtime refuses to start — and it also waives the TLS requirement. Dev mode accepts **any** `Authorization: Bearer <v>` as sender `<v>`, so the CP's existing dev-bearer fallback works unchanged.) Probe with `grpcurl` for raw wire truth first, independent of CP code, then add a CP-level integration test gated on `INTEGRATION_RUNTIME=remote`. **The test must read the page size from config/env, not hardcode it**, so P2 can keep it low (e.g. 50) and preserve the multi-page condition after P2 raises the default (see P2 AC6). **Seeding is required, not optional** — the original plan wrongly rejected it on the assumption the persisted store sufficed. Seed from an **agent-role** client kept OUTSIDE this repo (the control-plane must never contain `Send`-capable code), spread across sender identities because `MACP_SESSION_START_LIMIT_PER_MINUTE` defaults to **60/sender**. `docs/TROUBLESHOOTING.md` documents the procedure and its four non-obvious gotchas.
  **Gating note:** every existing gated spec uses the *inverse* gate (`isRealRuntime ? describe.skip : describe`, e.g. `test/integration/stream-gap.integration.spec.ts:10-12`). P1/P5 need the opposite (run **only** when real) and no shared helper exists — add one in `test/helpers/`.
- **Edge cases & failure modes:** The store is shared mutable state — assert *relative* facts (a full drain returns ≥ the first page; IDs unique and ascending) not absolute counts. Ordering is ascending **byte order of `session_id`**, and IDs are UUID v4, so **page order is unrelated to creation order** — no test may assume recency ordering. Keyset pagination means a session created mid-drain sorting below the cursor is **missed** (never duplicated), so exact totals are not assertable against a concurrent writer. Two non-obvious legal responses the test must tolerate rather than treat as bugs: **(a)** a **short page with a non-empty token** — the runtime skips IDs whose session vanished between the ID scan and the per-ID fetch (`server.rs:1341-1345`); **(b)** in the degenerate case, an **empty `sessions` array with a non-empty token**. Neither means "done"; only an empty token does. If the local store is under 100, the test must skip loudly rather than pass vacuously.
- **Acceptance criteria:**
  0. `cargo build` succeeds in `../macp-runtime` and the binary reports **v0.7.0** on startup.
  1. Documented, reproducible command sequence that starts a real 0.7.0 runtime and confirms >100 sessions present.
  2. A **gRPC client transcript** committed into this plan's §7 showing `next_page_token` non-empty for a store >100 with `page_size=0` — i.e. the v0.5.0 comment's premise is now false. (Originally worded "grpcurl transcript"; the committed artifact in §7 is an equivalent transcript produced through a gRPC client because the runtime exposes **no reflection**, so grpcurl requires `-import-path`/`-proto` and its raw JSON is less legible. The decoded cursor is included so the claim is independently checkable.)
  3. The same transcript shows the terminal page carrying an **empty** token.
  4. A CP-level test proving `provider.listSessions()` returns **more than one page's worth** of sessions against the real runtime (the multi-page branch executes for real for the first time).
  5. The test is skipped, not failed, whenever `INTEGRATION_RUNTIME` is `mock` (the default). **Gate polarity is deliberately "not mock", not an allowlist of `remote`** — it must match `test/helpers/test-app.ts:68`, which boots the real provider for any value other than `mock`; an allowlist would let a value like `REMOTE` boot the real provider while this spec silently skipped. Consequence to accept: a manual `workflow_dispatch` of `integration-tests.yml` with `runtime_mode: docker` now runs this spec against an ephemeral runtime with 0 sessions and fails loudly. Automatic CI is unaffected (`ci.yml:132` pins `mock`).
- **Tests:** the new gated integration spec; `npm test` unaffected.
- **Docs:** `docs/TROUBLESHOOTING.md` — running a local runtime for verification.

### Phase 2 — Truth-in-contract for `listSessions`

- **Status:** DONE
- **Delivers:** `listSessions` can no longer return a truncated list that looks complete; a bounded, configurable, observable drain.
- **Depends on:** P1.
- **Files:** `src/contracts/runtime.ts`, `src/runtime/rust-runtime.provider.ts`, `src/runtime/rust-runtime.provider.spec.ts`, `test/helpers/scripted-mock-runtime.provider.ts`, `src/config/app-config.service.ts`, `src/config/app-config.service.spec.ts` (startup validation of the new knobs), `src/telemetry/instrumentation.service.ts`, `src/telemetry/instrumentation.service.spec.ts`, `.env.example`, `docs/INTEGRATION.md` (its Environment Variables section, `:139`), `CLAUDE.md` (local-only — see P7).
- **Approach:** Change the return type to an explicit result object:
  ```ts
  interface RuntimeListSessionsResult {
    sessions: RuntimeSessionSnapshot[];
    complete: boolean;     // false ⇒ the drain stopped early; `sessions` is a prefix
    pagesFetched: number;
  }
  ```
  **Why a completeness bit rather than a throw:** for an observer UI a *labeled*
  partial list is strictly more useful than an exception — the caller can render
  5,000 sessions with a "showing first N" banner. A throw would make the method
  useless at exactly the scale it was built for. **Why not keep the bare array
  plus a louder log:** a log is not reachable by the caller; the whole defect is
  that callers cannot tell. With **zero production callers today**, changing the
  signature costs 2 implementations + 2 specs and nothing else — this is the
  cheapest moment it will ever be.
  Three supporting changes in the same phase, because each is part of "the drain
  is honest and bounded":
  - **Send an explicit `pageSize`** (new `RUNTIME_LIST_SESSIONS_PAGE_SIZE`, default **200**) and raise `MAX_PAGES` (new `RUNTIME_LIST_SESSIONS_MAX_PAGES`, default **200**). That lifts the truncation ceiling from 5,000 to **40,000** while halving round-trips. **Deliberately not 1000** (the runtime max): the gRPC client is constructed with **no channel options** (`rust-runtime.provider.ts:135`), so grpc-js's default **4 MB** `grpc.max_receive_message_length` applies. `SessionMetadata` carries `repeated string participants`, `repeated ParticipantActivity`, and `repeated string extension_keys`, and a session may have up to 1000 participants — at ~3–4 KB per session a 1000-item page reaches ~4 MB and the call fails with `RESOURCE_EXHAUSTED`, converting a working-but-truncating drain into a **total failure**. 200 keeps a worst-case page well under the limit. Values above the runtime's max are clamped server-side, so a higher configured value is safe from the server's perspective but not from the client's — which is exactly why the default is conservative.
  - **Bound the whole drain** with `RUNTIME_LIST_SESSIONS_TIMEOUT_MS` (default 60000), replacing the unbounded 50 × 30 s worst case. On expiry, return `complete: false` — same honest signal, not an exception.
  - **Observability:** add `macpRuntimeListSessionsTruncatedTotal` (Counter) and `macpRuntimeListSessionsPages` (Histogram) as fields on `InstrumentationService`, per the repo rule that all metrics are constructed there.
  Keep `MAX_PAGES` as a guard (now configurable via `RUNTIME_LIST_SESSIONS_MAX_PAGES`); it is still the only defense against a server that never clears the token. Also correct the now-false comments at `rust-runtime.provider.ts:453-457` and `contracts/runtime.ts:257-258`.
- **Edge cases & failure modes:** A circuit-breaker trip or gRPC error mid-drain still throws and discards collected pages — **unchanged and deliberate** (a partial result from a *failing* runtime is not trustworthy the way a page-capped one is); documented, not silently converted to `complete: false`. **`RESOURCE_EXHAUSTED` is the one exception worth special handling**: it means the page itself was too large to receive, and retrying the same page identically will fail identically. Halve the page size and retry that page (down to a floor of 1); if it still fails, throw. Without this, a deployment with large sessions gets a permanently broken `listSessions` rather than a slower one. `pageSize` configured above 1000 is clamped by the server, not rejected. `pageSize` of 0 would mean "server default" — the config must reject 0 and negatives at startup (negatives are an `INVALID_ARGUMENT` from the runtime). The two existing specs assert exact request bodies (`toEqual({ pageToken: '' })`) and **will fail the moment `pageSize` is added** — they are the intended tripwire and must be updated deliberately, not loosened.
- **Acceptance criteria:**
  1. `listSessions()` returns `RuntimeListSessionsResult`; no code path returns a truncated list without `complete: false`.
  2. Exhausting `MAX_PAGES` sets `complete: false`, increments the truncation counter, and still returns the collected prefix.
  3. Exceeding the overall timeout sets `complete: false`.
  4. The request carries an explicit `pageSize` from config.
  5. Both `RuntimeProvider` implementations compile and the interface comment no longer claims an unconditional full drain.
  6. A live re-run of P1's test returns multi-page results with `complete: true`. **Note the interaction:** once P2 raises the page size to 200, a ~150-session store fits in ONE page and the multi-page assertion becomes vacuous. So the live re-run must either seed >200 sessions, or set `RUNTIME_LIST_SESSIONS_PAGE_SIZE` low (e.g. 50) so multiple pages are still exercised. ~~P1's spec already reads that variable, so no test change is needed — only the env.~~ **CORRECTED during implementation — this sentence was false on two counts.** (a) P1's spec builds its `config` fixture as an object literal; without the three new knobs added to it, `this.config.runtimeListSessionsMaxPages` is `undefined` and `while (pagesFetched < undefined)` is `false` on the first check, so the drain loop never executes at all and the spec returns `{sessions: [], complete: false, pagesFetched: 0}` having issued zero RPCs. (b) The `EXPECTED_PAGE_SIZE` floor (100) became actively wrong once the CP sends its own `pageSize`: at the default 200 a **single** 150-session page satisfies `length > 100`, which is exactly the false green the floor existed to prevent. The spec was therefore rewritten to assert `pagesFetched > 1` directly (a real assertion on the loop branch rather than an inference from length) plus a new `complete === true`, keeping the uniqueness and ascending-order checks. This executes the TODO P1's own comment left for P2.
  7. `npm run lint` clean; no `new Counter(...)` outside `instrumentation.service.ts`; no `process.env` outside `app-config.service.ts`.
- **Tests:** unit — updated multi-page test asserting the new request shape incl. `pageSize`; **new** MAX_PAGES-exhaustion test (currently zero coverage of that branch) asserting `complete: false` + counter bump; new overall-timeout test; single-page test asserting `complete: true`. Live — P1's gated spec re-run.
- **Docs:** `CLAUDE.md` env table (3 new vars), `.env.example`, the `RuntimeProvider` contract comment.
- **Divergence from the planned approach (recorded at phase close):**
  1. **The halving ladder had to be capped.** The plan specified "halve the page size and retry
     that page (down to a floor of 1)". Implemented as written, that is up to 8 consecutive
     attempts from the default page size of 200 — and every attempt runs through the **shared**
     circuit breaker, whose default threshold is 5. The phase verifier reproduced this against
     the real `CircuitBreaker`: the breaker opened on attempt 5, the drain aborted with
     `Circuit breaker is OPEN` instead of the intended rethrow, and the breaker stayed OPEN for
     30s, failing every unrelated runtime RPC process-wide. Fixed with
     `MAX_PAGE_SIZE_HALVINGS = 2` (3 attempts total, deliberately under the breaker threshold),
     plus a regression test that runs the real breaker instead of stubbing `unary()`. The plan
     reasoned about the retry in isolation and never considered the breaker.
  2. **Mid-page `DEADLINE_EXCEEDED` now returns `complete: false`.** The plan's AC3 promised
     "exceeding the overall timeout sets `complete: false`", but the per-call deadline is clamped
     to the remaining drain budget, so a budget that expires *during* a page (the likelier case)
     surfaced as `DEADLINE_EXCEEDED` and discarded every collected page. The CP induces that
     failure itself, so it is now converted to a truthful partial result; a `DEADLINE_EXCEEDED`
     with budget still remaining (a genuinely slow runtime) still throws.
  3. **`RUNTIME_LIST_SESSIONS_TIMEOUT_MS` validation and integrality enforcement** were not in the
     plan. `0` — including a blank `.env` entry, since `Number('') === 0` — produced a permanently
     empty `complete: false` result having issued zero RPCs, which is the exact silent-degradation
     class this phase exists to remove.
  4. **`docs/TROUBLESHOOTING.md` was not in the Files list** but was made stale by this phase (it
     described the runtime's server-side 100/page default, which the CP now overrides, and its
     prescribed command no longer made the live spec pass). Updated.

### Phase 3 — Stream-consumer ordinal correctness + invariant-6 comment fixes

- **Status:** DONE
- **Delivers:** The envelope ordinal can no longer drift ahead of what was actually persisted; the two comments that contradict invariant 6 are corrected.
- **Depends on:** nothing (independent of P1/P2).
- **Files:** `src/runs/stream-consumer.service.ts`, `src/runs/stream-consumer.service.spec.ts`, `src/runtime/rust-runtime.provider.ts` (comment + filter), `src/runtime/rust-runtime.provider.spec.ts` (comment + new case).
- **Approach:** Two correctness fixes and one doc fix.
  - **Increment after persist.** Move the `marker.envelopeOrdinal += 1` at `stream-consumer.service.ts:384` to *after* `persistRawAndCanonical` (`:388`) returns successfully. **Scope, stated precisely:** the *persisted* ordinal is already safe — `updateStreamCursor` runs at `:397`, after the persist, so a persist failure throws before the DB value can advance. What the early increment corrupts is the **in-memory** `marker`, which feeds the *in-process* resubscribe at `:249`. So this fixes the live-reconnect path, **not** P4's cross-process path. (An earlier draft of this plan called it a strict prerequisite for P4; that was wrong and is corrected here.) Rejected: try/catch that rolls the counter back — equivalent but harder to reason about under partial failure.
  - **Empty-`sessionId` envelopes.** Make the filter explicit at `rust-runtime.provider.ts:257`: on the **per-session `StreamSession` subscription only**, an envelope whose `sessionId` does not equal the subscribed session is dropped, *including* when empty/absent, and logged at `warn`. **Important scoping:** empty `sessionId` is *not* anomalous in general — ambient **Signal envelopes always carry an empty `sessionId`** and correlate via `correlation_session_id` (`src/runs/signal-consumer.service.ts:82-86`, `:96-97`). Those arrive through `watchSignals`, which shares `fromEnvelope` but has **no** session filter (`rust-runtime.provider.ts:614`) and does not touch the envelope ordinal. So the drop must live in the StreamSession filter and must **not** be lifted into `fromEnvelope` or any shared helper, or ambient signals break. Rejected: counting them and hoping — the failure mode (silent skip on resume, no gap event) is unrecoverable and undetectable.
  - **Comments.** Correct `rust-runtime.provider.ts:62` and `rust-runtime.provider.spec.ts:11-12` to state that the write side is deliberately **kept open**, citing README invariant 6 and RFC-MACP-0006 §3.2.
- **Edge cases & failure modes:** If persistence is retried at a higher level, the ordinal must not double-increment for one envelope — the increment must be in the same straight-line path as the successful persist, executed once. The runtime **does** legitimately emit empty-`sessionId` envelopes — but only on the ambient signal bus, never on a per-session `StreamSession` (see Approach). The risk is therefore not "does this happen" but "is the drop scoped correctly": a filter placed in shared code would silently break `SignalConsumerService` and, with it, all token-usage/cost accounting. The `warn` log makes any unexpected drop diagnosable rather than silent.
- **Acceptance criteria:**
  1. A persist failure leaves `envelopeOrdinal` unchanged; the subsequent resubscribe uses the pre-failure ordinal.
  2. An envelope with an empty `sessionId` is not yielded to the consumer and does not increment the ordinal; it is logged.
  3. `grep -rn 'close.*write side\|half-clos' src/` returns only the two *correct* statements — the rationale comment at `rust-runtime.provider.ts:274-283` ("We deliberately do NOT half-close the write side here") and its updated spec counterpart. Neither of the two stale assertions (provider `:62`, spec `:11-12`) survives.
  4. `observer-invariant.spec.ts` passes unmodified.
  5. All existing stream-consumer specs still pass.
- **Tests:** unit — persist-throws leaves the ordinal unchanged (new); empty-`sessionId` envelope filtered + logged (new); existing ordinal/resume/gap specs (`stream-consumer.service.spec.ts:338-484`) unchanged and green; existing frame-semantics specs (`rust-runtime.provider.spec.ts:82-211`) unchanged and green.
- **Docs:** none (comment-level only).
- **Divergence / notes from implementation (recorded at phase close):**
  1. **A third false comment was found and fixed**, beyond the two the plan named. The filter
     block still asserted "Runtime may broadcast across sessions on a shared stream" — that is
     false. The verifier established from `../macp-runtime` that the stream bus is strictly
     per-session (`src/stream_bus.rs:8-46` is a per-session-keyed broadcast map; the emit loop
     has no `session_id` filter *because the channel is the filter*), and that empty-`session_id`
     envelopes are structurally impossible on `StreamSession` (`src/runtime.rs:229-232` guards
     publish on `!env.session_id.is_empty()`). Left standing, that false premise is exactly the
     justification a future reader would use to argue the new `warn` is too noisy.
  2. **Both new filter branches are unreachable against a conforming runtime.** That is the
     point — a firing `warn` means a protocol violation or a proxy/routing bug, so warn-once or
     a counter would be *worse*: they would suppress a signal that should never appear even once.
  3. **The plan's line references were stale** (P2 shifted the provider by ~32 lines): the stale
     header comment was at `:84`, not `:62`, and the spec comment at `:15`, not `:11-12`.
  4. **A post-commit failure window was documented and tested** but deliberately not changed.
     `persistRawAndCanonical` commits its transaction and *then* runs metrics + StreamHub
     publish; if those throw, the events are already durable, so the resubscribe redelivers and
     appends duplicates (there is no message-id dedup, and `onConflictDoNothing` cannot fire
     because each append gets a fresh UUID and seq). Duplication-over-loss is the right trade —
     pre-fix, the same failure advanced the ordinal and caused silent **loss** — but the comment
     now says so explicitly instead of claiming an unqualified guarantee.

### Phase 4 — Cross-process envelope-ordinal resume

- **Status:** DONE
- **Delivers:** `last_envelope_ordinal` stops being write-only — a control-plane restart resumes the stream from the last durably-ingested envelope instead of degrading to poll-only.
- **Depends on:** nothing structurally (see P3's corrected scope — the *persisted* ordinal is already persist-gated). P3 is **sequenced** before it because both touch the same resume machinery and landing them together keeps one mental model, not because P4 is unsafe without it.
- **Files:** `src/runs/run-recovery.service.ts`, `src/runs/stream-consumer.service.ts`, `src/runs/run-recovery.service.spec.ts`, `src/runs/stream-consumer.service.spec.ts`, `test/integration/stream-gap.integration.spec.ts` (must stay green — it covers the FAILED_PRECONDITION → gap → poll-only path this phase touches), `docs/ARCHITECTURE.md`.
- **Approach:** **This is roughly 3× the "wire the last mile" it first appears to be.** Passing `resumeFromEnvelopeOrdinal` alone accomplishes *nothing*: that param only seeds `marker.envelopeOrdinal` (`stream-consumer.service.ts:84`), which is consumed by the resubscribe at `:246-249` — and that entire block is gated behind `if (handle && !params.pollOnly)` (`:209`). `RunRecoveryService` today calls `streamConsumer.start({… pollOnly: true})` (`:123-131`, the flag itself at `:130`) with **no `sessionHandle`**, and its constructor (`run-recovery.service.ts:16-24`) has **no `RuntimeProviderRegistry`** at all. So P4 must:
  1. inject `RuntimeProviderRegistry` into `RunRecoveryService` (no `app.module.ts` change needed — both are already registered),
  2. resolve the provider and call `subscribeSession({ runId, runtimeSessionId, afterSequence: session.lastEnvelopeOrdinal })` to obtain a handle,
  3. pass that handle and drop `pollOnly: true` when `streamResumeEnabled` — falling back to today's poll-only path when the flag is off or the subscribe fails.
  Keep it behind the existing `STREAM_RESUME_ENABLED` flag so it is revertible by config, not redeploy. The `FAILED_PRECONDITION` → `session.stream.gap` → poll-only path already exists and is the designed safety net for a compacted resume point. Rejected: adding message-id dedup so resume-from-0 becomes safe — a much larger change (new index, new column, ingest-path rewrite) that this absorption does not need; the ordinal path is the design the runtime's B2 contract was written for.
- **Edge cases & failure modes:** **This is the riskiest phase — see §5.** There is no message-id dedup, so an ordinal that is too low duplicates events into an append-only log (not cleanly reversible per-run) and one that is too high loses them silently. `run-recovery.service.ts:130` currently forces `pollOnly: true`; that was the deliberate conservative choice in the 0.5.0 plan and this phase reverses it, so it must be justified by live evidence (P5), not unit tests against the CP's own model of the contract. A resume point compacted away must produce the gap event, never a resubscribe from 0.
  **The specific way the persisted ordinal can be wrong — it lags.** `updateStreamCursor` at `:396-397` is guarded by `if (marker.lastProcessedSeq > 0)`. An envelope that normalizes to **zero canonical events** advances `marker.envelopeOrdinal` but leaves `lastProcessedSeq` at 0, so the whole persist is skipped and the stored ordinal falls behind what was actually delivered. On restart the CP then resumes *too low* and re-ingests — duplicates, with no dedup to catch them. P4 must either persist the ordinal independently of that guard or prove no envelope can normalize to zero events; P5 must assert it live.
  Subscribing during recovery also means a **failed subscribe must not fail recovery** — fall back to poll-only and log, rather than leaving the run unrecovered.
- **Acceptance criteria:**
  1. After a simulated restart with the flag on, `RunRecoveryService` resolves a provider and calls `subscribeSession` with `afterSequence` equal to the persisted `lastEnvelopeOrdinal` — not 0, and not poll-only.
  1b. A `subscribeSession` failure during recovery degrades to poll-only and the run is still recovered.
  2. With `STREAM_RESUME_ENABLED=false`, `RunRecoveryService` calls `streamConsumer.start()` with `pollOnly: true` and **no** `sessionHandle` — identical to today, asserted on the call arguments.
  3. A `FAILED_PRECONDITION` on the resumed subscribe emits `session.stream.gap`, sets `historyGap`, and falls back to poll-only without resubscribing from 0.
  4. No canonical event is duplicated or lost across the restart in the live test (P5).
- **Tests:** unit — recovery passes the persisted ordinal; disabled-flag path unchanged; compacted-resume path. Live — covered by P5.
- **REVISED BEFORE IMPLEMENTATION — Fable one-way-door analysis (this phase is the plan's riskiest,
  so it was routed to Fable before any code was written). Three corrections:**
  1. **The stated mechanism for the lag hazard is FALSE.** A zero-canonical-event envelope is
     unreachable: `EventNormalizerService.normalize()` pushes `message.received` unconditionally for
     any `kind === 'stream-envelope'` raw with an envelope present (decode failure falls back to
     `payloadBase64`; an unmapped type only suppresses the *derived* event), and the consumer's
     increment predicate `raw.kind === 'stream-envelope' && raw.envelope` is the exact complement of
     the normalizer's early return. They are lockstep. Moreover the guard tests the **cumulative**
     `marker.lastProcessedSeq`, and the provider synthesizes a `stream-status: 'opened'` frame as the
     first item of every subscription, which normalizes to `session.stream.opened` with a positive
     seq — so `lastProcessedSeq > 0` before any envelope can arrive.
  2. **The real hazard, which this plan never identified: the poll path clobbers the ordinal to 0.**
     `updateStreamCursor` is a blind `.set()`, and `RunRecoveryService` passes `resumeFromSeq` but
     **not** `resumeFromEnvelopeOrdinal`, so the marker seeds `envelopeOrdinal: 0`. The first poll
     cycle's `session-snapshot` normalizes to a positive seq, the guard passes, and `0` is written
     over the real ordinal — destroying the resume point within one poll cycle of **every** restart.
     The impact matrix's "write-only, discarded across restart" understates it. A run surviving two
     restarts (or any flag-off recovery, which AC2 as written would enshrine) then resumes from 0 —
     which the runtime accepts as legitimate — and re-ingests the entire session as duplicates.
  3. **A too-high resume is completely silent**, worse than "no gap event": `get_incoming_after`
     returns `Ok(empty)` both for an out-of-range ordinal and for a missing/evicted session log, and
     the live broadcast is attached before replay regardless — so the skipped range disappears with
     no error, no gap, and live envelopes still flowing. There is no observable symptom even in
     principle. This is why the implementation must bias deliberately toward too-low.
- **REVISED approach (supersedes the guard bullet above):** do **both**, neither alone is sufficient.
  1. **Make the persist monotonic in SQL** in `RuntimeSessionRepository.updateStreamCursor`:
     `last_stream_cursor = GREATEST(COALESCE(last_stream_cursor, 0), $cursor)` and
     `last_envelope_ordinal = GREATEST(last_envelope_ordinal, $ordinal)`. Both values are strictly
     monotonic per run by their own semantics, so a floor is a no-op on the happy path and makes the
     whole clobber class — unseeded markers, future caller mistakes, races — structurally impossible.
     It does not change `last_stream_cursor`'s semantics: `recoverRun` already treats it as a floor
     via `Math.max`. Still one UPDATE, no extra hot-path write. Keep the `lastProcessedSeq > 0` guard
     (harmless; removing it buys nothing). Rejected: relying on the zero-event proof alone — it is
     real but *incidental*, resting on two separate files staying in lockstep, and any future
     normalizer filter would silently break it.
  2. **Seed `resumeFromEnvelopeOrdinal: session.lastEnvelopeOrdinal` on EVERY recovery path** —
     flag-on, flag-off, and the subscribe-failure fallback. The ordinal is a property of the
     session's history, not of the transport mode.
- **AC2 is AMENDED:** with `STREAM_RESUME_ENABLED=false`, recovery still calls `start()` with
  `pollOnly: true` and no `sessionHandle` — but **now also with `resumeFromEnvelopeOrdinal` seeded**.
  "Identical to today" was wrong: today's behavior is the clobber bug.
- **AC1b is NARROWED:** `subscribeSession` never throws synchronously (`launch()` catches into
  `streamFailure` and surfaces it through the iterator), so the try/catch guards a near-unreachable
  branch. Keep it, but the meaningful assertions are that the seeded ordinal reaches the subscribe
  frame and that an async failure lands in poll-only with the run still recovered.
- **SEQUENCING DECISION:** do **not** reorder P5 before P4 (P5's cross-restart assertion exercises
  P4's code; run earlier it can only test the in-process path), and do **not** flip the
  `STREAM_RESUME_ENABLED` default to false as a hedge — the flag also gates the already-shipped
  in-process resume, so flipping it would regress working v0.5.0 behavior for everyone in order to
  de-risk an unshipped feature. **Instead: implement P4 and P5 together on one branch, run the live
  spec against a real 0.7.0 runtime, and merge them atomically.** That makes this plan's own rule —
  "P4 should not ship without P5's live evidence" — literal rather than aspirational. If no live
  runtime can be run, **hold P4 unmerged** rather than merge behind a flipped default.
- **Deferred, recorded not fixed:** the cursor write sits outside `persistRawAndCanonical`'s
  transaction, so a crash between commit and cursor write lags the stored ordinal by exactly 1 → one
  duplicated envelope on restart. Folding it into the hot-path transaction is a larger change than
  this phase needs. Consequence for P5: its exactly-once assertion must target a **clean** stream
  break — a `kill -9` mid-persist can legitimately produce one duplicate, and the live test must not
  be written to flake on that.
- **Docs:** `docs/ARCHITECTURE.md` — **add** a stream-resume/recovery section. There is no existing one to correct (the only nearby text is `:102`, "persists a stream cursor for lossless resume").

### Phase 5 — Live B2 re-verification against a real 0.7.0 runtime

- **Status:** DONE
- **Delivers:** The re-test the runtime's own change review explicitly asks for, and the empirical evidence P3/P4 depend on. Closes the 0.5.0 plan's never-completed T11.
- **Depends on:** P1 (harness), P3, P4.
- **Files:** `test/integration/stream-resume-live.integration.spec.ts` (new, gated), `plans/absorb-runtime-v0.7.0.md` (results), `PROGRESS.md`.
- **Approach:** Against a real runtime, drive a session with a known number of envelopes, force a stream break mid-session, let the CP resubscribe, and assert the canonical event log contains **each envelope exactly once** — no duplicates, no gaps. This is the only test in the repo that validates the CP's ordinal against the *runtime's* semantics rather than against `ScriptedMockRuntimeProvider`, which re-implements the skip rule itself (`test/helpers/scripted-mock-runtime.provider.ts:150-161`) and therefore validates the CP against the CP team's own model of the contract. Also assert invariant 6 empirically: after the single subscribe frame, envelopes produced *later* still arrive (proving the write side is open and the runtime is still broadcasting).
- **Edge cases & failure modes:** Producing envelopes requires an agent that can `Send` — the CP cannot and must not. Use the runtime's example clients (built by P1's `cargo build`; they are **not** prebuilt) or `macp-sdk-python` as the emitting agent; the CP stays a pure observer throughout.
  **The stream break needs a named seam.** As a pure observer the CP has no error-injection point, and the test cannot reach into the provider's private `grpcCall`. Two workable seams, in preference order: **(a)** restart the *runtime* process mid-session — the CP's stream errors naturally and the reconnect path runs end-to-end, which also exercises exactly the cross-process case P4 changes; **(b)** call the consumer's existing `abort()`/stop path and restart it, which tests resume without testing the error classification. Prefer (a); it is the only one that proves the whole path. If neither is achievable, downgrade the criterion to "resume-after-restart verified" and record the error-injection case as static-only rather than quietly claiming it.
  Timing-sensitive: the break must land mid-session, so sequence on observed events, not sleeps. If the runtime cannot be started in CI, the spec must skip loudly and the plan must record the verification as local-only.
- **Acceptance criteria:**
  1. Exactly-once ingestion across a forced stream break against a **real** runtime, asserted on the canonical event log.
  2. Envelopes emitted after the subscribe frame are delivered — invariant 6 proven live, not just by unit assertion.
  3. Resuming below a compacted base yields `FAILED_PRECONDITION` → `session.stream.gap` (or is recorded as untestable locally, with the reason).
  4. The final report states plainly which of these ran against a live runtime and which remained static-only.
- **Tests:** the new gated spec.
- **Docs:** results recorded in this plan's §7 and in the `/drive` report.

- **LIVE FINDING (blocking for P4) — the compacted-resume safety net does not exist against
  runtime 0.7.0.** This is exactly what P5 was mandated to catch, and it contradicts both this
  plan and the repo README.
  - **What we believed** (README "Stream resume", P4's edge-case reasoning, and the Fable design
    analysis, which read this statically and got it wrong): a resume below the compacted base
    yields a stream-ending `FAILED_PRECONDITION`, which `isCompactedHistoryError` classifies,
    emitting `session.stream.gap`, flagging `historyGap`, and degrading to poll-only.
  - **What actually happens:** `../macp-runtime/src/server.rs:608-628` routes a subscribe error two
    ways — `Err(status) if is_stream_terminal_error(&status) => Err(status)?` (ends the stream)
    versus `Err(status) => yield inline PbMacpError` (**stream stays open**). And
    `is_stream_terminal_error` (`server.rs:745-755`) matches only `Unauthenticated | Internal |
    ResourceExhausted | InvalidArgument | NotFound | AlreadyExists` — **`FailedPrecondition` is not
    in the list.** So the compacted-resume error is delivered as a *non-terminal inline frame*.
  - **Consequence for the CP:** `isCompactedHistoryError` is only consulted from the stream-error
    `catch` (`stream-consumer.service.ts:223`). No stream error ever occurs, so that catch never
    runs: **no `session.stream.gap`, no `historyGap`, no poll fallback.** The inline frame instead
    normalizes to `message.send_failed`, and the consumer sits on an open stream that replayed
    nothing — a silent history hole. That is the precise failure mode this absorption exists to
    eliminate, and P4's risk model assumed the loud path was there.
  - **Fix (in scope for P4, since it is P4's safety net):** classify the inline
    `kind: 'stream-inline-error'` carrying the compaction error (provider `rust-runtime.provider.ts:269-272`)
    and route it to the same `emitStreamGap` + poll-only degrade. Note the runtime sets the inline
    frame's `code` to `status.message()` rather than a status name, so matching is on the message
    text (`session history before ordinal N was compacted`) — fragile, and worth raising upstream.
  - **Verification status:** criteria 1+2 **proven live** (exactly-once ingestion and invariant-6
    delivery across a real forced runtime restart). Criterion 3 is what surfaced this finding.

- **SECOND LIVE FINDING (pre-existing production bug, deeper than the first) — every inline
  error frame was silently dropped.** Fixing the gap classifier alone would NOT have worked: the
  frame never reached `StreamConsumerService` at all.
  - `StreamSessionResponse` declares `oneof response { Envelope envelope = 1; MACPError error = 2; }`.
    The proto-loader runs with `oneofs: true` (`rust-runtime.provider.ts:138`), which makes
    proto-loader set `chunk.response` to the **discriminant string** naming the set field
    (`'error'` / `'envelope'`), with the payloads flat on `chunk.error` / `chunk.envelope`.
  - The handler did `const responseBody = chunk.response ?? chunk`, so `responseBody` became the
    truthy **string** `'error'`, `('error').error` was `undefined`, and the frame was dropped
    before becoming a `RawRuntimeEvent`. Envelope frames survived only by accident, rescued by the
    `?? chunk.envelope` fallback on the following line.
  - **Blast radius beyond this plan:** the inline-error path documented in `CLAUDE.md` ("normalizer
    maps to `message.send_failed` canonical events") had therefore **never fired in production**.
  - Fixed at `rust-runtime.provider.ts:268-280` by treating `chunk.response` as the payload holder
    only when it is a genuine object. Mutation-verified (reverting fails the new regression test
    with `Expected length: 1, Received length: 0`). Only `StreamSessionResponse` uses a `oneof` —
    `watchSignals`/`watchSessions` read plain fields and were confirmed unaffected.
  - **Lesson worth keeping:** the first fix was correct, unit-tested, and mutation-verified, and
    would still have been inert in production because the layer beneath it discarded the input.
    Only driving real frames through the real provider surfaced that. This is precisely the
    re-test the runtime's `docs/change-review-phases-a-e.md` asks of this repo.
- **FINAL LIVE STATUS — all three criteria proven against a real macp-runtime v0.7.0:**
  1. Exactly-once ingestion across a forced runtime restart. ✅ live
  2. Invariant 6 — envelopes emitted after the subscribe frame still delivered. ✅ live
  3. Compacted-base resume → non-terminal inline frame → correctly decoded → `session.stream.gap`
     emitted, projection `historyGap` set, poll-only degrade, and `subscribeSession` called with
     exactly `[0, 1]` — never a second resubscribe from 0, with the run still reaching its true
     terminal state through the fallback. ✅ live


### Phase 6 — RFC-MACP-0013 supersedes alignment

- **Status:** TODO
- **Delivers:** Confirmation that the CP needs no decode change, plus the one behavioral consequence made explicit where a UI consumer can see it.
- **Depends on:** nothing.
- **Files:** `src/projection/projection.service.ts`, `src/projection/projection.service.spec.ts`, `src/contracts/control-plane.ts`, `docs/INTEGRATION.md`, `docs/TROUBLESHOOTING.md`.
- **Approach:** No decode work is needed — `commitment_hash` is not a new wire field and `extractSupersedes` already passes it through. The one real consequence: on a 0.7.0 runtime **every accepted** commitment's `supersedes.commitment_hash` is guaranteed canonical (`sha256:` + 64 lowercase hex), while replayed pre-0013 history may carry legacy values. Surface that distinction rather than silently mixing the two: keep the tolerant passthrough (never reject historical data at the projection layer — the CP observes, it does not adjudicate) and add a derived `supersedes.canonical: boolean` so an insight UI can badge legacy refs. Rejected: validating and dropping non-canonical refs — that would destroy observability of exactly the history this field exists to expose, and the CP is explicitly not the enforcement point (`control-plane.ts:281-283`).
- **Edge cases & failure modes:** **Do *not* bump `PROJECTION_SCHEMA_VERSION`.** The constant (`src/projection/projection.service.ts:14`, currently `3`) is **dual-purpose**: it also stamps every canonical event's `schemaVersion` (`src/events/event-normalizer.service.ts:491`, `src/events/run-event.service.ts:77`), and the value `3` is additionally hardcoded as the `run_events_canonical.schema_version` DB default (`src/db/schema.ts:125`) and as a fallback in `src/storage/event.repository.ts:64`. Bumping it to flag a purely additive, optional projection field would therefore also re-stamp every event, desync three unlisted sites, and require a migration — a large blast radius for a cosmetic badge. Since the new field is optional and additive, old projections remain valid and simply lack it. The dual-purpose constant is a latent design smell recorded in §6, not something this phase should fix in passing. Case sensitivity matters: `SHA256:`/uppercase hex is **not** canonical per the runtime check, and the CP's classifier must match that exactly rather than being helpfully lenient.
  **The operationally important consequence is a silent absence, not an error.** Only *accepted* envelopes are published to passive subscribers, and the rejection surfaces on the **sender's** ack — so from the CP's vantage point a commitment that would previously have been accepted simply **never appears**. The visible symptom is not a failure event but a **run that stalls without resolving**: no `decision.finalized`, no terminal transition, eventually a session-poll timeout. Any agent carrying a pre-0013 placeholder hash (`"abc123"`, uppercase hex, whitespace-padded) against a ≥0.7.0 runtime hits this, and a supersession chain crossing the boundary is **permanently severed** — there is no dual-read window. This is the single most likely 0.7.0-related production symptom, and it is worth naming in `TROUBLESHOOTING.md` precisely because it presents as a hang rather than an error.
- **Acceptance criteria:**
  1. A canonical hash projects `canonical: true`; a legacy/malformed one projects `canonical: false` and is **still surfaced**, never dropped.
  2. Uppercase hex and a `sha256:` prefix with wrong length classify as non-canonical.
  3. `PROJECTION_SCHEMA_VERSION` is **deliberately NOT bumped** (see Edge cases — the constant is dual-purpose and also stamps every canonical event, with `3` duplicated into `src/db/schema.ts:125` and `src/storage/event.repository.ts:64`); the added field is optional and additive, so old projections stay valid. Existing supersedes specs still pass.
  4. Documented: the runtime hard-rejects malformed refs with no dual-read window, so such a commitment never becomes accepted history — the CP sees it (if at all) as `message.send_failed`.
- **Tests:** unit — canonical/legacy/uppercase/wrong-length classification; existing `projection.service.spec.ts:436-468` green.
- **Docs:** `docs/INTEGRATION.md` — a note for agent authors that `supersedes.commitment_hash` must be canonical against a ≥0.7.0 runtime; `docs/TROUBLESHOOTING.md` — “run stalls, no decision.finalized” → check for a non-canonical supersedes hash.

### Phase 7 — documentation accuracy sweep (proto bump already landed upstream)

- **Status:** TODO
- **Delivers:** Removal of several `CLAUDE.md`/README statements that are actively false. **The proto bump this phase originally owned is already done** — PR #60 (`0b5ceab`) landed `^0.1.9` on `main` mid-implementation, so P7 no longer bumps anything; it only records the outcome and fixes the docs.
- **Depends on:** P2, P6 (so the docs sweep records their outcomes).
- **Files:** `CLAUDE.md` (untracked — local only), `README.md`, `docs/INTEGRATION.md`, `plans/absorb-runtime-v0.7.0.md` (§7 ledger). **No dependency files** — `package.json`/`package-lock.json` were already updated by PR #60 on `main`.
- **Approach:** **The bump is already done — do not attempt it.** PR #60 (`0b5ceab`) landed `^0.1.9` on `main` mid-implementation, touching only `package.json` and `package-lock.json` with no code change, and the suite is green against it. This phase's remaining job is purely documentation. Record that outcome in §7, then correct these verified-false statements: `CLAUDE.md` names the package `@macp/proto` (it is `@multiagentcoordinationprotocol/proto`); `CLAUDE.md` references a `MockRuntimeProvider` class that **does not exist** (the only mock is `ScriptedMockRuntimeProvider`); `CLAUDE.md:25` and `:55` claim "620 tests, 47 suites" when the actual count is **725 tests / 55 suites**; and `CLAUDE.md`'s claim that the `throw new Error` CI grep "should return zero violations" is false — it returns **13 hits**, all legitimate under the prose rule ("internal-consistency failures → plain `Error`"), so the *grep* needs narrowing, not the code. Also record two upstream corrections: the runtime now advertises its real version (item 15), and the v0.5.0 plan's forecast of runtime-emitted synthetic handoff accepts did **not** materialize (item 16).
- **Edge cases & failure modes:** Do not "fix" the 13 `throw new Error` sites to satisfy a wrong grep — that would replace correct code with worse code to satisfy a doc bug.
  **`CLAUDE.md` is gitignored and untracked** (`.gitignore:12` ignores `/plans/`; `CLAUDE.md` is listed separately and `git ls-files` does not know it). Corrections made there are **local-only and will never appear in a PR or reach another developer**. So any correction that matters to a *reviewer* — the package name, the provider-surface description — must also land in a tracked file (`README.md`, `docs/INTEGRATION.md`). Note the same applies to this plan: `plans/` is ignored, and `plans/absorb-runtime-v0.5.0.md` is tracked only because it was force-added; this plan needs `git add -f` to be committed, following that precedent. The repo has **no `CHANGELOG.md`**, so there is none to update.
- **Acceptance criteria:**
  1. The plan records that proto 0.1.9 arrived via PR #60 (`0b5ceab`), not via this work, and that the suite is green against it. **No dependency file is modified by this phase.**
  2. No remaining reference to `@macp/proto` (`CLAUDE.md:33`, `:127`) or `MockRuntimeProvider` (`CLAUDE.md:107`); the package-name correction also appears in a **tracked** doc, since `CLAUDE.md` itself is untracked.
  3. The corrected `throw new Error` grep returns zero violations against unchanged code.
  4. Full regression green.
- **Tests:** `npm test`, `npm run build`, `npm run lint`, the CI grep sweeps.
- **Docs:** `CLAUDE.md`, `README.md`, `docs/INTEGRATION.md`.

---

## 4. Sequencing / dependencies

```
P1 (build runtime + ground truth) ──► P2 (truth-in-contract) ──────────────┐
   └── (runtime build + gate helper) ─────────────┐                        ├──► P7
P3 (ordinal correctness + comments) ─ ─ ─► P4 (cross-process resume) ──► P5 ┘
P6 (RFC-0013 alignment) ──────────────────────────────────────────────────┘
```

Solid arrows are hard dependencies; the dashed P3→P4 edge is **sequencing
preference, not a safety prerequisite** (see §5). P5 depends on P1 for two
things — the built runtime binary *and* the real-runtime `describe` gate helper —
and on P4 for the behavior it verifies. P6 is fully independent. P7 closes out.

**P1 is on the critical path for both tracks**, because nothing can be verified
live until the runtime is built.

**Per-phase PR guidance:** P1 (test-only, no production change) and P3 (self-contained correctness fixes) are each independently valuable and safe to ship alone. P2 is a contract change with no callers — also safely independent. P4 should **not** ship without P5's live evidence.

---

## 5. Riskiest change expanded: P4 cross-process resume

**Why it's the riskiest.** Every other phase is either test-only, additive, or
signature-level with zero callers. P4 changes what the CP asks the runtime to
replay after a restart, and the CP has **no message-id dedup** — the
`(run_id, seq)` unique key uses a CP-allocated monotonic seq, so a replayed
envelope gets a *fresh* seq and is ingested again rather than deduped
(`stream-consumer.service.ts:146-148`, `schema.ts:102`). So:

- ordinal **too low** → duplicate canonical events in an append-only log, which
  corrupt projections (double-counted votes, duplicated timeline entries) and are
  not cleanly reversible per-run;
- ordinal **too high** → envelopes silently skipped, with **no** gap event,
  because the gap event only fires on `FAILED_PRECONDITION` from the runtime.

The CP's ordinal is entirely self-inferred and never cross-checked against a
runtime-supplied sequence (impact-matrix item 10). That is the structural
weakness P4 leans on, which is why **P5 (live exactly-once proof) is a hard
gate**. P3 is *not* the safety prerequisite an earlier draft claimed — the
persisted ordinal is already written after the persist (`:397`), so P3 protects
the in-process reconnect path, not P4's cross-process one. The real hazard
specific to P4 is the **lagging** persisted ordinal described in P4's edge
cases (`if (marker.lastProcessedSeq > 0)` can skip the write entirely), which
produces duplicates rather than loss.

**Rollback.** `STREAM_RESUME_ENABLED=false` restores the previous poll-only
recovery path by config, with no redeploy and no schema change. The column
already exists and is already written, so there is no migration to reverse.

**What would make me not ship it.** If P5 cannot be run against a real runtime,
P4 should be held rather than shipped on unit tests that validate the CP against
its own model of the contract. Shipping a resume path proven only by a mock that
re-implements the rule it is testing is precisely the failure mode the runtime's
change review warned about.

---

## 6. Long-term posture / out of scope

- **The real scaling limit is `WatchSessions`, not `ListSessions`.** The initial
  sync is unpaginated and un-cursored by protocol (`server.rs:1372-1390`), and
  `SessionDiscoveryService.knownSessions` is an unbounded `Set` that is never
  evicted. At the scale where `listSessions` truncation matters (thousands of
  sessions), the discovery path will burst-load every session on every
  reconnect and grow memory without bound. **Out of scope here** — it needs an
  upstream protocol change (a paginated/cursored `WatchSessions`), so the right
  artifact is an upstream issue, not a local workaround.
- **Strengthening `observer-invariant.spec.ts`** (AST-based instead of
  per-line grep, scanning `test/` and `scripts/`, capability-based rather than a
  hand-maintained literal denylist) is **deliberately out of scope**. The
  instruction is not to weaken it, and no phase does; broadening it is a separate
  change that would churn an invariant test in a release-absorption PR.
- **Message-id dedup on ingest** would make resume-from-0 safe and remove P4's
  entire risk class. It is the strategically right long-term answer and is
  explicitly *not* attempted here (new column, new index, ingest rewrite).
  Priced: roughly its own multi-phase plan.
- **`PROJECTION_SCHEMA_VERSION` is dual-purpose** — one constant stamps both the
  projection read-model shape *and* every canonical event, with the literal `3`
  additionally duplicated in `src/db/schema.ts:125` and
  `src/storage/event.repository.ts:64`. That means a purely cosmetic projection
  change cannot be versioned without re-stamping the event log, so in practice
  projections will go un-versioned (as P6 chooses to do). Splitting them into
  `PROJECTION_SCHEMA_VERSION` and `EVENT_SCHEMA_VERSION`, with the DB default
  derived rather than duplicated, is the right fix — **out of scope here**,
  recorded so the next projection change does not rediscover it.
- **One-way doors:** none in this plan. P2's signature change has zero callers;
  P6's projection-shape change is versioned and rebuildable; P4 is
  config-reversible; and P7 no longer performs a proto bump at all (PR #60 did it) — it is docs-only.

---

## 7. Verification ledger (live vs static)

### P1 live evidence — captured 2026-08-31 against macp-runtime **v0.7.0**

Runtime: `macp-runtime v0.7.0 listening addr=127.0.0.1:50051`, dev-mode auth
(`MACP_ALLOW_INSECURE=1`). Store seeded with **150 open decision-mode sessions**
(see "Seeding" below — the 131 persisted sessions could **not** be used; see the
finding below them).

```
--- PAGE 1: page_size omitted => server default ---
sessions returned : 100
nextPageToken     : 'djE6YTZjZTQzMzctYTU3My00ZDYyLWFkNzYtZGI3MmZiNzY0Y2Vj'
token empty?      : False

--- PAGE 2: page_token = page1.next_page_token ---
sessions returned : 50
nextPageToken     : ''
token empty?      : True

--- cross-page integrity ---
page1 count       : 100      page2 count       : 50
overlap (dupes)   : 0        total unique      : 150
page1 ascending?  : True     page2 ascending?  : True
page2 > page1 max?: True
```

The token decodes as `v1:a6ce4337-a573-4d62-ad76-db72fb764cec` — the documented
`base64url-nopad("v1:" + last emitted session_id)` keyset cursor.

**Conclusion:** the comment at `rust-runtime.provider.ts:453-457` ("Against
v0.5.0 … `next_page_token` comes back empty and this loops exactly once") is
**empirically false against 0.7.0**. The drain loop now genuinely iterates, and
its multi-page branch — previously exercised only by `jest.spyOn` mocks — is live
production behavior.

**Two findings that only live testing could have produced:**

1. **The 131 persisted sessions are unusable for this test.** On startup the
   runtime logs `replayed sessions from log count=131` and then immediately
   `evicted stale sessions from memory (registry + log cache + stream bus)
   count=131`. Eviction (`macp-runtime/src/runtime.rs:1200-1237`) drops any
   session in a terminal state (`Resolved`/`Expired`/`Cancelled`) older than a
   cutoff, and all 131 are old terminal sessions. `ListSessions` and `GetSession`
   both return nothing for them. **The plan's original premise that the existing
   store is "enough to cross the 100 boundary" was wrong** — live sessions must be
   seeded. P1's Approach above has been corrected accordingly.
2. **`SessionStartPayload.configuration_version` is mandatory** and must be
   non-empty (`crates/macp-core/src/session.rs:344-346`), as must `mode_version`;
   the mode identifier is `macp.mode.decision.v1` (not `macp.mode.decision`), and
   the ack's success field is **`ok`**, not `accepted`. Any seeding harness that
   checks the wrong field will silently report success while every send is
   rejected — which is exactly what happened on the first attempt here (150/150
   "succeeded" while all were `MODE_NOT_SUPPORTED`).


**CP-level proof (P1 AC4).** The **real** `RustRuntimeProvider.listSessions()` was
executed against the live runtime (provider constructed directly with its three
deps — config, credential resolver, instrumentation — no database involved):

```
{"total":150,"unique":150,"ascending":true,"multiPage":true}
```

So the control-plane's own drain loop followed a real `next_page_token` across two
pages and concatenated them correctly. **This is the first time that branch has
ever executed against a real runtime** rather than a `jest.spyOn` mock.

**Precisely what ran, and what did not.** The committed spec
`test/integration/list-sessions-pagination.integration.spec.ts` **was executed
end-to-end against the live runtime and passes**, and it **skips** under
`INTEGRATION_RUNTIME=mock` with no DB connection attempted. It is DB-free by
design (it constructs `RustRuntimeProvider` directly rather than booting the app),
so the only thing standing between it and `npm run test:integration` is
`test/setup/global-setup.ts:38-47`, which blocks on Postgres. **The live runs were
therefore performed through an equivalent jest config that omits
`globalSetup`/`globalTeardown`; `npm run test:integration` as documented still
cannot complete on this host**, because its Docker storage is corrupted
(`input/output error` reading container blobs), both Postgres containers are
`Exited` and refuse to start, and port 5433 accepts TCP but never answers a query.
No attempt was made to repair the host's Docker/Postgres — out of scope and
potentially destructive. So: the spec's assertions are genuinely executed against
a real 0.7.0 runtime; the *suite runner* is what remains blocked, not the spec.

**Seeding** (agent-role, deliberately kept OUTSIDE this repo — the control-plane
must never contain `Send`-capable code): a scratchpad Node script using
`@grpc/grpc-js` + the vendored protos, sending `SessionStart` envelopes across 6
sender identities to stay under `MACP_SESSION_START_LIMIT_PER_MINUTE` (60/sender).



To be completed as phases land — this is the artifact the final report is built from.

| Claim | Method | Result |
|---|---|---|
| `next_page_token` non-empty for >100 sessions | **live (P1)** | **CONFIRMED** — 100 returned, token non-empty |
| Multi-page drain returns >1 page against real runtime | **live (P1)** | **CONFIRMED** — 100 + 50, 0 dupes, ascending |
| Terminal page carries empty token | **live (P1)** | **CONFIRMED** — page 2 token empty |
| CP's own `listSessions()` drains multi-page live | **live (P1)** | **CONFIRMED** — 150 total, 150 unique, ascending |
| Committed integration spec executed end-to-end | **live (P1)** | **CONFIRMED** — passes against the live runtime, skips under mock. Run via a config omitting `globalSetup`; `npm run test:integration` itself still blocked on this host's Postgres |
| `complete: false` on MAX_PAGES exhaustion | static (unit, P2) | pending |
| Overall drain timeout | static (unit, P2) | pending |
| Ordinal unchanged on persist failure | static (unit, P3) | pending |
| Empty-`sessionId` envelope filtered | static (unit, P3) | pending |
| Invariant 6 holds in code | static (read + existing spec) | **confirmed** — one frame, no `.end()`, `spec.ts:105` asserts it |
| Invariant 6 holds live (post-subscribe envelopes delivered) | live (P5) | pending |
| Exactly-once across a forced stream break | live (P5) | pending |
| Compacted resume → `FAILED_PRECONDITION` → gap | live (P5) | pending |
| proto 0.1.8→0.1.9 is documentation-only | static (crate source diff) | **confirmed** |
| No new `commitment_hash` wire field | static (PR #108 file list + proto diff) | **confirmed** |
| Canonical/legacy hash classification | static (unit, P6) | pending |
| npm 0.1.9 published? | **resolved** | **YES** — landed via PR #60 (`0b5ceab`); installed and suite green against it |
| proto 0.1.8→0.1.9 needs no code change | **live** | **CONFIRMED** — PR #60 touched only package.json + lockfile; 725 tests green after install |

---

## 8. Open questions

None are blocking; each has a defensible default already encoded in the phase
above. Logged for `/reconcile`:

1. **Completeness bit vs. throw on truncation (P2).** Default: return
   `{sessions, complete, pagesFetched}`. Rationale in P2's Approach. Reversible
   (no callers).
2. **Default `RUNTIME_LIST_SESSIONS_PAGE_SIZE` = 200, `MAX_PAGES` = 200 (P2).**
   Revised down from an initial 1000 after finding the client sets no gRPC
   channel options, leaving grpc-js's 4 MB receive cap in force — a
   1000-session page can exceed it and fail outright. 200 lifts the truncation
   ceiling to 40,000 with margin. Reversible by config.
3. **Ship P4 at all (P4).** Default: yes, behind `STREAM_RESUME_ENABLED`, gated
   on P5's live evidence. If P5 cannot run live, hold P4.
4. **Persisting the ordinal past the `lastProcessedSeq > 0` guard (P4).**
   Default: persist the envelope ordinal independently of that guard, so a
   zero-canonical-event envelope cannot make the stored ordinal lag. Cheap and
   reversible, but it changes when a DB write happens on the hot path — worth a
   second look at reconcile time.
5. ~~**npm proto 0.1.9 availability (P7).**~~ **RESOLVED** — 0.1.9 is published and
   was bumped by PR #60 (`0b5ceab`) during implementation. No longer an open
   question; P7 keeps only its docs-sweep scope.
