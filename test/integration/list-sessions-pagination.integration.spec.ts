import { describeWithRealRuntime } from '../helpers/real-runtime-gate';
import { RustRuntimeProvider } from '../../src/runtime/rust-runtime.provider';

/**
 * Live ground-truth test for `RustRuntimeProvider.listSessions()` (Phase 1 of
 * plans/absorb-runtime-v0.7.0.md). It proves the multi-page drain branch in
 * `rust-runtime.provider.ts:452-475` actually executes against a real
 * runtime — until now that branch has only ever run against
 * `ScriptedMockRuntimeProvider`, which never returns a `next_page_token`.
 *
 * This spec constructs `RustRuntimeProvider` directly instead of booting the
 * whole app via `createTestApp()`. `listSessions()` needs no database, and
 * booting the app is actively harmful against a real runtime:
 * `SESSION_DISCOVERY_ENABLED` defaults to true
 * (`src/config/app-config.service.ts:120`), and the runtime's `WatchSessions`
 * replays every existing session as a CREATED event on connect — so booting
 * the app auto-creates one run per persisted session (hundreds, against a
 * seeded store) in the shared test DB and opens one concurrent
 * `StreamSession` gRPC stream per run. None of that is needed here, and it
 * leaks state into every later spec in the suite. Constructing the provider
 * directly with `.onModuleInit()` avoids the Nest module graph (no DB, no
 * SessionDiscoveryService, no StreamConsumer) while still exercising the
 * real, typed, production `RustRuntimeProvider` — that is the whole point of
 * this test.
 *
 * Requires a real macp-runtime 0.7.0 reachable at RUNTIME_ADDRESS with more
 * than one server page (default page size 100) of *live* (non-terminal)
 * sessions. The runtime's persisted `.macp-data` store is NOT sufficient on
 * its own — its sessions are terminal and get evicted from memory at startup
 * (`evicted stale sessions from memory ... count=131`), so `ListSessions`
 * returns nothing for them. See docs/TROUBLESHOOTING.md → "Running a local
 * macp-runtime for verification" for how to seed enough live sessions and
 * the exact boot/verification commands.
 *
 * PAGE SIZE CAVEAT (read before touching this file in Phase 2+): the current
 * `listSessions()` never sends an explicit `pageSize`
 * (`rust-runtime.provider.ts:465` sends `{ pageToken }` only), so the runtime
 * applies its own server-side default — 100 sessions per page as of runtime
 * 0.7.0 — no matter what `RUNTIME_LIST_SESSIONS_PAGE_SIZE` is set to. Phase 2
 * of the absorption plan will make the CP send an explicit `pageSize`; until
 * that lands, `EXPECTED_PAGE_SIZE` below is floored at 100 so a configured
 * value below the true server page size (e.g. the `=50` that P2 AC6
 * prescribes) can never lower the multi-page guard below what the server
 * actually enforces today — doing so would let a single 100-item page
 * masquerade as proof of multi-page draining. A configured value above 100
 * is still allowed to raise the guard, which only makes the test stricter.
 * Once Phase 2 makes the CP send an explicit `pageSize` AND exposes
 * `pagesFetched`, replace this whole env-driven/floored `EXPECTED_PAGE_SIZE`
 * scheme with a direct assertion on `pagesFetched > 1` — that is the real
 * invariant we want, and it removes the coupling to the server's default
 * page size entirely.
 */

// Mirrors the not-yet-introduced Phase 2 config knob so this test keeps
// exercising a genuine multi-page drain once page size becomes configurable.
// Today (Phase 1, pre-P2) the CP never sends pageSize, so the runtime's own
// server-side default applies — 100 sessions/page as of runtime 0.7.0 —
// regardless of what this env var says.
//
// Guard against the empty-string case: `??` only catches `undefined`/`null`,
// not `''`. `RUNTIME_LIST_SESSIONS_PAGE_SIZE=` (blank, routine in
// `.env`/CI templates) would otherwise produce `Number('') = 0`, which
// disables the loud-failure guard below entirely — `toBeGreaterThan(0)`
// would then pass with a single session, a full false green. Treat any
// blank, non-numeric, zero, or negative value the same as "unset" and fall
// back to the server default of 100.
const RAW_PAGE_SIZE = process.env.RUNTIME_LIST_SESSIONS_PAGE_SIZE?.trim();
const PARSED_PAGE_SIZE = RAW_PAGE_SIZE ? Number(RAW_PAGE_SIZE) : NaN;
const CONFIGURED_PAGE_SIZE =
  Number.isFinite(PARSED_PAGE_SIZE) && PARSED_PAGE_SIZE > 0 ? PARSED_PAGE_SIZE : 100;

// FLOOR at the true server-side default (100): the CP does not send an
// explicit `pageSize` yet, so the runtime always pages at 100 regardless of
// this env var. A configured value below 100 must not lower the guard below
// the server's actual page size — that would let a single-page result (a
// full 100-item page from a store that isn't even multi-page-sized) satisfy
// `sessions.length > EXPECTED_PAGE_SIZE` without the drain loop's
// non-empty-next-page-token branch ever having executed, i.e. a false green.
// A configured value above 100 is left alone: raising the guard only makes
// the test stricter, never weaker. Once Phase 2 lands (CP sends `pageSize`,
// provider exposes `pagesFetched`), delete this floor and the env-driven
// constant above in favor of asserting `pagesFetched > 1` directly.
const EXPECTED_PAGE_SIZE = Math.max(CONFIGURED_PAGE_SIZE, 100);

describeWithRealRuntime('ListSessions pagination (live runtime)', () => {
  let provider: RustRuntimeProvider;

  beforeAll(async () => {
    // Minimal fakes for the three constructor deps — no DB, no Nest module
    // graph, no SessionDiscoveryService side effects. `any` is used only for
    // these three injected collaborators; `RustRuntimeProvider` itself stays
    // the real, typed, production class under test.
    const config: any = {
      runtimeAddress: process.env.RUNTIME_ADDRESS ?? '127.0.0.1:50051',
      runtimeTls: false,
      runtimeRequestTimeoutMs: 30000,
      runtimeCircuitBreakerThreshold: 5,
      runtimeCircuitBreakerResetMs: 30000
    };
    const credentialResolver: any = {
      resolve: async () => ({
        metadata: {
          authorization: `Bearer ${process.env.RUNTIME_DEV_AGENT_ID ?? 'macp-control-plane'}`
        }
      })
    };
    // Instrumentation is only touched by the circuit breaker for metric
    // recording; a no-op Proxy is sufficient since we never assert on it.
    const instrumentation: any = new Proxy(
      {},
      { get: () => new Proxy({}, { get: () => () => undefined }) }
    );

    provider = new RustRuntimeProvider(config, credentialResolver, instrumentation);
    await provider.onModuleInit();
  });

  it(
    'drains every page and returns unique, ascending session IDs spanning more than one server page',
    async () => {
      const sessions = await provider.listSessions();

      // ── Loud, non-vacuous failure if the store is too small ──
      // A store at or below one server page can never prove the multi-page
      // branch ran — `nextPageToken` would come back empty on page 1, and a
      // green test here would mean nothing. Fail with an actionable message
      // instead of silently passing, per plan §"Edge cases": "If the local
      // store is under 100, the test must skip loudly rather than pass
      // vacuously."
      if (sessions.length <= EXPECTED_PAGE_SIZE) {
        throw new Error(
          `listSessions() returned only ${sessions.length} sessions, which does not exceed the ` +
            `configured page size of ${EXPECTED_PAGE_SIZE}. This test cannot prove multi-page ` +
            `pagination against a store this small. Seed more live (non-terminal) sessions in the ` +
            `runtime (see docs/TROUBLESHOOTING.md → "Running a local macp-runtime for verification") ` +
            `so the total exceeds ${EXPECTED_PAGE_SIZE}, then re-run with ` +
            `INTEGRATION_RUNTIME=remote npm run test:integration.`
        );
      }

      // ── Proof the multi-page branch executed for real ──
      // `sessions.length > EXPECTED_PAGE_SIZE` is only reachable if the loop
      // in `listSessions()` followed a non-empty `next_page_token` at least
      // once — a single page of the configured size can never exceed itself.
      // A *short* page carrying a non-empty token (the runtime skips IDs
      // whose session vanished between the ID scan and the per-ID fetch) is
      // a legal intermediate state and does not affect this assertion: only
      // the final concatenated count matters here.
      expect(sessions.length).toBeGreaterThan(EXPECTED_PAGE_SIZE);

      const ids = sessions.map((s) => s.sessionId);

      // ── Uniqueness proves the keyset cursor advanced correctly ──
      // Runtime pagination is keyset-based on `session_id`. If the cursor
      // (`page_token`) were mishandled — e.g. re-sent stale, or dropped —
      // a page could be re-fetched and duplicate IDs would appear in the
      // concatenated result. Duplicates would mean the drain is not safe to
      // treat as a complete, deduplicated listing.
      expect(new Set(ids).size).toBe(ids.length);

      // ── Ascending byte order proves the server-side ordering contract ──
      // The runtime paginates `ListSessions` by ascending byte order of
      // `session_id` (UUID v4 — so this is NOT creation order; no test may
      // assume recency ordering, per the absorption plan's edge cases).
      // Only an empty `next_page_token` means "done" — a short page with a
      // token, or an empty `sessions` array with a token, are both legal
      // non-terminal responses and are already tolerated because this
      // assertion only inspects the final concatenated, in-order result.
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
    },
    // The drain does multiple gRPC round trips against a real runtime
    // (>= 2 pages here); give it generous headroom over the default 60s.
    120000
  );
});
