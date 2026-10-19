import { macpErrorCodeOf } from '../runtime/grpc-helpers';

/** Back-off between WatchSessions / WatchSignals reconnects after an ordinary stream end. */
export const WATCH_RECONNECT_DELAY_MS = 5000;

/**
 * Reconnect policy shared by the two ambient watch consumers.
 *
 * A runtime >= v0.9.0 ends a watch stream with a coded `STREAM_LAGGED`
 * (RESOURCE_EXHAUSTED) when this consumer fell behind the runtime's broadcast
 * bus and events were dropped. Waiting out the normal back-off would only widen
 * the hole, so a lag reconnects immediately — but at most once per back-off
 * window: a lag within `WATCH_RECONNECT_DELAY_MS` of the previous immediate
 * reconnect takes the normal delay, so a consumer that is persistently too slow
 * cannot hot-loop against the runtime. Every other end (uncoded, transport,
 * auth) keeps the normal delay.
 */
export function watchReconnectDelay(
  error: unknown,
  lastImmediateReconnectAt: number | undefined,
  now: number
): { lagged: boolean; delayMs: number } {
  const lagged = macpErrorCodeOf(error) === 'STREAM_LAGGED';
  const immediateAllowed =
    lagged && (lastImmediateReconnectAt === undefined || now - lastImmediateReconnectAt >= WATCH_RECONNECT_DELAY_MS);
  return { lagged, delayMs: immediateAllowed ? 0 : WATCH_RECONNECT_DELAY_MS };
}
