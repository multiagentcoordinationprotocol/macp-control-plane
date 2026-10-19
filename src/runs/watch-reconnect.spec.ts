import * as grpc from '@grpc/grpc-js';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { WATCH_RECONNECT_DELAY_MS, watchReconnectDelay } from './watch-reconnect';

function coded(code: number, macpCode: string): Error {
  const metadata = new grpc.Metadata();
  metadata.set('macp-error-code', macpCode);
  return Object.assign(new Error(`${code} lagged`), { code, details: 'lagged', metadata });
}

describe('watchReconnectDelay', () => {
  const now = 1_000_000;

  it('reconnects immediately on the first coded STREAM_LAGGED', () => {
    expect(watchReconnectDelay(coded(8, 'STREAM_LAGGED'), undefined, now)).toEqual({ lagged: true, delayMs: 0 });
  });

  it('takes the normal delay for a second lag inside the back-off window (no hot loop)', () => {
    const last = now - (WATCH_RECONNECT_DELAY_MS - 1);
    expect(watchReconnectDelay(coded(8, 'STREAM_LAGGED'), last, now)).toEqual({
      lagged: true,
      delayMs: WATCH_RECONNECT_DELAY_MS
    });
  });

  it('allows another immediate reconnect once the window has passed', () => {
    const last = now - WATCH_RECONNECT_DELAY_MS;
    expect(watchReconnectDelay(coded(8, 'STREAM_LAGGED'), last, now)).toEqual({ lagged: true, delayMs: 0 });
  });

  it('reads the code off an AppException too', () => {
    const err = new AppException(ErrorCode.STREAM_LAGGED, 'lagged', 503, {
      macpErrorCode: 'STREAM_LAGGED',
      grpcCode: 8
    });
    expect(watchReconnectDelay(err, undefined, now).lagged).toBe(true);
  });

  it.each([
    ['an uncoded RESOURCE_EXHAUSTED (0.8.x lag)', Object.assign(new Error('8 RESOURCE_EXHAUSTED'), { code: 8 })],
    ['a coded RESOURCE_EXHAUSTED that is not a lag', coded(8, 'RATE_LIMITED')],
    ['a transport failure', Object.assign(new Error('14 UNAVAILABLE'), { code: 14 })],
    ['a plain error', new Error('boom')]
  ])('keeps the normal delay for %s', (_label, err) => {
    expect(watchReconnectDelay(err, undefined, now)).toEqual({ lagged: false, delayMs: WATCH_RECONNECT_DELAY_MS });
  });
});
