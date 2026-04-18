import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Invariant lint (direct-agent-auth §Verification).
 *
 * The control-plane's observer role forbids calling `provider.send(` anywhere in `src/`.
 * Agents authenticate to the runtime directly (RFC-MACP-0004 §4). If a future change
 * reintroduces an envelope-forging path, this test fails CI.
 */

const SRC_DIR = join(__dirname, '..', '..', 'src');
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /provider\.send\s*\(/,
    message:
      'provider.send() is forbidden — the control-plane must never emit envelopes. ' +
      'Agents speak for themselves via macp-sdk-* (direct-agent-auth §Invariants #5).'
  },
  {
    pattern: /openSession\s*\(/,
    message:
      "openSession() is forbidden — it forges SessionStart on the agent's behalf. " +
      'Use provider.subscribeSession() for read-only observation (CP-3).'
  },
  {
    pattern: /chooseInitiator\s*\(/,
    message:
      'chooseInitiator() is forbidden — the control-plane must not pick an initiator. ' +
      'The initiator is whichever agent calls SessionStart; learned via GetSession (CP-3).'
  },
  {
    pattern: /retryKickoff\s*\(/,
    message:
      'retryKickoff() is forbidden — kickoff messages are emitted by the initiator agent ' +
      'via its SDK, not by the control-plane (CP-4).'
  }
];

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walk(full));
    } else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('Observer invariant — no envelope-forging paths in src/', () => {
  const tsFiles = walk(SRC_DIR);

  for (const { pattern, message } of FORBIDDEN_PATTERNS) {
    it(`forbids ${pattern.source}`, () => {
      const violations: Array<{ file: string; line: number; text: string }> = [];
      for (const file of tsFiles) {
        const content = readFileSync(file, 'utf8');
        let inBlockComment = false;
        content.split('\n').forEach((line, idx) => {
          const trimmed = line.trim();
          // Track multi-line /* ... */ comments across lines.
          if (inBlockComment) {
            if (trimmed.includes('*/')) inBlockComment = false;
            return;
          }
          if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
            inBlockComment = true;
            return;
          }
          // Skip pure-comment lines (// or * inside a block).
          if (/^\s*(?:\/\/|\*)/.test(line)) return;
          // Strip trailing line comments from mixed lines.
          const codeOnly = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
          if (pattern.test(codeOnly)) {
            violations.push({ file, line: idx + 1, text: line.trim() });
          }
        });
      }

      if (violations.length > 0) {
        const msg = violations.map((v) => `  ${v.file}:${v.line}: ${v.text}`).join('\n');
        throw new Error(`${message}\n\nFound ${violations.length} violation(s):\n${msg}`);
      }
    });
  }
});
