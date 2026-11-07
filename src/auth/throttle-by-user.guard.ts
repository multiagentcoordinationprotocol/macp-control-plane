import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Header a trusted, authenticated front end (the hosted ui-console proxy) sets to the end user's
 * IP. It is honoured only on requests that already passed AuthGuard (an API-key holder), so an
 * anonymous client cannot use it to pick its own bucket.
 */
export const CLIENT_IP_HEADER = 'x-macp-client-ip';

/** Plausible IPv4/IPv6 literal; anything else is ignored rather than used as a bucket key. */
const IP_LITERAL = /^[0-9A-Fa-f:.]{2,45}$/;

function forwardedClientIp(req: Record<string, unknown>): string | undefined {
  const headers = req.headers as Record<string, string | string[] | undefined> | undefined;
  const raw = headers?.[CLIENT_IP_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && IP_LITERAL.test(value) ? value : undefined;
}

@Injectable()
export class ThrottleByUserGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    // Authenticated: bucket per API key, and per end-user IP when the key holder forwards one, so a
    // single visitor behind a shared front-end key cannot exhaust the quota for every visitor.
    if (req.actorId !== undefined && req.actorId !== null) {
      const clientIp = forwardedClientIp(req);
      return clientIp ? `${String(req.actorId)}|${clientIp}` : String(req.actorId);
    }
    return String(req.ip ?? 'anonymous');
  }

  protected getRequestResponse(context: ExecutionContext) {
    const ctx = context.switchToHttp();
    return { req: ctx.getRequest(), res: ctx.getResponse() };
  }
}
