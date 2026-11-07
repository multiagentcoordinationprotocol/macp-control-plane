import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { AppModule } from '../app.module';
import { RunsController } from '../controllers/runs.controller';
import { ErrorCode } from '../errors/error-codes';
import {
  appControllers,
  buildOpenApiDocument,
  controllerRoutes,
  danglingRefs,
  documentDiff,
  operations,
  serializeDocument,
  toOpenApi30
} from './build-document';
import { OPENAPI_FILE } from './serve-docs';

const rootDir = resolve(__dirname, '..', '..');
const { version } = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')) as { version: string };

describe('OpenAPI document (#112)', () => {
  let app: INestApplication;

  const build = () => {
    const { document, problems } = buildOpenApiDocument(app, { rootDir, version });
    return { document, problems, text: serializeDocument(document) };
  };

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { preview: true, logger: false, abortOnError: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it('builds without problems and is byte-identical across builds', () => {
    const first = build();
    const second = build();
    expect(first.problems).toEqual([]);
    expect(second.text).toBe(first.text);
  });

  it('has exactly one operation per controller route, and nothing else', () => {
    const { document } = build();
    const routes = controllerRoutes(appControllers()).map((r) => `${r.method} ${r.path}`);
    const ops = operations(document).map((o) => `${o.method} ${o.path}`);
    expect(routes.length).toBeGreaterThan(50);
    expect(new Set(routes).size).toBe(routes.length);
    expect([...ops].sort()).toEqual([...routes].sort());
  });

  it("documents each route's real success status (201 for an undecorated POST)", () => {
    const { document } = build();
    const byKey = new Map(operations(document).map((o) => [`${o.method} ${o.path}`, o.op]));
    const wrong: string[] = [];
    for (const route of controllerRoutes(appControllers())) {
      const op = byKey.get(`${route.method} ${route.path}`)!;
      if (op.deprecated) continue; // removed endpoints: always 410, never their nominal status
      const success = Object.keys(op.responses).filter((c) => /^2\d\d$/.test(c));
      if (success.length !== 1 || Number(success[0]) !== route.status) {
        wrong.push(`${route.method} ${route.path}: documents ${success.join(',') || 'none'}, returns ${route.status}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('marks exactly the @Public() routes as unauthenticated', () => {
    const { document } = build();
    const publicOps = operations(document)
      .filter((o) => Array.isArray(o.op.security) && o.op.security.length === 0)
      .map((o) => `${o.method} ${o.path}`)
      .sort();
    expect(publicOps).toEqual(['GET /healthz', 'GET /readyz']);
    expect(document.security).toEqual([{ bearer: [] }]);
    for (const { op } of operations(document)) {
      expect(op.responses.default).toBeDefined();
      expect(op.responses['401'] === undefined).toBe(Array.isArray(op.security) && op.security.length === 0);
    }
  });

  it('resolves every $ref, carries the package version and every ErrorCode', () => {
    const { document } = build();
    expect(danglingRefs(document)).toEqual([]);
    expect(document.info.version).toBe(version);
    const errorResponse = document.components!.schemas!.ErrorResponse as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(errorResponse.properties.errorCode.enum).toEqual(Object.values(ErrorCode));
  });

  it('matches the committed openapi.json (run `npm run openapi:export` if this fails)', () => {
    const committed = readFileSync(OPENAPI_FILE, 'utf8');
    const { text } = build();
    expect(documentDiff(committed, text)).toEqual([]);
    expect(text).toBe(committed);
  });

  it('the drift check fails, naming the path, when a route is mutated', () => {
    const committed = readFileSync(OPENAPI_FILE, 'utf8');
    const handler = RunsController.prototype.archiveRun;
    const original = Reflect.getMetadata(PATH_METADATA, handler) as string;
    Reflect.defineMetadata(PATH_METADATA, ':id/archived', handler);
    try {
      const diff = documentDiff(committed, build().text);
      expect(diff).toContain('- /paths/~1runs~1{id}~1archive');
      expect(diff).toContain('+ /paths/~1runs~1{id}~1archived');
    } finally {
      Reflect.defineMetadata(PATH_METADATA, original, handler);
    }
    expect(documentDiff(committed, build().text)).toEqual([]);
  });
});

describe('documentDiff', () => {
  it('is empty for identical text and reports changed, added and removed paths', () => {
    expect(documentDiff('{"a":1}\n', '{"a":1}\n')).toEqual([]);
    expect(documentDiff('{"a":1,"b":2}', '{"a":2,"c":3}')).toEqual(['~ /a', '- /b', '+ /c']);
    expect(documentDiff('{"a":1}', '{\n  "a": 1\n}\n')).toEqual(['~ (formatting only: regenerate)']);
    expect(documentDiff('', '{"a":1}')).toEqual(['(committed file is not valid JSON)']);
  });
});

describe('toOpenApi30', () => {
  it('maps draft-07 null types, const and definitions refs onto OpenAPI 3.0', () => {
    expect(toOpenApi30({ type: ['string', 'null'] })).toEqual({ type: 'string', nullable: true });
    expect(toOpenApi30({ const: 'x', type: 'string' })).toEqual({ enum: ['x'], type: 'string' });
    expect(toOpenApi30({ anyOf: [{ $ref: '#/definitions/A' }, { type: 'null' }] })).toEqual({
      allOf: [{ $ref: '#/components/schemas/A' }],
      nullable: true
    });
    expect(toOpenApi30({ anyOf: [{ type: 'number' }, { type: 'null' }] })).toEqual({ type: 'number', nullable: true });
    expect(toOpenApi30({ enum: ['a', null] })).toEqual({ enum: ['a'], nullable: true });
  });
});
