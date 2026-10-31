import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { verifyReceipt, trustedKeysFromJwks } from '../../test/helpers/receipt-verifier';

// RFC-MACP-0013 Appendix A receipt vectors and the A.5 example receipt/key set, copied verbatim
// from the spec repo (schemas/conformance/receipt/, examples/discovery/). They hold the test-only
// verifier honest, so the receipt-route tests that use it prove something.
const FIXTURES = join(__dirname, '../../test/fixtures/receipts');
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

interface Vector {
  name: string;
  receipt: Record<string, unknown>;
  trusted_keys: Record<string, string>;
  expected: { integrity: string | null; attestations: string[]; verdict: string };
}

const vectors: Vector[] = readdirSync(join(FIXTURES, 'vectors'))
  .filter((f) => /^receipt_\d{3}_.*\.json$/.test(f))
  .sort()
  .map((f) => read(join(FIXTURES, 'vectors', f)));

describe('test-only receipt verifier vs the RFC-MACP-0013 receipt vectors', () => {
  it('has all twelve vectors', () => {
    expect(vectors).toHaveLength(12);
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(verifyReceipt(v.receipt, v.trusted_keys)).toEqual(v.expected);
  });

  it('the spec example receipt verifies attested against the spec example JWK Set', () => {
    const keys = trustedKeysFromJwks(read(join(FIXTURES, 'receipt_keys.json')));
    expect(keys).toEqual({ 'example-1': 'TDVzkxaSf6_Oxu7mmn5TbCkF80s8Ulh33qKQsi0gnZM' });
    expect(verifyReceipt(read(join(FIXTURES, 'decision_receipt.json')), keys).verdict).toBe('attested');
  });
});
