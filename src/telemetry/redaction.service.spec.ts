import { RedactionService } from './redaction.service';
import { AppConfigService } from '../config/app-config.service';

function makeService(patterns: string[]): RedactionService {
  return new RedactionService({ redactPatterns: patterns } as unknown as AppConfigService);
}

describe('RedactionService (§8.3)', () => {
  it('passes through when no patterns are configured', () => {
    const svc = makeService([]);
    expect(svc.isActive()).toBe(false);
    expect(svc.redact('hello world')).toBe('hello world');
  });

  it('redacts matches in plain strings', () => {
    const svc = makeService(['\\bsk-[A-Za-z0-9]+']);
    const out = svc.redact('key is sk-abc123 here');
    expect(out).toBe('key is [REDACTED] here');
  });

  it('walks nested objects and arrays', () => {
    const svc = makeService(['secret']);
    const out = svc.redact({
      a: 'my secret value',
      b: ['no secret', 'clean'],
      nested: { c: 'secret inside', d: 42 },
    });
    expect(out).toEqual({
      a: 'my [REDACTED] value',
      b: ['no [REDACTED]', 'clean'],
      nested: { c: '[REDACTED] inside', d: 42 },
    });
  });

  it('ignores invalid regex patterns', () => {
    const svc = makeService(['[invalid(', 'ok\\d+']);
    expect(svc.isActive()).toBe(true);
    expect(svc.redact('ok42 works')).toBe('[REDACTED] works');
  });

  it('returns the same reference when passthrough (hot-path optimization)', () => {
    const svc = makeService([]);
    const input = { a: 1 };
    expect(svc.redact(input)).toBe(input);
  });
});
