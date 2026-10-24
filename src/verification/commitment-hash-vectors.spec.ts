import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { commitmentHash, verifyCommitmentHash } from 'macp-sdk-typescript';
import { toCommitmentPayload } from './commitment-verification.service';

// RFC-MACP-0013 §11 conformance vectors, copied verbatim from the spec repo (see the README there).
const VECTOR_DIR = join(__dirname, '../../test/fixtures/cmt-hash');

interface ComputeVector {
  name: string;
  payload: Record<string, unknown>;
  hash: string;
}
interface VerifyVector {
  name: string;
  wire_hex: string;
  claimed_hash: string;
  expected_outcome: 'match' | 'mismatch' | 'cannot_verify';
}

const vectors = readdirSync(VECTOR_DIR)
  .filter((f) => /^cmt_hash_\d{3}_.*\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(VECTOR_DIR, f), 'utf8')) as ComputeVector | VerifyVector);
const compute = vectors.filter((v): v is ComputeVector => 'payload' in v);
const verify = vectors.filter((v): v is VerifyVector => 'wire_hex' in v);
const hashOf = (name: string) => compute.find((v) => v.name === name)!.hash;

describe('RFC-MACP-0013 commitment-hash vectors', () => {
  it('has all five compute and five verify vectors', () => {
    expect(compute.map((v) => v.name)).toEqual([
      'cmt_hash_001_minimal',
      'cmt_hash_002_supersedes',
      'cmt_hash_003_all_empty',
      'cmt_hash_004_empty_supersedes',
      'cmt_hash_005_escapes'
    ]);
    expect(verify.map((v) => v.name)).toEqual([
      'cmt_hash_006_unknown_field',
      'cmt_hash_007_mismatch',
      'cmt_hash_008_noncanonical_claim',
      'cmt_hash_009_unknown_supersedes_field',
      'cmt_hash_010_no_prefix'
    ]);
  });

  // The vectors are snake_case (the §3 projection); the control plane's stored payloads are
  // camelCase. toCommitmentPayload must accept both and land on the pinned hash.
  it.each(compute.map((v) => [v.name, v] as const))('%s: computes the pinned hash', (_name, v) => {
    expect(commitmentHash(toCommitmentPayload(v.payload))).toBe(v.hash);
  });

  it('distinguishes an absent supersedes from a present-but-empty one (003 != 004)', () => {
    expect(hashOf('cmt_hash_003_all_empty')).not.toBe(hashOf('cmt_hash_004_empty_supersedes'));
  });

  it.each(verify.map((v) => [v.name, v] as const))('%s: verifier returns the pinned outcome', (_name, v) => {
    expect(verifyCommitmentHash(Buffer.from(v.wire_hex, 'hex'), v.claimed_hash)).toBe(v.expected_outcome);
  });
});
