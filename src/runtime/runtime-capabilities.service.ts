import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { RuntimeCapabilities, RuntimeInitializeResult, RuntimeProvider } from '../contracts/runtime';

/**
 * Initialize-advertised runtime capabilities. Providers cache them on each `initialize()`, which
 * otherwise only runs at run start — so a runtime upgraded since then would stay invisible.
 */
@Injectable()
export class RuntimeCapabilitiesService {
  constructor(private readonly config: AppConfigService) {}

  /** A fresh Initialize handshake (also refreshes the provider's cache). */
  async refresh(provider: RuntimeProvider): Promise<RuntimeInitializeResult> {
    return provider.initialize(
      { clientName: 'macp-control-plane', clientVersion: this.config.clientVersion },
      { deadline: new Date(Date.now() + this.config.runtimeRequestTimeoutMs) }
    );
  }

  /** The cached capabilities when they already advertise what-if replay, else a refresh's. */
  async forWhatIfReplay(provider: RuntimeProvider): Promise<RuntimeCapabilities | undefined> {
    const cached = (provider as { capabilities?: RuntimeCapabilities }).capabilities;
    if (cached?.policyRegistry?.whatIfReplay === true) return cached;
    return (await this.refresh(provider)).capabilities;
  }
}
