import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

interface CacheEntry {
  token: string;
  expiresAt: number;
}

interface MintResponse {
  token: string;
  sender: string;
  expires_in_seconds?: number;
}

/**
 * Mints and caches the control-plane's runtime JWT. Mirrors the
 * `AuthTokenMinterService` pattern in macp-playground but is
 * single-tenant — only ever mints for the `control-plane` sender with
 * `is_observer: true` (and, when opted in via
 * `MACP_AUTH_TOKEN_CAN_MANAGE_REGISTRY`, `can_manage_mode_registry: true`).
 *
 * The credential resolver calls `getToken()` on every gRPC call; the
 * minter returns a cached token until TTL minus a clock-skew buffer, then
 * re-mints in-band. A small in-flight promise dedupes concurrent
 * refreshes during the brief refresh window.
 */
@Injectable()
export class RuntimeJwtMinterService {
  private readonly logger = new Logger(RuntimeJwtMinterService.name);
  private cache: CacheEntry | undefined;
  private inflight: Promise<string> | undefined;

  // Refresh 30s before the cached token actually expires so a slow refresh
  // doesn't race ongoing requests. Auth-service signs with a separate clock,
  // so we also account for ~10s of skew tolerance.
  private static readonly REFRESH_BUFFER_MS = 30_000;
  private static readonly CLOCK_SKEW_MS = 10_000;

  constructor(private readonly config: AppConfigService) {}

  isEnabled(): boolean {
    return Boolean(this.config.authServiceUrl);
  }

  async getToken(): Promise<string> {
    if (!this.isEnabled()) {
      throw new Error('RuntimeJwtMinterService.getToken called but MACP_AUTH_SERVICE_URL is unset');
    }

    const now = Date.now();
    if (
      this.cache &&
      now < this.cache.expiresAt - RuntimeJwtMinterService.REFRESH_BUFFER_MS - RuntimeJwtMinterService.CLOCK_SKEW_MS
    ) {
      return this.cache.token;
    }

    if (this.inflight) return this.inflight;

    this.inflight = this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const url = `${this.config.authServiceUrl.replace(/\/+$/, '')}/tokens`;
    const body = {
      sender: this.config.authTokenSender,
      ttl_seconds: this.config.authTokenTtlSeconds,
      scopes: {
        // Control-plane is an observer by default. It cannot start sessions.
        can_start_sessions: false,
        is_observer: true,
        // allowed_modes intentionally omitted → the runtime treats it as
        // "all modes allowed" for read operations. The is_observer flag is
        // what authorizes `Stream`/`GetSession`/etc.
        //
        // Registry management (RegisterPolicy/UnregisterPolicy) is gated by the
        // runtime on `can_manage_mode_registry`. It stays off unless the
        // operator opts in via MACP_AUTH_TOKEN_CAN_MANAGE_REGISTRY, so the
        // default posture remains strictly read-only.
        ...(this.config.authTokenCanManageRegistry ? { can_manage_mode_registry: true } : {})
      }
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.authServiceTimeoutMs)
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown network error';
      this.logger.warn(`auth_mint_failure reason=network:${reason}`);
      throw new Error(`auth-service request failed: ${reason}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logger.warn(`auth_mint_failure http_${response.status} body=${text.slice(0, 200)}`);
      throw new Error(`auth-service returned ${response.status}`);
    }

    let parsed: MintResponse;
    try {
      parsed = (await response.json()) as MintResponse;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'invalid JSON';
      throw new Error(`auth-service response parse failed: ${reason}`);
    }
    if (!parsed?.token) throw new Error('auth-service response missing token');

    const ttlSec = Number.isFinite(parsed.expires_in_seconds)
      ? Math.max(60, Math.floor(parsed.expires_in_seconds!))
      : this.config.authTokenTtlSeconds;
    const expiresAt = Date.now() + ttlSec * 1000;
    this.cache = { token: parsed.token, expiresAt };
    this.logger.log(`auth_mint_success sender=${this.config.authTokenSender} expires_in=${ttlSec}s`);
    return parsed.token;
  }
}
