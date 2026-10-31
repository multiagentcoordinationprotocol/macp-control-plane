import { HttpStatus, NotFoundException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { RuntimeCapabilitiesService } from '../runtime/runtime-capabilities.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { RunManagerService } from '../runs/run-manager.service';
import { DecisionReceiptService, RECEIPT_KEYS_TTL_SECONDS } from './decision-receipt.service';

const jwsWithKid = (kid: string) => `${Buffer.from(JSON.stringify({ alg: 'EdDSA', kid })).toString('base64url')}..c2ln`;
const receiptText = (kid = 'k1') =>
  `{"receipt_format":"macp-receipt/1","session_id":"sess-1","attestations":[{"type":"jws","jws":"${jwsWithKid(kid)}"}]}`;
const JWKS = '{"keys":[{"kty":"OKP","crv":"Ed25519","kid":"k1","x":"AAAA"}]}';
const SUPPORTED = { decisionReceipt: { getDecisionReceipt: true, signed: true } };

describe('DecisionReceiptService', () => {
  let runManager: { getRun: jest.Mock };
  let provider: { getDecisionReceipt: jest.Mock; getReceiptKeys: jest.Mock };
  let registry: { get: jest.Mock };
  let capabilities: { forDecisionReceipt: jest.Mock };
  let service: DecisionReceiptService;

  beforeEach(() => {
    runManager = {
      getRun: jest.fn().mockResolvedValue({ id: 'run-1', runtimeKind: 'rust', runtimeSessionId: 'sess-1' })
    };
    provider = {
      getDecisionReceipt: jest.fn().mockResolvedValue({ receiptJson: receiptText() }),
      getReceiptKeys: jest.fn().mockResolvedValue({ jwksJson: JWKS })
    };
    registry = { get: jest.fn().mockReturnValue(provider) };
    capabilities = { forDecisionReceipt: jest.fn().mockResolvedValue(SUPPORTED) };
    service = new DecisionReceiptService(
      { runtimeKind: 'rust' } as AppConfigService,
      runManager as unknown as RunManagerService,
      registry as unknown as RuntimeProviderRegistry,
      capabilities as unknown as RuntimeCapabilitiesService
    );
  });

  const rejection = (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (e: unknown) => e as AppException
    );

  describe('getReceipt', () => {
    it("returns the runtime's text verbatim plus its parse, for the run's session", async () => {
      const view = await service.getReceipt('run-1');
      expect(view).toEqual({
        runId: 'run-1',
        sessionId: 'sess-1',
        receiptJson: receiptText(),
        receipt: JSON.parse(receiptText())
      });
      expect(registry.get).toHaveBeenCalledWith('rust');
      expect(provider.getDecisionReceipt).toHaveBeenCalledWith({ runtimeSessionId: 'sess-1' });
    });

    it('501 DECISION_RECEIPT_UNSUPPORTED without calling the RPC when the runtime does not advertise it', async () => {
      capabilities.forDecisionReceipt.mockResolvedValue({ decisionReceipt: { getDecisionReceipt: false } });
      const err = await rejection(service.getReceipt('run-1'));
      expect(err?.getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
      expect(err?.errorCode).toBe(ErrorCode.DECISION_RECEIPT_UNSUPPORTED);
      expect(provider.getDecisionReceipt).not.toHaveBeenCalled();
    });

    it('501 when Initialize advertises no capabilities at all', async () => {
      capabilities.forDecisionReceipt.mockResolvedValue(undefined);
      expect((await rejection(service.getReceipt('run-1')))?.errorCode).toBe(ErrorCode.DECISION_RECEIPT_UNSUPPORTED);
    });

    it('404 RUN_NOT_FOUND for an unknown run', async () => {
      runManager.getRun.mockRejectedValue(new NotFoundException('nope'));
      const err = await rejection(service.getReceipt('run-x'));
      expect(err?.getStatus()).toBe(404);
      expect(err?.errorCode).toBe(ErrorCode.RUN_NOT_FOUND);
    });

    it('404 NOT_FOUND when the run has no runtime session yet', async () => {
      runManager.getRun.mockResolvedValue({ id: 'run-1', runtimeKind: 'rust', runtimeSessionId: null });
      const err = await rejection(service.getReceipt('run-1'));
      expect(err?.getStatus()).toBe(404);
      expect(err?.errorCode).toBe(ErrorCode.NOT_FOUND);
      expect(capabilities.forDecisionReceipt).not.toHaveBeenCalled();
    });

    it("passes the runtime's mapped error through (RECEIPT_UNAVAILABLE 409)", async () => {
      const mapped = new AppException(ErrorCode.RECEIPT_UNAVAILABLE, 'not resolved', HttpStatus.CONFLICT);
      provider.getDecisionReceipt.mockRejectedValue(mapped);
      await expect(service.getReceipt('run-1')).rejects.toBe(mapped);
    });

    it.each([
      ['not JSON', 'nope'],
      ['an array', '[]'],
      ['null', 'null']
    ])('502 when receipt_json is %s', async (_label, text) => {
      provider.getDecisionReceipt.mockResolvedValue({ receiptJson: text });
      const err = await rejection(service.getReceipt('run-1'));
      expect(err?.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    });
  });

  describe('getReceiptKeys', () => {
    it('returns the JWKS text verbatim and caches it for the TTL', async () => {
      await expect(service.getReceiptKeys()).resolves.toEqual({
        jwksJson: JWKS,
        maxAgeSeconds: RECEIPT_KEYS_TTL_SECONDS
      });
      const again = await service.getReceiptKeys();
      expect(again.jwksJson).toBe(JWKS);
      expect(again.maxAgeSeconds).toBeLessThanOrEqual(RECEIPT_KEYS_TTL_SECONDS);
      expect(provider.getReceiptKeys).toHaveBeenCalledTimes(1);
      expect(registry.get).toHaveBeenCalledWith('rust');
    });

    it('asks the runtime again once the TTL has passed', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        await service.getReceiptKeys();
        now.mockReturnValue(1_000_000 + RECEIPT_KEYS_TTL_SECONDS * 1000 + 1);
        await service.getReceiptKeys();
        expect(provider.getReceiptKeys).toHaveBeenCalledTimes(2);
      } finally {
        now.mockRestore();
      }
    });

    it('drops the cache when a fetched receipt is signed by a kid the cached set lacks (rotation)', async () => {
      await service.getReceiptKeys();
      provider.getDecisionReceipt.mockResolvedValue({ receiptJson: receiptText('k2') });
      await service.getReceipt('run-1');
      await service.getReceiptKeys();
      expect(provider.getReceiptKeys).toHaveBeenCalledTimes(2);
    });

    it('keeps the cache when the receipt is signed by a cached kid', async () => {
      await service.getReceiptKeys();
      await service.getReceipt('run-1');
      await service.getReceiptKeys();
      expect(provider.getReceiptKeys).toHaveBeenCalledTimes(1);
    });

    it('501 DECISION_RECEIPT_UNSUPPORTED without calling the RPC, and caches nothing', async () => {
      capabilities.forDecisionReceipt.mockResolvedValue({ policyRegistry: { whatIfReplay: true } });
      const err = await rejection(service.getReceiptKeys());
      expect(err?.getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
      expect(err?.errorCode).toBe(ErrorCode.DECISION_RECEIPT_UNSUPPORTED);
      expect(provider.getReceiptKeys).not.toHaveBeenCalled();
    });

    it('serves the empty set {"keys":[]} (runtime without keys)', async () => {
      provider.getReceiptKeys.mockResolvedValue({ jwksJson: '{"keys":[]}' });
      expect((await service.getReceiptKeys()).jwksJson).toBe('{"keys":[]}');
    });

    it.each([
      ['not JSON', '{'],
      ['missing keys', '{"kty":"OKP"}']
    ])('502 when jwks_json is %s', async (_label, text) => {
      provider.getReceiptKeys.mockResolvedValue({ jwksJson: text });
      expect((await rejection(service.getReceiptKeys()))?.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    });
  });
});
