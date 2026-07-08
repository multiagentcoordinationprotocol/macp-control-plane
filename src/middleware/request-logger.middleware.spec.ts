import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { Request, Response } from 'express';
import { RequestLoggerMiddleware } from './request-logger.middleware';
import { InstrumentationService } from '../telemetry/instrumentation.service';

class FakeResponse extends EventEmitter {
  statusCode = 200;
}

describe('RequestLoggerMiddleware', () => {
  let middleware: RequestLoggerMiddleware;
  let mockInstrumentation: {
    httpRequestDuration: { observe: jest.Mock };
    httpRequestsTotal: { inc: jest.Mock };
  };
  let logSpy: jest.SpyInstance;

  function makeReq(overrides: Partial<Record<string, unknown>> = {}): Request {
    return {
      method: 'GET',
      originalUrl: '/runs',
      ...overrides
    } as unknown as Request;
  }

  beforeEach(() => {
    mockInstrumentation = {
      httpRequestDuration: { observe: jest.fn() },
      httpRequestsTotal: { inc: jest.fn() }
    };
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    middleware = new RequestLoggerMiddleware(mockInstrumentation as unknown as InstrumentationService);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('observes the histogram and increments the counter with method/path/status_code labels on finish', () => {
    const res = new FakeResponse();
    res.statusCode = 201;
    middleware.use(makeReq({ method: 'POST', originalUrl: '/runs' }), res as unknown as Response, jest.fn());

    expect(mockInstrumentation.httpRequestDuration.observe).not.toHaveBeenCalled();
    expect(mockInstrumentation.httpRequestsTotal.inc).not.toHaveBeenCalled();

    res.emit('finish');

    expect(mockInstrumentation.httpRequestDuration.observe).toHaveBeenCalledWith(
      { method: 'POST', path: '/runs', status_code: '201' },
      expect.any(Number)
    );
    expect(mockInstrumentation.httpRequestsTotal.inc).toHaveBeenCalledWith({
      method: 'POST',
      path: '/runs',
      status_code: '201'
    });
  });

  it('collapses UUID path segments to :id in metric labels', () => {
    const res = new FakeResponse();
    middleware.use(
      makeReq({ originalUrl: '/runs/a1a1a1a1-b2b2-c3c3-d4d4-e5e5e5e5e5e5/events' }),
      res as unknown as Response,
      jest.fn()
    );

    res.emit('finish');

    expect(mockInstrumentation.httpRequestsTotal.inc).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/runs/:id/events' })
    );
    expect(mockInstrumentation.httpRequestDuration.observe).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/runs/:id/events' }),
      expect.any(Number)
    );
  });

  it('strips the query string from the metric path', () => {
    const res = new FakeResponse();
    middleware.use(makeReq({ originalUrl: '/runs?limit=5&status=running' }), res as unknown as Response, jest.fn());

    res.emit('finish');

    expect(mockInstrumentation.httpRequestsTotal.inc).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/runs' })
    );
  });

  it('logs a JSON line including the requestId', () => {
    const res = new FakeResponse();
    res.statusCode = 404;
    middleware.use(
      makeReq({ method: 'GET', originalUrl: '/runs/missing', requestId: 'req-42' }),
      res as unknown as Response,
      jest.fn()
    );

    res.emit('finish');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(line).toEqual(
      expect.objectContaining({
        method: 'GET',
        path: '/runs/missing',
        statusCode: 404,
        requestId: 'req-42',
        durationMs: expect.any(Number)
      })
    );
  });

  it('falls back to "-" for requestId when none is attached', () => {
    const res = new FakeResponse();
    middleware.use(makeReq(), res as unknown as Response, jest.fn());

    res.emit('finish');

    const line = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(line.requestId).toBe('-');
  });

  it('always calls next()', () => {
    const res = new FakeResponse();
    const next = jest.fn();

    middleware.use(makeReq(), res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
