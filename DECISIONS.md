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
