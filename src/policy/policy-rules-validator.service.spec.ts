import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PolicyRulesValidatorService } from './policy-rules-validator.service';

describe('PolicyRulesValidatorService', () => {
  const validator = new PolicyRulesValidatorService();
  const DECISION = 'macp.mode.decision.v1';
  // The runtime's undefined-key refusal (macp-core policy/keys.rs `KeyViolation::Undefined`), used verbatim on "*".
  const undefinedKey = (path: string) =>
    `rules.${path} is not a defined key (RFC-MACP-0012 §4: rule objects are closed; annotation keys must match ^[_$])`;

  it('accepts a valid decision rules object', () => {
    expect(validator.validateRules(DECISION, { voting: { algorithm: 'majority' } })).toEqual([]);
  });

  it('names the offending key for a misspelled nested key', () => {
    const errors = validator.validateRules(DECISION, { objection_handling: { veto_threshhold: 1 } });
    expect(errors.join(' ')).toContain('unrecognized key "veto_threshhold"');
    expect(errors.join(' ')).toContain('/objection_handling');
  });

  it('names an unknown top-level key', () => {
    expect(validator.validateRules(DECISION, { votting: {} })).toEqual(['(root): unrecognized key "votting"']);
  });

  it('allows _/$-prefixed annotation keys that the schema whitelists', () => {
    expect(validator.validateRules(DECISION, { $comment: 'note', voting: { algorithm: 'majority' } })).toEqual([]);
  });

  it('rejects a non-positive weight and an empty weights map', () => {
    expect(validator.validateRules(DECISION, { voting: { algorithm: 'weighted', weights: { alice: 0 } } })).not.toEqual(
      []
    );
    expect(validator.validateRules(DECISION, { voting: { algorithm: 'weighted', weights: {} } })).not.toEqual([]);
    expect(
      validator.validateRules(DECISION, { voting: { algorithm: 'weighted', weights: { alice: 2, bob: 1 } } })
    ).toEqual([]);
  });

  it('wildcard mode accepts keys legitimate under some mode and rejects keys no mode declares', () => {
    expect(
      validator.validateRules('*', { voting: { algorithm: 'majority' }, commitment: { authority: 'any_participant' } })
    ).toEqual([]);
    expect(validator.validateRules('*', { nope: 1 })).toEqual([undefinedKey('nope')]);
  });

  it('wildcard mode still catches a typo nested inside a recognised key', () => {
    const errors = validator.validateRules('*', { objection_handling: { veto_threshhold: 1 } });
    expect(errors.join(' ')).toContain('veto_threshhold');
  });

  it('wildcard mode keeps cross-field conditionals on a key (designated_role needs roles)', () => {
    expect(validator.validateRules('*', { commitment: { authority: 'designated_role' } })).not.toEqual([]);
  });

  it('rejects a non-object rules value', () => {
    expect(validator.validateRules(DECISION, [])).not.toEqual([]);
    expect(validator.validateRules('*', 'x')).not.toEqual([]);
  });

  it('skips validation for modes with no vendored schema (extension modes)', () => {
    expect(validator.validateRules('ext.custom.v1', { anything: true })).toEqual([]);
  });
  describe('annotation keys (RFC-MACP-0012 §4, runtime v0.9.0 parity)', () => {
    it('wildcard mode skips top-level _/$ keys instead of refusing them as unrecognized', () => {
      expect(validator.validateRules('*', { _note: 'x', $id: 'y', voting: { algorithm: 'majority' } })).toEqual([]);
    });

    it('accepts annotation keys at nested closed levels, per mode and wildcard', () => {
      const rules = {
        _why: 'audit trail',
        voting: { $comment: 'x', algorithm: 'majority' },
        commitment: { _owner: 'ops' }
      };
      expect(validator.validateRules(DECISION, rules)).toEqual([]);
      expect(validator.validateRules('*', rules)).toEqual([]);
    });

    it('still refuses a non-annotation unknown key alongside annotations', () => {
      expect(validator.validateRules('*', { _note: 'x', nope: 1 })).toEqual([undefinedKey('nope')]);
    });
  });

  describe('vendor-extension keys (proposal S1)', () => {
    const EXT = 'x-com.example';

    it.each([DECISION, '*'])('%s: refuses an x- key the runtime does not advertise, naming the key', (mode) => {
      expect(validator.validateRules(mode, { [EXT]: { require_reason: true } }, { ruleExtensions: [] })).toEqual([
        "rules.x-com.example is not a defined key (RFC-MACP-0012 §4: rule objects are closed; annotation keys must match ^[_$]); this runtime implements no vendor extension 'x-com.example' (implemented: [])"
      ]);
      expect(validator.validateRules(mode, { [EXT]: {} }, { ruleExtensions: ['x-org.other'] }).join(' ')).toContain(
        '(implemented: ["x-org.other"])'
      );
    });

    it.each([DECISION, '*'])('%s: accepts an advertised x- key', (mode) => {
      expect(validator.validateRules(mode, { [EXT]: { require_reason: true } }, { ruleExtensions: [EXT] })).toEqual([]);
    });

    it.each([DECISION, '*'])('%s: leaves the name to the runtime when its extensions are unknown', (mode) => {
      expect(validator.validateRules(mode, { [EXT]: {} })).toEqual([]);
    });

    it.each([DECISION, '*'])('%s: refuses a non-object x- value even when advertised', (mode) => {
      for (const value of [1, true, 'x', [], null]) {
        expect(validator.validateRules(mode, { [EXT]: value }, { ruleExtensions: [EXT] })).toEqual([
          'rules.x-com.example: a vendor-extension value must be a JSON object'
        ]);
      }
    });

    it.each([DECISION, '*'])('%s: refuses an x- key below the top level', (mode) => {
      expect(
        validator.validateRules(mode, { voting: { algorithm: 'majority', [EXT]: {} } }, { ruleExtensions: [EXT] })
      ).toEqual(['rules.voting.x-com.example: vendor-extension keys are legal only at the top level of rules']);
    });

    it.each([
      [DECISION, '(root): unrecognized key "x-seam"'],
      ['*', undefinedKey('x-seam')]
    ])('%s: treats a malformed x- key as an ordinary unknown key', (mode, expected) => {
      expect(validator.validateRules(mode, { 'x-seam': {} }, { ruleExtensions: ['x-seam'] })).toEqual([expected]);
    });
  });

  describe('"*": keys closed over the union of the five modes (runtime keys.rs `rule_shape_for_mode("*")`)', () => {
    it('accepts acceptance children drawn from two modes (proposal criterion + handoff implicit_accept_timeout_ms)', () => {
      expect(
        validator.validateRules('*', { acceptance: { criterion: 'all_parties', implicit_accept_timeout_ms: 1000 } })
      ).toEqual([]);
    });

    it('accepts commitment children drawn from decision and the other modes', () => {
      expect(
        validator.validateRules('*', { commitment: { authority: 'initiator_only', require_vote_quorum: true } })
      ).toEqual([]);
    });

    it('refuses a nested key no mode defines at that level, naming its dotted path', () => {
      expect(validator.validateRules('*', { acceptance: { criterion: 'all_parties', criterium: 'x' } })).toEqual([
        undefinedKey('acceptance.criterium')
      ]);
      expect(validator.validateRules('*', { voting: { quorum: { type: 'count', valu: 1 } } })).toEqual([
        undefinedKey('voting.quorum.valu')
      ]);
    });

    it('still checks values once the keys are admitted', () => {
      expect(
        validator.validateRules('*', { acceptance: { criterion: 'all_parties', implicit_accept_timeout_ms: 'soon' } })
      ).not.toEqual([]);
      expect(validator.validateRules('*', { acceptance: { criterion: 'nobody' } })).not.toEqual([]);
    });

    it('leaves open maps open (voting.weights)', () => {
      expect(validator.validateRules('*', { voting: { algorithm: 'weighted', weights: { 'agent-a': 2 } } })).toEqual(
        []
      );
    });

    it('reports every undefined key, not just the first', () => {
      expect(validator.validateRules('*', { zeta: 1, alpha: 1 })).toEqual([
        undefinedKey('alpha'),
        undefinedKey('zeta')
      ]);
    });
  });

  it('keeps refusing rules.audit and a misspelt key (the runtime refuses both since v0.9.0)', () => {
    expect(validator.validateRules('*', { audit: { level: 'info' } })).toEqual([undefinedKey('audit')]);
    expect(validator.validateRules(DECISION, { objection_handling: { veto_threshhold: 1 } }).join(' ')).toContain(
      'veto_threshhold'
    );
  });

  describe('vendored schemas', () => {
    // Pinned in src/policy/schemas/README.md: byte-identical copies of spec commit 60262b8.
    const PINNED: Record<string, string> = {
      'decision-rules.schema.json': 'da877a4ab7859ee6c685964374d94a68347ff5bdab4b4acc359b25eba0b167cb',
      'handoff-rules.schema.json': 'd53090c690d8daae7a1effd0638dfd6dba2539f68fc2c74dd7946486618d5b3b',
      'proposal-rules.schema.json': 'ad5f3491e919bdcb361f381bfef4b0f216b0f30ef9c717d4ed24d1e811d15e94',
      'quorum-rules.schema.json': '6971df421e215c09167a76a824f794343f353d9192ee7f6f04be646a102bd53d',
      'task-rules.schema.json': '61f759faa5d32527776b0221417b9789a1dd0d00c0c7c3e623f501e9de43f3fd'
    };

    it.each(Object.entries(PINNED))('%s is byte-identical to spec 60262b8', (file, sha256) => {
      const bytes = readFileSync(join(__dirname, 'schemas', file));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    });

    it('the README pins the same hashes', () => {
      const readme = readFileSync(join(__dirname, 'schemas', 'README.md'), 'utf8');
      expect(readme).toContain('`60262b8`');
      for (const [file, sha256] of Object.entries(PINNED)) expect(readme).toContain(`| \`${file}\` | \`${sha256}\` |`);
    });
  });
});
