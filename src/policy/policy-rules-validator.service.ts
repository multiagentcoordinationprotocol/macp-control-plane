import { Injectable } from '@nestjs/common';
import Ajv2020, { ErrorObject, ValidateFunction } from 'ajv/dist/2020';
import decisionRules from './schemas/decision-rules.schema.json';
import handoffRules from './schemas/handoff-rules.schema.json';
import proposalRules from './schemas/proposal-rules.schema.json';
import quorumRules from './schemas/quorum-rules.schema.json';
import taskRules from './schemas/task-rules.schema.json';

const MODE_SCHEMAS: Record<string, object> = {
  'macp.mode.decision.v1': decisionRules,
  'macp.mode.quorum.v1': quorumRules,
  'macp.mode.proposal.v1': proposalRules,
  'macp.mode.task.v1': taskRules,
  'macp.mode.handoff.v1': handoffRules
};

const WILDCARD_MODE = '*';

/**
 * ajv's own `.message` for additionalProperties never names the offending key.
 * Fold `params.additionalProperty` (and every error's `instancePath`) into the
 * message so a rejection points at what to fix (e.g. a `veto_threshhold` typo).
 */
function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return [];
  return errors.map((error) => {
    const location = error.instancePath || '(root)';
    if (error.keyword === 'additionalProperties') {
      const extraKey = (error.params as { additionalProperty?: string }).additionalProperty;
      return `${location}: unrecognized key "${extraKey}"`;
    }
    return `${location}: ${error.message}`;
  });
}

/**
 * Closed-set validation of governance-policy `rules` against the upstream JSON
 * schemas vendored in `./schemas` (see its README). The runtime deserializes
 * rules without `deny_unknown_fields` and declined to add a schema evaluator
 * (macp-runtime #167), so a misspelled key is otherwise silently ignored.
 *
 * Modes without a vendored schema (extension modes) are not validated: the
 * control plane is scenario-agnostic and has nothing to check them against.
 */
@Injectable()
export class PolicyRulesValidatorService {
  private readonly ruleValidators = new Map<string, ValidateFunction>();
  // Top-level rules key -> every mode whose schema declares it (wildcard validation).
  private readonly topLevelKeyOwners = new Map<string, string[]>();

  constructor() {
    // strict:false — the schemas' conditional (if/then) arms trip ajv's default strictTypes
    // logging, which would pollute startup output. allErrors:true so one call reports every violation.
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    for (const [mode, schema] of Object.entries(MODE_SCHEMAS)) {
      this.ruleValidators.set(mode, ajv.compile(schema));
      for (const key of Object.keys((schema as { properties?: Record<string, object> }).properties ?? {})) {
        const owners = this.topLevelKeyOwners.get(key) ?? [];
        owners.push(mode);
        this.topLevelKeyOwners.set(key, owners);
      }
    }
  }

  /** Validation errors for `rules` under `mode`; empty when valid or when the mode has no vendored schema. */
  validateRules(mode: string, rules: unknown): string[] {
    if (mode === WILDCARD_MODE) return this.validateWildcardRules(rules);
    const validate = this.ruleValidators.get(mode);
    if (!validate) return [];
    return validate(rules) ? [] : formatErrors(validate.errors);
  }

  /**
   * A "*" policy binds to whichever mode's session starts, so a key is legitimate if ANY
   * mode's schema accepts it. Validated per top-level key (as a sparse single-key object
   * against that mode's FULL schema, so cross-field `allOf`/`if` conditionals on that key
   * still fire); a key no schema declares is an unconditional error. Every `allOf` arm in
   * the five schemas is gated on a single key's presence, so a sparse object never trips a
   * conditional about an absent key.
   */
  private validateWildcardRules(rules: unknown): string[] {
    if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) {
      const validate = this.ruleValidators.get('macp.mode.decision.v1')!;
      return validate(rules) ? [] : formatErrors(validate.errors);
    }

    const errors: string[] = [];
    for (const [key, value] of Object.entries(rules as Record<string, unknown>)) {
      const owners = this.topLevelKeyOwners.get(key);
      if (!owners || owners.length === 0) {
        errors.push(`(root): unrecognized key "${key}"`);
        continue;
      }
      const sparse = { [key]: value };
      let accepted = false;
      let firstFailure: ErrorObject[] | null | undefined;
      for (const mode of owners) {
        const validate = this.ruleValidators.get(mode)!;
        if (validate(sparse)) {
          accepted = true;
          break;
        }
        firstFailure ??= validate.errors;
      }
      if (!accepted) errors.push(...formatErrors(firstFailure));
    }
    return errors;
  }
}
