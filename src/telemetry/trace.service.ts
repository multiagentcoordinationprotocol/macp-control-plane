import { Injectable } from '@nestjs/common';
import { Span, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { MACP_CP_ATTR, SpanAttributeValue, withLegacyAttributes } from './semconv';

type Attributes = Record<string, SpanAttributeValue | undefined>;

function setAll(span: Span, attributes: Record<string, SpanAttributeValue>): void {
  for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value);
}

@Injectable()
export class TraceService {
  private readonly tracer = trace.getTracer('macp-control-plane');
  private readonly runSpans = new Map<string, Span>();

  async withSpan<T>(name: string, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
    const span = this.tracer.startSpan(name);
    setAll(span, withLegacyAttributes(attributes));

    try {
      return await context.with(trace.setSpan(context.active(), span), fn);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Create a child span parented to the stored `run.lifecycle` span for `runId`,
   * so operations that happen outside the span's active context (event loop
   * callbacks, async queue consumers, gRPC stream handlers) still link back to
   * the run trace. Falls back to {@link withSpan} if the run span has been
   * ended or is unknown.
   */
  async withRunSpan<T>(runId: string, name: string, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
    const parent = this.runSpans.get(runId);
    if (!parent) return this.withSpan(name, { [MACP_CP_ATTR.RUN_ID]: runId, ...attributes }, fn);

    const parentContext = trace.setSpan(context.active(), parent);
    const span = this.tracer.startSpan(name, undefined, parentContext);
    setAll(span, withLegacyAttributes({ [MACP_CP_ATTR.RUN_ID]: runId, ...attributes }));

    try {
      return await context.with(trace.setSpan(parentContext, span), fn);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  }

  /** Add a span event (timestamped annotation) to the active run span, if any. */
  addRunSpanEvent(
    runId: string,
    name: string,
    attributes?: Record<string, string | number | boolean | undefined>
  ): void {
    const span = this.runSpans.get(runId);
    if (!span) return;
    const clean: Record<string, string | number | boolean> = {};
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) {
        if (v !== undefined) clean[k] = v;
      }
    }
    span.addEvent(name, clean);
  }

  /** Return the active trace/span IDs for a run (for stamping canonical events). */
  getRunTraceContext(runId: string): { traceId: string; spanId: string } | undefined {
    const span = this.runSpans.get(runId);
    if (!span) return undefined;
    const ctx = span.spanContext();
    return { traceId: ctx.traceId, spanId: ctx.spanId };
  }

  startRunTrace(runId: string, attributes: Attributes): string {
    const span = this.tracer.startSpan('run.lifecycle');
    setAll(span, withLegacyAttributes({ [MACP_CP_ATTR.RUN_ID]: runId, ...attributes }));
    const traceId = span.spanContext().traceId;
    // Keep span alive — end it when run reaches terminal state
    this.runSpans.set(runId, span);
    return traceId;
  }

  endRunTrace(runId: string, status: 'completed' | 'failed' | 'cancelled', error?: string): void {
    const span = this.runSpans.get(runId);
    if (!span) return;
    this.runSpans.delete(runId);

    setAll(span, withLegacyAttributes({ [MACP_CP_ATTR.RUN_TERMINAL_STATUS]: status }));
    if (status === 'failed') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error ?? 'run failed' });
      if (error) span.recordException(new Error(error));
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
  }
}
