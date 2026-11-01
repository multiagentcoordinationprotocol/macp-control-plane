import { readFileSync } from 'fs';
import { resolve } from 'path';
import { buildOpenApiDocument, serializeDocument } from '../../src/openapi/build-document';
import { OPENAPI_FILE, setupApiDocs } from '../../src/openapi/serve-docs';
import { createTestApp, TestAppContext } from '../helpers/test-app';

// #112: the committed openapi.json is what a developer gets at /docs-json, and the export's preview-mode
// module graph describes the same routes as the fully instantiated app.
describe('OpenAPI document (integration)', () => {
  const committed = readFileSync(OPENAPI_FILE, 'utf8');

  describe('development', () => {
    let ctx: TestAppContext;
    let mounted = false;

    beforeAll(async () => {
      ctx = await createTestApp(undefined, { beforeListen: (app) => (mounted = setupApiDocs(app, true)) });
    });

    afterAll(async () => {
      await ctx.app.close();
    });

    it('serves the committed document at /docs-json, without auth', async () => {
      expect(mounted).toBe(true);
      const res = await fetch(`${ctx.url}/docs-json`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(JSON.parse(committed));
    });

    it('a document built from the running app equals the committed one', () => {
      const rootDir = resolve(__dirname, '..', '..');
      const { version } = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')) as { version: string };
      const { document, problems } = buildOpenApiDocument(ctx.app, { rootDir, version });
      expect(problems).toEqual([]);
      expect(serializeDocument(document)).toBe(committed);
    });
  });

  describe('outside development', () => {
    let ctx: TestAppContext;
    let mounted = true;

    beforeAll(async () => {
      ctx = await createTestApp(undefined, { beforeListen: (app) => (mounted = setupApiDocs(app, false)) });
    });

    afterAll(async () => {
      await ctx.app.close();
    });

    it('does not mount /docs or /docs-json', async () => {
      expect(mounted).toBe(false);
      expect((await fetch(`${ctx.url}/docs-json`)).status).toBe(404);
      expect((await fetch(`${ctx.url}/docs`)).status).toBe(404);
    });
  });
});
