import { createPublicKey, verify } from 'node:crypto';
import { commitmentHash, verifyCommitmentHash } from 'macp-sdk-typescript';
import { toCommitmentPayload } from '../../src/verification/commitment-verification.service';

/**
 * Test-only `macp-receipt/1` verifier (RFC-MACP-0013 Appendix A.4), used to prove that what
 * `GET /runs/:id/receipt` returns verifies against what `GET /runtime/receipt-keys` returns. The
 * control plane itself never verifies receipts. Held to the spec's receipt vectors by
 * `receipt-verifier.integration.spec.ts` (vendored under `test/fixtures/receipts/vectors`).
 */
export type Integrity = 'match' | 'mismatch' | 'cannot_verify' | null;
export type AttestationResult = 'valid' | 'invalid' | 'unknown_key' | 'unsupported';
export type Verdict = 'attested' | 'integrity_only' | 'unverified' | 'refused';

export interface ReceiptVerification {
  integrity: Integrity;
  attestations: AttestationResult[];
  verdict: Verdict;
}

/** RFC 8785 JCS for the JSON a receipt body holds (strings, booleans, non-negative integers, objects, arrays). */
export function jcs(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jcs((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** `kid` → Ed25519 public `x` (base64url), from a JWK Set. */
export function trustedKeysFromJwks(jwks: { keys?: unknown[] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of jwks.keys ?? []) {
    const key = k as { kty?: string; crv?: string; kid?: string; x?: string };
    if (key.kty === 'OKP' && key.crv === 'Ed25519' && key.kid && key.x) out[key.kid] = key.x;
  }
  return out;
}

export function verifyReceipt(
  receipt: Record<string, unknown>,
  trustedKeys: Record<string, string>
): ReceiptVerification {
  if (receipt.receipt_format !== 'macp-receipt/1') return { integrity: null, attestations: [], verdict: 'refused' };

  const integrity = checkIntegrity(receipt);
  if (integrity !== 'match') return { integrity, attestations: [], verdict: 'unverified' };

  const { attestations: _omit, ...body } = receipt;
  const signingInput = (protectedB64: string) =>
    Buffer.from(`${protectedB64}.${Buffer.from(jcs(body), 'utf8').toString('base64url')}`, 'ascii');

  const results = ((receipt.attestations as unknown[]) ?? []).map((a): AttestationResult => {
    const att = a as { type?: string; jws?: string };
    if (att.type !== 'jws' || typeof att.jws !== 'string') return 'unsupported';
    const [protectedB64, payload, sigB64] = att.jws.split('.');
    if (payload !== '' || !protectedB64 || !sigB64) return 'invalid';
    let header: { alg?: string; kid?: string };
    try {
      header = JSON.parse(Buffer.from(protectedB64, 'base64url').toString('utf8'));
    } catch {
      return 'invalid';
    }
    if (header.alg !== 'EdDSA') return 'unsupported';
    const x = header.kid ? trustedKeys[header.kid] : undefined;
    if (!x) return 'unknown_key';
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
    return verify(null, signingInput(protectedB64), key, Buffer.from(sigB64, 'base64url')) ? 'valid' : 'invalid';
  });

  return { integrity, attestations: results, verdict: results.includes('valid') ? 'attested' : 'integrity_only' };
}

function checkIntegrity(receipt: Record<string, unknown>): Integrity {
  const claimed = receipt.commitment_hash;
  if (typeof claimed !== 'string') return 'mismatch';
  const fromProjection = commitmentHash(toCommitmentPayload(receipt.commitment as Record<string, unknown>));
  if (fromProjection !== claimed) return 'mismatch';
  const wireB64 = receipt.commitment_wire_b64;
  if (typeof wireB64 !== 'string') return 'match';
  // Buffer.from is lenient; a receipt whose wire does not decode as base64 is cannot_verify (A.4 step 2).
  if (wireB64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(wireB64)) return 'cannot_verify';
  // §6.1 on the wire bytes; a match here plus the projection match means the wire projects to `commitment`.
  return verifyCommitmentHash(Buffer.from(wireB64, 'base64'), claimed);
}
