# DECISIONS — absorb-runtime-v0.7.0

Outcome of `/reconcile` over the 15 `ASSUMPTIONS.md` entries logged during
`plans/absorb-runtime-v0.7.0.md`. Verified against merged `main` (through `43ea166`), the
runtime source, the CI workflows, and live probes.

**Result: 12 CONFIRMED · 3 NEEDS-CHANGE · 1 DEFER.** None is a one-way door. No migration was
written by any phase, so every choice below remains reversible.

## CONFIRMED — no action

| # | Entry | Note |
|---|---|---|
| 1 | P1 manual live-harness gate | Gate polarity matches `test-app.ts`; the spec fails loudly rather than passing vacuously |
| 2 | P1 `workflow_dispatch` docker mode | Moot — that path is already broken upstream of this gate (see issues) |
| 3 | P1 host Docker/Postgres unrepaired | Overtaken; the residual defect is in the harness, not the host (see issues) |
| 4 | P1 globalSetup bypass | Spec is still DB-free; bypass is moot now the suite runs on the isolated cluster |
| 5 | P2 result-object signature | Re-verified **zero production callers**; interface-only, no HTTP surface |
| 6 | P2 page size 200 | Bound is right; the root-cause gap is wider than recorded (see issues) |
| 8 | P2 halving ladder capped at 2 | Holds against the real breaker; regression test runs the real `CircuitBreaker` |
| 9 | P4 `GREATEST` monotonic write | "Stuck high" needs an ordinal reset that the schema makes impossible (`runId` PK, `runtimeSessionId` unique) |
| 10 | P4 duplicate-over-loss bias | Right direction — the too-high resume has no observable symptom at all |
| 11 | P4 cursor write outside the txn | Bounded at one envelope per crash, on the preferred side |
| 12 | P4 legacy ordinal-0 rows seeded as-is | **Reasoning is stronger than recorded** — `SessionMetadata` exposes no ordinal count, so `count(*)` is unreliable in *both* directions (overshoots on duplicates, undershoots for poll-degraded runs). A backfill remains possible later |
| 7 | P3 post-commit duplication | Mechanics confirmed; **blast radius was understated** — see below |

**Entry 7 correction.** The entry claimed one duplicated envelope. A *persistent* publish failure
(e.g. Redis StreamHub down) redelivers on every resubscribe, each re-committing raw + canonical +
projection rows before throwing again — so it is ×(`STREAM_MAX_RETRIES`+1) duplicates, then
poll-only degrade. The trade is still correct; the bound was wrong.

## NEEDS-CHANGE

**13 — P5 compaction detection matches on message text.** Low urgency. There *is* CI-running
coverage the entry did not credit (`stream-consumer.service.spec.ts:534-560` pins the live string
and asserts the over-match guard), but it pins a *copy*, so it stays green if the runtime rewords.
Tighten to `/history before ordinal \d+ was compacted/`, which also closes the `PolicyDenied`
over-match in the same edit. → issue.

**15 — P5 deferred ship-gate follow-ups.** All three are still on `main`, and **one premise I
recorded was wrong**: I called the `STREAM_RESUME_ENABLED=false` gap-skip "narrow to reach
(flag-off recovery never subscribes)". It is not narrow — `run-executor.service.ts:348` subscribes
unconditionally, independent of the flag, so the gap-skip is reachable on the **normal live path
for every run**. P7 is docs-only, so all three need issues.

**16 — P6 `canonical` required vs optional.** Neither side of the original debate was the best
answer. `canonical` is derived purely from `commitmentHash`, and legacy rows already carry that —
so `ProjectionService.get()` can recompute it at read time, right where it already defaults with
`?? {}`. That makes the required type honest for every persisted row, with no third state for
consumers and no rebuild. **Decision: adopt the read-time derive**, keeping the type required.
The live consumer (`macp-ui-console/.../decision-panel.tsx:172-179`) reads only
`commitmentHash`/`sessionId` through a hand-written mirror, so there is no compile-time coupling.
**Status: implemented** in PR #77 (`deriveMissingCanonical()` in `projection.service.ts`), not
left open — the only entry on this list that produced code rather than an issue.

## DEFER

**14 — live integration suite needs per-spec auth.** Specs are green in their pinned mode and CI
pins `mock`. Resolves when someone decides whether a live suite runs in CI at all; revisit if
`INTEGRATION_RUNTIME=remote` ever becomes a required check.

## Raise upstream (`macp-runtime` / `macp-proto`)

1. **A stable machine-readable `code` on inline `MACPError` stream frames.** Today
   `code = status.message()`, which is the single root cause of *both* the text-matching fragility
   (13) and the dead `policy.denied` path (15.3). One upstream change fixes both.
2. **Expose the session's accepted-envelope ordinal** on `SessionMetadata`/`GetSession`. Its
   absence is why the legacy ordinal-0 reconstruction has no safe data source, and why a too-high
   resume is undetectable in principle.
3. Failing (1), document the compaction message string as a stable contract.

# DECISIONS — absorb-runtime-v0.8.0 (2026-09-22)

Outcome of `/reconcile` over the 3 `ASSUMPTIONS.md` entries tagged
`Plan: plans/absorb-runtime-v0.8.0.md` (P2, P3, P5), run as the final step of that plan's
`/drive` pipeline after all 8 phases shipped and `/implement`'s finalization pass (§4)
passed. All three ranked low blast radius / reversible in a commit (no schema shape, public
contract, auth model, or irreversible migration in play) — each analyzed and settled by a
fresh Opus subagent per the Autonomy ladder, none escalated to Fable or to the user.

**Result: 3 CONFIRMED (2 with a same-day correction applied, 1 as-is). 0 NEEDS-CHANGE.
0 DEFER.** All settled without the user. Both corrections are additive/defensive-only
changes (a redaction wrap, a nested try/catch fallback) — neither touches a public
contract or changes existing behavior on the happy path.

## Entry: P2 — inline `policy.denied`'s `errorCode` carries unbounded operator text, not the
ack path's fixed constant

- **Original assumption:** Ship the inline path's `errorCode` as free-text (`err.code`
  verbatim), not normalized to the ack path's `"POLICY_DENIED"` constant — correct per the
  plan's explicit shape, but left unredacted before reaching the trace span.
- **Analysis (Opus):** The field-shape choice is still correct — normalizing loses the raw
  denial text for no compensating benefit, and the choice was in-scope and deliberate.
  But `RunEventService.recordSpanEvents` wrote every key-event span attribute (including
  this unbounded `errorCode` string) straight to `TraceService.addRunSpanEvent` with zero
  redaction, unlike the LLM-signal path elsewhere in the codebase which already redacts via
  `RedactionService`. Recommended: wire `RedactionService` into `recordSpanEvents` before
  the `addRunSpanEvent` call — a small, safe, purely additive fix (the service is
  identity-passthrough when `MACP_REDACT_PATTERNS` is unconfigured).
- **Decided by:** Opus (auto-settled, low blast radius).
- **Verdict:** Applied the fix. `RunEventService` constructor takes `RedactionService` as
  a 9th parameter; `recordSpanEvents` calls `this.redaction.redact(attrs)` before emitting.
  New test in `run-event.service.spec.ts` (mutation-tested — fails when the redact call is
  removed). Full suite green (828/828), typecheck/build/lint/prettier clean.
- **Resulting status:** `CONFIRMED (2026-09-22)` — field-shape choice confirmed as-is,
  redaction gap closed same-day.

## Entry: P3 — the CP's `schemaVersion` pre-check is now deliberately stricter than the
runtime's own admission gate, with no tracked trigger to widen it

- **Original assumption:** Hardcode the pre-check to the closed set `{1,2,3}`, matching the
  runtime's evaluator-time authoritative set rather than its looser registration-time
  admission check — correct today, but with no automated staleness detector if the runtime
  later widens its set.
- **Analysis (Opus):** Confirmed as the strongest available option. The runtime's manifest
  exposes no supported-schema-version field to derive the set from at startup, so fetching
  it dynamically isn't currently possible; dropping the local check entirely reintroduces
  the exact silent-registration-then-silent-evaluation-failure bug this phase fixed. The
  lack of a staleness detector is an accepted, low-probability, non-silent gap (a visible
  400, a one-line fix) rather than something that justifies new CI/monitoring machinery for
  a three-item enum. The in-code comment already shipped (`2ac9dc6`) pointing at the
  runtime's authoritative source is adequate mitigation — a future maintainer updating this
  repo for a new runtime release has a direct pointer to what to check.
- **Decided by:** Opus (auto-settled, low blast radius).
- **Verdict:** No code change — confirmed as-is.
- **Resulting status:** `CONFIRMED (2026-09-22)`.

## Entry: P5 — `consumeLoop`'s last-resort `.catch()` marks the stream marker
finalized/aborted but never calls `finalizeRun`/`markFailed`

- **Original assumption:** Only update the in-memory marker from the last-resort catch
  handler, deliberately not calling `finalizeRun` — reasoned at the time that adding a
  second fallible async operation into the one place that must not throw would just
  relocate the unhandled-rejection hazard one line later. Alternative (b) (a nested
  try/catch around a `finalizeRun` attempt) was identified but not implemented, to keep the
  phase minimal.
- **Analysis (Opus):** Recommended implementing the previously-deferred alternative (b).
  `finalizeRun`'s `doFinalize` closure sets `marker.finalized`/`marker.aborted` as its first
  two synchronous statements, before any fallible `await` — so wrapping the `finalizeRun`
  call in its own nested try/catch is strictly safe: even if the inner DB write throws, the
  marker ends up in exactly the same safe state the old marker-only code produced directly,
  while the common case (successful `markFailed`) now actually finalizes the run instead of
  leaving it stuck until a restart-triggered `RunRecoveryService` sweep reconciles it.
- **Decided by:** Opus (auto-settled, low blast radius).
- **Verdict:** Applied the fix. The `.catch()` handler in `stream-consumer.service.ts`'s
  `start()` now `await`s `this.finalizeRun(params.runId, marker, 'failed', error)` inside a
  nested `try/catch` that falls back to the original marker-only behavior on failure.
  Existing safety-net test extended with `markFailed`/`streamHub.complete` assertions; new
  test added for the nested-fallback path (mutation-tested — fails when the nested attempt
  is removed). Full suite green (828/828), typecheck/build/lint/prettier clean.
- **Resulting status:** `CONFIRMED (2026-09-22)` — original safety reasoning confirmed,
  completeness gap closed same-day.

## Summary

3 confirmed (2 with a same-day correction, 1 as-is), 0 changed-with-follow-up, 0 deferred.
All 3 settled without the user (Opus, low blast radius per the Autonomy ladder). The P2 and
P5 code changes (4 files: `run-event.service.ts`/`.spec.ts`,
`stream-consumer.service.ts`/`.spec.ts`) need to go through `/ship`'s normal
branch→PR→CI-watch→merge cycle before this reconcile pass is fully closed — not yet shipped
as of this entry.
