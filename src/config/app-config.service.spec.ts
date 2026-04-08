import { AppConfigService } from './app-config.service';

describe('AppConfigService', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all env vars that AppConfigService reads
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.CORS_ORIGIN;
    delete process.env.DATABASE_URL;
    delete process.env.RUNTIME_KIND;
    delete process.env.RUNTIME_ADDRESS;
    delete process.env.RUNTIME_TLS;
    delete process.env.RUNTIME_ALLOW_INSECURE;
    delete process.env.RUNTIME_BEARER_TOKEN;
    delete process.env.RUNTIME_USE_DEV_HEADER;
    delete process.env.RUNTIME_REQUEST_TIMEOUT_MS;
    delete process.env.RUNTIME_DEV_AGENT_ID;
    delete process.env.RUNTIME_STREAM_SUBSCRIPTION_MESSAGE_TYPE;
    delete process.env.RUNTIME_STREAM_SUBSCRIBER_ID;
    delete process.env.STREAM_IDLE_TIMEOUT_MS;
    delete process.env.STREAM_MAX_RETRIES;
    delete process.env.STREAM_BACKOFF_BASE_MS;
    delete process.env.STREAM_BACKOFF_MAX_MS;
    delete process.env.REPLAY_MAX_DELAY_MS;
    delete process.env.REPLAY_BATCH_SIZE;
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_POOL_IDLE_TIMEOUT;
    delete process.env.DB_POOL_CONNECTION_TIMEOUT;
    delete process.env.LOG_LEVEL;
    delete process.env.OTEL_ENABLED;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('default values', () => {
    it('should default port to 3001', () => {
      const config = new AppConfigService();
      expect(config.port).toBe(3001);
    });

    it('should default runtimeRequestTimeoutMs to 30000', () => {
      const config = new AppConfigService();
      expect(config.runtimeRequestTimeoutMs).toBe(30000);
    });

    it('should default streamBackoffBaseMs to 250', () => {
      const config = new AppConfigService();
      expect(config.streamBackoffBaseMs).toBe(250);
    });

    it('should default streamBackoffMaxMs to 30000', () => {
      const config = new AppConfigService();
      expect(config.streamBackoffMaxMs).toBe(30000);
    });

    it('should default streamMaxRetries to 5', () => {
      const config = new AppConfigService();
      expect(config.streamMaxRetries).toBe(5);
    });

    it('should default streamIdleTimeoutMs to 120000', () => {
      const config = new AppConfigService();
      expect(config.streamIdleTimeoutMs).toBe(120000);
    });

    it('should default host to 0.0.0.0', () => {
      const config = new AppConfigService();
      expect(config.host).toBe('0.0.0.0');
    });

    it('should default corsOrigin to http://localhost:3000', () => {
      const config = new AppConfigService();
      expect(config.corsOrigin).toBe('http://localhost:3000');
    });
  });

  describe('custom PORT env var', () => {
    it('should use PORT when set', () => {
      process.env.PORT = '8080';
      const config = new AppConfigService();
      expect(config.port).toBe(8080);
    });

    it('should fall back to default when PORT is not a valid number', () => {
      process.env.PORT = 'not-a-number';
      const config = new AppConfigService();
      expect(config.port).toBe(3001);
    });

    it('should fall back to default when PORT is Infinity', () => {
      process.env.PORT = 'Infinity';
      const config = new AppConfigService();
      expect(config.port).toBe(3001);
    });
  });

  describe('readBoolean behavior', () => {
    it('should treat "1" as true', () => {
      process.env.RUNTIME_TLS = '1';
      const config = new AppConfigService();
      expect(config.runtimeTls).toBe(true);
    });

    it('should treat "true" as true', () => {
      process.env.RUNTIME_TLS = 'true';
      const config = new AppConfigService();
      expect(config.runtimeTls).toBe(true);
    });

    it('should treat "yes" as true', () => {
      process.env.RUNTIME_TLS = 'yes';
      const config = new AppConfigService();
      expect(config.runtimeTls).toBe(true);
    });

    it('should treat "on" as true', () => {
      process.env.RUNTIME_TLS = 'on';
      const config = new AppConfigService();
      expect(config.runtimeTls).toBe(true);
    });

    it('should treat "TRUE" as true (case insensitive)', () => {
      process.env.RUNTIME_TLS = 'TRUE';
      const config = new AppConfigService();
      expect(config.runtimeTls).toBe(true);
    });

    it('should treat "Yes" as true (case insensitive)', () => {
      process.env.RUNTIME_TLS = 'Yes';
      const config = new AppConfigService();
      expect(config.runtimeTls).toBe(true);
    });

    it('should treat "0" as false', () => {
      process.env.RUNTIME_TLS = '0';
      const config = new AppConfigService();
      expect(config.runtimeTls).toBe(false);
    });

    it('should treat "false" as false', () => {
      process.env.RUNTIME_TLS = 'false';
      const config = new AppConfigService();
      expect(config.runtimeTls).toBe(false);
    });

    it('should treat empty string as false', () => {
      process.env.RUNTIME_TLS = '';
      const config = new AppConfigService();
      expect(config.runtimeTls).toBe(false);
    });

    it('should treat missing env var as the default (false for RUNTIME_TLS)', () => {
      const config = new AppConfigService();
      expect(config.runtimeTls).toBe(false);
    });
  });

  describe('security defaults based on NODE_ENV', () => {
    it('should default runtimeAllowInsecure to false when NODE_ENV is not development', () => {
      process.env.NODE_ENV = 'production';
      const config = new AppConfigService();
      expect(config.runtimeAllowInsecure).toBe(false);
    });

    it('should default runtimeAllowInsecure to true when NODE_ENV is development', () => {
      process.env.NODE_ENV = 'development';
      const config = new AppConfigService();
      expect(config.runtimeAllowInsecure).toBe(true);
    });

    it('should default runtimeAllowInsecure to false when NODE_ENV is undefined', () => {
      delete process.env.NODE_ENV;
      const config = new AppConfigService();
      expect(config.runtimeAllowInsecure).toBe(false);
    });

    it('should default runtimeUseDevHeader to true when NODE_ENV is development', () => {
      process.env.NODE_ENV = 'development';
      const config = new AppConfigService();
      expect(config.runtimeUseDevHeader).toBe(true);
    });

    it('should default runtimeUseDevHeader to false when NODE_ENV is production', () => {
      process.env.NODE_ENV = 'production';
      const config = new AppConfigService();
      expect(config.runtimeUseDevHeader).toBe(false);
    });

    it('should respect explicit RUNTIME_ALLOW_INSECURE even in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.RUNTIME_ALLOW_INSECURE = 'true';
      const config = new AppConfigService();
      expect(config.runtimeAllowInsecure).toBe(true);
    });
  });

  describe('clientVersion', () => {
    it('should read version from package.json', () => {
      const config = new AppConfigService();
      expect(config.clientVersion).toBe('0.3.0');
    });
  });

  describe('readNumber edge cases', () => {
    it('should handle a valid number string for STREAM_BACKOFF_BASE_MS', () => {
      process.env.STREAM_BACKOFF_BASE_MS = '500';
      const config = new AppConfigService();
      expect(config.streamBackoffBaseMs).toBe(500);
    });

    it('should return default for NaN input', () => {
      process.env.STREAM_BACKOFF_BASE_MS = 'abc';
      const config = new AppConfigService();
      expect(config.streamBackoffBaseMs).toBe(250);
    });

    it('should return default for Infinity input', () => {
      process.env.STREAM_MAX_RETRIES = 'Infinity';
      const config = new AppConfigService();
      expect(config.streamMaxRetries).toBe(5);
    });

    it('should accept zero as a valid number', () => {
      process.env.STREAM_MAX_RETRIES = '0';
      const config = new AppConfigService();
      expect(config.streamMaxRetries).toBe(0);
    });

    it('should accept negative numbers', () => {
      process.env.REPLAY_MAX_DELAY_MS = '-100';
      const config = new AppConfigService();
      expect(config.replayMaxDelayMs).toBe(-100);
    });
  });

  describe('production validation', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      process.env.RUNTIME_TLS = 'true';
      process.env.RUNTIME_BEARER_TOKEN = 'secret';
      process.env.RUNTIME_USE_DEV_HEADER = 'false';
      process.env.AUTH_API_KEYS = 'key1,key2';
    });

    it('should throw if AUTH_API_KEYS is empty in production', () => {
      process.env.AUTH_API_KEYS = '';
      const config = new AppConfigService();
      expect(() => config.onModuleInit()).toThrow('AUTH_API_KEYS must be set in production');
    });

    it('should throw if DATA_RETENTION_TTL_DAYS < 1 when retention enabled', () => {
      process.env.DATA_RETENTION_ENABLED = 'true';
      process.env.DATA_RETENTION_TTL_DAYS = '0';
      const config = new AppConfigService();
      expect(() => config.onModuleInit()).toThrow('DATA_RETENTION_TTL_DAYS must be >= 1');
    });

    it('should throw if DB_POOL_MAX < 2', () => {
      process.env.DB_POOL_MAX = '1';
      const config = new AppConfigService();
      expect(() => config.onModuleInit()).toThrow('DB_POOL_MAX must be >= 2');
    });

    it('should not throw when all production config is valid', () => {
      const config = new AppConfigService();
      expect(() => config.onModuleInit()).not.toThrow();
    });
  });
});
