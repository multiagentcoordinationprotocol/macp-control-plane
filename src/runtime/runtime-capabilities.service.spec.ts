import { AppConfigService } from '../config/app-config.service';
import { RuntimeProvider } from '../contracts/runtime';
import { RuntimeCapabilitiesService } from './runtime-capabilities.service';

describe('RuntimeCapabilitiesService', () => {
  const config = { clientVersion: '0.6.1', runtimeRequestTimeoutMs: 30_000 } as AppConfigService;
  const service = new RuntimeCapabilitiesService(config);

  function provider(cached: unknown, fresh: unknown) {
    return {
      capabilities: cached,
      initialize: jest.fn().mockResolvedValue({ capabilities: fresh })
    } as unknown as RuntimeProvider & { initialize: jest.Mock };
  }

  it('refresh() runs a deadline-bound Initialize as macp-control-plane', async () => {
    const p = provider(undefined, {});
    await service.refresh(p);
    expect(p.initialize).toHaveBeenCalledWith(
      { clientName: 'macp-control-plane', clientVersion: '0.6.1' },
      { deadline: expect.any(Date) }
    );
  });

  it('forWhatIfReplay() trusts a cached advertisement without a round trip', async () => {
    const cached = { policyRegistry: { whatIfReplay: true } };
    const p = provider(cached, {});
    await expect(service.forWhatIfReplay(p)).resolves.toBe(cached);
    expect(p.initialize).not.toHaveBeenCalled();
  });

  it('forWhatIfReplay() re-initializes when the cache lacks it (runtime upgraded since)', async () => {
    const fresh = { policyRegistry: { whatIfReplay: true } };
    const p = provider({ policyRegistry: { registerPolicy: true } }, fresh);
    await expect(service.forWhatIfReplay(p)).resolves.toBe(fresh);
    expect(p.initialize).toHaveBeenCalledTimes(1);
  });

  it('forDecisionReceipt() trusts a cached advertisement without a round trip', async () => {
    const cached = { decisionReceipt: { getDecisionReceipt: true } };
    const p = provider(cached, {});
    await expect(service.forDecisionReceipt(p)).resolves.toBe(cached);
    expect(p.initialize).not.toHaveBeenCalled();
  });

  it('forDecisionReceipt() re-initializes when the cache lacks it (runtime upgraded since)', async () => {
    const fresh = { decisionReceipt: { getDecisionReceipt: true, signed: false } };
    const p = provider({ policyRegistry: { whatIfReplay: true } }, fresh);
    await expect(service.forDecisionReceipt(p)).resolves.toBe(fresh);
    expect(p.initialize).toHaveBeenCalledTimes(1);
  });
});
