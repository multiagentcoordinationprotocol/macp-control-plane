import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { AppConfigService } from '../config/app-config.service';

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
      // No API keys configured — auth is disabled (development mode)
      this.logger.warn('No AUTH_API_KEYS configured; allowing request');
      return true;
    }

    if (!validTokens.includes(token)) {
      throw new UnauthorizedException('Invalid authorization token');
    }

    // Attach actor identity to request for downstream use
    request.actorId = token.slice(0, 8) + '...';
    request.actorType = 'api-key';

    return true;
  }
}
