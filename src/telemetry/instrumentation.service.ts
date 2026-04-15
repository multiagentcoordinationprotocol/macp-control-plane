import { Injectable, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

@Injectable()
export class InstrumentationService implements OnModuleInit {
  readonly httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'path', 'status_code'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  });

  readonly httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'path', 'status_code'] as const
  });

  readonly activeSseConnections = new client.Gauge({
    name: 'active_sse_connections',
    help: 'Number of active SSE connections'
  });

  readonly activeStreams = new client.Gauge({
    name: 'active_runtime_streams',
    help: 'Number of active runtime gRPC streams'
  });

  readonly runStateTotal = new client.Counter({
    name: 'run_state_transitions_total',
    help: 'Total run state transitions',
    labelNames: ['status'] as const
  });

  readonly runDuration = new client.Histogram({
    name: 'macp_run_duration_seconds',
    help: 'End-to-end run duration in seconds (observed at terminal transition)',
    labelNames: ['terminal_status', 'mode_name'] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600]
  });

  readonly grpcCallDuration = new client.Histogram({
    name: 'grpc_call_duration_seconds',
    help: 'Duration of gRPC calls to runtime in seconds',
    labelNames: ['method', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30]
  });

  readonly circuitBreakerState = new client.Gauge({
    name: 'circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 1=half_open, 2=open)'
  });

  readonly circuitBreakerFailuresTotal = new client.Counter({
    name: 'macp_circuit_breaker_failures_total',
    help: 'Total circuit breaker failure count'
  });

  readonly circuitBreakerSuccessTotal = new client.Counter({
    name: 'macp_circuit_breaker_success_total',
    help: 'Total circuit breaker success count'
  });

  readonly outboundMessagesTotal = new client.Counter({
    name: 'macp_outbound_messages_total',
    help: 'Total outbound messages by category and status',
    labelNames: ['category', 'status'] as const
  });

  readonly inboundMessagesTotal = new client.Counter({
    name: 'macp_inbound_messages_total',
    help: 'Total inbound messages by mode and message type',
    labelNames: ['mode', 'message_type'] as const
  });

  readonly signalsTotal = new client.Counter({
    name: 'macp_signals_total',
    help: 'Total signals by signal type',
    labelNames: ['signal_type'] as const
  });

  readonly streamReconnectsTotal = new client.Counter({
    name: 'macp_stream_reconnects_total',
    help: 'Total stream reconnection attempts'
  });

  readonly recoveryTotal = new client.Counter({
    name: 'macp_recovery_total',
    help: 'Total recovery attempts by status',
    labelNames: ['status'] as const
  });

  readonly webhookDeliveriesTotal = new client.Counter({
    name: 'macp_webhook_deliveries_total',
    help: 'Total webhook deliveries by status',
    labelNames: ['status'] as const
  });

  onModuleInit(): void {
    client.collectDefaultMetrics();
  }

  async getMetrics(): Promise<string> {
    return client.register.metrics();
  }

  getContentType(): string {
    return client.register.contentType;
  }
}
