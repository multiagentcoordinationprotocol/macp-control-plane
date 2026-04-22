import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

function readBoolean(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function readNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function readStringList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

@Injectable()
export class AppConfigService implements OnModuleInit {
  private readonly logger = new Logger(AppConfigService.name);

  readonly nodeEnv = process.env.NODE_ENV ?? 'development';
  readonly isDevelopment = this.nodeEnv === 'development';

  /** Read from package.json at startup */
  readonly clientVersion: string = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('../../package.json').version as string;
    } catch {
      return '0.0.0';
    }
  })();

  readonly port = readNumber('PORT', 3001);
  readonly host = process.env.HOST ?? '0.0.0.0';
  readonly corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
  readonly databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/macp_control_plane';

  // Auth
  readonly authApiKeys = readStringList('AUTH_API_KEYS');

  readonly runtimeKind = process.env.RUNTIME_KIND ?? 'rust';
  readonly runtimeAddress = process.env.RUNTIME_ADDRESS ?? '127.0.0.1:50051';
  readonly runtimeTls = readBoolean('RUNTIME_TLS', false);
  readonly runtimeAllowInsecure = readBoolean('RUNTIME_ALLOW_INSECURE', process.env.NODE_ENV === 'development');
  /**
   * Control-plane's own single Bearer token. The control-plane has exactly one
   * runtime identity, least-privilege (`can_start_sessions: false`). Per-agent
   * tokens were removed with direct-agent-auth Phase 4 (CP-9) — agents authenticate
   * themselves now.
   */
  readonly runtimeBearerToken = process.env.RUNTIME_BEARER_TOKEN ?? '';
  readonly runtimeUseDevHeader = readBoolean('RUNTIME_USE_DEV_HEADER', process.env.NODE_ENV === 'development');
  readonly runtimeRequestTimeoutMs = readNumber('RUNTIME_REQUEST_TIMEOUT_MS', 30000);
  readonly runtimeDevAgentId = process.env.RUNTIME_DEV_AGENT_ID ?? 'control-plane';

  /**
   * When `MACP_AUTH_SERVICE_URL` is set, the credential resolver mints a
   * short-lived JWT for the `control-plane` sender via the auth-service
   * instead of using the static `RUNTIME_BEARER_TOKEN`. The minted token is
   * cached and refreshed on a TTL boundary. Falls back to the static bearer
   * if the URL isn't set, so deploys can switch incrementally.
   */
  readonly authServiceUrl = process.env.MACP_AUTH_SERVICE_URL ?? '';
  readonly authServiceTimeoutMs = readNumber('MACP_AUTH_SERVICE_TIMEOUT_MS', 5000);
  readonly authTokenTtlSeconds = readNumber('MACP_AUTH_TOKEN_TTL_SECONDS', 3600);
  readonly authTokenSender = process.env.MACP_AUTH_TOKEN_SENDER ?? 'control-plane';
  /**
   * Observer-mode poll cadence. Control-plane polls GetSession after POST /runs
   * until the initiator agent opens the session. See direct-agent-auth §End-to-end target flow.
   */
  readonly sessionPollBaseMs = readNumber('SESSION_POLL_BASE_MS', 100);
  readonly sessionPollMaxMs = readNumber('SESSION_POLL_MAX_MS', 1000);
  readonly sessionPollTimeoutMs = readNumber('SESSION_POLL_TIMEOUT_MS', 60000);
  /** HTTP timeout for proxying UI cancel to the initiator agent's callback (Option A). */
  readonly cancelCallbackTimeoutMs = readNumber('CANCEL_CALLBACK_TIMEOUT_MS', 5000);

  // Circuit breaker
  readonly runtimeCircuitBreakerThreshold = readNumber('RUNTIME_CIRCUIT_BREAKER_THRESHOLD', 5);
  readonly runtimeCircuitBreakerResetMs = readNumber('RUNTIME_CIRCUIT_BREAKER_RESET_MS', 30000);

  // Throttler (NestJS @nestjs/throttler)
  readonly throttleTtlMs = readNumber('THROTTLE_TTL_MS', 60000);
  readonly throttleLimit = readNumber('THROTTLE_LIMIT', 100);

  readonly streamIdleTimeoutMs = readNumber('STREAM_IDLE_TIMEOUT_MS', 120000);
  readonly streamMaxRetries = readNumber('STREAM_MAX_RETRIES', 5);
  readonly streamBackoffBaseMs = readNumber('STREAM_BACKOFF_BASE_MS', 250);
  readonly streamBackoffMaxMs = readNumber('STREAM_BACKOFF_MAX_MS', 30000);
  readonly streamSseHeartbeatMs = readNumber('STREAM_SSE_HEARTBEAT_MS', 15000);
  readonly replayMaxDelayMs = readNumber('REPLAY_MAX_DELAY_MS', 2000);
  readonly replayBatchSize = readNumber('REPLAY_BATCH_SIZE', 500);
  readonly runRecoveryEnabled = readBoolean('RUN_RECOVERY_ENABLED', true);
  readonly sessionDiscoveryEnabled = readBoolean('SESSION_DISCOVERY_ENABLED', true);

  readonly dbPoolMax = readNumber('DB_POOL_MAX', 20);
  readonly dbPoolIdleTimeout = readNumber('DB_POOL_IDLE_TIMEOUT', 30000);
  readonly dbPoolConnectionTimeout = readNumber('DB_POOL_CONNECTION_TIMEOUT', 5000);

  readonly streamHubStrategy = process.env.STREAM_HUB_STRATEGY ?? 'memory';
  readonly redisUrl = process.env.REDIS_URL ?? '';

  // Data retention
  readonly dataRetentionEnabled = readBoolean('DATA_RETENTION_ENABLED', false);
  readonly dataRetentionTtlDays = readNumber('DATA_RETENTION_TTL_DAYS', 30);
  readonly dataRetentionIntervalHours = readNumber('DATA_RETENTION_INTERVAL_HOURS', 24);
  readonly dataRetentionBatchSize = readNumber('DATA_RETENTION_BATCH_SIZE', 500);

  readonly logLevel = process.env.LOG_LEVEL ?? 'info';
  readonly otelEnabled = readBoolean('OTEL_ENABLED', false);
  readonly otelServiceName = process.env.OTEL_SERVICE_NAME ?? 'macp-control-plane';
  readonly otelExporterOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';

  // Privacy — redaction patterns applied to LLM prompt/response content (§8.3)
  readonly redactPatterns = readStringList('MACP_REDACT_PATTERNS');

  onModuleInit(): void {
    this.validate();
  }

  private validate(): void {
    if (this.isDevelopment) return;

    // 1.2: Fail-fast if bearer token missing in production with dev header enabled
    if (!this.runtimeBearerToken && this.runtimeUseDevHeader) {
      throw new Error('RUNTIME_BEARER_TOKEN must be set in production when RUNTIME_USE_DEV_HEADER is enabled');
    }

    // Warn (don't fail) when the control-plane has no runtime identity configured —
    // observer calls (GetSession, StreamSession, ListPolicies) will be rejected as unauthenticated.
    if (!this.runtimeBearerToken) {
      this.logger.warn(
        'Production start: RUNTIME_BEARER_TOKEN is not set. Runtime calls will be rejected as unauthenticated.'
      );
    }

    // 1.2: Fail-fast if TLS is off and insecure is not explicitly allowed
    if (!this.runtimeTls && !this.runtimeAllowInsecure) {
      throw new Error('RUNTIME_TLS must be true in production, or set RUNTIME_ALLOW_INSECURE=true to override');
    }

    // 1.2: Warn if OTEL enabled without exporter endpoint
    if (this.otelEnabled && !this.otelExporterOtlpEndpoint) {
      this.logger.warn('OTEL_ENABLED is true but OTEL_EXPORTER_OTLP_ENDPOINT is not set — traces will be discarded');
    }

    // Warn if using memory StreamHub in production (SSE events won't sync across instances)
    if (this.streamHubStrategy === 'memory') {
      this.logger.warn(
        'STREAM_HUB_STRATEGY=memory in production — SSE events will not sync across multiple instances. Set STREAM_HUB_STRATEGY=redis for multi-instance deployments.'
      );
    }

    // Fail-fast if no API keys configured in production (auth silently disabled)
    if (this.authApiKeys.length === 0) {
      throw new Error('AUTH_API_KEYS must be set in production. Empty value disables authentication.');
    }

    // Guard against misconfigured retention TTL
    if (this.dataRetentionEnabled && this.dataRetentionTtlDays < 1) {
      throw new Error('DATA_RETENTION_TTL_DAYS must be >= 1 when retention is enabled');
    }

    // Guard against connection pool starvation
    if (this.dbPoolMax < 2) {
      throw new Error('DB_POOL_MAX must be >= 2 to avoid connection pool starvation');
    }

    // Warn about aggressive gRPC timeout
    if (this.runtimeRequestTimeoutMs < 5000) {
      this.logger.warn(
        `RUNTIME_REQUEST_TIMEOUT_MS=${this.runtimeRequestTimeoutMs} is very low — gRPC calls may time out prematurely`
      );
    }
  }
}
