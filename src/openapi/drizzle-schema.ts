import { getTableColumns, Table } from 'drizzle-orm';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/**
 * JSON Schema (OpenAPI 3.0) for the row a `db.select().from(table)` returns, read from the table's
 * column metadata. Keys are the TS field names, as in `typeof table.$inferSelect`. Every key is
 * present in a selected row, so all are required; a nullable column is `nullable: true`.
 * `jsonb` columns are untyped at runtime (`$type<>()` is compile-time only), so they map to `{}` (any JSON
 * value, null included).
 */
export function drizzleRowSchema(table: Table, description?: string): { schema: SchemaObject; problems: string[] } {
  const problems: string[] = [];
  const properties: Record<string, SchemaObject> = {};
  for (const [field, column] of Object.entries(getTableColumns(table))) {
    let schema: SchemaObject;
    switch (column.dataType) {
      case 'string':
        // timestamp(mode: 'string') passes Postgres's own text through (`2026-11-01 12:34:56.789+00`),
        // which is not RFC 3339, so no `format: date-time`.
        schema =
          column.columnType === 'PgTimestampString'
            ? { type: 'string', description: 'Postgres timestamptz text, e.g. `2026-11-01 12:34:56.789+00`.' }
            : { type: 'string' };
        if (column.columnType === 'PgUUID') schema.format = 'uuid';
        if (column.enumValues?.length) schema.enum = [...column.enumValues];
        break;
      case 'number':
        schema = { type: column.columnType === 'PgInteger' ? 'integer' : 'number' };
        break;
      case 'boolean':
        schema = { type: 'boolean' };
        break;
      case 'json':
        schema = {};
        break;
      default:
        problems.push(`${field}: unmapped drizzle dataType ${column.dataType} (${column.columnType})`);
        schema = {};
    }
    if (!column.notNull && schema.type) schema.nullable = true;
    properties[field] = schema;
  }
  return {
    schema: { type: 'object', ...(description ? { description } : {}), required: Object.keys(properties), properties },
    problems
  };
}
