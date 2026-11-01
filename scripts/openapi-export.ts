/**
 * Export the control plane's OpenAPI document to `openapi.json` (#112).
 *
 *   npm run openapi:export   regenerate and write the file
 *   npm run openapi:check    regenerate in memory; exit 1 if the committed file differs (CI)
 *
 * Builds `AppModule` in Nest preview mode: the module graph and controllers resolve, no provider is
 * instantiated, so no database, runtime or environment is needed.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument, documentDiff, serializeDocument } from '../src/openapi/build-document';
import { OPENAPI_FILE } from '../src/openapi/serve-docs';

async function main(): Promise<number> {
  const check = process.argv.includes('--check');
  const rootDir = resolve(__dirname, '..');
  const { version } = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')) as { version: string };

  const app = await NestFactory.create(AppModule, { preview: true, logger: false, abortOnError: false });
  const { document, problems } = buildOpenApiDocument(app, { rootDir, version });
  await app.close();

  if (problems.length) {
    process.stderr.write(`openapi: ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return 1;
  }
  const generated = serializeDocument(document);

  if (!check) {
    writeFileSync(OPENAPI_FILE, generated);
    process.stdout.write(`openapi: wrote ${OPENAPI_FILE}\n`);
    return 0;
  }

  const committed = existsSync(OPENAPI_FILE) ? readFileSync(OPENAPI_FILE, 'utf8') : '';
  const diff = documentDiff(committed, generated);
  if (!diff.length) {
    process.stdout.write('openapi: openapi.json is current\n');
    return 0;
  }
  process.stderr.write(
    'openapi: openapi.json is out of date with the controllers (or package.json version).\n' +
      'Run `npm run openapi:export` and commit the result. Differences (- committed only, + generated only, ~ changed):\n' +
      diff.map((d) => `  ${d}`).join('\n') +
      '\n'
  );
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`openapi: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  }
);
