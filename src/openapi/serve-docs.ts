import { INestApplication, Logger } from '@nestjs/common';
import { OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * The committed document, `openapi.json` next to the nearest `package.json` above this file. Walking up
 * rather than a fixed `../..` keeps it right from `src/openapi`, `dist/openapi` (Docker build) and
 * `dist/src/openapi` (a local `nest build`, where drizzle.config.ts widens the root).
 */
function packageRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) return from;
  }
}

export const OPENAPI_FILE = join(packageRoot(__dirname), 'openapi.json');

/**
 * Swagger UI at `/docs` and the raw document at `/docs-json`, development only (as before #112).
 * Serves the committed `openapi.json`, so what a developer sees is exactly what CI checks; run
 * `npm run openapi:export` after changing a route. Off outside development: the document lists the
 * admin routes, and the file is in the repository for anyone who needs it.
 */
export function setupApiDocs(app: INestApplication, isDevelopment: boolean, file = OPENAPI_FILE): boolean {
  if (!isDevelopment) return false;
  if (!existsSync(file)) {
    new Logger('ApiDocs').warn(`${file} not found; /docs disabled (run npm run openapi:export)`);
    return false;
  }
  const document = JSON.parse(readFileSync(file, 'utf8')) as OpenAPIObject;
  SwaggerModule.setup('docs', app, document);
  return true;
}
