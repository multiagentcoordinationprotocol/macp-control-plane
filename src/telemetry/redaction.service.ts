import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

/**
 * Privacy redaction for LLM prompt/response content (§8.3).
 *
 * Configured via comma-separated regex patterns in MACP_REDACT_PATTERNS.
 * Matches are replaced with [REDACTED]. Applies to string values and
 * recursively to nested objects/arrays. Safe on non-string leaves.
 *
 * Default: empty pattern list → passthrough. Enable by setting env var.
 */
@Injectable()
export class RedactionService {
  private readonly logger = new Logger(RedactionService.name);
  private readonly patterns: RegExp[];

  constructor(private readonly config: AppConfigService) {
    this.patterns = this.compilePatterns(this.config.redactPatterns ?? []);
    if (this.patterns.length > 0) {
      this.logger.log(`Redaction active — ${this.patterns.length} pattern(s) loaded`);
    }
  }

  /** True when at least one redaction pattern is configured. */
  isActive(): boolean {
    return this.patterns.length > 0;
  }

  /**
   * Redact string/object content. Returns the same instance when no patterns
   * are active to avoid needless cloning on the hot path.
   */
  redact<T>(value: T): T {
    if (this.patterns.length === 0) return value;
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === 'string') return this.redactString(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.walk(v);
      }
      return out;
    }
    return value;
  }

  private redactString(input: string): string {
    let out = input;
    for (const pattern of this.patterns) {
      out = out.replace(pattern, '[REDACTED]');
    }
    return out;
  }

  private compilePatterns(raw: string[]): RegExp[] {
    const out: RegExp[] = [];
    for (const src of raw) {
      const trimmed = src.trim();
      if (!trimmed) continue;
      try {
        out.push(new RegExp(trimmed, 'g'));
      } catch (err) {
        this.logger.warn(
          `Ignoring invalid redaction pattern ${JSON.stringify(trimmed)}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return out;
  }
}
