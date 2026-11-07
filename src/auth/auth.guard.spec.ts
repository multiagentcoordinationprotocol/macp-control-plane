import { UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { IS_PUBLIC_KEY } from './public.decorator';
import { AppConfigService } from '../config/app-config.service';

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let mockReflector: { getAllAndOverride: jest.Mock };
  let mockConfig: { authApiKeys: string[]; authMayBeDisabled: boolean };
  let mockRequest: Record<string, any>;

  function createExecutionContext(request: Record<string, any>): ExecutionContext {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: jest.fn(),
        getNext: jest.fn()
      }),
      getArgs: jest.fn(),
      getArgByIndex: jest.fn(),
      switchToRpc: jest.fn(),
      switchToWs: jest.fn(),
      getType: jest.fn()
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    mockReflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false)
    };
    mockConfig = {
      authApiKeys: ['test-api-key-12345678'],
      authMayBeDisabled: true
    };
    mockRequest = {
      headers: {}
    };

    guard = new AuthGuard(mockReflector as unknown as Reflector, mockConfig as AppConfigService);
  });

  // =========================================================================
  // @Public() decorator
  // =========================================================================
  it('allows requests to @Public() endpoints', () => {
    mockReflector.getAllAndOverride.mockReturnValue(true);
    const context = createExecutionContext(mockRequest);

    const result = guard.canActivate(context);

    expect(result).toBe(true);
    expect(mockReflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
  });

  // =========================================================================
  // Missing Authorization header
  // =========================================================================
  it('throws UnauthorizedException when no Authorization header', () => {
    const context = createExecutionContext(mockRequest);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Missing Authorization header');
  });

  // =========================================================================
  // Empty token
  // =========================================================================
  it('throws UnauthorizedException when empty token', () => {
    mockRequest.headers.authorization = 'Bearer ';
    const context = createExecutionContext(mockRequest);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Empty authorization token');
  });

  // =========================================================================
  // Valid token matches configured API key
  // =========================================================================
  it('allows request when token matches configured API key', () => {
    mockRequest.headers.authorization = 'test-api-key-12345678';
    const context = createExecutionContext(mockRequest);

    const result = guard.canActivate(context);

    expect(result).toBe(true);
  });

  // =========================================================================
  // Invalid token
  // =========================================================================
  it('throws UnauthorizedException when token does not match', () => {
    mockRequest.headers.authorization = 'wrong-api-key';
    const context = createExecutionContext(mockRequest);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Invalid authorization token');
  });

  // =========================================================================
  // Auth disabled (no API keys configured)
  // =========================================================================
  it('allows all requests when no API keys are configured (auth disabled)', () => {
    mockConfig.authApiKeys = [];
    mockRequest.headers.authorization = 'any-token';
    const context = createExecutionContext(mockRequest);

    const result = guard.canActivate(context);

    expect(result).toBe(true);
  });

  it('refuses every request when no API keys are configured and auth may not be disabled', () => {
    mockConfig.authApiKeys = [];
    mockConfig.authMayBeDisabled = false;
    mockRequest.headers.authorization = 'any-token';
    const context = createExecutionContext(mockRequest);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  // =========================================================================
  // Constant-time comparison, multiple keys
  // =========================================================================
  it('accepts any of several configured keys', () => {
    mockConfig.authApiKeys = ['first-key-aaaaaaaa', 'second-key-bbbbbbbb'];
    mockRequest.headers.authorization = 'Bearer second-key-bbbbbbbb';

    expect(guard.canActivate(createExecutionContext(mockRequest))).toBe(true);
  });

  it('rejects a prefix or extension of a valid key', () => {
    for (const token of ['test-api-key-1234567', 'test-api-key-123456789', 'TEST-API-KEY-12345678']) {
      mockRequest.headers.authorization = `Bearer ${token}`;
      expect(() => guard.canActivate(createExecutionContext(mockRequest))).toThrow('Invalid authorization token');
    }
  });

  it('compares with crypto.timingSafeEqual against every configured key', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('node:crypto');
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    try {
      mockConfig.authApiKeys = ['first-key-aaaaaaaa', 'second-key-bbbbbbbb', 'third-key-cccccccc'];
      mockRequest.headers.authorization = 'Bearer first-key-aaaaaaaa';

      guard.canActivate(createExecutionContext(mockRequest));

      // No early exit on the first match: all three keys are compared.
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });

  // =========================================================================
  // Bearer token format
  // =========================================================================
  it('supports "Bearer <token>" format', () => {
    mockRequest.headers.authorization = 'Bearer test-api-key-12345678';
    const context = createExecutionContext(mockRequest);

    const result = guard.canActivate(context);

    expect(result).toBe(true);
  });

  // =========================================================================
  // Actor identity attachment
  // =========================================================================
  it('attaches actorId and actorType to request', () => {
    mockRequest.headers.authorization = 'test-api-key-12345678';
    const context = createExecutionContext(mockRequest);

    guard.canActivate(context);

    expect(mockRequest.actorId).toBe('test-api...');
    expect(mockRequest.actorType).toBe('api-key');
  });
});
