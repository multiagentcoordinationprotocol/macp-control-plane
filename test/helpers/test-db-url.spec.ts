import {
  assertSafeTestDatabase,
  DEFAULT_TEST_DATABASE_URL,
  ORIGINAL_DATABASE_URL_ENV,
  testDatabaseUrl
} from './test-db-url';

// Runs in the unit suite (jest.config.ts roots), so the guard is checked on every PR without docker.
describe('integration test database guard', () => {
  const DEV = 'postgres://postgres:postgres@localhost:5432/macp_control_plane';

  describe('assertSafeTestDatabase', () => {
    it('accepts the docker-compose.test.yml database', () => {
      expect(() => assertSafeTestDatabase(DEFAULT_TEST_DATABASE_URL, DEV)).not.toThrow();
      expect(() => assertSafeTestDatabase(DEFAULT_TEST_DATABASE_URL, undefined)).not.toThrow();
    });

    it('refuses a database whose name lacks "test" (the dev database)', () => {
      expect(() => assertSafeTestDatabase(DEV, undefined)).toThrow(/must contain 'test'/);
    });

    it('refuses the same database as DATABASE_URL, treating localhost and 127.0.0.1 alike', () => {
      const original = 'postgres://someone:else@127.0.0.1:5433/macp_control_plane_test';
      expect(() => assertSafeTestDatabase(DEFAULT_TEST_DATABASE_URL, original)).toThrow(
        /same database as DATABASE_URL/
      );
    });

    it('refuses a non-postgres or db-less URL', () => {
      expect(() => assertSafeTestDatabase('not a url')).toThrow(/postgres:\/\//);
      expect(() => assertSafeTestDatabase('postgres://localhost:5433')).toThrow(/postgres:\/\//);
    });

    it('never echoes credentials in its message', () => {
      expect(() => assertSafeTestDatabase('postgres://user:s3cret@db.example:5432/prod', undefined)).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('s3cret') })
      );
    });
  });

  describe('testDatabaseUrl', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });

    it('ignores DATABASE_URL and defaults to the test-compose database', () => {
      delete process.env.TEST_DATABASE_URL;
      delete process.env[ORIGINAL_DATABASE_URL_ENV];
      process.env.DATABASE_URL = DEV;
      expect(testDatabaseUrl()).toBe(DEFAULT_TEST_DATABASE_URL);
    });

    it('throws when TEST_DATABASE_URL points at the dev database', () => {
      delete process.env[ORIGINAL_DATABASE_URL_ENV];
      process.env.DATABASE_URL = DEV;
      process.env.TEST_DATABASE_URL = DEV;
      expect(() => testDatabaseUrl()).toThrow(/Refusing/);
    });

    it('compares against the stashed original DATABASE_URL after the helpers overwrite it', () => {
      const testUrl = 'postgres://postgres:postgres@localhost:5434/other_test';
      process.env[ORIGINAL_DATABASE_URL_ENV] = testUrl;
      process.env.DATABASE_URL = DEFAULT_TEST_DATABASE_URL; // as set by global setup
      process.env.TEST_DATABASE_URL = testUrl;
      expect(() => testDatabaseUrl()).toThrow(/same database as DATABASE_URL/);
    });
  });
});
