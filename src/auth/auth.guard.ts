import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { IS_PUBLIC_KEY } from './public.decorator';
import { AppConfigService } from '../config/app-config.service';

/**
 * Compares two secrets in constant time with crypto.timingSafeEqual. On a length mismatch it still
 * runs one comparison (of the expected key against itself) so the work done is the same; only the
 * key's length can leak, which reveals nothing useful about a high-entropy API key.
 */
function constantTimeEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfigService
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers?.authorization;

    if (!authHeader) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    // Support both "Bearer <token>" and raw API key
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    if (!token) {
      throw new UnauthorizedException('Empty authorization token');
    }

    const validTokens = this.config.authApiKeys;
    if (validTokens.length === 0) {
      // Auth may be switched off only when NODE_ENV is explicitly development/test (see
      // AppConfigService.authMayBeDisabled). Anywhere else an empty key list fails closed here, in
      // addition to the production fail-fast in AppConfigService.validate().
      if (!this.config.authMayBeDisabled) {
        this.logger.error('No AUTH_API_KEYS configured outside development/test; refusing request');
        throw new UnauthorizedException('Invalid authorization token');
      }
      this.logger.warn('No AUTH_API_KEYS configured; allowing request (development mode)');
      return true;
    }

    // Check every key (no early exit) so the time taken does not depend on which key matched.
    let matched = false;
    for (const candidate of validTokens) {
      if (constantTimeEquals(token, candidate)) matched = true;
    }
    if (!matched) {
      throw new UnauthorizedException('Invalid authorization token');
    }

    // Attach actor identity to request for downstream use
    request.actorId = token.slice(0, 8) + '...';
    request.actorType = 'api-key';

    return true;
  }
}
