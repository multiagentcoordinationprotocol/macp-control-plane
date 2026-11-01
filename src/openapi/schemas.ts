/**
 * Names and small helpers for the OpenAPI components the controllers reference (#112).
 *
 * Controllers point at components by `$ref` through `ref()`, so a misspelt name is a compile error.
 * The schemas behind the names come from three places, assembled by `build-document.ts`:
 *
 * - `GENERATED_TYPES`: TS interfaces turned into JSON Schema by ts-json-schema-generator at export time.
 * - `ROW_TABLES`: Drizzle tables, turned into the row shape `select()` returns (`drizzle-schema.ts`).
 * - `LITERAL_COMPONENTS` below: response shapes that exist only as an object literal inside a handler
 *   or service, so there is no named type to derive them from. Keep each one next to the code it
 *   describes in mind when that code changes; the drift check catches only the routes, not these.
 *
 * This file is imported by controllers at runtime, so it must stay free of build-time dependencies.
 */
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/** Interfaces exported from these files, by name, become components of the same name. */
export const GENERATED_TYPES = {
  'src/contracts/control-plane.ts': ['RunStateProjection', 'CanonicalEvent', 'Artifact', 'TraceSummary'],
  'src/verification/commitment-verification.service.ts': ['RunVerification'],
  'src/what-if/what-if-replay.service.ts': ['WhatIfReplayView'],
  'src/receipts/decision-receipt.service.ts': ['DecisionReceiptView'],
  'src/runtime/circuit-breaker.ts': ['CircuitBreakerStateChange'],
  'src/contracts/runtime.ts': ['RuntimeSessionSnapshot']
} as const;

/** Component name -> exported Drizzle table in `src/db/schema.ts`. */
export const ROW_TABLES = {
  RunRecord: 'runs',
  CanonicalEventRecord: 'runEventsCanonical',
  ArtifactRecord: 'runArtifacts',
  AuditLogRecord: 'auditLog',
  OutboundMessageRecord: 'runOutboundMessages',
  WebhookRecord: 'webhooks'
} as const;

const str: SchemaObject = { type: 'string' };
const int: SchemaObject = { type: 'integer' };
const bool: SchemaObject = { type: 'boolean' };
const obj: SchemaObject = { type: 'object', additionalProperties: true };
const strings: SchemaObject = { type: 'array', items: str };

const batchResult = (done: string): SchemaObject => ({
  type: 'array',
  items: {
    type: 'object',
    required: ['runId', 'status'],
    properties: {
      runId: str,
      status: { type: 'string', enum: [done, 'failed'] },
      error: { ...str, description: 'Present when status is failed.' }
    }
  }
});

export const LITERAL_COMPONENTS = {
  ErrorResponse: {
    type: 'object',
    description:
      'Every error body (GlobalExceptionFilter). `errorCode` is set by control-plane errors and absent on ' +
      'Nest built-in errors, which carry `error` instead; `message` is a list for request-validation failures.',
    required: ['statusCode', 'message'],
    properties: {
      statusCode: int,
      errorCode: { type: 'string', description: 'One of the ErrorCode values (filled in at export).' },
      message: { oneOf: [str, strings] },
      error: { ...str, description: 'HTTP reason phrase, on Nest built-in errors.' },
      metadata: obj
    }
  },
  ReasonRequest: { type: 'object', properties: { reason: str } },
  RunIdsRequest: { type: 'object', required: ['runIds'], properties: { runIds: strings } },
  PolicyRegistrationRequest: {
    type: 'object',
    required: ['policyId', 'mode', 'rules'],
    properties: {
      policyId: str,
      mode: str,
      description: str,
      rules: { ...obj, description: 'RFC-MACP-0012 per-mode rules object.' },
      schemaVersion: { ...int, description: 'Defaults to 3 (fail-closed).' }
    }
  },
  RunValidationResult: {
    type: 'object',
    required: ['valid', 'errors', 'warnings', 'runtime'],
    properties: {
      valid: bool,
      errors: strings,
      warnings: strings,
      runtime: {
        type: 'object',
        required: ['reachable', 'supportedModes'],
        properties: { reachable: bool, supportedModes: strings, capabilities: obj }
      }
    }
  },
  RunRecordPage: {
    type: 'object',
    required: ['data', 'total', 'limit', 'offset'],
    properties: {
      data: { type: 'array', items: { $ref: '#/components/schemas/RunRecord' } },
      total: int,
      limit: int,
      offset: int
    }
  },
  AuditLogPage: {
    type: 'object',
    required: ['data', 'total'],
    properties: { data: { type: 'array', items: { $ref: '#/components/schemas/AuditLogRecord' } }, total: int }
  },
  CanonicalEventRecordCursorPage: {
    type: 'object',
    required: ['data', 'total', 'limit'],
    properties: {
      data: { type: 'array', items: { $ref: '#/components/schemas/CanonicalEventRecord' } },
      total: int,
      limit: int,
      nextCursor: {
        ...int,
        description:
          'seq of the last event returned, to pass as afterSeq. It can be present on the last page; stop when `data` is empty.'
      }
    }
  },
  RunTraceSummary: {
    allOf: [
      { $ref: '#/components/schemas/TraceSummary' },
      { type: 'object', required: ['runStatus'], properties: { runStatus: str, scenarioRef: str } }
    ]
  },
  BatchCancelResult: batchResult('cancelled'),
  BatchArchiveResult: batchResult('archived'),
  BatchDeleteResult: batchResult('deleted'),
  RuntimeCapabilitiesResult: {
    type: 'object',
    required: ['supportedModes', 'capabilities'],
    properties: { runtimeInfo: obj, selectedProtocolVersion: str, supportedModes: strings, capabilities: obj }
  },
  AgentMetrics: {
    type: 'array',
    items: {
      type: 'object',
      required: ['participantId', 'runs', 'signals', 'messages', 'averageConfidence'],
      properties: {
        participantId: str,
        runs: int,
        signals: int,
        messages: int,
        averageConfidence: { type: 'number' }
      }
    }
  },
  Liveness: {
    type: 'object',
    required: ['ok', 'service'],
    properties: { ok: bool, service: { type: 'string', enum: ['macp-control-plane'] } }
  },
  Readiness: {
    type: 'object',
    required: ['ok', 'database', 'runtime', 'streamConsumer', 'circuitBreaker'],
    properties: {
      ok: bool,
      database: { type: 'string', enum: ['ok', 'unhealthy'] },
      runtime: { $ref: '#/components/schemas/RuntimeHealthResponseDto' },
      streamConsumer: { type: 'string', enum: ['ok', 'unhealthy'] },
      circuitBreaker: { type: 'string', enum: ['CLOSED', 'OPEN', 'HALF_OPEN'] }
    }
  },
  CircuitBreakerReset: {
    type: 'object',
    required: ['status', 'state'],
    properties: { status: { type: 'string', enum: ['ok'] }, state: { type: 'string', enum: ['CLOSED'] } }
  },
  CircuitBreakerHistory: {
    type: 'object',
    required: ['state', 'history'],
    properties: {
      state: { type: 'string', enum: ['CLOSED', 'OPEN', 'HALF_OPEN'] },
      history: { type: 'array', items: { $ref: '#/components/schemas/CircuitBreakerStateChange' } }
    }
  },
  RuntimeSessionDrift: {
    type: 'object',
    required: [
      'complete',
      'runtimeSessionCount',
      'liveRuntimeSessionCount',
      'trackedRunCount',
      'untrackedSessions',
      'missingFromRuntime'
    ],
    properties: {
      complete: bool,
      runtimeSessionCount: int,
      liveRuntimeSessionCount: int,
      trackedRunCount: int,
      untrackedSessions: { type: 'array', items: { $ref: '#/components/schemas/RuntimeSessionSnapshot' } },
      missingFromRuntime: {
        type: 'array',
        nullable: true,
        description: 'null when the runtime session list was truncated (not computed).',
        items: {
          type: 'object',
          required: ['runId', 'runtimeSessionId'],
          properties: { runId: str, runtimeSessionId: str }
        }
      }
    }
  },
  StreamComplete: { type: 'object', required: ['runId'], properties: { runId: str } },
  Heartbeat: { type: 'object', required: ['ts'], properties: { ts: { type: 'string', format: 'date-time' } } }
} satisfies Record<string, SchemaObject>;

export type ComponentName =
  | (typeof GENERATED_TYPES)[keyof typeof GENERATED_TYPES][number]
  | keyof typeof ROW_TABLES
  | keyof typeof LITERAL_COMPONENTS;

/** `{ $ref }` to a component assembled at export time. Use for `schema:` in swagger decorators. */
export function ref(name: ComponentName): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

export function arrayOf(name: ComponentName): SchemaObject {
  return { type: 'array', items: ref(name) };
}

/** Event name -> data schema, recorded on SSE operations as `x-macp-sse-events`. */
export const SSE_EVENTS_EXTENSION = 'x-macp-sse-events';
