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
