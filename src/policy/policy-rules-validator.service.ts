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

/** RFC-MACP-0012 §4 annotation keys — legal at every closed level, never validated. */
const ANNOTATION_KEY = /^[_$]/;
/**
 * Proposal S1 vendor-extension key (reverse-domain). Same grammar as the vendored schemas'
 * top-level `patternProperties` entry and the runtime's `is_vendor_extension_key`
 * (macp-core `policy/keys.rs`). A malformed `x-` key (e.g. `x-seam`) is just an undefined key.
 */
const VENDOR_EXTENSION_KEY = /^x-[a-z0-9]+(\.[a-z0-9-]+)+$/;

export interface ValidateRulesOptions {
  /**
   * Vendor-extension keys the runtime advertised in `PolicyRegistryCapability.rule_extensions`
   * (Initialize). `undefined` = not known (no Initialize cached yet): the name gate is skipped and
   * the runtime, whose admission is authoritative, decides. `[]` = the runtime implements none.
   */
  ruleExtensions?: readonly string[];
}

function vendorExtensionNotImplemented(key: string, implemented: readonly string[]): string {
  // The runtime's refusal text, verbatim (macp-policy registry.rs `validate_rule_keys`, which
  // Debug-formats the implemented names; macp-core policy/keys.rs `KeyViolation::Undefined`).
  return (
    `rules.${key} is not a defined key (RFC-MACP-0012 §4: rule objects are closed; annotation keys must match ^[_$]); ` +
    `this runtime implements no vendor extension '${key}' (implemented: [${implemented.map((name) => JSON.stringify(name)).join(', ')}])`
  );
}

function vendorExtensionNotObject(key: string): string {
  return `rules.${key}: a vendor-extension value must be a JSON object`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The closed-key shape of one schema level: the child shapes of each declared key, or `null`
 * for an open position (a map such as `voting.weights`, or a scalar) whose keys are not closed.
 */
type KeyShape = Map<string, KeyShape[]> | null;

/** Closed-key shape of a vendored schema node: closed exactly where `additionalProperties: false`. */
function keyShapeOf(schema: unknown): KeyShape {
  if (!isPlainObject(schema) || schema.additionalProperties !== false) return null;
  const children = new Map<string, KeyShape[]>();
  for (const [key, child] of Object.entries((schema.properties as Record<string, unknown> | undefined) ?? {})) {
    children.set(key, [keyShapeOf(child)]);
  }
  return children;
}

/**
 * Closed-key check over the UNION of `shapes`, mirroring the runtime's `closed_key_violation`
 * walk (macp-core policy/keys.rs) for a `"*"` policy: a key is defined at a level if any shape
 * defines it there, and its value is walked against every such shape's child. Annotation keys
 * are skipped; well-formed `x-` keys are the caller's concern at the top level and refused below
 * it. Reports every violation (the runtime stops at the first, in sorted key order).
 */
function unionKeyViolations(value: unknown, shapes: KeyShape[], path: string, top: boolean): string[] {
  if (!isPlainObject(value)) return [];
  const closed = shapes.filter((shape): shape is Map<string, KeyShape[]> => shape !== null);
  if (closed.length === 0) return [];
  const violations: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const childPath = path ? `${path}.${key}` : key;
    if (ANNOTATION_KEY.test(key)) continue;
    if (VENDOR_EXTENSION_KEY.test(key)) {
      if (!top) violations.push(`rules.${childPath}: vendor-extension keys are legal only at the top level of rules`);
      continue;
    }
    const children = closed.flatMap((shape) => shape.get(key) ?? []);
    if (children.length === 0) {
      violations.push(
        `rules.${childPath} is not a defined key (RFC-MACP-0012 §4: rule objects are closed; annotation keys must match ^[_$])`
      );
      continue;
    }
    violations.push(...unionKeyViolations(value[key], children, childPath, false));
  }
  return violations;
}

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
      // The schemas admit well-formed `x-` keys only at the top level, so one rejected here is nested.
      if (extraKey && VENDOR_EXTENSION_KEY.test(extraKey) && error.instancePath) {
        const path = `${error.instancePath.slice(1).split('/').join('.')}.${extraKey}`;
        return `rules.${path}: vendor-extension keys are legal only at the top level of rules`;
      }
      return `${location}: unrecognized key "${extraKey}"`;
    }
    const topLevelKey = error.instancePath.split('/')[1];
    if (
      error.keyword === 'type' &&
      error.instancePath === `/${topLevelKey}` &&
      VENDOR_EXTENSION_KEY.test(topLevelKey)
    ) {
      return vendorExtensionNotObject(topLevelKey);
    }
    return `${location}: ${error.message}`;
  });
}

/**
 * Closed-set validation of governance-policy `rules` against the upstream JSON
 * schemas vendored in `./schemas` (see its README). The runtime enforces the same
 * closed rule objects since v0.9.0 (proposal S1); this is a fail-fast pre-check
 * that refuses before the gRPC round-trip with a message naming the key path, and
 * against a 0.8.x runtime (which ignored unknown keys) it is the only check.
 *
 * Annotation keys (`^[_$]`) are skipped at every closed level. A well-formed
 * top-level `x-` vendor-extension key must hold an object and, when the runtime's
 * advertised `ruleExtensions` are known, be one of them.
 *
 * Modes without a vendored schema (extension modes) are not validated: the
 * control plane is scenario-agnostic and has nothing to check them against.
 */
@Injectable()
export class PolicyRulesValidatorService {
  private readonly ruleValidators = new Map<string, ValidateFunction>();
  // Top-level rules key -> every mode whose schema declares it (wildcard validation).
  private readonly topLevelKeyOwners = new Map<string, string[]>();
  // Every mode's closed-key shape: a "*" policy's keys are closed over their union.
  private readonly wildcardKeyShapes: KeyShape[] = Object.values(MODE_SCHEMAS).map(keyShapeOf);

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

  /**
   * Cross-field rules the schemas don't express, with the messages `POST /runtime/policies`
   * has always returned. The first violation, or undefined.
   */
  targetedRuleError(rules: Record<string, unknown>): string | undefined {
    const voting = rules.voting as Record<string, unknown> | undefined;
    if (voting?.algorithm === 'weighted' && (!voting.weights || typeof voting.weights !== 'object')) {
      return 'weighted voting algorithm requires a weights map';
    }
    if (voting?.algorithm === 'supermajority' && (typeof voting.threshold !== 'number' || voting.threshold <= 0.5)) {
      return 'supermajority voting requires threshold > 0.5';
    }
    const commitment = rules.commitment as Record<string, unknown> | undefined;
    if (commitment?.authority === 'designated_role') {
      const roles = commitment.designated_roles ?? commitment.designatedRoles;
      if (!Array.isArray(roles) || roles.length === 0) {
        return 'designated_role authority requires non-empty designated_roles list';
      }
    }
    return undefined;
  }

  /** Validation errors for `rules` under `mode`; empty when valid or when the mode has no vendored schema. */
  validateRules(mode: string, rules: unknown, options: ValidateRulesOptions = {}): string[] {
    if (mode === WILDCARD_MODE) return this.validateWildcardRules(rules, options.ruleExtensions);
    // `mode` comes from the request body: resolve it to one of OUR constant keys first, so no
    // caller-controlled string is ever used to pick the function that gets invoked.
    const knownMode = Object.keys(MODE_SCHEMAS).find((candidate) => candidate === mode);
    const validate = knownMode ? this.ruleValidators.get(knownMode) : undefined;
    if (!validate) return [];
    if (!validate(rules)) return formatErrors(validate.errors);
    // The schema already required each top-level `x-` value to be an object.
    return this.vendorExtensionGate(Object.keys(rules as Record<string, unknown>), options.ruleExtensions);
  }

  /** Refuses top-level vendor-extension keys the runtime does not implement (skipped when unknown). */
  private vendorExtensionGate(keys: string[], ruleExtensions: readonly string[] | undefined): string[] {
    if (ruleExtensions === undefined) return [];
    return keys
      .filter((key) => VENDOR_EXTENSION_KEY.test(key) && !ruleExtensions.includes(key))
      .map((key) => vendorExtensionNotImplemented(key, ruleExtensions));
  }

  /**
   * A "*" policy binds to whichever mode's session starts. As in the runtime, its keys are
   * closed over the UNION of the five modes' keys at every level (`unionKeyViolations`), so
   * `acceptance: {criterion, implicit_accept_timeout_ms}` — proposal's child plus handoff's —
   * is admitted. Values are then checked per top-level key, as a sparse single-key object
   * against each owning mode's FULL schema (so cross-field `allOf`/`if` conditionals on that
   * key still fire), with unknown-key errors dropped because the union walk already ruled on
   * keys. The value must pass EVERY owning mode, as the runtime parses a "*" policy's rules into
   * each mode's struct (registry.rs `validate_rules_for_mode`); the five schemas define the keys
   * they share identically, so this never refuses one mode's value for another's. Every `allOf` arm in the five schemas is
   * gated on a single key's presence, so a sparse object never trips a conditional about an
   * absent key.
   */
  private validateWildcardRules(rules: unknown, ruleExtensions: readonly string[] | undefined): string[] {
    if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) {
      const validate = this.ruleValidators.get('macp.mode.decision.v1')!;
      return validate(rules) ? [] : formatErrors(validate.errors);
    }

    const errors = unionKeyViolations(rules, this.wildcardKeyShapes, '', true);
    for (const [key, value] of Object.entries(rules as Record<string, unknown>)) {
      if (ANNOTATION_KEY.test(key)) continue;
      if (VENDOR_EXTENSION_KEY.test(key)) {
        if (!isPlainObject(value)) errors.push(vendorExtensionNotObject(key));
        else errors.push(...this.vendorExtensionGate([key], ruleExtensions));
        continue;
      }
      const owners = this.topLevelKeyOwners.get(key);
      if (!owners || owners.length === 0) continue; // already reported by the union walk
      const sparse = { [key]: value };
      for (const mode of owners) {
        const validate = this.ruleValidators.get(mode)!;
        if (validate(sparse)) continue;
        const valueErrors = (validate.errors ?? []).filter((error) => error.keyword !== 'additionalProperties');
        if (valueErrors.length > 0) {
          // The first owning mode that refuses the value speaks for all (shared fields are identical).
          errors.push(...formatErrors(valueErrors));
          break;
        }
      }
    }
    return errors;
  }
}
