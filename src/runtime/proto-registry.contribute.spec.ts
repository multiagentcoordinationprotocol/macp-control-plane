// Real-protobufjs decode coverage for multi-round `Contribute` (T3, proto 0.1.6).
//
// Unlike proto-registry.service.spec.ts (which mocks protobufjs), this suite
// loads the real .proto files shipped by @multiagentcoordinationprotocol/proto
// and asserts that both wire encodings — a protobuf-encoded ContributePayload
// AND a legacy JSON `{"value":"..."}` envelope — normalize to the same flat
// `{ value }` shape that downstream projection helpers expect.
import { ProtoRegistryService } from './proto-registry.service';

describe('ProtoRegistryService — multi-round Contribute decode (real protos)', () => {
  let service: ProtoRegistryService;

  beforeAll(() => {
    service = new ProtoRegistryService();
    service.onModuleInit();
  });

  // ContributePayload { string value = 1; } → wire: tag 0x0A, len, utf8 bytes.
  function encodeProtoContribute(value: string): Buffer {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from([0x0a, bytes.length]), bytes]);
  }

  it('resolves Contribute to the multi-round proto type (not __json__)', () => {
    expect(service.getKnownTypeName('ext.multi_round.v1', 'Contribute')).toBe(
      'macp.modes.multi_round.v1.ContributePayload'
    );
  });

  it('decodes a protobuf-encoded ContributePayload to { value }', () => {
    const decoded = service.decodeKnown('ext.multi_round.v1', 'Contribute', encodeProtoContribute('option-a'));
    expect(decoded).toEqual({ value: 'option-a' });
  });

  it('decodes a legacy JSON Contribute to the same flat { value } shape', () => {
    const jsonBytes = Buffer.from(JSON.stringify({ value: 'option-a' }), 'utf8');
    const decoded = service.decodeKnown('ext.multi_round.v1', 'Contribute', jsonBytes);
    expect(decoded).toEqual({ value: 'option-a' });
  });

  it('produces identical shapes for proto and JSON encodings of the same value', () => {
    const fromProto = service.decodeKnown('ext.multi_round.v1', 'Contribute', encodeProtoContribute('converged'));
    const fromJson = service.decodeKnown(
      'ext.multi_round.v1',
      'Contribute',
      Buffer.from(JSON.stringify({ value: 'converged' }), 'utf8')
    );
    expect(fromProto).toEqual(fromJson);
  });

  it('does not warn about a missing ContributePayload proto type at boot', () => {
    const warn = jest.spyOn(service['logger'], 'warn');
    const fresh = new ProtoRegistryService();
    fresh.onModuleInit();
    const warnedAboutContribute = warn.mock.calls.some((args) =>
      String(args[0] ?? '').includes('ContributePayload')
    );
    expect(warnedAboutContribute).toBe(false);
    warn.mockRestore();
  });
});
