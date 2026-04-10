/**
 * Returns the runtime kind for integration test fixtures.
 * - mock mode: 'scripted-mock' (default)
 * - docker/remote mode: 'rust' (real gRPC runtime)
 */
export function testRuntimeKind(): string {
  const mode = process.env.INTEGRATION_RUNTIME ?? 'mock';
  return mode === 'mock' ? 'scripted-mock' : 'rust';
}
