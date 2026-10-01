import { describeWithRealRuntime } from '../helpers/real-runtime-gate';
import { RustRuntimeProvider } from '../../src/runtime/rust-runtime.provider';

/**
 * In-suite regression guard that the harness is talking to a live macp-runtime
 * (not the mock / an empty stub). The manifest carries no version field, so this
 * proves liveness and the registered mode set, not the pinned image version.
 *
 * Builds `RustRuntimeProvider` directly (no DB, no Nest app) — booting the app
 * against a real runtime starts SessionDiscovery, which auto-creates a run per
 * existing session and makes `app.close()` slow. See list-sessions-pagination.
 */
describeWithRealRuntime('Runtime liveness (live runtime)', () => {
  let provider: RustRuntimeProvider;

  beforeAll(async () => {
    const config: any = {
      runtimeAddress: process.env.RUNTIME_ADDRESS ?? '127.0.0.1:50051',
      runtimeTls: false,
      runtimeRequestTimeoutMs: 30000,
      runtimeCircuitBreakerThreshold: 5,
      runtimeCircuitBreakerResetMs: 30000,
      runtimeListSessionsPageSize: 200,
      runtimeListSessionsMaxPages: 200,
      runtimeListSessionsTimeoutMs: 60000
    };
    const credentialResolver: any = {
      resolve: async () => ({
        metadata: { authorization: `Bearer ${process.env.RUNTIME_DEV_AGENT_ID ?? 'macp-control-plane'}` }
      })
    };
    const instrumentation: any = new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) });

    provider = new RustRuntimeProvider(config, credentialResolver, instrumentation);
    await provider.onModuleInit();
  });

  it('GetManifest reports the runtime-registered modes, including ext.multi_round.v1', async () => {
    const manifest = await provider.getManifest();

    expect(manifest.supportedModes).toEqual(
      expect.arrayContaining([
        'macp.mode.decision.v1',
        'macp.mode.proposal.v1',
        'macp.mode.task.v1',
        'macp.mode.handoff.v1',
        'macp.mode.quorum.v1',
        'ext.multi_round.v1'
      ])
    );
  });
});
