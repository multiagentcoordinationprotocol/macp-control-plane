import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey(),
    status: varchar('status', { length: 32 }).notNull(),
    mode: varchar('mode', { length: 16 }).notNull(),
    runtimeKind: varchar('runtime_kind', { length: 64 }).notNull(),
    runtimeVersion: varchar('runtime_version', { length: 64 }),
    runtimeSessionId: varchar('runtime_session_id', { length: 255 }),
    traceId: varchar('trace_id', { length: 255 }),
    idempotencyKey: varchar('idempotency_key', { length: 255 }),
    lastEventSeq: integer('last_event_seq').notNull().default(0),
    sourceKind: varchar('source_kind', { length: 128 }),
    sourceRef: text('source_ref'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    errorCode: varchar('error_code', { length: 128 }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' })
  },
  (table) => ({
    runtimeSessionIdx: uniqueIndex('runs_runtime_session_id_unique').on(table.runtimeSessionId),
    idempotencyIdx: uniqueIndex('runs_idempotency_key_unique').on(table.idempotencyKey),
    statusIdx: index('runs_status_idx').on(table.status),
    createdIdx: index('runs_created_at_idx').on(table.createdAt),
    modeIdx: index('runs_mode_idx').on(table.mode)
  })
);

export const runtimeSessions = pgTable(
  'runtime_sessions',
  {
    runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    runtimeKind: varchar('runtime_kind', { length: 64 }).notNull(),
    runtimeSessionId: varchar('runtime_session_id', { length: 255 }).notNull(),
    modeName: varchar('mode_name', { length: 255 }).notNull(),
    modeVersion: varchar('mode_version', { length: 64 }),
    configurationVersion: varchar('configuration_version', { length: 128 }),
    policyVersion: varchar('policy_version', { length: 128 }),
    initiatorParticipantId: varchar('initiator_participant_id', { length: 255 }),
    sessionState: varchar('session_state', { length: 64 }).notNull().default('SESSION_STATE_UNSPECIFIED'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }),
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>().notNull().default({}),
    lastStreamCursor: integer('last_stream_cursor'),
    streamConnectedAt: timestamp('stream_connected_at', { withTimezone: true, mode: 'string' }),
    streamDisconnectedAt: timestamp('stream_disconnected_at', { withTimezone: true, mode: 'string' }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.runId] }),
    sessionIdIdx: uniqueIndex('runtime_sessions_runtime_session_id_unique').on(table.runtimeSessionId),
    initiatorIdx: index('runtime_sessions_initiator_idx').on(table.initiatorParticipantId)
  })
);

export const runEventsRaw = pgTable(
  'run_events_raw',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    ts: timestamp('ts', { withTimezone: true, mode: 'string' }).notNull(),
    kind: varchar('kind', { length: 64 }).notNull(),
    sourceName: varchar('source_name', { length: 128 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    traceId: varchar('trace_id', { length: 255 }),
    spanId: varchar('span_id', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow()
  },
  (table) => ({
    runSeqIdx: uniqueIndex('run_events_raw_run_seq_unique').on(table.runId, table.seq),
    runIdx: index('run_events_raw_run_idx').on(table.runId)
  })
);

export const runEventsCanonical = pgTable(
  'run_events_canonical',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    ts: timestamp('ts', { withTimezone: true, mode: 'string' }).notNull(),
    type: varchar('type', { length: 128 }).notNull(),
    subjectKind: varchar('subject_kind', { length: 64 }),
    subjectId: varchar('subject_id', { length: 255 }),
    sourceKind: varchar('source_kind', { length: 64 }).notNull(),
    sourceName: varchar('source_name', { length: 128 }).notNull(),
    rawType: varchar('raw_type', { length: 128 }),
    traceId: varchar('trace_id', { length: 255 }),
    spanId: varchar('span_id', { length: 255 }),
    parentSpanId: varchar('parent_span_id', { length: 255 }),
    schemaVersion: integer('schema_version').notNull().default(3),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow()
  },
  (table) => ({
    runSeqIdx: uniqueIndex('run_events_canonical_run_seq_unique').on(table.runId, table.seq),
    runIdx: index('run_events_canonical_run_idx').on(table.runId),
    typeIdx: index('run_events_canonical_type_idx').on(table.type),
    runCreatedIdx: index('run_events_canonical_run_created_idx').on(table.runId, table.createdAt)
  })
);

export const runProjections = pgTable(
  'run_projections',
  {
    runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(0),
    schemaVersion: integer('schema_version').notNull().default(1),
    runSummary: jsonb('run_summary').$type<Record<string, unknown>>().notNull().default({}),
    participants: jsonb('participants').$type<Record<string, unknown>[]>().notNull().default([]),
    graph: jsonb('graph').$type<Record<string, unknown>>().notNull().default({ nodes: [], edges: [] }),
    decision: jsonb('decision').$type<Record<string, unknown>>().notNull().default({}),
    signals: jsonb('signals').$type<Record<string, unknown>>().notNull().default({ signals: [] }),
    timeline: jsonb('timeline').$type<Record<string, unknown>>().notNull().default({ latestSeq: 0, totalEvents: 0, recent: [] }),
    traceSummary: jsonb('trace_summary').$type<Record<string, unknown>>().notNull().default({ spanCount: 0, linkedArtifacts: [] }),
    progress: jsonb('progress').$type<Record<string, unknown>>().notNull().default({ entries: [] }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.runId] })
  })
);

export const runArtifacts = pgTable(
  'run_artifacts',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 64 }).notNull(),
    label: varchar('label', { length: 255 }).notNull(),
    uri: text('uri'),
    inline: jsonb('inline').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow()
  },
  (table) => ({
    runIdx: index('run_artifacts_run_idx').on(table.runId),
    kindIdx: index('run_artifacts_kind_idx').on(table.kind)
  })
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    actor: varchar('actor', { length: 255 }).notNull(),
    actorType: varchar('actor_type', { length: 64 }).notNull(),
    action: varchar('action', { length: 128 }).notNull(),
    resource: varchar('resource', { length: 128 }).notNull(),
    resourceId: varchar('resource_id', { length: 255 }),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    requestId: varchar('request_id', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow()
  },
  (table) => ({
    actorIdx: index('audit_log_actor_idx').on(table.actor),
    actionIdx: index('audit_log_action_idx').on(table.action),
    resourceIdx: index('audit_log_resource_idx').on(table.resource),
    createdIdx: index('audit_log_created_at_idx').on(table.createdAt)
  })
);

export const runMetrics = pgTable(
  'run_metrics',
  {
    runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    eventCount: integer('event_count').notNull().default(0),
    messageCount: integer('message_count').notNull().default(0),
    signalCount: integer('signal_count').notNull().default(0),
    proposalCount: integer('proposal_count').notNull().default(0),
    toolCallCount: integer('tool_call_count').notNull().default(0),
    decisionCount: integer('decision_count').notNull().default(0),
    streamReconnectCount: integer('stream_reconnect_count').notNull().default(0),
    firstEventAt: timestamp('first_event_at', { withTimezone: true, mode: 'string' }),
    lastEventAt: timestamp('last_event_at', { withTimezone: true, mode: 'string' }),
    durationMs: integer('duration_ms'),
    sessionState: varchar('session_state', { length: 64 }),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    estimatedCostUsd: text('estimated_cost_usd').notNull().default('0'),
    counters: jsonb('counters').$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.runId] })
  })
);

export const runOutboundMessages = pgTable(
  'run_outbound_messages',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    runtimeSessionId: varchar('runtime_session_id', { length: 255 }).notNull(),
    messageId: varchar('message_id', { length: 255 }).notNull(),
    messageType: varchar('message_type', { length: 128 }).notNull(),
    category: varchar('category', { length: 32 }).notNull(),
    sender: varchar('sender', { length: 255 }).notNull(),
    recipients: jsonb('recipients').$type<string[]>().notNull().default([]),
    status: varchar('status', { length: 32 }).notNull().default('queued'),
    payloadDescriptor: jsonb('payload_descriptor').$type<Record<string, unknown>>().notNull().default({}),
    ack: jsonb('ack').$type<Record<string, unknown>>(),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'string' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow()
  },
  (table) => ({
    messageIdIdx: uniqueIndex('run_outbound_messages_message_id_unique').on(table.messageId),
    runIdx: index('run_outbound_messages_run_idx').on(table.runId),
    statusIdx: index('run_outbound_messages_status_idx').on(table.status)
  })
);

export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey(),
    url: text('url').notNull(),
    events: jsonb('events').$type<string[]>().notNull().default([]),
    secret: varchar('secret', { length: 255 }).notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow()
  },
  (table) => ({
    activeIdx: index('webhooks_active_idx').on(table.active)
  })
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    webhookId: uuid('webhook_id').notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
    event: varchar('event', { length: 128 }).notNull(),
    runId: uuid('run_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'string' }),
    responseStatus: integer('response_status'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'string' })
  },
  (table) => ({
    webhookIdx: index('webhook_deliveries_webhook_idx').on(table.webhookId),
    statusIdx: index('webhook_deliveries_status_idx').on(table.status),
    runIdx: index('webhook_deliveries_run_idx').on(table.runId)
  })
);
