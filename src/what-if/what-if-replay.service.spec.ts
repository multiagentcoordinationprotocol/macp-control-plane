import { HttpStatus, NotFoundException } from '@nestjs/common';
import * as protobuf from 'protobufjs';
import { RuntimeWhatIfReplayResult } from '../contracts/runtime';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { PolicyRulesValidatorService } from '../policy/policy-rules-validator.service';
import { RuntimeCapabilitiesService } from '../runtime/runtime-capabilities.service';
import { ProtoRegistryService } from '../runtime/proto-registry.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { RunManagerService } from '../runs/run-manager.service';
import { WhatIfReplayService } from './what-if-replay.service';

const DECISION = 'macp.mode.decision.v1';

describe('WhatIfReplayService', () => {
  let proto: ProtoRegistryService;
  let runManager: { getRun: jest.Mock };
  let provider: { getSession: jest.Mock; whatIfReplay: jest.Mock };
  let capabilities: { forWhatIfReplay: jest.Mock };
  let service: WhatIfReplayService;

  const commitmentBytes = () => {
    const type = (proto as unknown as { root: protobuf.Root }).root.lookupType('macp.v1.CommitmentPayload');
    return Buffer.from(
      type.encode(type.fromObject({ commitmentId: 'c1', action: 'decision.approved', outcomePositive: true })).finish()
    );
  };

  const runtimeResult = (overrides: Partial<RuntimeWhatIfReplayResult> = {}): RuntimeWhatIfReplayResult => ({
    candidatePolicyId: 'cand',
    recordedPolicyId: 'policy.default',
    recorded: {
      state: 'SESSION_STATE_RESOLVED',
      resolution: commitmentBytes(),
      resolvedByHistoryIndex: 3,
      resolvedByMessageId: 'm4',
      resolvedByMessageType: 'Commitment'
    },
    candidate: {
      state: 'SESSION_STATE_OPEN',
      resolution: Buffer.alloc(0),
      resolvedByHistoryIndex: 0,
      resolvedByMessageId: '',
      resolvedByMessageType: ''
    },
    firstDivergence: 0,
    denials: [{ historyIndex: 3, messageId: 'm4', details: Buffer.from('{"reasons":["quorum not met"]}') }],
    entries: [
      {
        historyIndex: 3,
        messageId: 'm4',
        messageType: 'Commitment',
        recorded: { kind: 'KIND_APPLIED', state: 'SESSION_STATE_RESOLVED', errorCode: '', details: Buffer.alloc(0) },
        candidate: {
          kind: 'KIND_REFUSED',
          state: 'SESSION_STATE_OPEN',
          errorCode: 'POLICY_DENIED',
          details: Buffer.from('{"reasons":["quorum not met"]}')
        }
      }
    ],
    ...overrides
  });

  beforeAll(() => {
    proto = new ProtoRegistryService();
    proto.onModuleInit();
  });

  beforeEach(() => {
    runManager = {
      getRun: jest.fn().mockResolvedValue({ id: 'r1', runtimeKind: 'rust', runtimeSessionId: 's1' })
    };
    provider = {
      getSession: jest.fn().mockResolvedValue({ sessionId: 's1', mode: DECISION, state: 'SESSION_STATE_RESOLVED' }),
      whatIfReplay: jest.fn().mockResolvedValue(runtimeResult())
    };
    capabilities = {
      forWhatIfReplay: jest.fn().mockResolvedValue({ policyRegistry: { whatIfReplay: true, ruleExtensions: [] } })
    };
    service = new WhatIfReplayService(
      runManager as unknown as RunManagerService,
      { get: jest.fn().mockReturnValue(provider) } as unknown as RuntimeProviderRegistry,
      capabilities as unknown as RuntimeCapabilitiesService,
      new PolicyRulesValidatorService(),
      proto
    );
  });

  it('replays under the candidate and maps the response into the HTTP view', async () => {
    const view = await service.replay('r1', { rules: { voting: { algorithm: 'unanimous' } }, policyId: 'cand' });

    const sent = provider.whatIfReplay.mock.calls[0][0];
    expect(sent.runtimeSessionId).toBe('s1');
    expect(sent.candidate).toMatchObject({ policyId: 'cand', mode: DECISION, description: '', schemaVersion: 3 });
    expect(JSON.parse(sent.candidate.rules.toString())).toEqual({ voting: { algorithm: 'unanimous' } });

    expect(view).toEqual({
      runId: 'r1',
      sessionId: 's1',
      recordedPolicyId: 'policy.default',
      candidatePolicyId: 'cand',
      recorded: {
        state: 'RESOLVED',
        resolution: expect.objectContaining({ commitmentId: 'c1', action: 'decision.approved', outcomePositive: true }),
        resolvedBy: { historyIndex: 3, messageId: 'm4', messageType: 'Commitment' }
      },
      candidate: { state: 'OPEN', resolution: null, resolvedBy: null },
      firstDivergence: 0,
      denials: [{ historyIndex: 3, messageId: 'm4', details: { reasons: ['quorum not met'] } }],
      entries: [
        {
          historyIndex: 3,
          messageId: 'm4',
          messageType: 'Commitment',
          recorded: { kind: 'APPLIED', state: 'RESOLVED', errorCode: null, details: null },
          candidate: {
            kind: 'REFUSED',
            state: 'OPEN',
            errorCode: 'POLICY_DENIED',
            details: { reasons: ['quorum not met'] }
          }
        }
      ]
    });
  });

  it('reports agreeing replays as firstDivergence null', async () => {
    const agreeing = runtimeResult();
    delete agreeing.firstDivergence;
    provider.whatIfReplay.mockResolvedValue(agreeing);
    expect((await service.replay('r1', { rules: {} })).firstDivergence).toBeNull();
  });

  it('uses an explicit mode and schemaVersion without asking for the session', async () => {
    await service.replay('r1', { mode: '*', rules: {}, schemaVersion: 2 });
    expect(provider.getSession).not.toHaveBeenCalled();
    expect(provider.whatIfReplay.mock.calls[0][0].candidate).toMatchObject({ mode: '*', schemaVersion: 2 });
  });

  it('answers 501 WHAT_IF_REPLAY_UNSUPPORTED when the runtime does not advertise it', async () => {
    capabilities.forWhatIfReplay.mockResolvedValue({ policyRegistry: { registerPolicy: true } });
    const err = await service.replay('r1', { rules: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppException);
    expect((err as AppException).getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
    expect((err as AppException).errorCode).toBe(ErrorCode.WHAT_IF_REPLAY_UNSUPPORTED);
    expect(provider.whatIfReplay).not.toHaveBeenCalled();
  });

  it('refuses rules outside the closed set before calling the runtime', async () => {
    const err = await service.replay('r1', { rules: { voting: { algorithm: 'weighted' } } }).catch((e: unknown) => e);
    expect((err as AppException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect((err as AppException).errorCode).toBe(ErrorCode.INVALID_POLICY_DEFINITION);

    const typo = await service
      .replay('r1', { rules: { voting: { algorithmm: 'unanimous' } } })
      .catch((e: unknown) => e);
    expect((typo as AppException).message).toMatch(/^INVALID_POLICY_DEFINITION: invalid policy rules for mode/);
    expect(provider.whatIfReplay).not.toHaveBeenCalled();
  });

  it('404s an unknown run and a run without a session', async () => {
    runManager.getRun.mockRejectedValueOnce(new NotFoundException('run r9 not found'));
    const unknown = await service.replay('r9', { rules: {} }).catch((e: unknown) => e);
    expect((unknown as AppException).getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect((unknown as AppException).errorCode).toBe(ErrorCode.RUN_NOT_FOUND);

    const dbDown = new Error('connection refused');
    runManager.getRun.mockRejectedValueOnce(dbDown);
    await expect(service.replay('r1', { rules: {} })).rejects.toBe(dbDown);

    runManager.getRun.mockResolvedValueOnce({ id: 'r2', runtimeKind: 'rust', runtimeSessionId: null });
    const err = await service.replay('r2', { rules: {} }).catch((e: unknown) => e);
    expect((err as AppException).getStatus()).toBe(HttpStatus.NOT_FOUND);
  });

  it('passes runtime errors (e.g. HISTORY_UNAVAILABLE) through unchanged', async () => {
    const historyUnavailable = new AppException(ErrorCode.HISTORY_UNAVAILABLE, 'compacted', HttpStatus.CONFLICT);
    provider.whatIfReplay.mockRejectedValue(historyUnavailable);
    await expect(service.replay('r1', { rules: {} })).rejects.toBe(historyUnavailable);
  });
});
