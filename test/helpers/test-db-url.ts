/**
 * Which database the integration suite may write to — and truncate.
 *
 * The suite TRUNCATEs every table between specs, so it must never resolve to a real database.
 * It used to read `DATABASE_URL`, which `.env` and Doppler `macp-control-plane/dev` point at the
 * DEV database (localhost:5432): `doppler run -- npm run test:integration` would have wiped it.
 *
 * Now the suite reads only `TEST_DATABASE_URL` (default: the throwaway `postgres-test` service in
 * docker-compose.test.yml, host port 5433) and refuses any target that
 *   - has a database name without `test` in it, or
 *   - is the same database as the caller's `DATABASE_URL` (same host, port and name).
 * `DATABASE_URL` is never a fallback.
 */

export const DEFAULT_TEST_DATABASE_URL = 'postgres://postgres:postgres@localhost:5433/macp_control_plane_test';

/**
 * The suite's helpers set `process.env.DATABASE_URL` to the test URL so the Nest app under test
 * uses it. The caller's original value is stashed here first (by global setup, which runs before
 * any helper overwrites it) so the "same database as DATABASE_URL" check still compares against
 * the real one.
 */
export const ORIGINAL_DATABASE_URL_ENV = 'MACP_TEST_ORIGINAL_DATABASE_URL';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

interface DbTarget {
  host: string;
  port: string;
  database: string;
}

function parseTarget(url: string): DbTarget | undefined {
  try {
    const parsed = new URL(url);
    if (!/^postgres(ql)?:$/.test(parsed.protocol)) return undefined;
    const rawHost = parsed.hostname.toLowerCase();
    return {
      host: LOOPBACK_HOSTS.has(rawHost) ? 'loopback' : rawHost,
      port: parsed.port || '5432',
      database: decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    };
  } catch {
    return undefined;
  }
}

/** Host/port/db only — never echo credentials into an error message. */
function label(target: DbTarget): string {
  return `${target.host}:${target.port}/${target.database}`;
}

/**
 * Throws unless `testUrl` is safe to truncate. Pure (takes the original DATABASE_URL as an
 * argument) so it can be unit-tested.
 */
export function assertSafeTestDatabase(testUrl: string, originalDatabaseUrl?: string): void {
  const target = parseTarget(testUrl);
  if (!target || !target.database) {
    throw new Error(
      'Refusing to run integration tests: TEST_DATABASE_URL is not a postgres:// URL with a database name.'
    );
  }
  if (!/test/i.test(target.database)) {
    throw new Error(
      `Refusing to run integration tests against ${label(target)}: the suite truncates every table, ` +
        "so the database name must contain 'test'. Point TEST_DATABASE_URL at the throwaway test database " +
        `(default ${label(parseTarget(DEFAULT_TEST_DATABASE_URL) as DbTarget)}, docker-compose.test.yml).`
    );
  }
  const original = originalDatabaseUrl ? parseTarget(originalDatabaseUrl) : undefined;
  if (
    original &&
    original.host === target.host &&
    original.port === target.port &&
    original.database === target.database
  ) {
    throw new Error(
      `Refusing to run integration tests against ${label(target)}: it is the same database as DATABASE_URL. ` +
        'The suite truncates every table; give it a dedicated TEST_DATABASE_URL.'
    );
  }
}

/** The guarded test database URL. Every integration helper that touches Postgres goes through this. */
export function testDatabaseUrl(): string {
  if (process.env[ORIGINAL_DATABASE_URL_ENV] === undefined) {
    process.env[ORIGINAL_DATABASE_URL_ENV] = process.env.DATABASE_URL ?? '';
  }
  const url = process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
  assertSafeTestDatabase(url, process.env[ORIGINAL_DATABASE_URL_ENV] || undefined);
  return url;
}
