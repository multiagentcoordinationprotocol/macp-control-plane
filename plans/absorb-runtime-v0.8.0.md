# Absorb macp-runtime v0.8.0

Status: **TODO**
Owner: this session (macp-control-plane-dd)
Upstream inputs: macp-runtime CHANGELOG.md v0.7.1→v0.8.0, macp-runtime PRs #116/#137/#159/#161/#165/#168/#171/#175, this repo's own GitHub issues #67–#75 and #79, `DECISIONS.md` (prior absorption's recorded decisions — see §9), the "Runtime 0.8.0 Absorption" report (2026-09-22).

## 1. Context

Control-plane was last absorbed against macp-runtime v0.7.0 (`plans/absorb-runtime-v0.7.0.md`, closed 2026-09-01, commit `a6dc15d`). Runtime has since shipped v0.7.1 through v0.8.0 (2026-09-20), with v0.8.1 queued (PR #180, dependency-only). A prior research pass (four parallel analyses, cross-verified against source in both repos) found that the one breaking runtime change in this window — handoff implicit-accept, semantics_rev 2 (PR #171) — needs **no source change** here: `src/projection/projection.service.ts:362-365,790-793` already badges the synthetic `HandoffAccept` via `isImplicitAccept()`, built preemptively during the v0.5.0 absorption. What's missing is test coverage proving it, an absorption plan recording that, and a curated backlog of nine pre-existing open issues (#67–#75) that this window's research gave several of a confirmed root cause.

This plan's phases were designed against the actual code by four fresh analysis passes this session, then **independently re-verified by a fifth fresh Opus review pass** that read every cited `file:line` against both repos. That review returned `REVISE` with 5 blocking findings, which are folded into the phases below (see §9 for what changed and why). Two corrections worth flagging up front: bumping `docker-compose.test.yml`'s runtime image tag is **not** a one-line version swap (Phase 1), and the policy `schema_version` tightening in Phase 3 is a **behavior change**, not a pure convenience — the runtime's admission-time check is looser than originally believed.

## 2. Impact matrix

| Change | Impact | Evidence | Phase |
|---|---|---|---|
| Handoff implicit-accept (runtime v0.8.0, PR #171) | Already modeled; missing integration test | `projection.service.ts:790-793` | 6 |
| `docker-compose.test.yml` pins runtime `:v0.5.0` (issue #73) | Integration harness can't validate 0.7.x/0.8.0 behavior; **no `0.8.0`/`0.7.x` GHCR tag exists** (upstream tag-trigger bug); separately, the *existing* `:v0.5.0` pin is dead due to a leading-`v` typo in this repo (metadata-action strips `v`; the real tag is `:0.5.0`) | GHCR tag list confirms `0.5.0`/`0.5`/`latest`/`main`/SHA tags exist, no `0.8.x`; `macp-runtime/.github/workflows/docker.yml:9` matches `v*`, release-plz tags `macp-runtime-v0.8.0` | 1 |
| `integration-tests.yml` sets `CI: true` (issue #74) | `runtime_mode=docker` starts no runtime | `test/setup/global-setup.ts:12-17` (guard is `!process.env.CI`, and GHA injects `CI=true` unconditionally — removing the explicit line doesn't fix it) | 1 |
| Postgres probe has no timeout (issue #72) | Can hang the whole suite ~25 min on a dead connection | `test/setup/global-setup.ts:38` (`new Client({ connectionString })`, pg default `connectionTimeoutMillis: 0`) | 1 |
| `policy.denied` never fires from inline frames (issue #67) | Governance-visibility event silently lost from the canonical event log / span on every live policy denial mid-stream (note: `policy.denied` was never surfaced in the `GET /runs/:id/state` projection either way — `projection.service.ts` has no `case 'policy.denied'` — so this fix restores the event-log/span surface, not a projection field) | `event-normalizer.service.ts:140` vs. wire truth `macp-runtime/src/server.rs:611-629,769-785` | 2 |
| `/compact/i` over-matches PolicyDenied reasons (issue #68) | False `session.stream.gap`, permanent poll-degrade, on any policy reason mentioning "compact" | `stream-consumer.service.ts:154-158` vs. runtime's actual fixed sentence `macp-runtime/src/server.rs:516-521` | 2 |
| `STREAM_RESUME_ENABLED=false` skips gap detection (issue #69) | Real history holes go unrecorded on the normal run path for **every** run, not an edge case — `run-executor.service.ts:348` subscribes unconditionally, independent of this flag | `stream-consumer.service.ts:277-283` (flag check `break`s before the gap check runs) | 2 |
| Policy `schema_version` admission check is looser than believed (issue #79, item 2 of 3) | `macp-runtime` only rejects `schema_version == 0` at admission (`crates/macp-policy/src/registry.rs:301-303`); the `{1,2,3}` enum is enforced at **evaluation** time only (`evaluator.rs:24,26-37`). A bad value like `99` is accepted today and silently denies every subsequent decision under that policy. This repo's pre-check is the *only* admission-time guard — tightening it is a genuine behavior change, not a no-op convenience | `runtime.controller.ts:77-79` | 3 |
| No explicit gRPC channel options (issue #70) | `StreamSession`/`ListSessions`/`WatchSessions`/`WatchSignals` all share one 4 MiB-capped channel | `rust-runtime.provider.ts:150-152` (two-arg client construction) | 4 |
| Persistent publish failure re-ingests envelopes (issue #71) | Bounded duplication (≤6× per consume loop) and double-counted projection state, not data loss; the same post-commit pattern in `emitControlPlaneEvents` (`run-event.service.ts:85-89`) is invoked from `emitStreamGap` *outside* the consume loop's own try/catch, and `consumeLoop` itself has no `.catch()` on its promise chain (`stream-consumer.service.ts:88`) — an uncaught throw there is a process-crash path | `run-event.service.ts:114-131`, `stream-consumer.service.ts:428,452-454` | 5 |
| `listSessions()` has zero production callers (issue #75) | Dead capability; real gap is `SessionDiscoveryService` has no drift detection when sessions are created while the CP is down | `session-discovery.service.ts:72` (uses `watchSessions()` only); grep confirms zero callers elsewhere | 7 |
| `@multiagentcoordinationprotocol/proto` 0.1.9→0.1.10 | **Landed independently, outside this plan** — see Phase 8 | An automated dependency-bump PR (#80, "dispatched on publish", merged 2026-09-20 — before this absorption's planning started) already bumped `package.json` to `^0.1.10` and resolved `package-lock.json` to `0.1.10` on `main`. This branch inherited it via the pre-Phase-1-ship rebase onto `origin/main`. | 8 |
| Policy `designated_role`/`designated_roles`, `INVALID_POLICY_DEFINITION` prefix, 5 fail-open policy fixes, `WatchSessions` bounded sync, Progress envelope validation, `ListSessions` pagination, parity-contract-176, RFC-MACP-0013 commitment hash | Already correct / not applicable / already absorbed — confirmed by direct source review | `runtime.controller.ts:94-99,120-122`; `event-normalizer.service.ts:309-357`; commits `6ff0cf4`, `43ea166` | none — no phase needed |
| Policy schema "closed rule objects" (`additionalProperties: false`, issue #79 item 1) | **Correction from an earlier pass of this plan:** this is *not* already absorbed and *not* enforced by either repo today. `runtime.controller.ts:80-82` only checks `rules` is a non-array object — unknown keys pass through. `macp-runtime/crates/macp-policy/src/registry.rs:384-407` deserializes via `serde_json::from_value` with **no `deny_unknown_fields`** (confirmed: zero hits repo-wide) — issue #79's own motivating example (`veto_threshhold` silently ignored) still reproduces end-to-end today | `runtime.controller.ts:80-82`; `registry.rs:378,384-407` | none this cycle — see §6 Out of scope for why |

## 3. Work plan

### Phase 1 — Repoint the integration harness at runtime v0.8.0

**Status:** DONE (2026-09-22)

**Divergence from the plan as written:**
- AC2 as literally worded calls for "a passing assertion that... asserts `GET /runtime/manifest`'s `supportedModes`" inside the test suite. No such assertion was added as a new automated test (this phase's own Tests section already scoped Phase 1 as test-infrastructure with manual verification, not new specs). It was instead satisfied in substance via two independent live checks: (1) `grpcurl` called `macp.v1.MACPRuntimeService/GetManifest` directly against the pinned `f97fd15` container and got back exactly the 6 expected modes including `ext.multi_round.v1`; (2) `INTEGRATION_RUNTIME=docker npm run test:integration:docker` was run against the live container and `policy.integration.spec.ts` (one of the 7 real-runtime-gated specs) passed, proving the control plane's own gRPC client — credential chain and proto registry included, not just raw connectivity — reaches a live v0.8.0-equivalent runtime. Both checks together are stronger evidence *right now* than the originally-specified single assertion would have been — but weaker in the one dimension that assertion had: a repeatable, in-suite regression guard that would catch a future re-break of this same path. Adding that assertion is a reasonable, low-cost follow-up for whoever next touches this harness, not required by this phase's own scope.
- Beyond the plan's literal text, `global-setup.ts`/`global-teardown.ts` picked up two additional hardenings surfaced by the phase's own Opus verifier (PASS verdict, non-blocking follow-ups) and folded in before commit since they were cheap, in-scope, and closed real gaps: (a) `INTEGRATION_RUNTIME` is now lowercased before comparison, matching `test/helpers/real-runtime-gate.ts`'s documented case-insensitive convention — without this, `INTEGRATION_RUNTIME=Docker` would boot the real gRPC provider (per `test-app.ts`'s case-sensitive "anything but exactly `mock`" check) while never starting a container for it; (b) `globalSetup` now does inline best-effort cleanup of any containers it started if the Postgres-readiness wait subsequently throws — Jest does not invoke `globalTeardown` when `globalSetup` throws, so without this a runtime container could leak for the rest of the CI job. Both were reproduced live (container leaked before the fix, cleaned up automatically after) — see `PROGRESS.md`'s Phase 1 checkpoint for the verifier's full non-blocking-findings list, including the items deliberately left for a future cycle.
**Delivers:** A working docker-mode integration harness — a real runtime container starts, is health-checked correctly, and at least one real-runtime-dependent test suite passes against it; `docker`/`mock`/`remote` modes correctly decide whether to start Postgres/runtime containers; the Postgres readiness probe can't hang the job. **Explicitly does not deliver a fully green docker-mode `npm run test:integration:docker`** — see the scope note below.
**Depends on:** none.
**Files:**
- `docker-compose.test.yml`
- `test/setup/global-setup.ts`
- `test/setup/global-teardown.ts`
- `plans/cross-repo/macp-runtime-docker-tag-trigger.md` (new)

**Scope note — what "docker mode works" means here.** `test/helpers/test-app.ts:99-121` silently ignores the passed `RuntimeScript` in `docker`/`remote` mode and talks to the real `RustRuntimeProvider` instead. Of the 23 integration spec files, only 7 gate themselves on non-mock mode appropriately for a real, agentless runtime (`batch-operations`, `list-sessions-pagination`, `policy`, `runs-lifecycle`, `runs-suspend-resume`, `stream-gap`, `stream-resume-live`); the other 16 (including `observer-mode`) assume a mock-scripted runtime and will time out waiting for events that never arrive against a real, empty, agentless runtime. This is a **pre-existing** gap, not introduced by this phase — `DECISIONS.md`'s DEFER #14 already flagged it ("live integration suite needs per-spec auth… resolves when someone decides whether a live suite runs in CI at all"). This phase makes the harness *capable* of running docker mode correctly; it does not gate the other 16 specs. That gating is out of scope here — see §6.

**Approach.**

*Runtime image pin (closes #73).* No `0.8.0`/`0.8`/`0.7.x` tag exists on `ghcr.io/multiagentcoordinationprotocol/macp-runtime` — root cause: `.github/workflows/docker.yml:9` triggers on `tags: ["v*"]`, but release-plz now tags releases `macp-runtime-v0.8.0` (visible in `git tag`), which never matches that glob, so no versioned image has published since the tagging scheme changed. Separately — and this is a correction to an earlier draft of this plan — `0.5.0` and `0.5` **do** exist on GHCR; the currently-pinned `:v0.5.0` is dead because of a **leading-`v` typo in this repo's own compose file**, not the upstream bug: `docker/metadata-action`'s `type=semver,pattern={{version}}` strips the leading `v` from `refs/tags/v0.5.0` before publishing, so the tag was always `:0.5.0`, never `:v0.5.0`. Two separate bugs, one on each side.

The image **does** exist for v0.8.0 under its immutable commit-SHA tag: `docker.yml:51`'s `type=sha,prefix=` pushes `f97fd15` for the v0.8.0 release commit (`f97fd15a9e0…`, tagged `macp-runtime-v0.8.0`, verified multi-arch `linux/amd64,linux/arm64`). Pin to that, with a comment naming the correspondence and the two-bug history above, rather than `:latest` (mutable, already ahead at 0.8.1) or waiting on the upstream fix. `latest`/`main` remain as loud, documented fallbacks if `f97fd15` is ever GC'd before the upstream fix lands (see Edge cases).

Building from source (`runtime-src`, `docker-compose.test.yml:41-55`) was considered as an alternative and rejected for CI: it needs the sibling `../macp-runtime` working copy, which doesn't exist in a GitHub Actions checkout without a second `actions/checkout` into a path Actions restricts to inside `$GITHUB_WORKSPACE`, plus a compose-context edit; and `macp-runtime/Dockerfile:3-19` is a full cold `cargo build --release` of the workspace, many minutes per run. SHA-pinning a published image is the right near-term call.

*Healthcheck (closes the second blocker on #73).* The current healthcheck (`docker-compose.test.yml:33`, `CMD grpc_health_probe -addr=:50051`) can never pass — `grpc_health_probe` does not exist anywhere in the macp-runtime image (`Dockerfile:21-42` is `debian:bookworm-slim` + `ca-certificates` + the binary only; `bash` is present as part of the base image, not because of the `--shell /bin/bash` useradd flag at `Dockerfile:28`, which only sets a passwd field). The runtime does serve standard gRPC health (`tonic-health`, `macp-runtime/src/main.rs:490-492,519`), so replace the probe mechanism, not the concept, with a plain TCP check: `['CMD-SHELL', 'timeout 2 bash -c "</dev/tcp/127.0.0.1/50051"']`. Apply identically to the `runtime-src` build-from-source variant's healthcheck. **Note:** `runtime` and `runtime-src` are in different compose profiles (`with-runtime` at `docker-compose.test.yml:28-29`, `with-runtime-src` at `:49-50`) and both bind host port 50051 (`:25`, `:46`) — they cannot run concurrently; verify each independently.

*CI env-var split (closes #74).* Do **not** just delete `CI: true` from `integration-tests.yml:72` — GitHub Actions injects `CI=true` into every job unconditionally, so the guard at `global-setup.ts:12` (`if (!process.env.CI)`) would still suppress runtime startup even with the explicit line removed. Fix it at the source: replace the single `CI`-gated block with two independent decisions:
```ts
const needPostgres = !process.env.CI;              // CI supplies Postgres as a service container
const needRuntime  = runtimeMode === 'docker';      // mock: none; remote: externally managed
```
and compose accordingly — critically, when only the runtime is needed, name the service explicitly (`docker compose -f docker-compose.test.yml --profile with-runtime up -d --wait runtime`), **not** the bare profile-up command, which also starts `postgres-test` and collides on host port 5433 with CI's own Postgres service container (`integration-tests.yml:41-42` vs. `docker-compose.test.yml:9`). Mirror both booleans in `global-teardown.ts:7-19`, including the existing "assume services are already running" fallback when `execSync` throws — teardown must not `down` containers this run didn't start. `ci.yml:132` pins `INTEGRATION_RUNTIME: mock`, landing in the "neither" branch — confirm it stays a no-op after the change. **Requirement, not optional:** emit a log line stating which of `needPostgres`/`needRuntime` fired, so AC3 below is actually checkable from CI output rather than inferred.

*Postgres probe timeout (closes #72).* `global-setup.ts:38`'s `new Client({ connectionString: TEST_DB_URL })` has no `connectionTimeoutMillis` (pg 8 default: `0`, i.e. none) — a dead connection inherits the OS TCP timeout (~75s) × 20 retries ≈ 25 minutes before the job fails on its own. Add `connectionTimeoutMillis: 5000`; the retry loop at `global-setup.ts:35-47` then bounds worst case to ≈110s (5s × 20 + 19 × 500ms). `docker-compose.test.yml`'s own `pg_isready` healthcheck (`:12-16`) with `--wait` already gates the common case — this is the belt-and-suspenders bound for the uncommon one.

**Edge cases & failure modes.**
- A `docker`-mode run against the pinned SHA tag still needs `MACP_ALLOW_INSECURE=1` (unchanged, `docker-compose.test.yml:27`; runtime refuses to start without it or real auth config, `macp-runtime/src/main.rs:422-436`) — don't drop it.
- If GHCR ever garbage-collects the untagged/SHA-only `f97fd15` image, the pin breaks loudly (compose pull fails) before the upstream fix lands — re-pin to whatever SHA tag is current, or fall back to `latest`/`main` temporarily. The cross-repo issue (filed, `macp-runtime#184`) is what fixes this durably.
- `list-sessions-pagination.integration.spec.ts:118-121` **will fail by design** against a fresh, empty docker-mode runtime — it explicitly throws if fewer than 2 pages were fetched, and a bare `docker compose up` runtime has zero live sessions. This was already recorded as an accepted consequence in `plans/absorb-runtime-v0.7.0.md` (criterion 5) and `DECISIONS.md:15`. Don't use it as Phase 1's proof of a working harness (see AC2 below) — either seed live sessions first (out of scope here) or exclude it from an unseeded docker-mode run.
- If `global-setup`'s `execSync` throws (falls into "assume services are already running"), `global-teardown` must still only tear down what it can verify it started — pre-existing nuance, worth a comment since this phase is rewriting both files.

**Acceptance criteria.**
1. `docker compose -f docker-compose.test.yml --profile with-runtime up --wait runtime` succeeds locally (healthcheck passes). Separately, `docker compose -f docker-compose.test.yml --profile with-runtime-src up --wait runtime-src` also succeeds locally (run independently — see the port-50051 conflict note above).
2. `INTEGRATION_RUNTIME=docker npm run test:integration:docker` (or the equivalent CI job) actually connects to a live v0.8.0-equivalent runtime — verified by a passing assertion that depends on real runtime behavior and does **not** require pre-seeded sessions: assert `GET /runtime/manifest`'s `supportedModes` matches the runtime's actual registered mode list (6 modes, including `ext.multi_round.v1` — `macp-runtime/src/server.rs:2079-2082`), proving the harness is talking to a live runtime rather than returning mock/empty data. Note the manifest (`macp-runtime/src/server.rs:1121-1133`) carries no version field, so this proves **liveness**, not the specific pinned version — don't phrase the assertion as version verification. `list-sessions-pagination.integration.spec.ts` is explicitly **not** the proof here (see Edge cases) — running the full docker-mode suite unseeded is expected to show failures in the 16 mock-only specs; that's the known, pre-existing, out-of-scope gap, not a regression.
3. `INTEGRATION_RUNTIME=mock npm run test:integration` starts no containers via `global-setup.ts` — confirmed via the required log line (see CI env-var split above), not inferred.
4. A forced-unreachable Postgres (wrong port) fails `global-setup.ts` within ~2 minutes, not ~25.
5. `plans/cross-repo/macp-runtime-docker-tag-trigger.md` exists and a GitHub issue is filed in `multiagentcoordinationprotocol/macp-runtime` linking to it. (Already done during planning: `multiagentcoordinationprotocol/macp-runtime#184`.)

**Tests.** No new unit tests (this phase is test-infrastructure); the acceptance criteria above are the verification. Manually run both docker-mode compose profiles once locally to confirm before merge — this is the one phase that can't be verified by `npm test` alone.

**Docs.** Update the compose file's own inline comments (why the SHA tag, the two-bug history, why the TCP healthcheck). No `CLAUDE.md` change needed — the documented commands (`npm run test:integration:docker`) don't change shape.

---

### Phase 2 — Fix the stream pipeline's policy-denial and gap-detection bugs

**Status:** DONE (2026-09-22). Implemented exactly as planned (verified `file:line` against the actual diff by a fresh Opus verifier — PASS): `event-normalizer.service.ts:149-152` for #67 with `parsePolicyDenyReasons` at `:526-534`; `stream-consumer.service.ts:160` (`COMPACTED_HISTORY_RE`, unanchored) split into `isCompactedHistoryTerminalError`/`isCompactedHistoryInlineError` for #68; `stream-consumer.service.ts:306-321` reordered (`gapDetected` check before the `streamResumeEnabled` check) for #69. All 4 acceptance criteria backed by real, load-bearing tests (each provably fails pre-fix — confirmed by the verifier).
**Divergence from the plan as written:** none in the core approach. Six non-blocking follow-ups the verifier surfaced were folded in before commit rather than deferred: (1) a stale `isCompactedHistoryError (/compact/i)` doc-comment reference in `test/integration/stream-resume-live.integration.spec.ts` (drift this phase's rename created, outside the plan's file list) corrected to name the actual `COMPACTED_HISTORY_RE`/`isCompactedHistoryInlineError`; (2) `test/integration/stream-gap.integration.spec.ts`'s fixture comment softened — it had claimed the fixture "exercises the tightened, sentence-specific regex, not just the `code === 9` fallback," but since the fixture keeps `code: 9` alongside the real sentence, the `||` short-circuits and the regex branch is never actually evaluated there; the regex-only path is what AC3's *unit* test isolates, so the integration comment now says that plainly instead of overclaiming; (3) `CLAUDE.md`'s two "786 tests" mentions updated to 792 (now 793 with the added test below); (4) the two inline-`PolicyDenied` unit-test fixtures changed `messageId: 'msg-1'` → `messageId: ''` to match the runtime's real wire shape (`server.rs:624` is `message_id: String::new()` on this path — the plan itself says not to assert this field is populated, and the fixtures shouldn't imply otherwise either), with `subject`/`errorCode` assertions updated to match; (5) added one more unit test for `parsePolicyDenyReasons`'s all-empty-after-split fallback branch (input `"PolicyDenied: ; "`) — the one genuinely untested branch the verifier found, now closed (793/793 total, up from 792). Item (6), the pre-existing `emitStreamGap` unguarded-await hazard becoming reachable on one additional path via this phase's reordering, needed no new action — Phase 5's own plan text below (§"Approach", second paragraph) already explicitly names this exact call site as in scope. Re-ran the full suite, lint, typecheck, build, and the full mock-mode integration suite (103/103, including `stream-gap.integration.spec.ts` 2/2) after folding in the follow-ups — all still green.
**Delivers:** `policy.denied` fires correctly from inline stream-error frames (into the canonical event log / span, not the projection — see impact matrix note); compacted-history detection no longer false-positives on policy-denial reason text and actually matches the real, grpc-js-wrapped error text it's meant to catch; `session.stream.gap` is recorded regardless of whether stream-resume is enabled.
**Depends on:** none (independent of Phase 1 — these are unit-testable via the mock runtime already in place).
**Files:**
- `src/events/event-normalizer.service.ts`
- `src/runs/stream-consumer.service.ts`
- `src/events/event-normalizer.service.spec.ts`
- `src/runs/stream-consumer.service.spec.ts`
- `test/integration/stream-gap.integration.spec.ts` (fixture text update)

**Prior decision context.** `DECISIONS.md` entries 13 and 15 (from the v0.7.0 absorption) already diagnosed both #68 and #69 and are the basis for the fixes below — entry 13 specifically prescribes the regex form used here; entry 15 independently confirms #69's severity (`run-executor.service.ts:348` subscribes unconditionally). `DECISIONS.md`'s "raise upstream" list item 1 also names the actual root cause of *both* bugs: the runtime's inline `MACPError` frames carry no stable machine-readable `code`, only a human-readable `status.message()` string doing double duty as both fields. That's a real upstream ask (a structured `code` enum on inline frames would make both the #67 and #68 fixes unnecessary), tracked as a follow-up rather than filed as a blocking cross-repo issue this cycle, since both bugs have working client-side fixes below.

**Approach.**

*Inline `policy.denied` matching (closes #67).* `event-normalizer.service.ts:140` checks `err.code === 'POLICY_DENIED'`, which never matches on this path. The ack-based path (`:83`) is correct — the runtime's ack error code genuinely is the constant `POLICY_DENIED` (`macp-runtime/crates/macp-core/src/error.rs:75`). But the inline-stream-error path's `code` **and** `message` fields are both built from `status.message().to_string()` (`macp-runtime/src/server.rs:621-622`), and for `MacpError::PolicyDenied`, that string is literally `"PolicyDenied"` or `"PolicyDenied: <reason1>; <reason2>"` (`server.rs:769-775`). Structured reasons (`details`/`macp-error-details-bin`) are **not** available on this path — `server.rs:625` hardcodes `details: vec![]`, and `src/contracts/runtime.ts:52-57`'s `inlineError` type has no `details`/`reasons` field to carry them even if they were. Fix:
```ts
const isPolicyDeny = err.code === 'POLICY_DENIED' || /^PolicyDenied(:|$)/.test(err.code) || /^PolicyDenied(:|$)/.test(err.message);
```
(keep the literal for forward-compat; anchor the `PolicyDenied` pattern so it doesn't false-match unrelated text), and parse reasons from the message: take the substring after the first `": "`, split on `"; "`, trim, drop empties, falling back to `[err.message]` if nothing remains — mirroring the ack path's own fallback at `:96-98`. Document two known lossy edges: a reason containing `"; "` internally is mis-split (matches the ack path's own best-effort parsing), and a reason containing `": "` internally loses everything before the first occurrence (since that's the delimiter between the `"PolicyDenied"` prefix and the reasons). Keep the emitted `policy.denied` event shape identical to the ack path so `run-event.service.ts:25-27`'s existing span-annotation labeling keeps working — this fix restores the canonical-event-log and span surface; `policy.denied` has never had its own field in the `GET /runs/:id/state` projection (verified: zero `case 'policy.denied'` in `projection.service.ts`), so don't describe this as fixing a projection gap. Note `err.messageId` is always `""` on this path (`server.rs:624`) — don't assert on it being populated.

*Compacted-history regex (closes #68).* `stream-consumer.service.ts:154-158`'s `isCompactedHistoryError` (`code === 9 || /compact/i.test(message)`) is called both on the terminal-stream-error path (`:271`, an error object with numeric `code`) and on inline-error text (`:248-249`, plain strings) — only the regex half applies to inline frames, and a `PolicyDenied: <reasons>` message containing the substring "compact" (e.g. "exceeds the negotiated compact window") trips it. The damage is severe: it `break`s *before* the frame reaches `handleRawEvent` (`:264`), so neither `message.send_failed` nor `policy.denied` gets emitted, and a bogus `session.stream.gap` fires, permanently setting `historyGap: true` and degrading the run to poll-only.

Fix using `DECISIONS.md:37`'s already-prescribed, **unanchored** form (not the `^`-anchored form drafted in an earlier pass of this plan, which is wrong — see below):
```ts
private static readonly COMPACTED_HISTORY_RE = /history before ordinal \d+ was compacted/i;
```
**Why unanchored matters:** on the *terminal* path, the error reaching `consumeLoop`'s catch is the raw grpc-js `ServiceError`, thrown verbatim (`rust-runtime.provider.ts:324-328,387`). grpc-js formats `ServiceError.message` as `"<code> <CODE_NAME>: <details>"`, e.g. `"9 FAILED_PRECONDITION: session history before ordinal 5 was compacted; resume with after_sequence >= 5 …"` — a `^session`-anchored regex would **not** match that prefixed string, silently making the text-fallback branch dead code on the one path where `code === 9` doesn't already mask the gap (today's test fixtures use a bare, unprefixed message and can't catch this). The unanchored form matches both the grpc-prefixed terminal message and the bare inline message, while still excluding `"PolicyDenied: … compact …"` (no `"history before ordinal"` substring there).

Split into two call sites: the terminal path keeps `code === 9 || COMPACTED_HISTORY_RE.test(message)`; the inline path drops the numeric branch entirely (there is no numeric gRPC code on the inline path, and PolicyDenied can never reach the terminal path anyway — `server.rs:748-756` excludes `FailedPrecondition`, PolicyDenied's status code, from terminal errors): `COMPACTED_HISTORY_RE.test(inline.message) || COMPACTED_HISTORY_RE.test(inline.code)`.

*Gap-detection ordering (closes #69).* `stream-consumer.service.ts:277-283`: when `streamResumeEnabled` is false, the code `break`s at line 278 *before* the `gapDetected` check at line 280 ever runs — so a real history gap goes unrecorded on the normal (resume-disabled) run path for **every** run, since `run-executor.service.ts:348` subscribes unconditionally regardless of this flag (`DECISIONS.md` entry 15, independently reconfirmed this session). Swap the order: check `gapDetected` first (call `emitStreamGap` and `break` regardless of the resume flag), then check `streamResumeEnabled` (if false, `break` to the poll fallback as today). Behavior when resume is enabled is unchanged; when disabled, the gap is now correctly recorded before falling back to polling. Verify `marker.finalized || marker.aborted` still short-circuits before either check.

**Edge cases & failure modes.**
- The regex is coupled to the runtime's exact sentence (`server.rs:516-521`); if it's ever reworded upstream, this regex stops matching and gaps degrade to poll-fallback via the `code === 9` branch only (terminal path) — the inline path has no such fallback, so a reworded sentence would silently regress issue #68's protection. Note this coupling in the code comment.
- `test/integration/stream-gap.integration.spec.ts`'s existing fixture uses the message `'resume point compacted'` (not the real runtime sentence) and currently only passes via the `code === 9` branch — update it to the real sentence (`'session history before ordinal 5 was compacted'`) so it actually exercises the tightened regex, not just the numeric fallback.
- The upstream in-code comments this phase touches (`stream-consumer.service.ts:226,230,238`) cite stale `server.rs` line numbers (`745-755`, `608-628`, `512-519`) — refresh to `748-756`, `611-629`, `516-521` while in this file.

**Acceptance criteria.**
1. A scripted inline `PolicyDenied: <reason>` frame produces exactly one `message.send_failed` and one `policy.denied` canonical event, with `decodedPayload.reasons` containing the parsed reason(s).
2. A scripted inline `PolicyDenied: log compaction window exceeded` frame does **not** set `historyGap` and does **not** emit `session.stream.gap`.
3. A scripted terminal error whose message is `"9 FAILED_PRECONDITION: session history before ordinal 5 was compacted; resume with after_sequence >= 5 …"` (the real grpc-js-wrapped form, not a bare unprefixed string) sets `historyGap: true` and emits `session.stream.gap` — this is the regression guard that proves the unanchored regex, not just `code === 9`.
4. With `STREAM_RESUME_ENABLED=false`, a scripted compacted-history condition still sets `marker.historyGap === true` and still emits `session.stream.gap`, while `subscribeSession` is never called again (poll-fallback preserved).

**Tests.**
- `event-normalizer.service.spec.ts`: new case for an inline `PolicyDenied: reason-a; reason-b` frame asserting the parsed `reasons` array and the emitted `policy.denied` event; keep the existing ack-path test unchanged.
- `stream-consumer.service.spec.ts`: new case for the false-positive regex (§68) using a `PolicyDenied` inline message containing "compact"; a new/updated case using the real grpc-js-prefixed terminal message form (§AC3 above, replacing or supplementing the existing bare-string fixture); clone the existing "emits session.stream.gap … on a compacted-history FAILED_PRECONDITION" test with `streamResumeEnabled = false` to prove ordering (§69).
- `test/integration/stream-gap.integration.spec.ts`: update the scripted error message to the real runtime sentence.

**Docs.** None (internal correctness fix, no documented contract changes).

---

### Phase 3 — Tighten the policy `schema_version` pre-check

**Status:** DONE (2026-09-22). Implemented as planned and verified by a fresh Opus subagent (PASS): shared closed-set constant `POLICY_SCHEMA_VERSIONS`/`PolicySchemaVersion` added at `src/contracts/runtime.ts:310-311`; the controller's `< 1` check replaced with a membership test at `runtime.controller.ts:78-79`, message derived from the constant (`schemaVersion must be one of ${POLICY_SCHEMA_VERSIONS.join(', ')}`) so it auto-tracks if the set widens later. All 3 acceptance criteria backed by tests that assert on the actual forwarded values, not just "didn't throw" (e.g. AC3's test asserts `registerPolicy` was called with `descriptor: expect.objectContaining({schemaVersion: 1})`, not merely a 200).
**Divergence from the plan as written:** the plan's literal instruction — "only the request-side inline body type in the controller narrows" — was not followed verbatim, deliberately: the inline `@Body()` type stayed `schemaVersion?: number` (unnarrowed), with the membership check applying a local cast (`schemaVersion as PolicySchemaVersion`) only at the `.includes()` call site. Narrowing the body type itself would assert a compile-time lie about unvalidated network JSON (there's no `ValidationPipe` on this inline body) and would make the plan's own required test cases (`schemaVersion: 99`, `schemaVersion: 1.5`) fail to compile — the plan's literal instruction was internally inconsistent with its own Tests section, and this is the correct resolution. The response/descriptor side (`RuntimePolicyDescriptor.schemaVersion`, `src/dto/runtime-responses.dto.ts`) was correctly left as plain `number`, unnarrowed, exactly as the plan required — confirmed load-bearing by `test/helpers/scripted-mock-runtime.provider.ts:318`, which returns `schemaVersion: 0` from a mock `getPolicy` and would fail to compile under a narrowed descriptor type. One additional test beyond the plan's list was added: a non-integer (`1.5`) rejection case, closing the plan's own noted edge case with a real assertion instead of an assumption.
**Delivers:** `POST /runtime/policies` rejects `schemaVersion` values outside `{1,2,3}` locally, with a clear message. **This is a behavior change, not a pure convenience** — see Approach.
**Depends on:** none.
**Files:**
- `src/contracts/runtime.ts`
- `src/controllers/runtime.controller.ts`
- `src/controllers/runtime.controller.spec.ts`

**Approach.** `runtime.controller.ts:59-79`'s policy-registration body is an inline type (not a DTO) with only `if (schemaVersion < 1) throw new BadRequestException('schemaVersion must be > 0')` (`:77-79`) — `99` and `1.5` both currently pass.

**Correction to an earlier draft of this plan:** the runtime does **not** enforce a `{1,2,3}` enum at admission. The only admission-time check is `macp-runtime/crates/macp-policy/src/registry.rs:301-303`, which rejects `schema_version == 0` and nothing else — `99` is accepted and registered successfully today. The `{1,2,3}` enum lives in `crates/macp-policy/src/evaluator.rs:24` (`SUPPORTED_SCHEMA_VERSIONS`) and `evaluator.rs:26-37` (`check_schema_version`), applied only when a policy is *evaluated* against a live decision — an unsupported version silently denies every commitment under that policy from then on, with no signal at registration time. This means: **this repo's pre-check, once tightened, becomes the *only* place a bad `schemaVersion` is caught early** — not a convenience layered in front of an authoritative runtime check. A caller registering `schemaVersion: 99` today gets `200 { ok: true }` and then silent, ongoing evaluation-time denials; after this phase, they get an immediate `400`. That is the intended, and correct, outcome — but it is a behavior change worth stating plainly rather than framing as risk-free.

Add a shared closed-set constant next to `RuntimePolicyDescriptor` (`src/contracts/runtime.ts:302-309`), following the existing pattern used for `CANONICAL_EVENT_TYPES` (`src/contracts/control-plane.ts:125-155`):
```ts
export const POLICY_SCHEMA_VERSIONS = [1, 2, 3] as const;
export type PolicySchemaVersion = (typeof POLICY_SCHEMA_VERSIONS)[number];
```
Replace the `< 1` check with a membership test against `POLICY_SCHEMA_VERSIONS`, message `schemaVersion must be one of 1, 2, 3`. **Do not** narrow `schemaVersion` on the response/descriptor side (`src/contracts/runtime.ts:307`, `src/dto/runtime-responses.dto.ts:37`) — those decode whatever the runtime returns from `listPolicies`/`getPolicy`, and narrowing them would make a future runtime-side v4 undecodable here before this repo is updated. Only the request-side inline body type narrows.

**Edge cases & failure modes.**
- A future runtime schema_version 4 would make this pre-check reject a value the runtime's own admission path would currently accept (since the runtime's admission check is only `!= 0`) — acceptable and intended: this repo's check is deliberately stricter than the runtime's own loose admission gate, matching the runtime's *evaluation-time* authoritative set. A later absorption widens the constant when the runtime ships a new version.
- Non-integer values (e.g. `1.5`) must also be rejected — confirm the membership test naturally excludes them (array `.includes(1.5)` on `[1,2,3]` is `false`, so no separate `Number.isInteger` check is needed).
- Existing callers who were relying on `schemaVersion: 99`-style values silently succeeding (then silently failing at evaluation) will see a behavior change from `200` to `400` — call this out in the PR description, not just the plan.

**Acceptance criteria.**
1. `POST /runtime/policies` with `schemaVersion: 99` returns 400 with a message naming the valid set, and `provider.registerPolicy` is never called. Note in the test/PR that this is a **new** rejection — today this same request returns `200 { ok: true }` against a real runtime and only fails later, silently, at evaluation time.
2. `schemaVersion: 1`, `2`, and `3` are all accepted (subject to the rest of the body being valid).
3. Omitting `schemaVersion` still defaults to `1` and succeeds, unchanged from today.

**Tests.** Update `runtime.controller.spec.ts`'s existing `'rejects schemaVersion < 1'` case (message text changes) and add: a `schemaVersion: 99` rejection case asserting `provider.registerPolicy` was not called, and accept cases for `2` and `3`.

**Docs.** None.

---

### Phase 4 — Set explicit gRPC channel options

**Status:** DONE (2026-09-22). Implemented and verified by a fresh Opus subagent (PASS): `RUNTIME_MAX_RECEIVE_MESSAGE_BYTES`/`RUNTIME_MAX_SEND_MESSAGE_BYTES` added to `app-config.service.ts` following the existing `readNumber` + validation-block pattern, `createClient()` (`rust-runtime.provider.ts`) passes them as the third gRPC constructor argument. All 4 acceptance criteria met — the verifier gave an unusually candid assessment of AC4 specifically (see divergence note) that is worth preserving here rather than letting a clean PASS imply it was tested in a way it wasn't.
**Divergence from the plan as written:** none in the implemented approach, but one honest limitation the plan didn't anticipate, surfaced by the verifier and worth recording: **AC4 ("a response exceeding the new, raised ceiling still degrades through `MAX_PAGE_SIZE_HALVINGS` rather than hard-failing") is not directly testable at the unit level in this codebase.** The byte-size ceiling this phase configures is enforced inside grpc-js's own deserializer, strictly *below* the `unary()` seam every test in `rust-runtime.provider.spec.ts` stubs — `createClient()` itself (which reads the two new config fields) is bypassed entirely by the existing test harness (`provider.client` is stubbed directly). No unit test can trip a real byte-size limit; that would require an actual gRPC server emitting an oversized frame, which is integration-test territory this plan didn't scope for Phase 4. The test added for AC4 is honest about this in its own comment: it proves the `MAX_PAGE_SIZE_HALVINGS` ladder still correctly survives *two* consecutive `RESOURCE_EXHAUSTED` responses (a genuinely new case beyond the pre-existing single-halving test), not that the new, raised ceiling specifically is what triggers the ladder. Also folded in: two additional stale-doc references the plan's Docs note under-scoped (it named only `app-config.service.ts`/`.env.example`/`CLAUDE.md`, but `docs/INTEGRATION.md:314-318` carried the same "gRPC client has no channel options" sentence and had no rows for the two new vars — fixed and added); a factual correction in `.env.example` (an *unset* var falls back to its default and starts fine — only an *empty-string* value fails startup, the two aren't the same and the original wording conflated them); a "worst-case" vs. "typical" wording mismatch between `.env.example` and `app-config.service.ts` about the 1000-session `ListSessions` page (the `app-config.service.ts` framing is the defensible one — resolved by changing `.env.example` to say "typical"); and a one-clause addition noting the send-side default is a genuine *tightening* (grpc-js's implicit send default is unlimited, not 4 MB) rather than a raise, which AC3's "no behavior change at default values beyond the raised ceiling" phrasing didn't anticipate — practical risk is nil (the runtime's own ~1.06 MiB receive-side limit rejects first regardless) but worth stating accurately.
**Delivers:** The runtime gRPC client has explicit, configurable message-size limits instead of grpc-js's implicit 4 MiB default, closing a documented workaround.
**Depends on:** none.
**Files:**
- `src/runtime/rust-runtime.provider.ts`
- `src/config/app-config.service.ts`
- `.env.example`
- `src/config/app-config.service.spec.ts`
- `src/runtime/rust-runtime.provider.spec.ts`

**Approach.** `rust-runtime.provider.ts:150-152` constructs the shared gRPC client (`return new this.serviceConstructor(this.runtimeAddress, this.channelCreds)`) with no channel-options argument — used by every call path (`unary`, `StreamSession`, `WatchSessions`, `WatchSignals`). CLAUDE.md's own `RUNTIME_LIST_SESSIONS_PAGE_SIZE` doc already documents this as a known gap ("kept below the runtime's max of 1000 because the gRPC client has no channel options"). Add a third constructor argument built from config, following the existing `readNumber` pattern (`app-config.service.ts:9-14`):
- `RUNTIME_MAX_RECEIVE_MESSAGE_BYTES` (default **16777216** / 16 MiB — a 1000-session `ListSessions` page at ~1-2 KB/session is ~2 MB, giving ~8× headroom, while staying bounded rather than `-1`/unbounded; tonic sets no server-side encoding cap on its own, so this receive limit is the genuinely binding constraint on this side).
- `RUNTIME_MAX_SEND_MESSAGE_BYTES` (default **4194304** / 4 MiB — the largest outbound payload, `RegisterPolicy.rules`, is already bounded by the 1 MB HTTP body limit; the *actual* binding constraint on the wire is the runtime's own `max_decoding_message_size` on its receive side, `~max_payload_bytes + 64 KiB ≈ 1.06 MiB` per `macp-runtime/src/main.rs:501-505,522` — so this 4 MiB client-side send ceiling is headroom above a limit the runtime itself enforces first, not the binding one; state it that way rather than attributing the bound to the HTTP body limit).

Validate both as positive integers in the existing validation block (`app-config.service.ts:200-214`, same `!Number.isInteger(x) || x <= 0` pattern already used there — `throw new Error(...)` is convention-legal in this file per CLAUDE.md's Env vars exemption). **Startup-failure trap to guard against:** `readNumber`'s underlying `Number('')` evaluates to `0`, which is a valid finite number — `app-config.service.ts:206-211` already comments around this exact trap for `RUNTIME_LIST_SESSIONS_TIMEOUT_MS`; reuse that same guard reasoning here so an accidentally-blank env var (e.g. `RUNTIME_MAX_RECEIVE_MESSAGE_BYTES=` in someone's `.env`) fails startup with a clear message rather than silently becoming `0` and passing the `> 0` check as a false positive, or worse, being coerced into an unintended default. Ensure the `.env.example` entries carry concrete, non-blank example values.

**Rollback.** If either new limit causes problems in practice (e.g. legitimately larger payloads than anticipated), the rollback is unsetting both env vars, which reverts to today's implicit grpc-js default — no migration, no data implications.

**Edge cases & failure modes.**
- A misconfigured value of `0`, negative, non-integer, or blank-string must fail fast at startup (config validation), not at first gRPC call.
- Existing `MAX_PAGE_SIZE_HALVINGS` retry ladder (`rust-runtime.provider.ts:53-72`) stays in place as a safety net for a still-oversized response; this phase should make it fire far less often, not remove it — add a test proving a response that still exceeds the new (raised) ceiling correctly degrades through that ladder rather than hard-failing.

**Acceptance criteria.**
1. The gRPC client is constructed with a third argument containing `grpc.max_receive_message_length` and `grpc.max_send_message_length` set from config.
2. Setting either env var to `0`, a negative number, a non-integer, or an empty string causes startup to fail with a clear error, consistent with other numeric config in this file.
3. Existing `ListSessions`/`StreamSession` tests continue to pass unmodified (no behavior change at default values beyond the raised ceiling).
4. A response exceeding the new, raised ceiling still degrades through `MAX_PAGE_SIZE_HALVINGS` rather than hard-failing (new test).

**Tests.** `rust-runtime.provider.spec.ts`: this needs a **new** test setup — the existing helper (`:85-92`) assigns `provider.client` directly, bypassing `createClient()` and setting none of `serviceConstructor`/`runtimeAddress`/`channelCreds`, so it cannot be reused as-is. Stub those three fields directly, invoke the private `createClient()`, and assert the third constructor argument matches the config-derived option map. Add the AC4 halvings-ladder-still-works case. `app-config.service.spec.ts`: add cases asserting `0`/`-1`/`1.5`/`''` for both new env vars throw at startup.

**Docs.** Add both new env vars to `.env.example` and to CLAUDE.md's Key Environment Variables table. Note (informational, no action required this phase): `RUNTIME_LIST_SESSIONS_PAGE_SIZE`'s rationale text in `app-config.service.ts:78-88`, `.env.example`, and CLAUDE.md is now stale ("gRPC client has no channel options") — update that sentence in this phase since it's a one-line consequence of the same change.

---

### Phase 5 — Make publish-side failures non-blocking for the stream consumer

**Status:** DONE (2026-09-22)

**Divergence from plan:** Implemented as designed, with three notes:
1. Both `emitControlPlaneEvents` and `persistRawAndCanonical` shared an identical
   post-commit tail (`recordSpanEvents`/`metricsService.recordEvents`/`streamHub.publishEvent`/
   `streamHub.publishSnapshot`), so the fix was extracted into one shared private
   `runPostCommitSideEffects(runId, events, projection)` helper rather than duplicating three
   independent try/catch blocks in both methods — same behavior the plan asked for, DRYer
   implementation. `streamHub.publishEvent` is now caught **per event inside the loop**, not
   once around the whole `forEach`, so one bad event in a batch doesn't suppress publishing its
   siblings — a small strengthening beyond the plan's literal wording, in the same spirit as its
   "so one failure doesn't suppress the others" edge case.
2. Added the Prometheus counter the plan flagged as "a reasonable near-term addition... if time
   allows" (`macp_post_commit_side_effect_failures_total`, labeled by `step`) rather than
   deferring it — it's genuinely the operational signal for the failure mode this phase makes
   silent, and the cost was small.
3. **Judgment call, logged to `ASSUMPTIONS.md` (P5):** the new `consumeLoop` `.catch()` safety
   net marks the stream marker `finalized`/`aborted` and logs, but deliberately does **not** call
   `finalizeRun`/`markFailed` — calling another fallible async operation from inside the one
   place that must not throw would risk recreating the exact hazard being closed. See the
   `ASSUMPTIONS.md` entry for the full reasoning and blast radius (mitigated by
   `RunRecoveryService.onApplicationBootstrap()` re-attaching non-terminal runs on restart).

All 5 acceptance criteria met; see PROGRESS.md for the verify round and test summary.
**Delivers:** A persistent (non-transient) failure in post-commit side effects (metrics recording, SSE publish, control-plane event emission) no longer causes the stream consumer to re-fetch and re-apply an already-durably-persisted envelope on every reconnect, and can no longer crash the process via an uncaught rejection.
**Depends on:** none.
**Files:**
- `src/events/run-event.service.ts`
- `src/runs/stream-consumer.service.ts`
- `src/events/run-event.service.spec.ts`

**Approach.** `run-event.service.ts:114-126` commits the DB transaction (raw + canonical events + projection); `:128-131` then runs `recordSpanEvents`, `metricsService.recordEvents` (itself a DB write), `publishEvent`, and `publishSnapshot` — all **outside** that transaction. The stream consumer (`stream-consumer.service.ts:428`) awaits the whole call and only advances its resume ordinal (`:452-454`) after it resolves. A persistent failure in any of the post-commit steps therefore causes the same already-durable envelope to be re-ingested on every reconnect, bounded by `streamMaxRetries` (default 5, so ≤6 total ingests) before the consumer degrades to poll-only (`:285-287`). This is **not** harmless: `onConflictDoNothing` (`src/storage/event.repository.ts:40,67`) only dedupes on primary key or `(run_id, seq)`; a redelivered envelope gets a fresh UUID and a fresh sequence allocation, so it inserts duplicate rows *and* re-applies to the projection (double-counted participants/messages/votes).

The **same** post-commit-outside-transaction pattern exists in `emitControlPlaneEvents` (`run-event.service.ts:85-89`), invoked from `emitStreamGap`, which is called at `stream-consumer.service.ts:317` (Phase 2's reordered gap-detection call — line refreshed post-Phase-2; re-verify all citations in this paragraph fresh against source when Phase 5 actually starts, don't trust any of them blindly) — **outside** the consume loop's own `try/catch`, which wraps only the `for await` at `:218-268`. And `consumeLoop` itself is launched at `stream-consumer.service.ts:88` inside a `.finally(...)` chain with **no `.catch()`** — so a throw from `emitControlPlaneEvents` on this path is not just a re-ingestion issue like the main case, it's an **unhandled promise rejection**, which crashes the Node process (Node ≥15 default behavior; confirmed no `unhandledRejection`/`uncaughtException` handler exists anywhere in `src/`). There is a **second, identical** unprotected `emitControlPlaneEvents` call site in the poll-fallback loop at `stream-consumer.service.ts:359` (inside the `while`, after its own `catch (pollError)` block) — same hazard, same root cause. This is a pre-existing hazard, not introduced by Phase 2, but Phase 5's own thesis — "a post-commit failure must not propagate and must not be allowed to crash or mis-account" — covers both call sites, since the actual fix (wrapping the post-commit steps inside `RunEventService`, where `emitControlPlaneEvents` itself lives) is at the source common to both, not per-call-site. These are the only paths in this plan that can currently take the whole process down. Fold both into this phase's scope rather than leaving them as a separate, unowned gap.

This repo's `DECISIONS.md` entry 7 recorded, during the v0.7.0 absorption, that the ×(`STREAM_MAX_RETRIES`+1) duplication bound "is still correct" as a trade-off and that "the bound was wrong" (meaning the retry cap itself, not the duplication strategy). This phase **reverses that framing for the specific case of post-commit failures**: since a post-commit failure carries zero data-loss risk (the envelope is already durable), retrying and re-ingesting it buys nothing and only costs duplicate rows and re-applied projection state — so eliminating the retry trigger for this specific failure class is a strict improvement over entry 7's accepted trade-off, not a reversal of its underlying reasoning about pre-commit failures (which still correctly retry).

Do **not** move the ordinal-advance earlier in the consumer (a genuine pre-commit failure would then silently lose the envelope — existing tests at `stream-consumer.service.spec.ts:445,460` explicitly guard against this). Instead, make both `persistRawAndCanonical` and `emitControlPlaneEvents`/`emitStreamGap`'s post-commit calls resolve once the data is durable: wrap the post-commit side effects in separate `try/catch` blocks (metrics, SSE publish, and the control-plane-event emission each independently, so one failure doesn't suppress the others) that log via `Logger` rather than rethrow. `RunEventService` currently has no logger (`:38-48`) — add `private readonly logger = new Logger(RunEventService.name);` per CLAUDE.md convention. Additionally, add a `.catch()` to `consumeLoop`'s promise chain (`stream-consumer.service.ts:88`) as a last-resort safety net — logging and marking the consumer's marker as errored/finalized rather than leaving an unhandled rejection, even after the primary fix removes the main trigger, since other unrelated throws could still reach that path.

A Prometheus counter for this now-logged (not rethrown) failure mode is a reasonable near-term addition given Phase 5's whole point is turning a loud failure into a silent one operationally — construct it in `src/telemetry/instrumentation.service.ts` per convention if time allows in this phase; otherwise track it explicitly in `PROGRESS.md` as a fast-follow rather than silently dropping it (see §6).

**Rollback.** If swallowing post-commit failures turns out to hide a real, actionable StreamHub or metrics outage in practice, the revert is a one-line change back to rethrowing in the relevant `catch` block — the observable signal to watch for is the new `Logger` line (or the counter, if added) firing at a rate that indicates a systemic issue rather than a transient blip.

**Edge cases & failure modes.**
- A `publishEvent` failure must not suppress a successful `metricsService.recordEvents`, and vice versa, and neither must suppress `emitControlPlaneEvents` — three independent catches, not one wrapping all.
- The now-stale comment at `stream-consumer.service.ts:434-451` (describing the current re-ingestion-on-failure behavior as deliberate) needs updating to reflect the new contract.
- This does not change behavior for genuine pre-commit (transaction) failures — those still propagate and still cause a correct retry/re-ingest, since the envelope was never durably persisted.
- The new `consumeLoop` `.catch()` must not mask a genuine pre-commit failure's existing handling — it's a last-resort net for anything that still escapes, not a replacement for the existing per-envelope error handling in the loop body.

**Acceptance criteria.**
1. `persistRawAndCanonical` resolves successfully even when `metricsService.recordEvents` or `streamHub.publishEvent` throws, as long as the DB transaction itself committed.
2. `emitControlPlaneEvents`/`emitStreamGap`'s post-commit path resolves successfully under the same failure conditions, and no longer produces an unhandled promise rejection when called from `consumeLoop`'s `.finally()` chain.
3. All such failures are logged (via `Logger`, not swallowed silently).
4. The stream consumer's resume ordinal advances after such a call, so the envelope is not re-ingested on the next reconnect.
5. A genuine pre-commit (transaction) failure still propagates and still blocks ordinal advancement (regression guard).

**Tests.** Rewrite `run-event.service.spec.ts:341-388` (the existing "metrics throws" test currently asserts the call rejects): keep the same throwing-metrics setup, but assert the promise **resolves** with the normalized events, `streamHub.publishEvent` still fires, and the failure is logged. Add a twin case where `publishEvent` throws and the call still resolves with metrics still recorded, and a third case covering `emitControlPlaneEvents`'s post-commit path. `stream-consumer.service.spec.ts`: add a case proving `consumeLoop`'s new `.catch()` prevents an unhandled rejection when a post-commit call throws past the individual catches (belt-and-suspenders regression guard); existing rejection-mock tests continue to correctly model pre-commit failures only.

**Docs.** None (internal reliability fix).

---

### Phase 6 — Handoff implicit-accept integration test coverage

**Status:** TODO
**Delivers:** An integration test proving the runtime's v0.8.0 synthetic `HandoffAccept` (semantics_rev 2, RFC-MACP-0010 §5.1) is correctly badged `implicit: true` in the projection, end-to-end through the real decode path — not just the unit-level mocked-decoder tests that exist today.
**Depends on:** none (uses the mock runtime, not Phase 1's real-runtime harness).
**Files:**
- `test/helpers/scripted-mock-runtime.provider.ts`
- `test/fixtures/handoff-mode.ts`
- `test/integration/handoff-implicit-accept.integration.spec.ts` (new)

**Approach.** Existing coverage stops short of proving this end-to-end: `event-normalizer.service.spec.ts:364-379` and `projection.service.spec.ts:673-719` both supply `decodedPayload`/mocked decode results directly rather than exercising the real proto decoder, and `observer-mode.integration.spec.ts:44-48` runs a handoff-mode session but only asserts event *types*, never `implicit`. Structurally: the mock runtime's default JSON-payload encoding (`scripted-mock-runtime.provider.ts:407`, `Buffer.from(JSON.stringify(payload))`) is not valid input to the real `HandoffAcceptPayload` protobuf decoder — whether that decode throws outright or succeeds on garbage and returns an empty/wrong object depends on the specific bytes, but either way `decodeKnown` (`proto-registry.service.ts:118-133`) does not come back with a real `implicit: true` boolean from JSON input, and `tryDecodeUtf8` (`:176-185`)'s fallback wraps the JSON under a `json` key regardless — so `decodedPayload.implicit` is `undefined` either way. A naive JSON-only fixture would only ever exercise the message-id-corroboration branch (`projection.service.ts:792`), never the primary decoded-boolean branch (`:791`). The new test must use **real proto-encoded bytes** for at least one case.

Extend `makeStreamEnvelope` (`scripted-mock-runtime.provider.ts:389-410`) with an optional 6th parameter `opts?: { messageId?: string; payloadBytes?: Buffer }` — when `payloadBytes` is supplied, use it verbatim instead of JSON-encoding `payload`; backward-compatible with all existing call sites (positional, ≤5 args today — 57 confirmed). Add `handoffImplicitAcceptScript()` to `test/fixtures/handoff-mode.ts` alongside the existing `handoffAcceptScript()` (`:25-60`), proto-encoding `HandoffAcceptPayload` the same way `stream-resume-live.integration.spec.ts:170-209` already does (load `macp/modes/handoff/v1/handoff.proto` via protobufjs, `lookupType`, `encode`). Note the proto registry's mode-key/type-name distinction is intentional, not a typo to "fix": `proto-registry.service.ts:33`'s map key is `macp.mode.handoff.v1`, the target message type is `macp.modes.handoff.v1.HandoffAcceptPayload` — the new fixture must match both exactly as they exist today.

New file `test/integration/handoff-implicit-accept.integration.spec.ts` (matches `testRegex` in `test/jest.integration.config.ts:7`), gated using the same inline ternary pattern other mock-only specs use around `isRealRuntime` (`test/helpers/real-runtime-gate.ts:29`; there is no single exported mock-only helper — five existing specs each inline their own ternary, follow that pattern) since it depends on mock scripting, not real-runtime behavior. Scenario: a `HandoffOffer` from the initiator, followed (after a short scripted delay — the harness has no fake timers; it pairs real short delays with `waitFor` polling per `test/helpers/wait-for.ts:11`) by the synthetic accept frame with `messageId: 'implicit-accept:handoff-1'` and proto-encoded `{ implicit: true }`. Three cases, so the assertion is load-bearing rather than accidentally green:
1. **Primary branch** — proto-encoded `implicit: true`, plain-UUID `messageId` → `implicit: true` (only reachable via `projection.service.ts:791`).
2. **Corroboration branch** — JSON payload (not decodable as a valid `implicit` boolean) + `messageId: 'implicit-accept:handoff-1'` → `implicit: true` (only reachable via `:792`).
3. **Negative control** — reuse the existing `handoffAcceptScript()`'s explicit accept (payload `{ acceptedAt }`, random UUID `messageId` — hits neither branch) → `implicit` is `undefined`.

Cite **RFC-MACP-0010 §5.1** in the new fixture/test comments, matching `projection.service.ts:362-365` (call site) and `:785-789` (doc comment on `isImplicitAccept`, function body at `:790-793`) and the proto's own field comment.

**Edge cases & failure modes.**
- The mock runtime's scripting has no notion of the runtime-side `acceptance.implicit_accept_timeout_ms` — control-plane is observer-only and never sees that field, so the test simulates the *outcome* (the synthetic envelope arriving), not the timeout mechanism itself. Document this scope explicitly in the test file header.
- Confirm the 6th-parameter extension to `makeStreamEnvelope` doesn't break any of its 57 existing call sites (all positional, ≤5 args) — run the full integration suite, not just the new file.

**Acceptance criteria.**
1. All three cases pass. Falsifiability is proven by actually running the test twice more with each of `projection.service.ts:791` and `:792` individually commented out (a mutation check) and confirming the corresponding case fails both times — paste both mutation-run outputs into the verification ledger (§7) as evidence, not just an assertion that the test "would" fail.
2. `npm run test:integration` (mock mode) passes with the new file included.

**Tests.** This phase *is* the test addition — see Approach above for the exact scenario.

**Docs.** None beyond the RFC citation already present in code comments.

---

### Phase 7 — `listSessions()` disposition: admin drift-detection endpoint

**Status:** TODO
**Delivers:** A read-only admin endpoint that surfaces drift between the runtime's live session list and this service's locally-tracked active runs — the one genuine gap `listSessions()` being uncalled was hiding, rather than a cosmetic doc-comment fix.
**Depends on:** none.
**Files:**
- `src/controllers/admin.controller.ts`
- `src/controllers/admin.controller.spec.ts`
- `CLAUDE.md` (Administration endpoints list)

**Approach.** Confirmed zero production callers of `listSessions()` (grep across `src/` and `test/` excluding the interface/impl/config/metrics/spec files returns nothing); `SessionDiscoveryService` uses `watchSessions()` exclusively (`session-discovery.service.ts:72`). A bare doc-comment (an option considered and rejected earlier in planning) adds nothing — `src/contracts/runtime.ts:270-278` already carries an eight-line contract comment. The real, load-bearing gap: `SessionDiscoveryService.knownSessions` starts empty on boot (`session-discovery.service.ts:22`), so sessions created while the control plane was down, or during its reconnect sleep window, are never discovered — and today nothing can even detect that this happened. Add `GET /admin/runtime/sessions`, read-only, diffing `provider.listSessions()` against `RunRepository.listActiveRuns()` (`src/storage/run.repository.ts:178-183`, already returns exactly the `starting|binding_session|running|suspended` set, matched against `runs.runtimeSessionId` at `schema.ts:23`). Surface `complete: false` (a truncated drain, per the existing pagination contract) verbatim in the response rather than silently treating a partial result as "no drift found." `admin.controller.ts` already injects `RustRuntimeProvider` (`:8`) — add `RunRepository`. Both `AdminController` and `RunRepository` are registered in the same `app.module.ts`, so DI resolves without a module change.

Scope this endpoint narrowly: it reports drift, it does not auto-reconcile. A future auto-backfill inside `SessionDiscoveryService`'s own loop is a larger, separate follow-up this endpoint should precede, not replace or block on.

**Correction to an earlier draft of this plan:** `admin.controller.ts` today has **no error handling at all** — its two existing methods are synchronous passthroughs, and there is no generic "circuit-breaker-aware error handling" pattern elsewhere in this file to reuse. `runtime.controller.ts`'s `translateRegistryError`/`assertRegistryWritable` are specific to the policy-registry read-only case, not a general circuit-breaker adapter. Handle it explicitly: `src/errors/error-codes.ts` already has suitable codes — use `ErrorCode.RUNTIME_UNAVAILABLE` (`:4`) when the runtime is unreachable and `ErrorCode.CIRCUIT_BREAKER_OPEN` (`:11`) when the breaker is open, each via `AppException(ErrorCode.<the matching one>, message, HttpStatus.SERVICE_UNAVAILABLE)` per CLAUDE.md's Errors convention — no new `ErrorCode` entry needed.

**Edge cases & failure modes.**
- `listSessions()` can return `complete: false` on a large runtime (per its existing pagination-exhaustion contract, `RUNTIME_LIST_SESSIONS_MAX_PAGES`/`_TIMEOUT_MS`) — the endpoint must report this explicitly (e.g. a `truncated: true` field) rather than presenting a partial diff as authoritative.
- This is an admin/observability endpoint — apply the same auth expectations as other `/admin/*` routes (no new `@Public()` decorator).
- A runtime that's circuit-broken or unreachable must surface a specific, named error status (see Approach above) — not a false "no drift" result, and not a bare unhandled-exception 500.

**Acceptance criteria.**
1. `GET /admin/runtime/sessions` returns sessions present in the runtime but not in `listActiveRuns()` (and optionally the reverse), plus a `truncated`/`complete` flag reflecting the underlying `listSessions()` result.
2. The endpoint requires the same auth as other admin routes.
3. A runtime error surfaces as `HttpStatus.SERVICE_UNAVAILABLE` via `AppException` — `ErrorCode.RUNTIME_UNAVAILABLE` when unreachable, `ErrorCode.CIRCUIT_BREAKER_OPEN` when the breaker is open — not a generic 500, not a silently-empty diff.

**Tests.** `admin.controller.spec.ts`: new cases for (a) no drift, (b) a runtime-only session reported as drift, (c) `complete: false` surfaced correctly, (d) runtime error propagated as the specific `AppException`/status from AC3, not swallowed.

**Docs.** Add one line under CLAUDE.md's **Administration** endpoint list. While there: CLAUDE.md's Administration list is also missing the already-shipped `GET /admin/circuit-breaker/history` endpoint — add that too, since this phase is already touching this section.

---

### Phase 8 — Bump `@multiagentcoordinationprotocol/proto`

**Status:** DONE — **landed independently, outside this plan, before it was needed here.**

**What actually happened (supersedes the Approach/Acceptance-criteria below, kept for
record):** PR #80 ("chore(deps): bump @multiagentcoordinationprotocol/proto to 0.1.10",
an automated dependency-bump PR triggered on package publish) bumped `package.json`'s
range to `^0.1.10` and resolved `package-lock.json` to `0.1.10`, merged to `main`
2026-09-20T15:55:59Z — two days before this absorption's planning session started, and
entirely unrelated to it. Phase 1's pre-ship rebase onto current `origin/main` (per
`/ship`'s §0 Orient & sync) pulled this in automatically. Confirmed on this branch:
`package.json`'s range is `^0.1.10`, `package-lock.json` resolves `@multiagentcoordinationprotocol/proto`
to `0.1.10`, and `npm run lint && npm test && npm run build` all pass (786/786 tests) —
i.e. both of Phase 8's original acceptance criteria are independently satisfied. No
further action needed; this phase closes with zero commits of its own in this plan.

**Delivers:** Dependency currency; picks up the 0.1.10 patch already permitted by the existing `^0.1.9` range.
**Depends on:** none.
**Files:**
- `package.json` (no version-string change needed — `^0.1.9` already permits 0.1.10)
- `package-lock.json`

**Approach (as originally planned; superseded — see above).** `package-lock.json` still resolves `@multiagentcoordinationprotocol/proto` to `0.1.9` despite the `^0.1.9` range in `package.json` already permitting `0.1.10`. The diff between the two published tags is registry-asserted (via the package registry's own changelog/description) to be a single doc-comment on `policy.proto`'s `schema_version` field — this was **not** independently verified against source this session (no local registry/source access to diff the two tag contents directly), so treat it as low-risk based on the registry's own description, not as source-confirmed. Run `npm install @multiagentcoordinationprotocol/proto@0.1.10` (prefer the pinned-version form over a bare `npm update`, which would also churn unrelated transitive deps) and re-run the full suite — the acceptance criteria below are the actual safety net regardless of the diff's true size. **Requires registry auth** (`NODE_AUTH_TOKEN` for `npm.pkg.github.com`, per `.npmrc`/CI secrets) to resolve — confirm this is available in whatever environment runs this phase before starting.

**Edge cases & failure modes.** If the diff turns out to be larger than the registry description suggests, the full suite (lint/test/build) is what catches it — don't skip re-running it based on the "doc-comment-only" assumption.

**Acceptance criteria.**
1. `package-lock.json` resolves the proto package to `0.1.10`. — **Satisfied** (via #80).
2. `npm run lint && npm test && npm run build` all pass unchanged. — **Satisfied**, re-confirmed on this branch after the Phase 1 rebase.

**Tests.** None new — this phase's test *is* the existing suite passing after the bump.

**Docs.** None.

## 4. Sequencing

Phases 1–8 are independently shippable and have no cross-phase `Depends on` edges — Phase 6 in particular does not depend on Phase 1 (it uses the mock runtime, not the real-runtime docker harness), and Phase 5's expanded scope (folding in `consumeLoop`'s `.catch()` safety net) touches a file Phase 2 also edits (`stream-consumer.service.ts`) but at non-overlapping locations (Phase 2: `isCompactedHistoryError` and the gap-detection ordering around lines 154-283; Phase 5: the `.finally()`/`.catch()` chain at line 88) — sequence Phase 2 before Phase 5 if both land in the same PR to avoid a rebase-only conflict, not a logical dependency. Recommended execution order follows the priority ranking in the originating report (integration harness first, since it's what makes the rest verifiable end-to-end in CI; confirmed bugs next; hygiene/hardening last), but `/implement` may reorder or parallelize within that constraint if it chooses a multi-PR strategy.

## 5. Riskiest change expanded

**Phase 1's runtime image pin.** This is the one phase whose correct completion cannot be verified by `npm test` alone — it requires actually running `docker compose ... up --wait` (both profiles, separately) and a real docker-mode integration check locally, since CI itself is part of what's being fixed. It also introduces a maintenance liability (pinning to a commit-SHA tag rather than a semver tag) that only the upstream fix (tracked via the filed cross-repo issue, `macp-runtime#184`) fully resolves — and that upstream fix itself needs a specific `metadata-action` extractor change (a `type=match` rule), not just a trigger-glob fix, since `type=semver` cannot parse `macp-runtime-vX.Y.Z` as a semver string; this is documented in the cross-repo plan so whoever picks up the issue doesn't have to rediscover it. Mitigation: the plan explicitly files that issue rather than treating the SHA-pin as a permanent solution, `latest`/`main` are documented as loud fallbacks if the SHA tag is ever GC'd, and Phase 1's acceptance criteria require an actual local verification run against a non-seeded-dependent assertion, not "the compose file parses" or a test that's known to fail by design.

## 6. Out of scope

- Auto-reconciliation/backfill inside `SessionDiscoveryService` for sessions missed during downtime (Phase 7 explicitly scopes to detection only, per the drift-endpoint's own Approach).
- Upstream fix to `macp-runtime/.github/workflows/docker.yml`'s tag trigger and `metadata-action` extractor — tracked via `plans/cross-repo/macp-runtime-docker-tag-trigger.md` and `macp-runtime#184`, not implemented here (cross-repo write, out of this repo's scope).
- Gating the 16 mock-only integration specs (everything except `batch-operations`/`list-sessions-pagination`/`policy`/`runs-lifecycle`/`runs-suspend-resume`/`stream-gap`/`stream-resume-live`) so they behave sensibly in docker mode, and/or seeding live sessions for `list-sessions-pagination` to pass unseeded — pre-existing gap (`DECISIONS.md` DEFER #14), not introduced or closed by this plan. Phase 1 makes the harness capable of running docker mode correctly; it does not make the full suite green in that mode.
- Closed-set (`additionalProperties: false`) validation of policy `rules` objects (issue #79 item 1). **Correction to an earlier draft of this plan**, which incorrectly claimed this was already absorbed: neither this repo (`runtime.controller.ts:80-82` only checks `rules` is a non-array object) nor the runtime (`registry.rs:384-407` deserializes with no `deny_unknown_fields`, confirmed) enforces this. Issue #79's own motivating example (a misspelled `veto_threshhold` silently ignored) still reproduces end-to-end today. Deferred rather than added as a ninth phase because: (a) it wasn't part of the original 6-item action list this absorption is scoped to, (b) a proper fix likely belongs upstream (the runtime should enforce its own admission-time schema, matching what it already does for `schema_version == 0`), and a client-side-only closed-set check here would need to hand-maintain a shadow copy of five rule schemas that could drift from the spec repo's actual JSON schemas. Recommend filing a follow-up issue in this repo (tracking the audit issue #79 already asked for: "check any fixture, test factory, seed data, or example policy in this repo") in a future cycle rather than folding it in here.
- A Prometheus counter for Phase 5's now-logged (not rethrown) publish failures — attempted within Phase 5 if time allows, otherwise tracked explicitly in `PROGRESS.md` as a fast-follow, not silently dropped.
- Widening `POLICY_SCHEMA_VERSIONS` beyond `{1,2,3}` — deferred to whenever the runtime actually ships a schema_version 4.

## 7. Verification ledger

(Populated by `/implement` as phases land — each phase's `Status` line above flips to `DONE` with a one-line divergence note, and `PROGRESS.md` carries the full per-phase checkpoint trail. Phase 6's mutation-check outputs and Phase 1's local docker-mode verification runs are recorded here, not just asserted.)

**Phase 1 — local docker-mode verification runs (2026-09-22):**
- `docker compose -f docker-compose.test.yml --profile with-runtime up -d --wait runtime`: pulled `ghcr.io/multiagentcoordinationprotocol/macp-runtime:f97fd15` successfully, container reported `Healthy` via the new TCP healthcheck.
- `docker compose -f docker-compose.test.yml --profile with-runtime-src up -d --wait runtime-src`: built from `../macp-runtime` (release profile, ~28s), container reported `Healthy` via the same TCP healthcheck.
- `grpcurl` direct call to `macp.v1.MACPRuntimeService/GetManifest` on the pinned `f97fd15` container returned `supportedModes: [ext.multi_round.v1, macp.mode.decision.v1, macp.mode.handoff.v1, macp.mode.proposal.v1, macp.mode.quorum.v1, macp.mode.task.v1]` — 6 modes, matches `macp-runtime/src/server.rs:2079-2082`.
- `INTEGRATION_RUNTIME=docker npm run test:integration:docker` run against the live `f97fd15` container: `policy.integration.spec.ts` (one of the 7 real-runtime-gated specs) passed, proving the control plane's own gRPC client (credential chain + proto registry, not just raw TCP) reaches the runtime end-to-end. The other 16 mock-only specs fail as expected/pre-existing (see Scope note above) — not a regression, not claimed as covered.
- `CI=true INTEGRATION_RUNTIME=mock` against the real `global-setup.ts` (via `ts-node`, bad `DATABASE_URL`): logged `needPostgres=false needRuntime=false`, invoked zero docker commands, threw only from the Postgres retry loop (~9.5s, fast-refuse).
- `CI=true INTEGRATION_RUNTIME=mock` against a blackhole IP (`10.255.255.1`, genuine hang not fast-refuse): threw after `109568ms` — matches the predicted `5000×20 + 500×19 ≈ 109.5s` bound, well under the ~2min AC.
- `CI=true INTEGRATION_RUNTIME=Docker` (case-mismatch probe): logged `needRuntime=true`, started and health-checked the runtime container correctly (confirms the lowercasing fix).
- Forced-failure-after-container-start probe (`CI=true INTEGRATION_RUNTIME=Docker`, bad `DATABASE_URL`): runtime container started and went `Healthy`, then the Postgres wait threw, triggering the new inline cleanup path (`docker compose … rm -sf runtime`) — post-run `docker compose ps -a` showed zero containers. Re-confirmed independently by the ship-gate verifier (fresh subagent, separate run), who also confirmed the CI-only teardown branch (`rm -sf runtime` with no `--profile` flag) correctly resolves and removes a running profiled container under compose v2.39, and that GHCR's `f97fd15` tag is anonymously pullable (no `docker/login-action` in either CI workflow, so this is load-bearing).

## 8. Open questions

- **Phase 1 SHA-pin maintenance:** if GHCR garbage-collects the `f97fd15` tag before the upstream fix lands, the pin breaks. Decided (Opus, defensible default, cheap to reverse): proceed with the SHA pin now and file the upstream issue (done: `macp-runtime#184`); if it breaks before the fix lands, the failure is loud (compose pull fails) and easy to re-pin to whatever SHA tag is current, or fall back to `latest`/`main` temporarily. Not escalated — low likelihood, cheap failure mode, and the alternative (blocking this whole plan on an upstream fix in another repo) is worse.
- **Phase 7 endpoint path/shape:** `GET /admin/runtime/sessions` is a judgment call on naming and response shape; `/implement` should follow existing `admin.controller.ts` conventions for whatever's already there rather than inventing new response envelope conventions.
- **Phase 8's "doc-comment-only" claim:** registry-asserted, not source-verified this session (see Phase 8's Approach). Low risk given the full suite re-runs regardless, but flagged so `/implement` doesn't repeat the claim as independently confirmed.

## 9. Prior decisions consulted (from `DECISIONS.md`)

A round-1 plan review found this plan had not consulted `DECISIONS.md` (the prior absorption's recorded decisions) before drafting Phase 2 and Phase 5, and in Phase 2's case had proposed a regex that would have regressed a form `DECISIONS.md` had already gotten right. Reconciled here:

- **Entry 13** (compaction detection matches on message text) — prescribes the unanchored `/history before ordinal \d+ was compacted/` form. An earlier draft of Phase 2 in this plan proposed a `^`-anchored variant instead, which would have silently broken on grpc-js's real `"9 FAILED_PRECONDITION: …"`-prefixed terminal error text. **Corrected** — Phase 2 now uses entry 13's form verbatim, plus a new test fixture carrying the real grpc-js prefix so the text-fallback branch is actually exercised rather than masked by `code === 9`.
- **Entry 15** (STREAM_RESUME_ENABLED=false gap-skip is not narrow) — independently reconfirmed this session (`run-executor.service.ts:348` subscribes unconditionally). No conflict; Phase 2 now cites this entry directly rather than re-deriving the same conclusion from scratch without attribution.
- **Entry 7** (the ×(STREAM_MAX_RETRIES+1) duplication bound "is still correct" as a trade-off) — Phase 5 narrows this specifically for post-commit failures, where retrying buys nothing since the envelope is already durable, without disputing entry 7's reasoning for genuine pre-commit failures, which still correctly retry. See Phase 5's Approach for the explicit argument against the prior framing, rather than silently overriding it.
- **"Raise upstream" item 1** (a stable machine-readable `code` on inline `MACPError` frames would fix both the #67 and #68 root causes at the source) — not filed as a new cross-repo issue this cycle, since both bugs have working client-side fixes in Phase 2; noted here as a legitimate future upstream ask rather than silently dropped.

## Plan review

**Round 1** — fresh Opus agent, full read of every cited `file:line` in both `macp-control-plane` and `macp-runtime`. **Verdict: REVISE** — 5 blocking findings (Phase 1 AC2 named a test that fails by design against an empty runtime; Phase 1 didn't scope that 16/23 integration specs are ungated for docker mode; Phase 3's premise about the runtime's admission-time check was wrong — it's evaluation-time only; Phase 2's proposed regex was `^`-anchored and would break on real grpc-js error text, contradicting `DECISIONS.md` entry 13; the cross-repo doc misattributed the `:v0.5.0` pin's failure entirely to the upstream bug when it's actually a local leading-`v` typo), plus 5 `🟠` and several `🟡` findings (impossible AC on running two port-conflicting compose profiles simultaneously; `DECISIONS.md` never consulted; the "closed rule objects" impact-matrix row was unsupported; Phase 7 cited error handling that doesn't exist in `admin.controller.ts`; Phase 4's startup-failure trap; Phase 5's `emitControlPlaneEvents`/`consumeLoop` `.catch()` gap; several falsifiability tightenings; ~10 minor citation drifts). All blocking and 🟠 findings applied directly to this plan (see the "Correction to an earlier draft of this plan" callouts throughout, and §9 above); citation drift corrected throughout; falsifiability tightenings applied to Phases 1, 6, and 7's acceptance criteria.

**Round 2** (final round, per this project's 2-round cap) — a different fresh Opus agent, targeted re-verification of every round-1 fix against current code in both repos (not a full re-review). **Verdict: SOUND.** All five round-1 blocking fixes independently re-confirmed correct against source (`registry.rs:301-303`/`evaluator.rs:24` for Phase 3; `DECISIONS.md:34-37` entry 13's exact prescribed regex plus the full grpc-js error-unwrapping path from `rust-runtime.provider.ts:324-387` through `stream-consumer.service.ts:269` for Phase 2; the real `docker.yml` metadata-action rule and `docker-compose.test.yml:23`'s actual `:v0.5.0` pin for the cross-repo doc; `docker-compose.test.yml`'s actual profile/port layout for Phase 1's AC1 split). Four small nits found and applied: (1) Phase 1 AC2's "reflecting the pinned runtime version" was unachievable — the runtime's manifest (`server.rs:1121-1133`) carries no version field; reworded to assert `supportedModes` liveness instead. (2) A citation fix (`with-runtime`/`with-runtime-src` profile line numbers). (3) `docker.yml:50`→`:51` for `type=sha,prefix=`, and the cross-repo doc's suggested-fix snippet was missing the existing `branches: [main]` clause — dropping it while "fixing" the tag glob would have been a regression; fixed in the doc and flagged via a follow-up comment on `macp-runtime#184`. (4) Phase 5 had a second, identical unprotected `emitControlPlaneEvents` call site at `stream-consumer.service.ts:359` (the poll-fallback loop) not mentioned alongside the one at `:281` — both are covered by the same fix (wrapping post-commit effects inside `RunEventService`, the common source), but the text now names both. Phase 7 was also tightened per the reviewer's explicit suggestion: named `ErrorCode.RUNTIME_UNAVAILABLE`/`ErrorCode.CIRCUIT_BREAKER_OPEN` directly (both already exist in `error-codes.ts`) rather than leaving "check for an existing code" vague. No findings required re-planning or further rounds.

**Plan is SOUND as of this revision. Ready for `/implement`.**
