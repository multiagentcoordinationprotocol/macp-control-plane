import { PolicyRulesValidatorService } from './policy-rules-validator.service';

describe('PolicyRulesValidatorService', () => {
  const validator = new PolicyRulesValidatorService();
  const DECISION = 'macp.mode.decision.v1';

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
    expect(
      validator.validateRules(DECISION, { voting: { algorithm: 'weighted', weights: { alice: 0 } } })
    ).not.toEqual([]);
    expect(validator.validateRules(DECISION, { voting: { algorithm: 'weighted', weights: {} } })).not.toEqual([]);
    expect(
      validator.validateRules(DECISION, { voting: { algorithm: 'weighted', weights: { alice: 2, bob: 1 } } })
    ).toEqual([]);
  });

  it('wildcard mode accepts keys legitimate under some mode and rejects keys no mode declares', () => {
    expect(
      validator.validateRules('*', { voting: { algorithm: 'majority' }, commitment: { authority: 'any_participant' } })
    ).toEqual([]);
    expect(validator.validateRules('*', { nope: 1 })).toEqual(['(root): unrecognized key "nope"']);
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
});
