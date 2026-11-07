import { ExecutionContext } from '@nestjs/common';
import { ThrottleByUserGuard } from './throttle-by-user.guard';

describe('ThrottleByUserGuard', () => {
  let guard: ThrottleByUserGuard;

  beforeEach(() => {
    // ThrottlerGuard requires constructor args, but we only test overridden methods
    // so we create the instance via Object.create to bypass the constructor
    guard = Object.create(ThrottleByUserGuard.prototype);
  });

  // ===========================================================================
  // getTracker
  // ===========================================================================
  describe('getTracker', () => {
    it('returns actorId when present', async () => {
      const req = { actorId: 'user-42', ip: '10.0.0.1' };

      const result = await (guard as any).getTracker(req);

      expect(result).toBe('user-42');
    });

    it('falls back to ip when actorId is absent', async () => {
      const req = { ip: '10.0.0.1' };

      const result = await (guard as any).getTracker(req);

      expect(result).toBe('10.0.0.1');
    });

    it('falls back to "anonymous" when both actorId and ip are absent', async () => {
      const req = {};

      const result = await (guard as any).getTracker(req);

      expect(result).toBe('anonymous');
    });

    it('returns actorId even when it is a number', async () => {
      const req = { actorId: 123, ip: '10.0.0.1' };

      const result = await (guard as any).getTracker(req);

      expect(result).toBe('123');
    });

    it('falls back to ip when actorId is null', async () => {
      const req = { actorId: null, ip: '192.168.1.1' };

      const result = await (guard as any).getTracker(req);

      expect(result).toBe('192.168.1.1');
    });

    it('keys an authenticated request on actorId plus the forwarded client IP', async () => {
      const req = { actorId: 'console-...', ip: '10.0.0.1', headers: { 'x-macp-client-ip': '203.0.113.7' } };

      expect(await (guard as any).getTracker(req)).toBe('console-...|203.0.113.7');
    });

    it('accepts an IPv6 forwarded client IP', async () => {
      const req = { actorId: 'k', headers: { 'x-macp-client-ip': '2001:db8::1' } };

      expect(await (guard as any).getTracker(req)).toBe('k|2001:db8::1');
    });

    it('ignores the client-IP header on an unauthenticated request', async () => {
      const req = { ip: '10.0.0.1', headers: { 'x-macp-client-ip': '203.0.113.7' } };

      expect(await (guard as any).getTracker(req)).toBe('10.0.0.1');
    });

    it('ignores a client-IP header that is not an IP literal', async () => {
      const req = { actorId: 'k', headers: { 'x-macp-client-ip': 'evil|bucket' } };

      expect(await (guard as any).getTracker(req)).toBe('k');
    });

    it('falls back to ip when actorId is undefined', async () => {
      const req = { actorId: undefined, ip: '172.16.0.1' };

      const result = await (guard as any).getTracker(req);

      expect(result).toBe('172.16.0.1');
    });
  });

  // ===========================================================================
  // getRequestResponse
  // ===========================================================================
  describe('getRequestResponse', () => {
    it('extracts req and res from ExecutionContext', () => {
      const mockReq = { url: '/runs' };
      const mockRes = { statusCode: 200 };
      const context = {
        switchToHttp: () => ({
          getRequest: () => mockReq,
          getResponse: () => mockRes
        })
      } as unknown as ExecutionContext;

      const result = (guard as any).getRequestResponse(context);

      expect(result).toEqual({ req: mockReq, res: mockRes });
    });
  });
});
