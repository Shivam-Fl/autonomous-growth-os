import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateExperiment,
  evaluateExperiment,
  stopRuleTriggered,
} from '../../src/domain/experiments.js';

const BASE = {
  experiment_id: 'exp_test',
  tenant_id: 'tenant_demo',
  arms: [{ id: 'arm_control', name: 'Control' }, { id: 'arm_treatment', name: 'Treatment' }],
  caps: { max_spend_micros: 500_000_000, max_downside_micros: 200_000_000 },
  stopRules: { min_runtime_hours: 48, min_sample: 100, success_threshold: 0.1, harm_threshold: 0.2 },
  state: 'running',
  data_through: '2026-09-25T08:00:00.000Z',
};

function validExperiment(overrides = {}) {
  const result = validateExperiment({ ...BASE, ...overrides });
  assert.equal(result.ok, true, `fixture experiment must validate: ${result.ok ? '' : result.error.message}`);
  return result.experiment;
}

test('underpowered counts evaluate to inconclusive, never win or loss', () => {
  // The pinned case: 10/1000 vs 12/1000 total conversions is 22, below the
  // min_sample gate of 100 — too few conversions to even test.
  const evaluated = evaluateExperiment({
    counts: { control_conversions: 10, control_exposures: 1000, treatment_conversions: 12, treatment_exposures: 1000 },
    min_sample: 100,
  });
  assert.equal(evaluated.outcome, 'inconclusive');
  assert.equal(evaluated.reason, 'underpowered');
  assert.equal(evaluated.next_state, 'inconclusive');
  assert.notEqual(evaluated.outcome, 'win');
  assert.notEqual(evaluated.outcome, 'loss');
});

test('a clear winner and a clear loser evaluate to win and loss with next_state matured', () => {
  const win = evaluateExperiment({
    counts: { control_conversions: 30, control_exposures: 1000, treatment_conversions: 70, treatment_exposures: 1000 },
    min_sample: 100,
  });
  assert.equal(win.outcome, 'win');
  assert.equal(win.next_state, 'matured');
  assert.ok(Math.abs(win.z) >= 1.96);

  const loss = evaluateExperiment({
    counts: { control_conversions: 70, control_exposures: 1000, treatment_conversions: 30, treatment_exposures: 1000 },
    min_sample: 100,
  });
  assert.equal(loss.outcome, 'loss');
  assert.equal(loss.next_state, 'matured');
});

test('contradicting evidence |z| < 1.96 stays inconclusive with reason no-separation', () => {
  // 22 conversions each side would be underpowered; push total above the gate
  // but keep the difference small.
  const evaluated = evaluateExperiment({
    counts: { control_conversions: 100, control_exposures: 5000, treatment_conversions: 104, treatment_exposures: 5000 },
    min_sample: 100,
  });
  assert.equal(evaluated.outcome, 'inconclusive');
  assert.equal(evaluated.reason, 'no-separation');
  assert.equal(evaluated.next_state, 'inconclusive');
});

test('a harm-threshold breach triggers the stop rule', () => {
  const experiment = validExperiment();
  // Control converts at 10%, treatment at 6% — a 0.4 relative drop beyond the
  // 0.2 harm threshold, so the early stop fires naming harm.
  const result = stopRuleTriggered({
    counts: { control_conversions: 100, control_exposures: 1000, treatment_conversions: 60, treatment_exposures: 1000 },
    stopRules: experiment.stopRules,
    caps: experiment.caps,
  });
  assert.equal(result.triggered, true);
  assert.equal(result.reason, 'harm');
});

test('a cap breach triggers the stop rule naming cap; inside the caps nothing fires', () => {
  const experiment = validExperiment();
  const breached = stopRuleTriggered({
    counts: { control_conversions: 10, control_exposures: 1000, treatment_conversions: 12, treatment_exposures: 1000 },
    stopRules: experiment.stopRules,
    caps: experiment.caps,
    spend_micros: 500_000_000,
  });
  assert.equal(breached.triggered, true, 'spending exactly the max spend cap is a breach');
  assert.equal(breached.reason, 'cap');

  const inside = stopRuleTriggered({
    counts: { control_conversions: 10, control_exposures: 1000, treatment_conversions: 9, treatment_exposures: 1000 },
    stopRules: experiment.stopRules,
    caps: experiment.caps,
    spend_micros: 400_000_000,
  });
  assert.equal(inside.triggered, false);
  assert.equal(inside.reason, null);
});

test('zero or negative caps reject with EXP_BAD_CAPS', () => {
  for (const caps of [
    { max_spend_micros: 0, max_downside_micros: 200_000_000 },
    { max_spend_micros: 500_000_000, max_downside_micros: -1 },
    { max_spend_micros: 500.5, max_downside_micros: 200_000_000 },
  ]) {
    const result = validateExperiment({ ...BASE, caps });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'EXP_BAD_CAPS');
  }
});

test('inconclusive is an accepted validateExperiment state', () => {
  validExperiment({ state: 'inconclusive' });
  assert.equal(validateExperiment({ ...BASE, state: 'inconclusive' }).ok, true);
});

test('malformed experiments reject with the stable codes, never a throw', () => {
  const id = validateExperiment({ ...BASE, experiment_id: 'evt_nope' });
  assert.equal(id.error.code, 'EXP_BAD_ID');
  const tenant = validateExperiment({ ...BASE, tenant_id: '' });
  assert.equal(tenant.error.code, 'EXP_BAD_ID');
  const arms = validateExperiment({ ...BASE, arms: [{ id: 'arm_control' }] });
  assert.equal(arms.error.code, 'EXP_BAD_ARMS');
  const stopRules = validateExperiment({ ...BASE, stopRules: { ...BASE.stopRules, min_sample: 0 } });
  assert.equal(stopRules.error.code, 'EXP_BAD_STOP_RULES');
  const state = validateExperiment({ ...BASE, state: 'celebrated' });
  assert.equal(state.error.code, 'EXP_BAD_STATE');
});

test('conversions above their exposures reject with EXP_BAD_COUNTS, never a verdict', () => {
  // 99 conversions in 10 exposures makes the pooled standard error the square
  // root of a negative number: z is NaN, and NaN fails every comparison, so a
  // separation check that only tests |z| < threshold falls through into a
  // forced win/loss. The counts are arithmetically impossible, not merely
  // weak, so they are rejected before the z-test.
  for (const counts of [
    { control_conversions: 99, control_exposures: 10, treatment_conversions: 1, treatment_exposures: 10 },
    { control_conversions: 1, control_exposures: 10, treatment_conversions: 11, treatment_exposures: 10 },
  ]) {
    const result = evaluateExperiment({ counts, min_sample: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'EXP_BAD_COUNTS');
    assert.equal(result.outcome, undefined, 'no outcome at all, so nothing can be persisted');
  }
});

test('the z statistic separates in the direction of the better-converting arm', () => {
  const win = evaluateExperiment({
    counts: { control_conversions: 30, control_exposures: 1000, treatment_conversions: 70, treatment_exposures: 1000 },
    min_sample: 100,
  });
  const loss = evaluateExperiment({
    counts: { control_conversions: 70, control_exposures: 1000, treatment_conversions: 30, treatment_exposures: 1000 },
    min_sample: 100,
  });
  assert.ok(win.z > 0, 'treatment above control is positive');
  assert.ok(loss.z < 0, 'treatment below control is negative');
});
