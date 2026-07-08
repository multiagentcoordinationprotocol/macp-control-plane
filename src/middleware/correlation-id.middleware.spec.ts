import { Request, Response } from 'express';
import { CorrelationIdMiddleware, CORRELATION_HEADER, getCorrelationId } from './correlation-id.middleware';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('CorrelationIdMiddleware', () => {
  let middleware: CorrelationIdMiddleware;
  let mockRes: { setHeader: jest.Mock };

  function makeReq(headers: Record<string, string> = {}): Request {
    return { headers } as unknown as Request;
  }

  beforeEach(() => {
    middleware = new CorrelationIdMiddleware();
    mockRes = { setHeader: jest.fn() };
  });

  it('echoes an incoming x-request-id on the response header', () => {
    const req = makeReq({ [CORRELATION_HEADER]: 'incoming-id-123' });

    middleware.use(req, mockRes as unknown as Response, jest.fn());

    expect(mockRes.setHeader).toHaveBeenCalledWith(CORRELATION_HEADER, 'incoming-id-123');
  });

  it('generates a UUID when no x-request-id header is present', () => {
    const req = makeReq();

    middleware.use(req, mockRes as unknown as Response, jest.fn());

    expect(mockRes.setHeader).toHaveBeenCalledTimes(1);
    const [header, value] = mockRes.setHeader.mock.calls[0];
    expect(header).toBe(CORRELATION_HEADER);
    expect(value).toMatch(UUID_REGEX);
  });

  it('attaches requestId to the request object', () => {
    const req = makeReq({ [CORRELATION_HEADER]: 'attached-id' });

    middleware.use(req, mockRes as unknown as Response, jest.fn());

    expect((req as unknown as Record<string, unknown>).requestId).toBe('attached-id');
  });

  it('makes getCorrelationId() return the id inside next() and undefined outside', () => {
    const req = makeReq({ [CORRELATION_HEADER]: 'ctx-id' });
    let insideNext: string | undefined;
    const next = jest.fn(() => {
      insideNext = getCorrelationId();
    });

    expect(getCorrelationId()).toBeUndefined();

    middleware.use(req, mockRes as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(insideNext).toBe('ctx-id');
    // Outside the AsyncLocalStorage.run scope the store is gone again
    expect(getCorrelationId()).toBeUndefined();
  });
});
