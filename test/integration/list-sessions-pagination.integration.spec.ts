import { describeWithRealRuntime } from '../helpers/real-runtime-gate';
import { RustRuntimeProvider } from '../../src/runtime/rust-runtime.provider';

/**
 * Live ground-truth test for `RustRuntimeProvider.listSessions()` (Phase 1 of
 * plans/absorb-runtime-v0.7.0.md, extended in Phase 2). It proves the
 * multi-page drain branch in `rust-runtime.provider.ts` actually executes
 * against a real runtime — until Phase 1 landed this branch had only ever
 * run against `ScriptedMockRuntimeProvider`, which never returns a
 * `next_page_token`.
 *
 * As of Phase 2, `listSessions()` sends an explicit `pageSize` (from
 * `AppConfigService.runtimeListSessionsPageSize`, default 200) and returns a
 * `RuntimeListSessionsResult` with `pagesFetched` and `complete` alongside
 * `sessions`. This test asserts directly on `pagesFetched > 1` — the real
 * signal that the drain loop followed a non-empty `next_page_token` at least
 * once — instead of inferring multi-page behavior from `sessions.length`
 * exceeding some assumed server page size. It also asserts `complete: true`:
 * against the seeded store below with the default max-pages/timeout budget,
 * the drain must reach an empty `next_page_token` and finish, or every other
 * assertion here is only about a prefix of the store, not the whole thing.
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
 * live (non-terminal) sessions than fit in one `RUNTIME_LIST_SESSIONS_PAGE_SIZE`
 * page. The runtime's persisted `.macp-data` store is NOT sufficient on its
 * own — its sessions are terminal and get evicted from memory at startup
 * (`evicted stale sessions from memory ... count=131`), so `ListSessions`
 * returns nothing for them. See docs/TROUBLESHOOTING.md → "Running a local
 * macp-runtime for verification" for how to seed enough live sessions and
 * the exact boot/verification commands. Because this fixture now sends an
 * explicit page size (default 200, same as production), a store of roughly
 * 150 sessions fits in a single page — set `RUNTIME_LIST_SESSIONS_PAGE_SIZE`
 * low (e.g. 50) to force multiple pages out of a smaller store, or seed more
 * sessions so the store exceeds the configured page size on its own.
 */

// Config knobs mirrored from `AppConfigService` (`src/config/app-config.service.ts`).
// This fixture builds `RustRuntimeProvider`'s config directly, bypassing
// AppConfigService/Nest DI entirely (see the class comment above), so the
// same env vars and defaults are deliberately duplicated here rather than
// imported, to keep this spec fully standalone.
//
// Guard against the empty-string case: `??` only catches `undefined`/`null`,
// not `''`. `RUNTIME_LIST_SESSIONS_PAGE_SIZE=` (blank, routine in
// `.env`/CI templates) would otherwise produce `Number('') = 0`, which would
// make the provider request page size 0. Treat any blank, non-numeric, zero,
// or negative value the same as "unset" and fall back to the production
// default of 200.
const RAW_PAGE_SIZE = process.env.RUNTIME_LIST_SESSIONS_PAGE_SIZE?.trim();
const PARSED_PAGE_SIZE = RAW_PAGE_SIZE ? Number(RAW_PAGE_SIZE) : NaN;
const CONFIGURED_PAGE_SIZE =
  Number.isFinite(PARSED_PAGE_SIZE) && PARSED_PAGE_SIZE > 0 ? PARSED_PAGE_SIZE : 200;

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
      runtimeCircuitBreakerResetMs: 30000,
      // listSessions() pagination knobs — see AppConfigService for the
      // production defaults this mirrors.
      runtimeListSessionsPageSize: CONFIGURED_PAGE_SIZE,
      runtimeListSessionsMaxPages: 200,
      runtimeListSessionsTimeoutMs: 60000
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
      const { sessions, complete, pagesFetched } = await provider.listSessions();

      // ── Loud, non-vacuous failure if the store is too small ──
      // A store that fits in one page can never prove the multi-page branch
      // ran — `pagesFetched` would stay at 1, and a green test here would
      // mean nothing. Fail with an actionable message instead of silently
      // passing, per plan §"Edge cases": "If the local store is under 100,
      // the test must skip loudly rather than pass vacuously."
      if (pagesFetched <= 1) {
        throw new Error(
          `listSessions() only fetched ${pagesFetched} page(s) (returned ${sessions.length} sessions) against ` +
            `a configured page size of ${CONFIGURED_PAGE_SIZE} (RUNTIME_LIST_SESSIONS_PAGE_SIZE). This test ` +
            `cannot prove multi-page pagination against a store this small relative to the page size. Either ` +
            `set RUNTIME_LIST_SESSIONS_PAGE_SIZE to a smaller value (e.g. 50) so the current store spans ` +
            `multiple pages, or seed more live (non-terminal) sessions in the runtime (see ` +
            `docs/TROUBLESHOOTING.md → "Running a local macp-runtime for verification") so the total exceeds ` +
            `${CONFIGURED_PAGE_SIZE}, then re-run with INTEGRATION_RUNTIME=remote npm run test:integration.`
        );
      }

      // ── Proof the multi-page branch executed for real ──
      // `pagesFetched > 1` is only reachable if the loop in `listSessions()`
      // followed a non-empty `next_page_token` at least once.
      expect(pagesFetched).toBeGreaterThan(1);

      // ── Proof the drain actually finished, not just ran multiple pages ──
      // Against a live store sized for this test with the default
      // max-pages/timeout budget, the drain must reach an empty
      // `next_page_token` and return `complete: true`. If this were false,
      // the drain aborted early (page cap or overall timeout) and every
      // other assertion below is about a prefix of the store, not the whole
      // set — which would make the uniqueness/ordering assertions far less
      // meaningful.
      expect(complete).toBe(true);

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
