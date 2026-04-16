// ---------------------------------------------------------------------------
// We mock protobufjs so tests don't need real .proto files on disk.
//
// The service's private lookupType does `instanceof protobuf.Type`, so
// mockLookupType must return an instance of the same class we export as Type.
// ---------------------------------------------------------------------------

// Shared mock class that will be both `protobuf.Type` and the prototype
// for values returned by `root.lookupType`.
class MockType {
  encode = jest.fn().mockReturnValue({ finish: () => Buffer.from('encoded') });
  fromObject = jest.fn().mockReturnValue({ encoded: true });
  decode = jest.fn().mockReturnValue({ decoded: true });
  toObject = jest.fn().mockReturnValue({ field: 'value' });
}

let mockTypeInstance: MockType;

const mockLookupType = jest.fn().mockImplementation(() => mockTypeInstance);
const mockLoadSync = jest.fn();

class MockRoot {
  resolvePath: any;
  lookupType = mockLookupType;
  loadSync = mockLoadSync;
}

jest.mock('protobufjs', () => {
  return {
    Root: MockRoot,
    Type: MockType
  };
});

import { ProtoRegistryService } from './proto-registry.service';

describe('ProtoRegistryService', () => {
  let service: ProtoRegistryService;

  beforeEach(() => {
    // Fresh MockType instance per test
    mockTypeInstance = new MockType();

    mockLookupType.mockReset().mockImplementation(() => mockTypeInstance);
    mockLoadSync.mockReset();

    service = new ProtoRegistryService();
    // Invoke onModuleInit to load the (mocked) proto root
    service.onModuleInit();
  });

  // =========================================================================
  // onModuleInit
  // =========================================================================
  describe('onModuleInit', () => {
    it('loads proto files via protobufjs.loadSync', () => {
      expect(mockLoadSync).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.stringContaining('proto/macp/v1/core.proto')
        ])
      );
    });

    it('validates known types by calling lookupType', () => {
      // It should have looked up at least the core types during init
      expect(mockLookupType).toHaveBeenCalledWith('macp.v1.SessionStartPayload');
      expect(mockLookupType).toHaveBeenCalledWith('macp.v1.CommitmentPayload');
    });
  });

  // =========================================================================
  // getKnownTypeName
  // =========================================================================
  describe('getKnownTypeName', () => {
    it('returns core type for __core__ messages', () => {
      expect(service.getKnownTypeName('__core__', 'SessionStart')).toBe(
        'macp.v1.SessionStartPayload'
      );
    });

    it('returns core type when modeName does not match but messageType is core', () => {
      // Falls back to __core__ lookup
      expect(service.getKnownTypeName('unknown.mode', 'Signal')).toBe(
        'macp.v1.SignalPayload'
      );
    });

    it('returns mode-specific type for decision mode', () => {
      expect(
        service.getKnownTypeName('macp.mode.decision.v1', 'Proposal')
      ).toBe('macp.modes.decision.v1.ProposalPayload');
    });

    it('returns mode-specific type for task mode', () => {
      expect(service.getKnownTypeName('macp.mode.task.v1', 'TaskRequest')).toBe(
        'macp.modes.task.v1.TaskRequestPayload'
      );
    });

    it('returns mode-specific type for handoff mode', () => {
      expect(
        service.getKnownTypeName('macp.mode.handoff.v1', 'HandoffOffer')
      ).toBe('macp.modes.handoff.v1.HandoffOfferPayload');
    });

    it('returns mode-specific type for quorum mode', () => {
      expect(
        service.getKnownTypeName('macp.mode.quorum.v1', 'ApprovalRequest')
      ).toBe('macp.modes.quorum.v1.ApprovalRequestPayload');
    });

    it('returns undefined for unknown type in unknown mode', () => {
      expect(
        service.getKnownTypeName('unknown.mode', 'UnknownMessage')
      ).toBeUndefined();
    });
  });

  // =========================================================================
  // decodeKnown
  // =========================================================================
  describe('decodeKnown', () => {
    it('decodes a known core type via protobuf', () => {
      const payload = Buffer.from('test-data');

      const result = service.decodeKnown('__core__', 'SessionStart', payload);

      expect(mockLookupType).toHaveBeenCalledWith('macp.v1.SessionStartPayload');
      expect(mockTypeInstance.decode).toHaveBeenCalledWith(payload);
      expect(result).toEqual({ field: 'value' });
    });

    it('decodes a known mode-specific type via protobuf', () => {
      const payload = Buffer.from('decision-data');

      service.decodeKnown('macp.mode.decision.v1', 'Proposal', payload);

      expect(mockLookupType).toHaveBeenCalledWith(
        'macp.modes.decision.v1.ProposalPayload'
      );
    });

    it('falls back to tryDecodeUtf8 for unknown types with JSON payload', () => {
      const jsonPayload = Buffer.from(JSON.stringify({ key: 'val' }), 'utf8');

      const result = service.decodeKnown(
        'unknown.mode',
        'CustomMessage',
        jsonPayload
      );

      expect(result).toEqual({
        json: { key: 'val' },
        encoding: 'json'
      });
    });

    it('falls back to tryDecodeUtf8 for unknown types with non-JSON payload', () => {
      const textPayload = Buffer.from('just plain text', 'utf8');

      const result = service.decodeKnown(
        'unknown.mode',
        'CustomMessage',
        textPayload
      );

      expect(result).toEqual({
        text: 'just plain text',
        encoding: 'text',
        payloadBase64: Buffer.from('just plain text').toString('base64')
      });
    });

    it('returns undefined for unknown types with empty payload', () => {
      const result = service.decodeKnown(
        'unknown.mode',
        'CustomMessage',
        Buffer.alloc(0)
      );

      expect(result).toBeUndefined();
    });
  });

});
