# Align with macp-runtime v0.9.0

Status: **DONE** (phases 1–5 + finalization, 2026-10-18) (planned 2026-10-18 against `origin/main` @ `6014442`, the proto 0.1.11 bump #113).
Owner: unassigned
Upstream inputs: macp-runtime PRs [#228](https://github.com/multiagentcoordinationprotocol/macp-runtime/pull/228) (0.8.9 — S2 `schema_version` admission), [#229](https://github.com/multiagentcoordinationprotocol/macp-runtime/pull/229) (0.9.0 — Seam upstream: S1/S4/S5/S6/S7/S12/S13, `semantics_rev` 4), [#232](https://github.com/multiagentcoordinationprotocol/macp-runtime/pull/232) (`SPEC_REV` → spec `60262b8` / spec #196, parity contract 1.4.0); macp-runtime `CHANGELOG.md` 0.8.9 + 0.9.0; macp-runtime `docs/deployment.md` "Upgrading to 0.9.0"; macp-runtime `docs/sdk-guide.md` (S13 error-code metadata); macp-runtime `crates/macp-core/src/error.rs:166-215` (the error registry: code → gRPC status → HTTP); spec #191/#196; this repo's `plans/archive/absorb-runtime-v0.8.0.md` and `DECISIONS.md`/`ASSUMPTIONS.md` (P2).

## 1. Context

The control plane was last absorbed through macp-runtime v0.8.6 (`plans/archive/absorb-runtime-v0.8.0.md`, closed 2026-10-03; `README.md:142`, `docs/INTEGRATION.md:33-35`). Since then the runtime has shipped 0.8.7–0.8.9 and 0.9.0. Only one dependency moved here already: `@multiagentcoordinationprotocol/proto ^0.1.11` (`package.json:30`, #113).

The 0.9.0 changes that reach this repo, all evidenced below:

1. **S13 — every gRPC `Status` carries the registry code.** Each status now carries `macp-error-code` ASCII metadata. `POLICY_DENIED` also carries `macp-error-details-bin`, holding JSON `{reasons:[…], denials:[{code,message,participants}]}`. The gRPC status was also **re-mapped per the registry**. Before 0.9.0, everything not specially cased fell to `FAILED_PRECONDITION` (pre-0.9 `src/server.rs:786`); `POLICY_DENIED` itself was `FAILED_PRECONDITION` with message `PolicyDenied: r1; r2`. Several codes now share one status, so a client that maps by status alone mis-maps them:
   - `RESOURCE_EXHAUSTED` covers `PAYLOAD_TOO_LARGE` (413), `RATE_LIMITED` (429) and `STREAM_LAGGED` (503).
   - `FAILED_PRECONDITION` covers `SESSION_NOT_OPEN` (409) and `REGISTRY_READ_ONLY` (409).
   - `NOT_FOUND` covers `SESSION_NOT_FOUND` (404), `UNKNOWN_POLICY_VERSION` (404) and `AGENT_NOT_FOUND` (404).
   - `PERMISSION_DENIED` covers `FORBIDDEN` (403) and `POLICY_DENIED` (403).
   - `INVALID_ARGUMENT` covers `INVALID_ENVELOPE`, `INVALID_SESSION_ID`, `MODE_NOT_SUPPORTED`, `INVALID_POLICY_DEFINITION` and `INVALID_REQUEST`.

   `REGISTRY_READ_ONLY`, `INVALID_REQUEST`, `STREAM_LAGGED` and `AGENT_NOT_FOUND` became permanent registry rows in spec #196.
2. **Inline `StreamSession` `MACPError` frames changed shape.** `code` is now the registry code; it used to be `status.message()`. `message` is the `Display` text, so for a policy denial it is just `PolicyDenied`, with no reasons. `details` carries the structured bytes. The compacted-history inline frame now has `code = INVALID_ENVELOPE`, and its message sentence is unchanged.
3. **S1 — closed policy rule objects at admission.** An unknown key is refused with `INVALID_POLICY_DEFINITION`, and the error names the path. `^[_$]` annotation keys are ignored. `x-<reverse-domain>` keys are legal only at the top level, must hold an object value, and are refused unless a `RuleExtension` is registered; the server binary registers none. `Initialize` advertises `PolicyRegistryCapability.rule_extensions` (proto 0.1.11). `rules.audit` is refused; it is replaced by `MACP_AUDIT_LEVEL`/`MACP_AUDIT_INFO_*`.
4. **`WatchSignalsResponse.sender_authenticated`** (proto 0.1.11). It is `true` under JWT and static bearer auth and `false` under dev-mode auth.
5. **`session_id` ≤ 128 bytes** (`MAX_SESSION_ID_BYTES`, landed in #229), plus the long-standing strict UUID rule: a 36-char parseable UUID must be canonical lowercase v4/v7 and never falls through to base64url (`crates/macp-core/src/session.rs:762-796`).
6. **`semantics_rev` 4.** Decision enums are case-exact (S7). Handoff rule 3a (S5) and Task rule 2a (S6) were added. Quorum S4 makes an unreachable threshold decline. The control plane is an observer that never sends mode messages (`src/contracts/runtime.ts:42-47`), so for it these are projection-only (§2).
7. **Image.** `ghcr.io/multiagentcoordinationprotocol/macp-runtime:0.9.0` and `:0.9` exist, so the harness can now pin the real release tag.

The control plane's whole runtime-error surface was built against status-only, message-text classification. Under 0.9.0 that surface still *compiles* and mostly still *runs*, but several branches now silently mis-classify. The impact matrix below lists each one.

## 2. Impact matrix

| Change | Impact | Evidence (`origin/main`) | Phase |
|---|---|---|---|
| Harness pins runtime `:0.8.6` | Integration suite never exercises 0.9.0 | `docker-compose.test.yml:18-28` | 1 |
| Tested range `>=0.8.0 <0.9.0` | Every 0.9.0 runtime logs `untested` at startup (warn only, never blocks) | `src/runtime/runtime-version.ts:1-6`; `README.md:142`; `docs/INTEGRATION.md:33-35` | 1 |
| S13: `mapGrpcError` maps by status only and ignores `macp-error-code` | `STREAM_LAGGED` → 429 `RATE_LIMITED` (should be 503); `PAYLOAD_TOO_LARGE` → 429 (should be 413); `POLICY_DENIED` → generic 403 `FORBIDDEN` (should be `ErrorCode.POLICY_DENIED` with reasons); `REGISTRY_READ_ONLY`/`SESSION_NOT_OPEN` are indistinguishable 409 `CONFLICT`s | `src/runtime/grpc-helpers.ts:140-178` | 2 |
| S13: run-failure classification greps the message for code names | The code names now travel in metadata, not in the status message, so `UNKNOWN_POLICY_VERSION`/`POLICY_DENIED`/`INVALID_POLICY_DEFINITION`/`SESSION_ALREADY_EXISTS` are never recognised | `src/runs/run-executor.service.ts:489-520` (`msg.includes(...)`) | 2 |
| S13: `NOT_FOUND` is now shared by three codes | `pollForOpenSession` retries any `ErrorCode.NOT_FOUND` until the poll timeout, which would include a non-session `NOT_FOUND` | `src/runs/run-executor.service.ts:469-470` | 2 |
| S13: read-only registry detection keys on `grpcCode === 9` plus message text | Works today only by coincidence of status/text; the authoritative signal is `macp-error-code = REGISTRY_READ_ONLY` | `src/controllers/runtime.controller.ts:188-232` (`translateRegistryError` :208-216); its spec at `runtime.controller.spec.ts:270-273` | 2 |
| S13: circuit breaker counts coded client errors as failures | A burst of `INVALID_ARGUMENT`/`ALREADY_EXISTS`/`FAILED_PRECONDITION` refusals (e.g. stricter S1 admission, `SESSION_NOT_OPEN`) can open the breaker against a healthy runtime | `src/runtime/rust-runtime.provider.ts:173-183` (`isExpectedError` = `NOT_FOUND` \| `PERMISSION_DENIED` only) | 2 |
| S13: `ListSessions` halves page size on any `RESOURCE_EXHAUSTED` | `RATE_LIMITED`/`STREAM_LAGGED` trigger the payload-size back-off; only an uncoded or `PAYLOAD_TOO_LARGE`-equivalent condition should | `src/runtime/rust-runtime.provider.ts:570-629` (`isResourceExhausted` :625-629) | 2 |
| Inline `MACPError.details` dropped at the provider boundary | Structured policy-deny reasons/denials are lost before normalisation | `src/runtime/rust-runtime.provider.ts:294-306`; `src/contracts/runtime.ts:52-57` (no `details`) | 3 |
| Inline policy-deny reasons parsed from message text | With `message = "PolicyDenied"`, the inline `policy.denied` event's reasons degrade to `["PolicyDenied"]`. Detection still fires (`err.code === 'POLICY_DENIED'`), but the reasons are wrong | `src/events/event-normalizer.service.ts:139-166`, `parsePolicyDenyReasons` :531-541; `ASSUMPTIONS.md` P2 (free-text inline code) is now obsolete | 3 |
| Compacted-history comments/mocks describe a shape the runtime no longer emits | Detection still works (it matches the message sentence via `COMPACTED_HISTORY_RE`), but the comments say `code = status.message()` and the integration mock is a terminal `code: 9` the runtime never sends | `src/runs/stream-consumer.service.ts:280-325, 390-416`; `test/integration/stream-gap.integration.spec.ts:15,41,48`; `test/integration/stream-resume-live.integration.spec.ts:69-71,631,645`; `docs/INTEGRATION.md:12,283`; `docs/ARCHITECTURE.md:214-219`; `docs/TROUBLESHOOTING.md:131` | 3 |
| `STREAM_LAGGED` on `WatchSessions`/`WatchSignals` is now identifiable | Both consumers reconnect after a generic 5 s with no lag-specific log/metric; a lagged `WatchSessions` can miss lifecycle events, so the resync must not be silent | `src/runs/session-discovery.service.ts:73-79`; `src/runs/signal-consumer.service.ts:77-83`; runtime `src/server.rs:749,1428,1600,1623` | 3 |
| S1 closed rules: CP closed-set check diverges from the runtime | The CP's `"*"` validator reports `_`/`$` annotation keys as `unrecognized key`, which the runtime ignores. Its comments/docs claim the runtime ignores unknown keys, which is now false. The vendored schemas lack the `^x-…` patternProperty | `src/policy/policy-rules-validator.service.ts:84-111`; `src/policy/schemas/README.md:1-8` (vendored at spec `7159afe`); `src/controllers/runtime.controller.ts:107-112`; `docs/API.md:510-515` | 4 |
| S1: `x-` extension keys gated on `Initialize`-advertised `rule_extensions` | The CP cannot pre-check `x-` keys, because it drops the capability's contents unread | `src/runtime/rust-runtime.provider.ts:185-229` (passes `policyRegistry` through raw; no `ruleExtensions` use anywhere in `src/`) | 4 |
| `session_id` mirror is looser than the runtime | The CP accepts uppercase and v1–v6 UUIDs and base64url tokens longer than 128 bytes, then fails late at the runtime instead of at `validate` | `src/runs/run-executor.service.ts:19-31` (`/i` flag, `[1-7]`, `{22,}` unbounded), used at :83, :128; `src/dto/run-descriptor.dto.ts:47-53` | 4 |
| `WatchSignalsResponse.sender_authenticated` | Dropped; signal consumers cannot tell a dev-mode (unauthenticated) sender from a verified one | `src/runtime/rust-runtime.provider.ts:779-830` (maps `chunk.envelope ?? chunk.signal ?? chunk`, :813-816) | 5 |
| S7 Decision case-exact enums | **No change.** The projection is case-tolerant (`toUpperCase`) and the CP never sends Decision messages | `src/projection/projection.service.ts:778-835`; `src/contracts/runtime.ts:42-47` | — (see Q4) |
| S5 Handoff 3a / S6 Task 2a / S4 Quorum unreachable-decline | **No change.** These are runtime-side acceptance rules; the CP only projects accepted envelopes and never sends | `src/contracts/runtime.ts:42-47` | — |
| `rules.audit` refused / S2 `schema_version` {1,2,3} | **Already aligned.** No `audit` usage in `src/` or `test/`; the {1,2,3} pre-check with default 3 shipped in v0.8.0 P3 / v0.8.6 | `src/controllers/runtime.controller.ts:62-140` | — |
| Proto 0.1.11 | **Already done** (#113) | `package.json:30` | — |

## 3. Work plan

### Phase 1 — Repoint the harness and tested range at 0.9.0

**Status: DONE** (2026-10-18, Opus verify PASS round 1)

**Divergences from plan:** the old "v0.8.1–v0.8.6 absorption" section in `docs/INTEGRATION.md` is kept as history (its range note now says "at the time; widened to <0.10.0") instead of being replaced; the new section does not link this plan because `plans/` is gitignored. AC3: 8 suites / 28 tests are already red on `main` against `:0.8.6` (agent-driven specs time out waiting for "run completed" — the docker tier has no agents driving sessions; CI runs that tier only via manual dispatch). They are a pre-existing harness limitation, not a 0.9.0 regression, so they are recorded rather than attributed to a P2–P5 item.

**Goal:** CI's real-runtime integration tier runs against the released 0.9.0 image, and a 0.9.x runtime classifies as `tested`.

**Files:**
- `docker-compose.test.yml:28`: change `macp-runtime:0.8.6` → `macp-runtime:0.9.0`. Keep the full patch tag, matching the existing comment at :18-27 (metadata-action strips the leading `v`). Do not use `:0.9`; a moving tag makes CI non-reproducible.
- `src/runtime/runtime-version.ts:1-6`: set `maxExclusive: [0, 10, 0]` and update the comment to "absorbed through macp-runtime v0.9.0". Leave `min` at `[0, 8, 0]`, because Phase 2 keeps 0.8.x working (see §5).
- `README.md:142` and `docs/INTEGRATION.md:33-35`: replace the "v0.8.1–v0.8.6 absorption" section with a "v0.8.7–v0.9.0 absorption" section. It should say that the proto is `^0.1.11`, the range is `>=0.8.0 <0.10.0`, and it should link this plan.

**Acceptance criteria:**
1. `docker compose -f docker-compose.test.yml up` pulls `:0.9.0` and `GetManifest` returns the six modes, including `ext.multi_round.v1`.
2. `classifyRuntimeVersion('0.9.0')` returns `tested`, and `0.10.0` returns `untested`.
3. `INTEGRATION_RUNTIME=docker npm run test:integration:docker` is green, or every red spec is attributed to a Phase 2–5 item and fixed there in the same PR train (§4).

**Tests:** extend the existing `runtime-version` unit spec with `0.9.0`, `0.9.7` (tested) and `0.10.0` (untested) cases. The real-runtime tier is the acceptance gate.

### Phase 2 — Map runtime errors by registry code, not by gRPC status

**Status: DONE** (2026-10-18, Opus verify PASS round 1)

**Divergences from plan:** carried fields live on `AppException.metadata` (`macpErrorCode`, `grpcCode`, `reasons`, `denials`), not `details` — that is the existing error-body field. The `ok:false` `INVALID_POLICY_DEFINITION` string check in `registerPolicy` stays: that in-band result has no code. `UNKNOWN_POLICY_VERSION` stays 400 as a run-failure reason; a directly mapped status uses the registry's 404. The breaker also counts transport statuses when coded (ASSUMPTIONS P2 v0.9.0). Added a real-runtime spec (`policy-registry-readonly.integration.spec.ts` + compose `runtime-readonly` on :50052 with `MACP_POLICIES_DIR`) proving coded `REGISTRY_READ_ONLY` → 405 — green on 0.9.0. No CHANGELOG exists in the repo; the client-visible changes are documented in `docs/API.md` / `docs/TROUBLESHOOTING.md`.

**Goal:** every gRPC failure from the runtime becomes an `AppException` whose `errorCode`/HTTP status come from `macp-error-code` (registry HTTP column). Every downstream branch (run-failure classification, poll retry, read-only registry, circuit breaker, ListSessions back-off) keys on that code instead of status number or message text.

**Files:**
- `src/runtime/grpc-helpers.ts:140-178` (`mapGrpcError`):
  - Read `error.metadata?.get('macp-error-code')?.[0]`.
  - Add a `REGISTRY_CODE_TO_HTTP` table mirroring macp-runtime `crates/macp-core/src/error.rs:174-215`: `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `SESSION_NOT_FOUND` 404, `SESSION_NOT_OPEN` 409, `DUPLICATE_MESSAGE` 409, `SESSION_ALREADY_EXISTS` 409, `INVALID_ENVELOPE` 400, `UNSUPPORTED_PROTOCOL_VERSION` 400, `MODE_NOT_SUPPORTED` 400, `PAYLOAD_TOO_LARGE` 413, `RATE_LIMITED` 429, `INVALID_SESSION_ID` 400, `INTERNAL_ERROR` 500, `UNKNOWN_POLICY_VERSION` 404, `POLICY_DENIED` 403, `INVALID_POLICY_DEFINITION` 400, `REGISTRY_READ_ONLY` (see Q1), `INVALID_REQUEST` 400, `STREAM_LAGGED` 503, `AGENT_NOT_FOUND` 404, and the legacy `UNAUTHORIZED` 403.
  - Map to the matching existing `ErrorCode` where one exists (`POLICY_DENIED`, `UNKNOWN_POLICY_VERSION`, `INVALID_POLICY_DEFINITION`, `SESSION_ALREADY_EXISTS`, `INVALID_SESSION_ID`, `MODE_NOT_SUPPORTED`, `REGISTRY_READ_ONLY`, `RATE_LIMITED`, `FORBIDDEN`, `UNAUTHENTICATED`). Add `PAYLOAD_TOO_LARGE`, `SESSION_NOT_OPEN`, `STREAM_LAGGED`, `INVALID_ENVELOPE` and `DUPLICATE_MESSAGE` to `src/errors/error-codes.ts` (additive).
  - Always carry `{ grpcCode, macpErrorCode }` in `details`.
  - For `POLICY_DENIED`, decode `macp-error-details-bin` and attach `reasons` and `denials`. Reuse the parser already used by `fromAck` (`grpc-helpers.ts:32-75`) and extend it to return `denials` too.
  - Unknown or absent code: fall back to today's status-only table, unchanged (0.8.x compatibility, §5).
- `src/runs/run-executor.service.ts:489-520` (`handleExecuteError`): branch on `error.details.macpErrorCode` (or `error.errorCode`). Keep the `msg.includes` checks only as the 0.8.x fallback, with a comment saying so.
- `src/runs/run-executor.service.ts:469-470`: retry only when `macpErrorCode === 'SESSION_NOT_FOUND'`, or when the error is uncoded `NOT_FOUND` (0.8.x).
- `src/controllers/runtime.controller.ts:208-216` (`translateRegistryError`): match `macpErrorCode === 'REGISTRY_READ_ONLY'` first and keep the `grpcCode === 9` plus text heuristic as the 0.8.x fallback. Update `:225-228` in `rust-runtime.provider.ts`, whose comment says a read-only registry otherwise round-trips "to a FAILED_PRECONDITION", to say "to `REGISTRY_READ_ONLY`".
- `src/controllers/runtime.controller.ts:133-138`: the `result.error?.includes('INVALID_POLICY_DEFINITION')` check keys on the code instead.
- `src/runtime/rust-runtime.provider.ts:173-183` (`isExpectedError`): a status carrying any `macp-error-code` other than `INTERNAL_ERROR`/`STREAM_LAGGED` is a protocol-level refusal from a healthy runtime and must not count toward opening the breaker. Uncoded statuses keep today's rule.
- `src/runtime/rust-runtime.provider.ts:625-629` (`isResourceExhausted`): halve the page only when the code is absent (0.8.x) or `PAYLOAD_TOO_LARGE`. Propagate `RATE_LIMITED`/`STREAM_LAGGED` as mapped `AppException`s.
- `docs/API.md:530-537` (Policy Errors table) and `docs/TROUBLESHOOTING.md:252-264`: add `REGISTRY_READ_ONLY`, `PAYLOAD_TOO_LARGE` 413, `STREAM_LAGGED` 503, `SESSION_NOT_OPEN` 409, and note that `POLICY_DENIED` carries `reasons` + `denials`. `docs/INTEGRATION.md:118-121` (the PERMISSION_DENIED → FORBIDDEN walk-through): say that `POLICY_DENIED` is distinguished from `FORBIDDEN` by the code.

**Acceptance criteria:**
1. For each registry code above, a `ServiceError` with `code=<status>` plus `macp-error-code=<code>` maps to the table's HTTP status and `ErrorCode`, with `details.macpErrorCode` set. The two shared-status trios (`RESOURCE_EXHAUSTED`, `NOT_FOUND`) each resolve to three distinct outcomes.
2. A `POLICY_DENIED` status with `macp-error-details-bin` yields an `AppException(POLICY_DENIED, 403)` whose details hold the decoded `reasons` and `denials` arrays verbatim.
3. A `ServiceError` with no metadata maps exactly as today. Every existing row of `grpc-helpers.spec.ts:175` still passes unchanged.
4. `handleExecuteError` records `UNKNOWN_POLICY_VERSION`/`POLICY_DENIED`/`INVALID_POLICY_DEFINITION`/`SESSION_ALREADY_EXISTS` from the code, even when the message contains none of those strings.
5. `pollForOpenSession` rethrows a coded `UNKNOWN_POLICY_VERSION`/`AGENT_NOT_FOUND` `NOT_FOUND` on the first attempt and retries `SESSION_NOT_FOUND`.
6. Ten consecutive coded `INVALID_ARGUMENT` refusals leave the breaker closed, while ten `UNAVAILABLE`s open it.
7. A coded `RATE_LIMITED` on `ListSessions` is not retried with a halved page.

**Tests:**
- `src/runtime/grpc-helpers.spec.ts`: a table-driven case per registry code plus the no-metadata fallback, and the details-bin decode (including malformed JSON → no `reasons`, no throw).
- `run-executor.service.spec.ts`: AC4 and AC5.
- `runtime.controller.spec.ts:270`: add a coded `REGISTRY_READ_ONLY` case whose message lacks "read-only", so it proves the code path.
- `rust-runtime.provider.spec.ts`: AC6 and AC7.
- Real-runtime tier: register a policy against a `MACP_POLICIES_DIR` runtime and assert the read-only response.

### Phase 3 — Inline stream errors, compacted-history shape, and lag handling

**Status: DONE** (2026-10-18, Opus verifier, 2 rounds)

**Divergences from this plan (found during implementation):**
- **No real-runtime policy-deny test.** The planned live test cannot exist: `stream_inline_error` (the only frame carrying `details`, `macp-runtime/src/server.rs:239-255`) is reached only from the `Rejected` arm for an envelope sent on *that* stream (`server.rs:702-706`), and the passive-subscribe path (`server.rs:527-592`) yields only `Terminal` or detail-less `Inline` failures. The CP never sends, so a live runtime never delivers an inline `POLICY_DENIED` to it. AC1/AC2 are proven by unit tests; the details pass-through serves any non-passive consumer of the provider.
- **"0.8.x terminal code 9" was wrong.** 0.8.x already downgraded the compacted-resume `FAILED_PRECONDITION` to an inline frame with the sentence as both `code` and `message` (0.8.8 `server.rs:614-629`). The terminal code-9 branch is kept as a fallback for a proxy or other non-runtime peer only — no released runtime sends it (v0.5–0.8 are inline too; v0.4 has no compaction notice) — and counts only when uncoded; `stream-gap.integration.spec.ts` covers v0.9.0-inline, 0.8.x-inline and legacy-terminal.
- **Immediate lag reconnect is rate-limited:** at most once per 5s (`src/runs/watch-reconnect.ts`), so a persistently slow consumer cannot hot-loop the runtime.
- **"Rely on the initial sync" needed code:** the sync re-emits known sessions as `created`, which discovery used to skip. `SessionDiscoveryService.reconcileFromSnapshot` now moves a tracked `running`/`suspended` run to the snapshot's state, recovering a lifecycle event dropped in a lag (the runtime's `watch_sync.rs:40-42` asks lagged clients to reconcile).
- **`stream-resume-live`:** comments only; re-run green against a locally built v0.9.0 (3/3).

**Goal:** inline `StreamSession` errors preserve the runtime's structured `details`. The inline `policy.denied` event carries the real reasons and denials. Comments, mocks and docs describe the frame the runtime actually emits. A lagged watch stream is logged, counted and resynced, not silently reconnected.

**Files:**
- `src/contracts/runtime.ts:52-57`: add `details?: Uint8Array` to `inlineError`.
- `src/runtime/rust-runtime.provider.ts:294-306`: pass `details` through.
- `src/events/event-normalizer.service.ts:139-166`: when `details` decodes as JSON, take `reasons`/`denials` from it. Otherwise fall back to `parsePolicyDenyReasons(err.message, err.code)` (:531-541), keeping it for 0.8.x frames. Rewrite the stale comment at :139-148, which says code and message are both `status.message()`. Emit `denials` on the `policy.denied` event payload alongside `reasons` (additive field).
- `ASSUMPTIONS.md` P2: record that from 0.9.0 the inline code is the constant `POLICY_DENIED` and the reasons are structured, and that the free-text path is the 0.8.x fallback.
- `src/runs/stream-consumer.service.ts:280-325`: keep `COMPACTED_HISTORY_RE` as the discriminator, because the code is now the generic `INVALID_ENVELOPE`, so text remains the only distinguishing signal. Also accept `code === 'INVALID_ENVELOPE'` plus the regex on inline frames. Correct the comments at :280-321 and :390-416. The terminal `code === 9` branch stays as a 0.8.x fallback, commented as such.
- `test/integration/stream-gap.integration.spec.ts:15,41,48`: replace the terminal `{ code: 9 }` mock with the real inline frame `{ error: { code: 'INVALID_ENVELOPE', message: 'session history before ordinal 5 was compacted; resume with after_sequence >= 5 or re-read state via GetSession' } }`. Keep one 0.8.x terminal-`9` case, named as such.
- `test/integration/stream-resume-live.integration.spec.ts:69-71,631,645`: correct the comments; the assertions at :785/:824 already match `/compact/i`.
- `src/runs/stream-consumer.service.spec.ts:526-581` and `src/runs/run-recovery.service.spec.ts:253-295`: add the inline-`INVALID_ENVELOPE` variant beside the existing `code: 9` cases.
- `src/runs/session-discovery.service.ts:73-79` and `src/runs/signal-consumer.service.ts:77-83`: when the stream ends with `macp-error-code = STREAM_LAGGED`, log at `warn` with the stream name, increment a new `macp_watch_stream_lagged_total{stream}` counter, and reconnect immediately (no 5 s back-off). For `WatchSessions`, rely on its initial sync to re-deliver current state. Other errors keep today's 5 s path.
- `docs/INTEGRATION.md:12,283`, `docs/ARCHITECTURE.md:214-219` and `docs/TROUBLESHOOTING.md:131`: describe the compacted-history signal as an inline `MACPError` with code `INVALID_ENVELOPE` and the fixed sentence, not `FAILED_PRECONDITION`. Document the lag counter.

**Acceptance criteria:**
1. An inline frame `{code:'POLICY_DENIED', message:'PolicyDenied', details:<JSON {reasons:['quorum not met'], denials:[…]}>}` produces one `policy.denied` event with `reasons: ['quorum not met']` and the `denials` array. It does not produce `['PolicyDenied']`.
2. A 0.8.x-shaped frame (`code` = `message` = `PolicyDenied: a; b`, no details) still yields `reasons: ['a','b']`.
3. The inline `INVALID_ENVELOPE` compacted-history frame emits exactly one `session.stream.gap` and degrades to poll-only. An `INVALID_ENVELOPE` frame with any other message does not.
4. A `WatchSessions`/`WatchSignals` end with `STREAM_LAGGED` increments the counter once and reconnects without the 5 s delay. An uncoded end keeps the 5 s delay.
5. `stream-gap.integration.spec.ts` passes against the mock runtime with the corrected frame. The real-runtime `stream-resume-live` spec stays green on `:0.9.0`.

**Tests:** unit specs for AC1–AC4 in `event-normalizer.service.spec.ts`, `stream-consumer.service.spec.ts`, `session-discovery.service.spec.ts` and `signal-consumer.service.spec.ts`; integration for AC5. Add one real-runtime integration test: a Decision session whose policy denies the commitment, observed over `StreamSession`. Assert the `policy.denied` event's reasons equal the runtime's structured reasons. This is the live proof that the provider no longer drops `details`.

### Phase 4 — Policy and session admission parity with S1 and the 128-byte cap

**Status: DONE** (2026-10-18, Opus verifier, 2 rounds)

**Divergences from the plan:**
- **The live tier is a new spec, `test/integration/admission-parity-live.integration.spec.ts`, not `policy.integration.spec.ts`.** It needs `describeWithLocalRuntime`: per-agent tokens for `SessionStart`, plus an observer token with `can_manage_mode_registry` for RegisterPolicy (`macp-auth/src/security.rs:452`). It covers the whole AC5 table live (8 ids, not just the 129-byte case) and 13 AC3 rule sets, comparing the runtime's verdict to the CP's on each. It passed 22/22 on a locally built v0.9.0.
- **`"*"` keys are closed over the union of the five modes at every level (verifier round 1 gap).** The earlier per-top-level-key check refused `acceptance: {criterion, implicit_accept_timeout_ms}`, which the runtime accepts. The fix mirrors the runtime's `rule_shape_for_mode("*")` walk and requires every owning mode to accept each value.
- **The CP refusal message now leads with `INVALID_POLICY_DEFINITION:`,** matching the runtime's in-band refusal, so both layers present one 400 contract (AC2's wording).
- **The vendor-extension refusal text is the runtime's verbatim,** including the Debug-formatted `(implemented: ["x-…"])` list.
- **When capabilities are unknown, the name gate is skipped** (provider not initialized, or `ruleExtensions` not a string array); the shape checks always run. A 0.8.x runtime decodes the field to `[]`.
- **Q4 done in this phase.** `test/fixtures/decision-mode.ts:58,128,178` are now `APPROVE`; `:210` `reject` stays lowercase, with a comment, as the projection-tolerance pin.


**Goal:** the control plane's own pre-checks agree with the runtime's 0.9.0 admission. The CP should never refuse what the runtime accepts, and should catch what the runtime will refuse before the round-trip, with the same reason.

**Files:**
- `src/policy/schemas/*.schema.json`: re-vendor all five byte-for-byte from spec `60262b8`. The only delta is the `^x-[a-z0-9]+(\\.[a-z0-9-]+)+$` top-level `patternProperties` entry. `src/policy/schemas/README.md:1-8`: bump the pin to `60262b8`, and replace the "the runtime does not enforce closed-set rules (#167)" text with "the runtime enforces closed rule objects since 0.9.0 (S1); this copy is a fail-fast pre-check and must stay byte-identical".
- `src/policy/policy-rules-validator.service.ts:84-111` (`validateWildcardRules`): skip top-level keys matching `^[_$]`, as the runtime does. Treat `x-…` keys via the extension gate below instead of `unrecognized key`. Also apply the `^[_$]` skip to the per-mode Ajv path if the vendored schemas do not already exempt them; verify against the spec copy and do not assume.
- Extension gate: `src/runtime/rust-runtime.provider.ts:185-229` already caches `policyRegistry`. Expose `ruleExtensions` (proto 0.1.11 `PolicyRegistryCapability.rule_extensions`) from the cached capabilities. The validator refuses an `x-` key whose name is not advertised, with the runtime's message shape (the key path). It also refuses a non-object `x-` value and an `x-` key below the top level.
- `src/controllers/runtime.controller.ts:107-112` and `docs/API.md:510-515`: drop "the runtime ignores unknown keys". State that both layers refuse them and that the CP's check exists to fail before the gRPC call with the same path-naming message.
- `src/runs/run-executor.service.ts:19-31` (`isValidSessionId`): mirror `crates/macp-core/src/session.rs:762-796` exactly:
  - reject empty strings and strings over 128 bytes (`Buffer.byteLength`)
  - if 36 chars with `-` and parseable as a UUID, require canonical lowercase and version 4 or 7, with no base64url fall-through
  - otherwise accept `^[A-Za-z0-9_-]{22,}$`
  Update the comment's citation, the error text at :84, and `src/dto/run-descriptor.dto.ts:49`.

**Acceptance criteria:**
1. `POST /runtime/policies` with `rules: { "_note": "x", … }` on a `"*"` policy is accepted by the CP and forwarded. Today it is a 400 `unrecognized key`.
2. `rules: { "x-com.example": {…} }` is refused by the CP with 400 `INVALID_POLICY_DEFINITION` naming `x-com.example`, when the runtime advertises no extensions. It is forwarded when the runtime advertises that name. `rules: { "x-com.example": 1 }` and a nested `x-` key are refused.
3. `rules: { "audit": {…} }` and a misspelt key (`veto_threshhold`) are refused by the CP. The same request with the CP check bypassed is refused by the live 0.9.0 runtime with `INVALID_POLICY_DEFINITION`, which proves parity rather than CP-only strictness.
4. The five vendored schema files are byte-identical to spec `60262b8` (`cmp` in a unit test, or the existing vendoring check if one exists).
5. `isValidSessionId` rejects an uppercase v4 UUID, a v1 UUID and a 129-byte base64url token. It accepts a lowercase v4, a lowercase v7, a 22-char token and a 128-byte token. Each verdict matches the runtime's on the real-runtime tier.

**Tests:**
- `policy-rules-validator.service.spec.ts`: AC1 and AC2.
- `runtime.controller.spec.ts`: forwarding and refusal.
- A new real-runtime spec in `policy.integration.spec.ts`: AC3, which calls the provider directly to bypass the CP check.
- `run-executor.service.spec.ts`: an AC5 unit table, plus one real-runtime case for the 129-byte token.

### Phase 5 — Carry `sender_authenticated` on signals

**Status: DONE** (2026-10-18, Opus verifier, 2 rounds)

**Divergences (implementation):**
- **AC2 is not achievable on the wire.** `sender_authenticated` is a plain proto3 `bool` without presence (`core.proto:417`), so "absent on 0.8.x" decodes to `false`, exactly like dev mode. The proto documents this as the safe direction. The event therefore always carries a boolean (only a literal `true` counts), and docs list two states, not three. A version gate from Initialize was rejected (see ASSUMPTIONS "P5 (v0.9.0)"). The UI console has to treat only `true` as verified.
- The real-runtime spec is a new `test/integration/signal-auth-live.integration.spec.ts` (gated by `describeWithRealRuntime`). It expects `true` under `INTEGRATION_RUNTIME=remote` with `MACP_RUNTIME_AUTH_TOKENS_FILE`, else `false`. In dev mode it lists the CP's dev identity as a session participant, because dev auth grants no `is_observer`.
- `signal-consumer.service.ts` needed no change: it already passes the raw event to the normalizer as is.
- **Wider than the Files list (verifier round 1).** The console's signal rail reads the projection, not the events. So the flag is also on the projected signal entry (`SignalProjection.signals[].senderAuthenticated`, optional; no projection schema bump). It is also on every event built from the same envelope that attributes content to the sender: `message.received`, `llm.call.completed` (feeds token/cost metrics) and the ambient `progress.reported`. `participant.seen` stays unmarked. The live spec checks the projection too.

**Goal:** signal events expose whether the runtime authenticated the sender, so consumers and the console can distinguish dev-mode signals from verified ones.

**Files:**
- `src/runtime/rust-runtime.provider.ts:779-830` (`watchSignals`, mapping at :813-816): read `chunk.senderAuthenticated` (proto 0.1.11) and attach it to the yielded signal. It is absent on 0.8.x runtimes, so treat it as `undefined`, never `false`. *(Superseded: not achievable on the wire; see Divergences above.)*
- `src/contracts/runtime.ts`: add `senderAuthenticated?: boolean` to the signal shape.
- `src/runs/signal-consumer.service.ts` and the signal → event path in `src/events/event-normalizer.service.ts`: propagate it as `senderAuthenticated` on the emitted signal event payload (additive).
- `docs/API.md` (signal event schema) and `docs/INTEGRATION.md`: document the field, its three states (`true` / `false` / absent on runtimes before 0.9.0), and that `false` means dev-mode auth.

**Acceptance criteria:**
1. A `WatchSignalsResponse` with `senderAuthenticated: true` or `false` yields a signal event carrying the same value.
2. A response without the field yields an event without it, rather than with `false`.
3. On the real-runtime tier, the dev-mode harness yields `false`. On the static-bearer harness, if one is configured, it yields `true`.

**Tests:** provider and normalizer unit specs for AC1 and AC2; the real-runtime signal integration spec for AC3.

## 4. Sequencing

Phase 1 goes first, because it is the acceptance gate for everything else. Phase 2 comes next: Phase 3's lag handling and the read-only/admission assertions in Phase 4 consume `details.macpErrorCode` from it. Phases 3, 4 and 5 are mutually independent after Phase 2 and can land in parallel PRs. Phase 1 may be merged with a temporarily red real-runtime tier only if every red spec is explicitly mapped to an open Phase 2–4 PR. Otherwise, land Phase 1 together with Phase 2.

## 5. Compatibility and rollout

Every change is additive and keyed on the presence of 0.9.0 signals: `macp-error-code` metadata, inline `details`, `senderAuthenticated` and `ruleExtensions`. When a signal is absent, the code falls back to today's status/text behavior. The exception is `senderAuthenticated`: it has no presence, so a 0.8.x runtime reads as `false`, the proto's documented safe direction (Phase 5 Divergences). This keeps a 0.8.x runtime fully supported, which is why `TESTED_RUNTIME_RANGE.min` stays `[0, 8, 0]`. Each fallback branch keeps or gains a unit test.

**Externally visible changes for HTTP clients:**
- `PAYLOAD_TOO_LARGE` becomes 413 instead of 429.
- `STREAM_LAGGED` becomes 503 instead of 429.
- Commit-time `POLICY_DENIED` becomes `errorCode: POLICY_DENIED` instead of `FORBIDDEN`, at the same 403.
- New `ErrorCode` members are added.
- `"*"` policies with `_`/`$` keys stop being refused.
- Uppercase, non-v4/v7 and over-128-byte session ids are refused at `validate` instead of at the runtime.

These changes belong in the CHANGELOG under a "Runtime 0.9.0 alignment" heading. The UI console should be checked for any branch on `FORBIDDEN` for policy denials or on 429 for size errors before release. Rollback is a plain revert per phase; no data migration or persisted-state change is involved.

## 6. Out of scope / already done

- Proto `^0.1.11`: done in #113 (`package.json:30`).
- `schema_version` {1,2,3} pre-check with default 3: done in v0.8.0 P3 and v0.8.6 (`runtime.controller.ts:62-140`).
- Ack-path `POLICY_DENIED` reasons from `ack.error.details` / trailing `macp-error-details-bin`: already works (`grpc-helpers.ts:32-75`). Phase 2 extends it to `denials` only.
- Handoff implicit-accept projection: done in v0.8.0 P6.
- Decision vote/recommendation casing: the projection is already case-insensitive (`projection.service.ts:778-835`).
- `rules.audit`: not used anywhere in `src/` or `test/`.
- S4/S5/S6 mode acceptance rules: runtime-side; the CP never sends mode messages.
- Open issues #111 and #112: unrelated to this upgrade.

## 7. Open questions

1. **`REGISTRY_READ_ONLY` HTTP status.** The registry's HTTP column says 409. The CP has returned 405 `METHOD_NOT_ALLOWED` since v0.5.0 T9 (`runtime.controller.ts:188-232`, `error-codes.ts` comment). Options: adopt 409 for registry parity (a breaking change for the console), or keep 405 and document the deliberate divergence. The recommendation is to keep 405: the `errorCode` is already `REGISTRY_READ_ONLY`, so clients branch on that, and 405 more accurately describes "this method is disabled on this deployment".
2. **Should `STREAM_LAGGED` ever reach an HTTP client?** It only arises on server streams the CP consumes internally. With Phase 2 it maps to 503 if it ever surfaces through a unary-looking path. The recommendation is yes as 503 `STREAM_LAGGED` (retryable), with no special case.
3. **Should the CP keep its own closed-set rule validation now that the runtime enforces it?** The recommendation is to keep it, re-synced in Phase 4. It fails before the gRPC round-trip with a field-level message, and the byte-identity test keeps it from drifting.
4. **Should the lowercase `vote: 'approve'` fixtures be uppercased?** These are `test/fixtures/decision-mode.ts:58,128,178`. They are projection inputs only, and a 0.9.0 runtime would never accept or emit them. The recommendation is to uppercase them so fixtures reflect the wire, while keeping one explicit lowercase case that pins the projection's tolerance.
