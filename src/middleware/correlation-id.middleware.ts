import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Request, Response, NextFunction } from 'express';

export const correlationStorage = new AsyncLocalStorage<string>();

export const CORRELATION_HEADER = 'x-request-id';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = (req.headers[CORRELATION_HEADER] as string) || randomUUID();
    res.setHeader(CORRELATION_HEADER, requestId);
    (req as unknown as Record<string, unknown>).requestId = requestId;
    correlationStorage.run(requestId, () => next());
  }
}

export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}
