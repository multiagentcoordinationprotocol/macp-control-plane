import { readFileSync } from 'fs';
import { join } from 'path';
import { NotFoundException } from '@nestjs/common';
import * as protobuf from 'protobufjs';
import { verifyCommitmentHash } from 'macp-sdk-typescript';
import { CommitmentVerificationService } from './commitment-verification.service';
import { ProtoRegistryService } from '../runtime/proto-registry.service';
import { RunManagerService } from '../runs/run-manager.service';
import { EventRepository } from '../storage/event.repository';

const VECTOR_DIR = join(__dirname, '../../test/fixtures/cmt-hash');
const vector = (name: string) => JSON.parse(readFileSync(join(VECTOR_DIR, `${name}.json`), 'utf8'));

const H001 = vector('cmt_hash_001_minimal').hash as string;
// 007's wire is exactly 001's payload; 006 is the same plus an unknown field 99.
const WIRE_001 = Buffer.from(vector('cmt_hash_007_mismatch').wire_hex, 'hex');
const WIRE_UNKNOWN_FIELD = Buffer.from(vector('cmt_hash_006_unknown_field').wire_hex, 'hex');

describe('CommitmentVerificationService', () => {
  let proto: ProtoRegistryService;
  let runManager: { getRun: jest.Mock; getState: jest.Mock };
  let events: { findLatestRawEnvelope: jest.Mock; findReceivedMessage: jest.Mock };
  let service: CommitmentVerificationService;

  beforeAll(() => {
    proto = new ProtoRegistryService();
    proto.onModuleInit(); // real .proto files from @multiagentcoordinationprotocol/proto
  });

  /** Seed the repositories the way the stream consumer + normalizer would have for one envelope. */
  function seed(wire: Buffer | null, stored?: Record<string, unknown>) {
    events.findLatestRawEnvelope.mockResolvedValue({
      ts: '2026-10-24T00:00:00.000Z',
      payload: {
        kind: 'stream-envelope',
        envelope: {
          messageType: 'Commitment',
          messageId: 'm-commit',
          sessionId: 's1',
          sender: 'coordinator',
          ...(wire ? { payloadBase64: wire.toString('base64') } : {})
        }
      }
    });
    const payload = stored ?? (wire ? proto.decodeKnown('macp.mode.decision.v1', 'Commitment', wire) : undefined);
    events.findReceivedMessage.mockResolvedValue(payload ? { data: { messageId: 'm-commit', payload } } : undefined);
  }

  beforeEach(() => {
    runManager = {
      getRun: jest.fn().mockResolvedValue({ id: 'r1' }),
      getState: jest.fn().mockResolvedValue({
        decision: { current: { finalized: true, action: 'decision.approved', outcomePositive: true } }
      })
    };
    events = { findLatestRawEnvelope: jest.fn(), findReceivedMessage: jest.fn() };
    service = new CommitmentVerificationService(
      runManager as unknown as RunManagerService,
      events as unknown as EventRepository,
      proto
    );
  });

  it('verifies a committed run: stored hash == wire recompute == RFC-MACP-0013 vector 001', async () => {
    seed(WIRE_001);
    const result = await service.verify('r1');
    expect(result).toMatchObject({
      status: 'verified',
      match: true,
      label: 'macp-commitment-hash/1',
      commitmentHash: H001,
      recomputed: H001,
      wireVerdict: 'match',
      commitment: {
        messageId: 'm-commit',
        sender: 'coordinator',
        sessionId: 's1',
        payload: vector('cmt_hash_001_minimal').payload
      }
    });
    expect(result.checks.map((c) => [c.id, c.passed])).toEqual([
      ['wire_recompute', true],
      ['rfc0013_verify', true],
      ['projection_consistency', true]
    ]);
    expect(result.notVerified.length).toBeGreaterThan(0);
    expect(Date.parse(result.checkedAt)).not.toBeNaN();
  });

  it('is pending while the run has no Commitment', async () => {
    events.findLatestRawEnvelope.mockResolvedValue(undefined);
    await expect(service.verify('r1')).resolves.toMatchObject({
      status: 'pending',
      match: false,
      commitmentHash: null,
      recomputed: null,
      commitment: null,
      checks: []
    });
  });

  it('reports a mismatch when the stored record no longer matches the wire bytes', async () => {
    const stored = proto.decodeKnown('macp.mode.decision.v1', 'Commitment', WIRE_001)!;
    seed(WIRE_001, { ...stored, reason: 'edited after the fact' });
    const result = await service.verify('r1');
    expect(result.status).toBe('mismatch');
    expect(result.match).toBe(false);
    expect(result.recomputed).toBe(H001);
    expect(result.commitmentHash).not.toBe(H001);
    expect(result.wireVerdict).toBe('mismatch');
    expect(result.checks.find((c) => c.id === 'wire_recompute')?.passed).toBe(false);
  });

  // protobufjs silently drops the unknown field, so both hashes agree — only the §6.1 verifier sees it.
  it('is cannot_verify when the wire carries a field outside the frozen set', async () => {
    seed(WIRE_UNKNOWN_FIELD);
    const result = await service.verify('r1');
    expect(result.commitmentHash).toBe(H001);
    expect(result.recomputed).toBe(H001);
    expect(result.wireVerdict).toBe('cannot_verify');
    expect(result.status).toBe('cannot_verify');
    expect(result.match).toBe(false);
  });

  it('is cannot_verify when the raw row kept no payload bytes', async () => {
    seed(null, proto.decodeKnown('macp.mode.decision.v1', 'Commitment', WIRE_001));
    const result = await service.verify('r1');
    expect(result.status).toBe('cannot_verify');
    expect(result.commitmentHash).toBe(H001);
    expect(result.recomputed).toBeNull();
  });

  it('fails projection_consistency when the displayed decision differs from the hashed one', async () => {
    seed(WIRE_001);
    runManager.getState.mockResolvedValue({ decision: { current: { finalized: true, action: 'decision.denied' } } });
    const result = await service.verify('r1');
    expect(result.status).toBe('mismatch');
    expect(result.match).toBe(true);
    expect(result.checks.find((c) => c.id === 'projection_consistency')).toMatchObject({ passed: false });
  });

  it('checks the supersedes reference shape and hashes the chained vector 002', async () => {
    const v002 = vector('cmt_hash_002_supersedes');
    const type = (proto as unknown as { root: protobuf.Root }).root.lookupType('macp.v1.CommitmentPayload');
    const p = v002.payload;
    const wire = Buffer.from(
      type
        .encode(
          type.fromObject({
            commitmentId: p.commitment_id,
            action: p.action,
            authorityScope: p.authority_scope,
            reason: p.reason,
            modeVersion: p.mode_version,
            policyVersion: p.policy_version,
            configurationVersion: p.configuration_version,
            outcomePositive: p.outcome_positive,
            supersedes: { sessionId: p.supersedes.session_id, commitmentHash: p.supersedes.commitment_hash }
          })
        )
        .finish()
    );
    seed(wire);
    runManager.getState.mockResolvedValue({ decision: { current: { finalized: true, action: p.action } } });
    const result = await service.verify('r1');
    expect(result.commitmentHash).toBe(v002.hash);
    expect(result.status).toBe('verified');
    expect(result.checks.find((c) => c.id === 'supersedes_canonical')?.passed).toBe(true);
    // RFC-MACP-0013 §11: each compute vector's pinned hash also verifies as match on its wire.
    expect(verifyCommitmentHash(wire, v002.hash)).toBe('match');
  });

  it('propagates 404 for an unknown run', async () => {
    runManager.getRun.mockRejectedValue(new NotFoundException('run r1 not found'));
    await expect(service.verify('r1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
