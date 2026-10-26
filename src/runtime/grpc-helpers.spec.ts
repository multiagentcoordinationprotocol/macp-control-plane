import { HttpStatus } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import {
  buildMetadata,
  fromAck,
  fromEnvelope,
  fromSessionMetadata,
  getClientMethod,
  MACP_ERROR_REGISTRY,
  macpErrorCodeOf,
  mapGrpcError,
  parsePolicyDenyDetails,
  readMacpErrorCode
} from './grpc-helpers';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';

describe('gRPC helpers (Q3-1)', () => {
  describe('fromEnvelope', () => {
    it('unwraps a gRPC envelope into the internal shape with numeric timestamp', () => {
      const raw = {
        macpVersion: '1.0',
        mode: 'macp.mode.decision.v1',
        messageType: 'Proposal',
        messageId: 'msg-1',
        sessionId: 'sess-1',
        sender: 'agent-a',
        timestampUnixMs: '1700000000000', // Long serialized as string (longs: String)
        payload: Buffer.from('hello')
      };
      const result = fromEnvelope(raw);
      expect(result.timestampUnixMs).toBe(1700000000000);
      expect(result.payload.toString()).toBe('hello');
      expect(result.messageId).toBe('msg-1');
    });

    it('coerces non-buffer payload to Buffer', () => {
      const result = fromEnvelope({
        macpVersion: '1.0',
        mode: '',
        messageType: '',
        messageId: '',
        sessionId: '',
        sender: '',
        payload: 'hello'
      });
      expect(Buffer.isBuffer(result.payload)).toBe(true);
    });

    it('defaults timestampUnixMs to now when missing', () => {
      const before = Date.now();
      const result = fromEnvelope({
        macpVersion: '1.0',
        mode: '',
        messageType: '',
        messageId: '',
        sessionId: '',
        sender: ''
      });
      expect(result.timestampUnixMs).toBeGreaterThanOrEqual(before);
    });
  });

  describe('fromAck', () => {
    it('maps a successful ack with default session state', () => {
      const ack = fromAck({ ok: true, sessionId: 's', messageId: 'm' });
      expect(ack.ok).toBe(true);
      expect(ack.sessionState).toBe('SESSION_STATE_UNSPECIFIED');
      expect(ack.error).toBeUndefined();
    });

    it('parses structured reasons from error.details JSON', () => {
      const detailsBytes = Buffer.from(JSON.stringify({ reasons: ['rule-x', 'rule-y'] }));
      const ack = fromAck({
        ok: false,
        error: { code: 'POLICY_DENIED', message: 'no', details: detailsBytes }
      });
      expect(ack.error?.reasons).toEqual(['rule-x', 'rule-y']);
      expect(ack.error?.code).toBe('POLICY_DENIED');
      expect(ack.error?.detailsBase64).toBe(detailsBytes.toString('base64'));
    });

    it('falls back to trailing macp-error-details-bin metadata for reasons', () => {
      const meta = new grpc.Metadata();
      meta.add('macp-error-details-bin', Buffer.from(JSON.stringify({ reasons: ['meta-rule'] })));
      const ack = fromAck({ ok: false, error: { code: 'POLICY_DENIED', message: '' } }, meta);
      expect(ack.error?.reasons).toEqual(['meta-rule']);
    });

    it('carries structured denials from error.details alongside reasons (runtime v0.9.0)', () => {
      const denials = [{ code: 'VETO', message: 'vetoed', participants: ['x'] }];
      const ack = fromAck({
        ok: false,
        error: {
          code: 'POLICY_DENIED',
          message: 'PolicyDenied',
          details: Buffer.from(JSON.stringify({ reasons: ['vetoed'], denials }))
        }
      });
      expect(ack.error?.reasons).toEqual(['vetoed']);
      expect(ack.error?.denials).toEqual(denials);
    });

    it('omits denials on a pre-0.9.0 details payload that has reasons only', () => {
      const ack = fromAck({
        ok: false,
        error: { code: 'POLICY_DENIED', message: 'x', details: Buffer.from(JSON.stringify({ reasons: ['r'] })) }
      });
      expect(ack.error?.reasons).toEqual(['r']);
      expect(ack.error).not.toHaveProperty('denials');
    });

    it('tolerates malformed details JSON by leaving reasons undefined', () => {
      const ack = fromAck({
        ok: false,
        error: { code: 'POLICY_DENIED', message: '', details: Buffer.from('{not json') }
      });
      expect(ack.error?.reasons).toBeUndefined();
    });
  });

  describe('fromSessionMetadata', () => {
    it('maps fields including optional initiator', () => {
      const snap = fromSessionMetadata({
        sessionId: 's',
        mode: 'decision',
        state: 'SESSION_STATE_OPEN',
        initiator: 'agent-1',
        startedAtUnixMs: '123'
      });
      expect(snap.sessionId).toBe('s');
      expect(snap.state).toBe('SESSION_STATE_OPEN');
      expect(snap.initiator).toBe('agent-1');
      expect(snap.startedAtUnixMs).toBe(123);
    });

    it('defaults state to UNSPECIFIED when missing', () => {
      const snap = fromSessionMetadata({});
      expect(snap.state).toBe('SESSION_STATE_UNSPECIFIED');
    });

    it('maps contextId (field 12) and extensionKeys (field 13) from 0.1.6 metadata', () => {
      const snap = fromSessionMetadata({
        sessionId: 's',
        mode: 'decision',
        state: 'SESSION_STATE_OPEN',
        contextId: 'ctx-42',
        extensionKeys: ['analytics', 'trace']
      });
      expect(snap.contextId).toBe('ctx-42');
      expect(snap.extensionKeys).toEqual(['analytics', 'trace']);
    });

    it('leaves contextId/extensionKeys undefined when absent or empty', () => {
      const snap = fromSessionMetadata({ sessionId: 's', state: 'SESSION_STATE_OPEN', extensionKeys: [] });
      expect(snap.contextId).toBeUndefined();
      expect(snap.extensionKeys).toBeUndefined();
    });
  });

  describe('buildMetadata', () => {
    it('sets only truthy credential keys', () => {
      const meta = buildMetadata({ authorization: 'Bearer abc', 'x-empty': '' });
      expect(meta.get('authorization')).toEqual(['Bearer abc']);
      expect(meta.get('x-empty')).toEqual([]);
    });

    it('always tries to inject trace context (traceparent absent is OK)', () => {
      // No active OTel span means inject is a no-op. We just verify buildMetadata
      // returns a real grpc.Metadata and doesn't throw.
      expect(() => buildMetadata({})).not.toThrow();
    });
  });

  describe('getClientMethod', () => {
    it('resolves PascalCase method names', () => {
      const fn = () => 'ok';
      const client = { Initialize: fn };
      expect(getClientMethod(client, 'Initialize')).toBe(fn);
    });

    it('falls back to lowerCamelCase', () => {
      const fn = () => 'ok';
      const client = { initialize: fn };
      expect(getClientMethod(client, 'Initialize')).toBe(fn);
    });

    it('throws on unknown method', () => {
      expect(() => getClientMethod({}, 'Nope')).toThrow(/not available on client/);
    });
  });

  describe('mapGrpcError', () => {
    const grpcError = (code: grpc.status, details = 'boom'): grpc.ServiceError =>
      ({ code, details, message: details, metadata: new grpc.Metadata(), name: 'Error' }) as grpc.ServiceError;

    it.each([
      [grpc.status.PERMISSION_DENIED, HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN],
      [grpc.status.NOT_FOUND, HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND],
      [grpc.status.INVALID_ARGUMENT, HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR],
      [grpc.status.ALREADY_EXISTS, HttpStatus.CONFLICT, ErrorCode.CONFLICT],
      [grpc.status.FAILED_PRECONDITION, HttpStatus.CONFLICT, ErrorCode.CONFLICT],
      [grpc.status.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHENTICATED],
      [grpc.status.RESOURCE_EXHAUSTED, HttpStatus.TOO_MANY_REQUESTS, ErrorCode.RATE_LIMITED],
      [grpc.status.UNIMPLEMENTED, HttpStatus.NOT_IMPLEMENTED, ErrorCode.NOT_IMPLEMENTED],
      [grpc.status.UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.RUNTIME_UNAVAILABLE],
      [grpc.status.DEADLINE_EXCEEDED, HttpStatus.GATEWAY_TIMEOUT, ErrorCode.RUNTIME_TIMEOUT]
    ])('maps gRPC code %i → HTTP %i', (code, http, errorCode) => {
      const mapped = mapGrpcError(grpcError(code as grpc.status), 'RegisterPolicy');
      expect(mapped).toBeInstanceOf(AppException);
      expect(mapped!.getStatus()).toBe(http);
      expect(mapped!.errorCode).toBe(errorCode);
    });

    it('preserves the runtime "details" string as the client-facing message', () => {
      const mapped = mapGrpcError(
        grpcError(grpc.status.PERMISSION_DENIED, 'only the session initiator or policy-delegated roles can suspend'),
        'SuspendSession'
      );
      expect((mapped!.getResponse() as { message: string }).message).toBe(
        'only the session initiator or policy-delegated roles can suspend'
      );
    });

    it('maps unlisted gRPC codes (INTERNAL, UNKNOWN) to HTTP 500', () => {
      const mapped = mapGrpcError(grpcError(grpc.status.INTERNAL), 'GetSession');
      expect(mapped!.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(mapped!.errorCode).toBe(ErrorCode.INTERNAL_ERROR);
    });

    it('returns undefined for non-gRPC errors so callers rethrow unchanged', () => {
      expect(mapGrpcError(new Error('plain'), 'GetSession')).toBeUndefined();
      expect(mapGrpcError({ code: 'ECONNREFUSED' }, 'GetSession')).toBeUndefined();
      expect(mapGrpcError(undefined, 'GetSession')).toBeUndefined();
    });

    it('carries grpcCode and no macpErrorCode for an uncoded (0.8.x) status', () => {
      const mapped = mapGrpcError(grpcError(grpc.status.NOT_FOUND), 'GetSession');
      expect(mapped!.metadata).toEqual({ grpcCode: grpc.status.NOT_FOUND });
    });
  });

  describe('mapGrpcError — runtime v0.9.0 registry codes (S13)', () => {
    const coded = (code: grpc.status, macpCode: string, details = 'boom', detailsBin?: Buffer): grpc.ServiceError => {
      const metadata = new grpc.Metadata();
      metadata.set('macp-error-code', macpCode);
      if (detailsBin) metadata.set('macp-error-details-bin', detailsBin);
      return { code, details, message: details, metadata, name: 'Error' } as grpc.ServiceError;
    };

    // [registry code, gRPC status the runtime sends, expected HTTP, expected ErrorCode]
    // — mirrors macp-runtime crates/macp-core/src/error.rs ERROR_CODE_REGISTRY.
    const rows: Array<[string, grpc.status, number, ErrorCode]> = [
      ['UNAUTHENTICATED', grpc.status.UNAUTHENTICATED, 401, ErrorCode.UNAUTHENTICATED],
      ['FORBIDDEN', grpc.status.PERMISSION_DENIED, 403, ErrorCode.FORBIDDEN],
      ['SESSION_NOT_FOUND', grpc.status.NOT_FOUND, 404, ErrorCode.NOT_FOUND],
      ['SESSION_NOT_OPEN', grpc.status.FAILED_PRECONDITION, 409, ErrorCode.SESSION_NOT_OPEN],
      ['DUPLICATE_MESSAGE', grpc.status.ALREADY_EXISTS, 409, ErrorCode.DUPLICATE_MESSAGE],
      ['SESSION_ALREADY_EXISTS', grpc.status.ALREADY_EXISTS, 409, ErrorCode.SESSION_ALREADY_EXISTS],
      ['INVALID_ENVELOPE', grpc.status.INVALID_ARGUMENT, 400, ErrorCode.INVALID_ENVELOPE],
      ['UNSUPPORTED_PROTOCOL_VERSION', grpc.status.INVALID_ARGUMENT, 400, ErrorCode.VALIDATION_ERROR],
      ['MODE_NOT_SUPPORTED', grpc.status.INVALID_ARGUMENT, 400, ErrorCode.MODE_NOT_SUPPORTED],
      ['PAYLOAD_TOO_LARGE', grpc.status.RESOURCE_EXHAUSTED, 413, ErrorCode.PAYLOAD_TOO_LARGE],
      ['RATE_LIMITED', grpc.status.RESOURCE_EXHAUSTED, 429, ErrorCode.RATE_LIMITED],
      ['INVALID_SESSION_ID', grpc.status.INVALID_ARGUMENT, 400, ErrorCode.INVALID_SESSION_ID],
      ['INTERNAL_ERROR', grpc.status.INTERNAL, 500, ErrorCode.INTERNAL_ERROR],
      ['UNKNOWN_POLICY_VERSION', grpc.status.NOT_FOUND, 404, ErrorCode.UNKNOWN_POLICY_VERSION],
      ['POLICY_DENIED', grpc.status.PERMISSION_DENIED, 403, ErrorCode.POLICY_DENIED],
      ['INVALID_POLICY_DEFINITION', grpc.status.INVALID_ARGUMENT, 400, ErrorCode.INVALID_POLICY_DEFINITION],
      // Deliberate divergence from the registry's 409 (owner decision Q1).
      ['REGISTRY_READ_ONLY', grpc.status.FAILED_PRECONDITION, 405, ErrorCode.REGISTRY_READ_ONLY],
      ['INVALID_REQUEST', grpc.status.INVALID_ARGUMENT, 400, ErrorCode.VALIDATION_ERROR],
      ['STREAM_LAGGED', grpc.status.RESOURCE_EXHAUSTED, 503, ErrorCode.STREAM_LAGGED],
      ['AGENT_NOT_FOUND', grpc.status.NOT_FOUND, 404, ErrorCode.NOT_FOUND],
      ['HISTORY_UNAVAILABLE', grpc.status.FAILED_PRECONDITION, 409, ErrorCode.HISTORY_UNAVAILABLE],
      ['UNAUTHORIZED', grpc.status.PERMISSION_DENIED, 403, ErrorCode.FORBIDDEN]
    ];

    it('covers every registry row exactly once', () => {
      expect(rows.map((r) => r[0]).sort()).toEqual(Object.keys(MACP_ERROR_REGISTRY).sort());
    });

    it.each(rows)('%s (gRPC %i) → HTTP %i / %s', (macpCode, status, http, errorCode) => {
      const mapped = mapGrpcError(coded(status, macpCode), 'Op');
      expect(mapped!.getStatus()).toBe(http);
      expect(mapped!.errorCode).toBe(errorCode);
      expect(mapped!.metadata).toMatchObject({ grpcCode: status, macpErrorCode: macpCode });
    });

    it.each([
      [grpc.status.RESOURCE_EXHAUSTED, ['PAYLOAD_TOO_LARGE', 'RATE_LIMITED', 'STREAM_LAGGED']],
      [grpc.status.NOT_FOUND, ['SESSION_NOT_FOUND', 'UNKNOWN_POLICY_VERSION', 'AGENT_NOT_FOUND']]
    ])('gRPC %i resolves to three distinct outcomes by code', (status, codes) => {
      const outcomes = codes.map((c) => {
        const m = mapGrpcError(coded(status as grpc.status, c), 'Op')!;
        return `${m.getStatus()}/${m.errorCode}/${String(m.metadata?.macpErrorCode)}`;
      });
      expect(new Set(outcomes).size).toBe(3);
    });

    it('decodes POLICY_DENIED reasons and denials from macp-error-details-bin verbatim', () => {
      const denials = [{ code: 'QUORUM_NOT_MET', message: 'quorum not met', participants: ['a', 'b'] }];
      const bin = Buffer.from(JSON.stringify({ reasons: ['quorum not met'], denials }));
      const mapped = mapGrpcError(
        coded(grpc.status.PERMISSION_DENIED, 'POLICY_DENIED', 'PolicyDenied: quorum not met', bin),
        'Send'
      );
      expect(mapped!.errorCode).toBe(ErrorCode.POLICY_DENIED);
      expect(mapped!.getStatus()).toBe(403);
      expect(mapped!.metadata).toEqual({
        grpcCode: grpc.status.PERMISSION_DENIED,
        macpErrorCode: 'POLICY_DENIED',
        reasons: ['quorum not met'],
        denials
      });
      expect((mapped!.getResponse() as { metadata: unknown }).metadata).toEqual(mapped!.metadata);
    });

    it('tolerates malformed POLICY_DENIED details (no reasons, no throw)', () => {
      const mapped = mapGrpcError(
        coded(grpc.status.PERMISSION_DENIED, 'POLICY_DENIED', 'PolicyDenied', Buffer.from('{not json')),
        'Send'
      );
      expect(mapped!.errorCode).toBe(ErrorCode.POLICY_DENIED);
      expect(mapped!.metadata).toEqual({ grpcCode: grpc.status.PERMISSION_DENIED, macpErrorCode: 'POLICY_DENIED' });
    });

    it('falls back to the status table for an unrecognised code, still recording it', () => {
      const mapped = mapGrpcError(coded(grpc.status.FAILED_PRECONDITION, 'SOME_FUTURE_CODE'), 'Op');
      expect(mapped!.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(mapped!.errorCode).toBe(ErrorCode.CONFLICT);
      expect(mapped!.metadata).toEqual({
        grpcCode: grpc.status.FAILED_PRECONDITION,
        macpErrorCode: 'SOME_FUTURE_CODE'
      });
    });

    it('does not resolve prototype keys as registry codes', () => {
      const mapped = mapGrpcError(coded(grpc.status.INVALID_ARGUMENT, 'constructor'), 'Op');
      expect(mapped!.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  describe('readMacpErrorCode / macpErrorCodeOf', () => {
    it('reads the code from a raw ServiceError and from a mapped AppException', () => {
      const metadata = new grpc.Metadata();
      metadata.set('macp-error-code', 'SESSION_NOT_OPEN');
      const raw = { code: grpc.status.FAILED_PRECONDITION, details: 'x', metadata } as unknown as grpc.ServiceError;
      expect(readMacpErrorCode(raw)).toBe('SESSION_NOT_OPEN');
      expect(macpErrorCodeOf(raw)).toBe('SESSION_NOT_OPEN');
      expect(macpErrorCodeOf(mapGrpcError(raw, 'Op'))).toBe('SESSION_NOT_OPEN');
    });

    it('is undefined for uncoded, empty, non-Metadata and non-error values', () => {
      const empty = new grpc.Metadata();
      empty.set('macp-error-code', '  ');
      expect(readMacpErrorCode({ code: 5, metadata: new grpc.Metadata() })).toBeUndefined();
      expect(readMacpErrorCode({ code: 5, metadata: empty })).toBeUndefined();
      expect(readMacpErrorCode({ code: 5, metadata: { 'macp-error-code': 'X' } })).toBeUndefined();
      expect(readMacpErrorCode(undefined)).toBeUndefined();
      expect(macpErrorCodeOf(new AppException(ErrorCode.NOT_FOUND, 'x', 404))).toBeUndefined();
      expect(macpErrorCodeOf(new Error('plain'))).toBeUndefined();
    });
  });

  describe('parsePolicyDenyDetails', () => {
    it('returns reasons and denials when present', () => {
      const bytes = Buffer.from(JSON.stringify({ reasons: ['r'], denials: [{ code: 'C', message: 'r' }] }));
      expect(parsePolicyDenyDetails(bytes)).toEqual({ reasons: ['r'], denials: [{ code: 'C', message: 'r' }] });
    });

    it.each([
      ['empty bytes', Buffer.alloc(0)],
      ['undefined', undefined],
      ['malformed JSON', Buffer.from('{')],
      ['a JSON scalar', Buffer.from('42')],
      ['JSON null', Buffer.from('null')],
      ['neither field', Buffer.from('{"other":1}')],
      ['non-string reasons and non-object denials', Buffer.from('{"reasons":[1],"denials":["x"]}')]
    ])('returns undefined for %s', (_label, bytes) => {
      expect(parsePolicyDenyDetails(bytes)).toBeUndefined();
    });
  });
});
