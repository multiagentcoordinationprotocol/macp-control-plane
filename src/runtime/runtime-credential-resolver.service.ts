import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { RuntimeCredentialResolver, RuntimeCredentials } from '../contracts/runtime';
import { RuntimeJwtMinterService } from './runtime-jwt-minter.service';

/**
 * Single-identity credential resolver for the control-plane.
 *
 * Two modes (chosen at runtime by env var):
 *
 *  1. **JWT mode** (preferred) — when `MACP_AUTH_SERVICE_URL` is set, mints
 *     a short-lived RS256 JWT for `control-plane` via auth-service and
 *     caches it. Long-running CP processes refresh on a TTL boundary.
 *
 *  2. **Static-bearer mode** (fallback) — when the auth-service URL is
 *     unset, uses the static `RUNTIME_BEARER_TOKEN` from env. This path
 *     is preserved so deploys can switch incrementally.
 *
 * Either way, the resolver returns the same shape — gRPC sees a normal
 * `Authorization: Bearer …` header with no knowledge of which mode minted
 * the token.
 */
@Injectable()
export class RuntimeCredentialResolverService implements RuntimeCredentialResolver {
  private readonly logger = new Logger(RuntimeCredentialResolverService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly jwtMinter: RuntimeJwtMinterService
  ) {}

  async resolve(_req: { runtimeKind: string }): Promise<RuntimeCredentials> {
    const sender = this.config.runtimeDevAgentId;
    const metadata: Record<string, string> = {};

    if (this.jwtMinter.isEnabled()) {
      try {
        const token = await this.jwtMinter.getToken();
        metadata.authorization = `Bearer ${token}`;
        return { metadata, sender };
      } catch (err) {
        // Fall through to static-bearer / dev-header fallbacks if the
        // mint fails. Better to degrade than fail every gRPC call when
        // auth-service is briefly unreachable.
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(`JWT mint failed; falling back to static bearer: ${reason}`);
      }
    }

    if (this.config.runtimeBearerToken) {
      metadata.authorization = `Bearer ${this.config.runtimeBearerToken}`;
    } else if (this.config.runtimeUseDevHeader) {
      // Runtime v0.5.0 removed the `x-macp-agent-id` dev-header path entirely
      // (macp-auth `authenticate_metadata` is bearer-only). Its dev-mode auth
      // (no auth configured + MACP_ALLOW_INSECURE=1) accepts *any* bearer and
      // uses the token value as the sender identity, so we send the dev agent
      // id as a bearer. This keeps the CP's `macp-control-plane` identity while
      // being accepted by v0.5.0 dev-mode runtimes.
      metadata.authorization = `Bearer ${sender}`;
    }

    return { metadata, sender };
  }
}
