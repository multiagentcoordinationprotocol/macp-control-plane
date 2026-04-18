import * as grpc from '@grpc/grpc-js';
import { buildMetadata, fromAck, fromEnvelope, fromSessionMetadata, getClientMethod } from './grpc-helpers';

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
});
