/**
 * Build-time OpenAPI document for the control plane (#112). Used by `scripts/openapi-export.ts` and the
 * specs, never by the running service: it pulls in ts-json-schema-generator (a devDependency) and is
 * excluded from `tsconfig.build.json`. The running service serves the committed file instead
 * (`serve-docs.ts`).
 *
 * Nothing here throws on a content problem: it returns `problems`, and the caller decides (the export
 * script exits non-zero). The CI conventions job bans raw Error throws under `src/`.
 */
import { INestApplication, RequestMethod, Type } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import type {
  OperationObject,
  PathItemObject,
  SchemaObject
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { join, posix } from 'path';
import { createGenerator } from 'ts-json-schema-generator';
import { AppModule } from '../app.module';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import * as dbSchema from '../db/schema';
import { ErrorCode } from '../errors/error-codes';
import { drizzleRowSchema } from './drizzle-schema';
import { GENERATED_TYPES, LITERAL_COMPONENTS, ROW_TABLES } from './schemas';

export const OPENAPI_TITLE = 'MACP Control Plane';
export const OPENAPI_DESCRIPTION =
  'Scenario-agnostic execution and observability plane for the MACP runtime. Generated from the NestJS ' +
  'controllers by `npm run openapi:export`; do not edit by hand.';
export const BEARER_SCHEME = 'bearer';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export interface ControllerRoute {
  /** Upper-case HTTP method, `GET` for `@Sse`. */
  method: string;
  /** OpenAPI path template, e.g. `/runs/{id}/stream`. */
  path: string;
  controller: string;
  handler: string;
  public: boolean;
  /** `@HttpCode` value, else Nest's default (201 for POST, 200 otherwise). */
  status: number;
}

/** Controllers registered by `AppModule` and every module it imports. */
export function appControllers(root: unknown = AppModule): Type[] {
  const out: Type[] = [];
  const seen = new Set<unknown>();
  const visit = (mod: unknown) => {
    if (!mod || seen.has(mod)) return;
    seen.add(mod);
    const dynamic =
      typeof mod === 'object' ? (mod as { module?: unknown; controllers?: Type[]; imports?: unknown[] }) : undefined;
    const target = dynamic?.module ?? mod;
    const controllers = [
      ...((Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, target as object) as Type[] | undefined) ?? []),
      ...(dynamic?.controllers ?? [])
    ];
    for (const c of controllers) if (!out.includes(c)) out.push(c);
    const imports = [
      ...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, target as object) as unknown[] | undefined) ?? []),
      ...(dynamic?.imports ?? [])
    ];
    imports.forEach(visit);
  };
  visit(root);
  return out;
}

/** Every route the given controllers declare, read from the same metadata Nest's router uses. */
export function controllerRoutes(controllers: Type[]): ControllerRoute[] {
  const routes: ControllerRoute[] = [];
  for (const ctrl of controllers) {
    const bases = [Reflect.getMetadata(PATH_METADATA, ctrl) as string | string[]].flat();
    const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, ctrl) === true;
    const proto = ctrl.prototype as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(proto)) {
      const handler = proto[key];
      if (typeof handler !== 'function' || !Reflect.hasMetadata(METHOD_METADATA, handler)) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      const paths = [Reflect.getMetadata(PATH_METADATA, handler) as string | string[]].flat();
      const code = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined;
      for (const base of bases) {
        for (const sub of paths) {
          const joined = [base, sub]
            .map((p) => (p ?? '').replace(/^\/|\/$/g, ''))
            .filter(Boolean)
            .join('/');
          routes.push({
            method,
            path: `/${joined}`.replace(/:(\w+)/g, '{$1}'),
            controller: ctrl.name,
            handler: key,
            public: classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true,
            status: code ?? (method === 'POST' ? 201 : 200)
          });
        }
      }
    }
  }
  return routes;
}

/** Swagger is a draft-07 producer; OpenAPI 3.0 has `nullable` instead of `null` types and no `const`. */
export function toOpenApi30(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toOpenApi30);
  if (!node || typeof node !== 'object') return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === '$schema' || k === 'definitions') continue;
    if (k === '$ref' && typeof v === 'string') {
      out.$ref = decodeURIComponent(v).replace('#/definitions/', '#/components/schemas/');
      continue;
    }
    out[k] = toOpenApi30(v);
  }
  if ('const' in out) {
    out.enum = [out.const];
    delete out.const;
  }
  if (Array.isArray(out.type)) {
    const types = (out.type as string[]).filter((t) => t !== 'null');
    if (types.length < (out.type as string[]).length) out.nullable = true;
    if (types.length === 1) out.type = types[0];
    else {
      delete out.type;
      out.anyOf = types.map((t) => ({ type: t }));
    }
  }
  if (Array.isArray(out.enum) && out.enum.includes(null)) {
    out.enum = out.enum.filter((e) => e !== null);
    out.nullable = true;
  }
  for (const combinator of ['anyOf', 'oneOf'] as const) {
    const members = out[combinator] as Record<string, unknown>[] | undefined;
    if (!members) continue;
    const nonNull = members.filter((m) => !(m.type === 'null' && Object.keys(m).length === 1));
    if (nonNull.length === members.length) continue;
    out.nullable = true;
    if (nonNull.length === 1 && !('$ref' in nonNull[0])) {
      delete out[combinator];
      Object.assign(out, nonNull[0]);
    } else if (nonNull.length === 1) {
      delete out[combinator];
      out.allOf = nonNull;
    } else {
      out[combinator] = nonNull;
    }
  }
  return out;
}

/** Components for the TS interfaces in `GENERATED_TYPES`, plus every type they reference. */
export function generatedComponents(rootDir: string): { schemas: Record<string, SchemaObject>; problems: string[] } {
  const problems: string[] = [];
  const schemas: Record<string, SchemaObject> = {};
  const files = Object.keys(GENERATED_TYPES);
  const generator = createGenerator({
    path:
      files.length === 1 ? join(rootDir, files[0]) : posix.join(rootDir.split('\\').join('/'), `{${files.join(',')}}`),
    tsconfig: join(rootDir, 'tsconfig.json'),
    skipTypeCheck: true,
    additionalProperties: true,
    expose: 'export',
    topRef: true,
    jsDoc: 'extended',
    encodeRefs: false,
    functions: 'hide'
  });
  for (const name of Object.values(GENERATED_TYPES).flat()) {
    const out = generator.createSchema(name) as { definitions?: Record<string, unknown> };
    for (const [defName, def] of Object.entries(out.definitions ?? {})) {
      const converted = toOpenApi30(def) as SchemaObject;
      if (schemas[defName] && JSON.stringify(schemas[defName]) !== JSON.stringify(converted)) {
        problems.push(`generated type ${defName} resolves to two different schemas`);
      }
      schemas[defName] = converted;
    }
  }
  return { schemas, problems };
}

/** Components for the Drizzle row shapes in `ROW_TABLES`. */
export function rowComponents(): { schemas: Record<string, SchemaObject>; problems: string[] } {
  const problems: string[] = [];
  const schemas: Record<string, SchemaObject> = {};
  for (const [name, tableExport] of Object.entries(ROW_TABLES)) {
    const table = (dbSchema as Record<string, unknown>)[tableExport];
    if (!table) {
      problems.push(`${name}: src/db/schema.ts has no export ${tableExport}`);
      continue;
    }
    const built = drizzleRowSchema(
      table as Parameters<typeof drizzleRowSchema>[0],
      `A row of \`${tableExport}\` as stored (src/db/schema.ts).`
    );
    problems.push(...built.problems.map((p) => `${name}.${p}`));
    schemas[name] = built.schema;
  }
  return { schemas, problems };
}

/** Recursively sort object keys; arrays keep their order (it is decorator order, which is stable). */
export function sortKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sortKeys);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.keys(node as object)
      .sort()
      .map((k) => [k, sortKeys((node as Record<string, unknown>)[k])])
  );
}

export function serializeDocument(document: OpenAPIObject): string {
  return `${JSON.stringify(sortKeys(document), null, 2)}\n`;
}

function collectRefs(node: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, into));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') into.add(v);
      else collectRefs(v, into);
    }
  }
  return into;
}

/** `$ref`s in the document that point at no component. */
export function danglingRefs(document: OpenAPIObject): string[] {
  const schemas = document.components?.schemas ?? {};
  return [...collectRefs(document, new Set())]
    .filter((r) => !(r.startsWith('#/components/schemas/') && r.slice('#/components/schemas/'.length) in schemas))
    .sort();
}

export function operations(document: OpenAPIObject): Array<{ method: string; path: string; op: OperationObject }> {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    HTTP_METHODS.filter((m) => (item as PathItemObject)[m]).map((m) => ({
      method: m.toUpperCase(),
      path,
      op: (item as PathItemObject)[m] as OperationObject
    }))
  );
}

export interface BuildOptions {
  /** Repo root: where `tsconfig.json` and the `GENERATED_TYPES` files are. */
  rootDir: string;
  /** `info.version`; the export script passes `package.json` `version`. */
  version: string;
  /** Controllers to check public routes against; defaults to everything `AppModule` registers. */
  controllers?: Type[];
}

export function buildOpenApiDocument(
  app: INestApplication,
  options: BuildOptions
): { document: OpenAPIObject; problems: string[] } {
  const problems: string[] = [];
  const config = new DocumentBuilder()
    .setTitle(OPENAPI_TITLE)
    .setDescription(OPENAPI_DESCRIPTION)
    .setVersion(options.version)
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API key',
        description:
          'One of the keys in AUTH_API_KEYS, as `Authorization: Bearer <key>` (the bare key is also accepted). ' +
          'When AUTH_API_KEYS is empty, auth is disabled (development only).'
      },
      BEARER_SCHEME
    )
    .addSecurityRequirements(BEARER_SCHEME)
    .build();
  const document = SwaggerModule.createDocument(app, config);

  // Components: swagger's own DTOs first, then the three derived sources. A name in two places is a bug.
  const schemas = (document.components ??= {}).schemas ?? {};
  const generated = generatedComponents(options.rootDir);
  const rows = rowComponents();
  problems.push(...generated.problems, ...rows.problems);
  const literal = structuredClone(LITERAL_COMPONENTS) as Record<string, SchemaObject>;
  const errorCode = (literal.ErrorResponse.properties as Record<string, SchemaObject>).errorCode;
  errorCode.enum = Object.values(ErrorCode);
  for (const [source, extra] of [
    ['generated', generated.schemas],
    ['row', rows.schemas],
    ['literal', literal]
  ] as const) {
    for (const [name, schema] of Object.entries(extra)) {
      if (name in schemas) problems.push(`component ${name} (${source}) collides with an existing component`);
      schemas[name] = schema;
    }
  }
  document.components.schemas = schemas;

  // Security and error responses, from the same @Public() metadata AuthGuard reads.
  const publicRoutes = new Set(
    controllerRoutes(options.controllers ?? appControllers())
      .filter((r) => r.public)
      .map((r) => `${r.method} ${r.path}`)
  );
  const errorRef = { $ref: '#/components/schemas/ErrorResponse' };
  const errorResponse = (description: string) => ({
    description,
    content: { 'application/json': { schema: errorRef } }
  });
  for (const { method, path, op } of operations(document)) {
    const isPublic = publicRoutes.has(`${method} ${path}`);
    if (isPublic) op.security = [];
    op.responses ??= {};
    if (!isPublic) op.responses['401'] ??= errorResponse('Missing or invalid API key.');
    op.responses['429'] ??= errorResponse('Rate limited (THROTTLE_LIMIT per THROTTLE_TTL_MS, per caller).');
    op.responses.default ??= errorResponse('Any other error; branch on `errorCode` when present.');
  }

  document.tags = [...(document.tags ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  problems.push(...danglingRefs(document).map((r) => `dangling $ref ${r}`));
  return { document: sortKeys(document) as OpenAPIObject, problems };
}

/** Top-level differences between two serialized documents, as JSON paths, for the drift message. */
export function documentDiff(committed: string, generated: string, limit = 20): string[] {
  if (committed === generated) return [];
  let a: unknown;
  try {
    a = JSON.parse(committed);
  } catch {
    return ['(committed file is not valid JSON)'];
  }
  const b = JSON.parse(generated) as unknown;
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, at: string) => {
    if (out.length >= limit) return;
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
      for (const k of keys)
        walk(
          (x as Record<string, unknown>)[k],
          (y as Record<string, unknown>)[k],
          `${at}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`
        );
      return;
    }
    out.push(x === undefined ? `+ ${at}` : y === undefined ? `- ${at}` : `~ ${at}`);
  };
  walk(a, b, '');
  return out.length ? out : ['~ (formatting only: regenerate)'];
}
