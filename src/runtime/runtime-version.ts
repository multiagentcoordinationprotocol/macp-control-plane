/**
 * Runtime versions this control plane has been verified against (absorbed through
 * macp-runtime v0.8.6). A version outside this range is not rejected — it only
 * produces a warning so operators notice a mismatched runtime early.
 */
export const TESTED_RUNTIME_RANGE = { min: [0, 8, 0], maxExclusive: [0, 9, 0] } as const;

export type RuntimeVersionStatus = 'tested' | 'untested' | 'unknown';

function parse(version: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function classifyRuntimeVersion(version: string | undefined): RuntimeVersionStatus {
  const parsed = version ? parse(version) : undefined;
  if (!parsed) return 'unknown';
  return compare(parsed, TESTED_RUNTIME_RANGE.min) >= 0 && compare(parsed, TESTED_RUNTIME_RANGE.maxExclusive) < 0
    ? 'tested'
    : 'untested';
}
