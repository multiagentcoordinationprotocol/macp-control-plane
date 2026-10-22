import 'reflect-metadata';
import { readdirSync } from 'fs';
import { join } from 'path';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

// #111: Nest registers a route declared in two controllers twice, and the controller registered
// first silently answers. Every method + path must have exactly one owner.
describe('controller routes', () => {
  it('declares each method + path in only one handler', () => {
    const owners = new Map<string, string[]>();
    const files = readdirSync(__dirname).filter((f) => f.endsWith('.controller.ts'));

    for (const file of files) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const exported = require(join(__dirname, file)) as Record<string, unknown>;
      for (const value of Object.values(exported)) {
        if (typeof value !== 'function' || !Reflect.hasMetadata(PATH_METADATA, value)) continue;
        const ctrl = value as { name: string; prototype: Record<string, unknown> };
        const bases = [Reflect.getMetadata(PATH_METADATA, ctrl) as string | string[]].flat();
        for (const key of Object.getOwnPropertyNames(ctrl.prototype)) {
          const handler = ctrl.prototype[key];
          if (typeof handler !== 'function' || !Reflect.hasMetadata(METHOD_METADATA, handler)) continue;
          const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
          const paths = [Reflect.getMetadata(PATH_METADATA, handler) as string | string[]].flat();
          for (const base of bases) {
            for (const path of paths) {
              const route = `${method} /${[base, path]
                .map((p) => p.replace(/^\/|\/$/g, ''))
                .filter(Boolean)
                .join('/')}`;
              owners.set(route, [...(owners.get(route) ?? []), `${ctrl.name}.${key}`]);
            }
          }
        }
      }
    }

    expect(owners.size).toBeGreaterThan(0);
    const duplicates = [...owners].filter(([, handlers]) => handlers.length > 1);
    expect(duplicates).toEqual([]);
  });
});
