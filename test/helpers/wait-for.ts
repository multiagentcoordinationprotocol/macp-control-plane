/**
 * Polling helper for integration tests.
 *
 * Runs `predicate` until it returns a truthy value or `timeoutMs` elapses.
 * Returns the resolved value so callers can chain assertions without re-fetching.
 *
 * This replaces hardcoded `sleep(1500)` waits in integration tests: instead of
 * waiting for a fixed duration, we wait for a specific condition — which is both
 * faster in the happy case and more reliable under load.
 */
export async function waitFor<T>(
  predicate: () => Promise<T | null | undefined> | T | null | undefined,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  let last: T | null | undefined = undefined;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(
    `waitFor timed out after ${timeoutMs}ms${opts.label ? ` (${opts.label})` : ''}${last === undefined ? '' : ` — last value: ${JSON.stringify(last)}`}`,
  );
}
