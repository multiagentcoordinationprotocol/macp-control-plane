import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { RuntimeCredentialResolver, RuntimeCredentials } from '../contracts/runtime';

/**
 * Single-bearer credential resolver (CP-9, direct-agent-auth.md).
 *
 * The control-plane has one runtime identity — its own least-privilege Bearer
 * token with `can_start_sessions: false`. All observer calls (GetSession,
 * StreamSession, ListPolicies, CancelSession) use this identity.
 *
 * Per-agent token maps were removed because agents now authenticate to the
 * runtime directly (RFC-MACP-0004 §4). The control-plane never forges envelopes
 * on behalf of agents.
 */
@Injectable()
export class RuntimeCredentialResolverService implements RuntimeCredentialResolver {
  constructor(private readonly config: AppConfigService) {}

  async resolve(_req: { runtimeKind: string }): Promise<RuntimeCredentials> {
    const sender = this.config.runtimeDevAgentId;
    const metadata: Record<string, string> = {};

    if (this.config.runtimeBearerToken) {
      metadata.authorization = `Bearer ${this.config.runtimeBearerToken}`;
    } else if (this.config.runtimeUseDevHeader) {
      metadata['x-macp-agent-id'] = sender;
    }

    return { metadata, sender };
  }
}
