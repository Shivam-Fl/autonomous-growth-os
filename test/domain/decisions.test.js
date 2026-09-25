// The decision domain (TR-6, TR-15): record validation, maturity math, live
// calibration and the CI-only frozen replay. Tests pin the work order's
// computed examples so the numbers cannot drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calibrationReport,
  evaluateReplay,
  expectedEvaluationAtIso,
  frontierCheck,
  validateDecisionRecord,
} from '../../src/domain/decisions.js';

// The fixture carries a prose header as // comments, which JSON.parse
// rejects: strip them the same way the frozen replay runner would.
const FIXTURES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'replay-scenarios.json'), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n'),
).scenarios;

function validRecord(overrides = {}) {
  return {
    decision_id: 'dec_test_1',
    tenant_id: 'tenant_demo',
    state_snapshot_id: 'state_test_1',
    decided_at: '2026-09-20T00:00:00.000Z',
    action_class: 'budget-change',
    selected_action: 'raise_budget',
    alternatives: [
      { action: 'raise_budget', reason: 'qualified CPL tracks below target', expected_outcomes: { mean: -0.08, p10: -0.14, p90: 0.02 } },
      { action: 'do_nothing', reason: 'holding keeps spend flat while evidence matures', expected_outcomes: { mean: 0, p10: 0, p90: 0 } },
    ],
    risk: { expected_downside_micros: 300_000_000, worst_reasonable_case: 'qualified CPL rises 14% for a week' },
    evidence_refs: ['evt_1'],
    memory_refs: ['learn_1'],
    critic_result: 'critic agrees',
    policy_decision_id: 'policy_test_1',
    model_versions: ['strategy-fixture-v1'],
    prompt_versions: ['journal-baseline-v1'],
    ...overrides,
  };
}

function validationCode(record) {
  const validated = validateDecisionRecord(record);
  return validated.ok ? null : validated.error.code;
}

// AC-1: schema rejections with stable codes.
test('a decision without state_snapshot_id is rejected as MISSING_STATE_SNAPSHOT', () => {
  const record = validRecord();
  delete record.state_snapshot_id;
  assert.equal(validationCode(record), 'MISSING_STATE_SNAPSHOT');
});

test('a decision whose alternatives lack a do-nothing entry is rejected as MISSING_DO_NOTHING', () => {
  assert.equal(
    validationCode(validRecord({
      alternatives: [{ action: 'raise_budget', reason: 'x', expected_outcomes: { mean: 0, p10: 0, p90: 0 } }],
    })),
    'MISSING_DO_NOTHING',
  );
  assert.equal(
    validationCode(validRecord({
      alternatives: [
        { action: 'do_nothing', reason: '', expected_outcomes: { mean: 0, p10: 0, p90: 0 } },
        { action: 'raise_budget', reason: 'x', expected_outcomes: { mean: 0, p10: 0, p90: 0 } },
      ],
    })),
    'MISSING_DO_NOTHING',
    'an empty do-nothing reason is no reason at all',
  );
});

test('bad distributions and non-integer money are rejected with stable codes', () => {
  assert.equal(
    validationCode(validRecord({
      alternatives: [
        { action: 'raise_budget', reason: 'x', expected_outcomes: { mean: 'low', p10: 0, p90: 0 } },
        { action: 'do_nothing', reason: 'hold', expected_outcomes: { mean: 0, p10: 0, p90: 0 } },
      ],
    })),
    'BAD_DISTRIBUTION',
  );
  assert.equal(
    validationCode(validRecord({ risk: { expected_downside_micros: 1.5, worst_reasonable_case: 'x' } })),
    'INVALID_MONEY',
  );
  assert.equal(
    validationCode(validRecord({ risk: { expected_downside_micros: Number.NaN, worst_reasonable_case: 'x' } })),
    'INVALID_MONEY',
  );
});

test('a valid record round-trips with the field defaults the validator fills', () => {
  const validated = validateDecisionRecord(validRecord());
  assert.ok(validated.ok, `fixture must validate: ${validated.ok ? '' : validated.error.message}`);
  assert.equal(validated.record.decided_at, '2026-09-20T00:00:00.000Z');
  assert.equal(validated.record.evaluation, undefined, 'no evaluation until the decision matures');
});

// AC-1: evaluation objects, allowed only alongside a matured decided_at.
test('a malformed evaluation object is rejected as BAD_EVALUATION', () => {
  assert.equal(
    validationCode(validRecord({ evaluation: { outcome: 'maybe', needless: false, evaluated_at: '2026-09-25T00:00:00.000Z' } })),
    'BAD_EVALUATION',
  );
  assert.equal(
    validationCode(validRecord({ evaluation: { outcome: 'correct', needless: 'no', evaluated_at: '2026-09-25T00:00:00.000Z' } })),
    'BAD_EVALUATION',
  );
  assert.equal(
    validationCode(validRecord({ evaluation: { outcome: 'correct', needless: false, evaluated_at: 'not-a-time' } })),
    'BAD_EVALUATION',
  );
  assert.equal(
    validationCode(validRecord({ evaluation: 42 })),
    'BAD_EVALUATION',
  );
});

test('an evaluation dated inside the lag window is rejected as BAD_EVALUATION', () => {
  assert.equal(
    validationCode(validRecord({
      decided_at: '2026-09-20T00:00:00.000Z',
      evaluation: { outcome: 'correct', needless: false, evaluated_at: '2026-09-22T00:00:00.000Z' },
    })),
    'BAD_EVALUATION',
  );
  assert.ok(
    validateDecisionRecord(validRecord({
      decided_at: '2026-09-20T00:00:00.000Z',
      evaluation: { outcome: 'correct', needless: false, evaluated_at: '2026-09-25T00:00:00.000Z' },
    })).ok,
    'an evaluation at exactly the maturity moment is allowed',
  );
});

// TR-15: maturity math with the work order's pinned computed example.
test('maturity sits 120h after decided_at; 2026-09-20 evaluates 2026-09-25', () => {
  assert.equal(expectedEvaluationAtIso('2026-09-20T00:00:00.000Z'), '2026-09-25T00:00:00.000Z');
  assert.equal(
    validateDecisionRecord(validRecord({ decided_at: '2026-09-20T00:00:00.000Z', evaluation: undefined })).ok,
    true,
  );
});

test('a recent decision is awaiting-maturity and a matured one is not', async () => {
  const { evaluationStatus } = await import('../../src/domain/decisions.js');
  const record = validateDecisionRecord(validRecord({ decided_at: new Date(Date.now() - 6 * 3_600_000).toISOString() })).record;
  assert.equal(evaluationStatus(record, new Date().toISOString()), 'awaiting-maturity');
  const old = validateDecisionRecord(validRecord({ decided_at: '2026-09-20T00:00:00.000Z' })).record;
  assert.equal(evaluationStatus(old, new Date().toISOString()), 'matured');
});

// AC-5's live totals, pinned at the domain layer: 2/2 -> 1.00, 0/1 -> 0.00.
test('live calibration computes the seeded totals and null rates with no evaluations', () => {
  const rows = [
    { selected_action: 'raise_budget', evaluation: { outcome: 'correct', needless: false, evaluated_at: '2026-09-25T00:00:00.000Z' } },
    { selected_action: 'do_nothing', evaluation: { outcome: 'correct', needless: false, evaluated_at: '2026-09-25T00:00:00.000Z' } },
    { selected_action: 'shift_budget', evaluation: undefined },
  ];
  const report = calibrationReport(rows);
  assert.equal(report.precision, 1);
  assert.equal(report.falseInterventionRate, 0);
  assert.equal(report.evaluated, 2);
  assert.equal(report.correct, 2);
  assert.equal(report.interventions, 1);
  assert.equal(report.needless, 0);
  assert.equal(report.awaitingMaturity, 1);

  const empty = calibrationReport([]);
  assert.equal(empty.precision, null, 'no evaluations yet: precision is null (rendered as an em-dash)');
  assert.equal(empty.falseInterventionRate, null);
  assert.equal(empty.awaitingMaturity, 0);
});

test('calibration counts awaiting records in the denominator of nothing', () => {
  // An awaiting intervention has produced no observable outcome: it must not
  // sharpen either rate.
  const report = calibrationReport([
    { selected_action: 'raise_budget', evaluation: { outcome: 'correct', needless: false, evaluated_at: '2026-09-25T00:00:00.000Z' } },
    { selected_action: 'shift_budget', evaluation: null },
  ]);
  assert.equal(report.evaluated, 1);
  assert.equal(report.interventions, 1);
  assert.equal(report.awaitingMaturity, 1);
  assert.equal(report.precision, 1);
});

// AC-2: the frozen replay aggregate, CI-only.
test('the frozen fixture aggregates to precision 0.70 and false-intervention 0.33 across 10 matured decisions', () => {
  const report = evaluateReplay(FIXTURES.filter((scenario) => scenario.id !== 'replay-broken'));
  assert.equal(report.evaluated, 10);
  assert.equal(report.correct, 7);
  assert.equal(report.precision, 0.7, '7 correct of 10 matured');
  assert.equal(report.interventions, 6);
  assert.equal(report.needless, 2);
  assert.equal(report.falseInterventionRate, 0.33, '2 needless of 6 interventions, rounded to two decimals');
  assert.equal(report.awaitingMaturity, 3);
  assert.deepEqual(report.perScenario.map((entry) => entry.id), ['replay-cpl-hold', 'replay-tracking-outage']);
  assert.deepEqual(
    report.perScenario.map((entry) => entry.evaluated),
    [6, 4],
    'per-scenario split: 6 matured + 4 matured',
  );
  assert.equal(report.mutationsExecuted, 0, 'a replay run executes zero mutations');
});

test('evaluateReplay over an empty fold is byte-deterministic with null rates', () => {
  assert.deepEqual(evaluateReplay([]), {
    precision: null,
    falseInterventionRate: null,
    evaluated: 0,
    correct: 0,
    interventions: 0,
    needless: 0,
    awaitingMaturity: 0,
    perScenario: [],
    mutationsExecuted: 0,
  });
});

// AC-3: a target-met episode keeps proposing and records do-nothing decisions.
test('a target-met episode keeps proposing and carries a reasoned do-nothing decision', () => {
  const result = frontierCheck({
    target_cpl_met: true,
    decisions: [{ action: 'do_nothing', reason: 'qualified CPL within 15% of target; no frontier move beats holding spend' }],
  });
  assert.equal(result.keepProposing, true, 'hitting the target never stops the frontier');
  assert.equal(result.valid, true);
  assert.equal(result.doNothing.reason, 'qualified CPL within 15% of target; no frontier move beats holding spend');
});

test('a target-met episode with an unreasoned do-nothing decision is invalid', () => {
  const result = frontierCheck({ target_cpl_met: true, decisions: [{ action: 'do_nothing' }] });
  assert.equal(result.valid, false);
  assert.equal(result.doNothing, null);
  assert.equal(result.keepProposing, true, 'keepProposing holds regardless of decision quality');
});
