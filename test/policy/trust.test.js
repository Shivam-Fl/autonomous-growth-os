// The trust ledger (issue #20, TR-4): autonomy is earned per action class and
// a class with no evidence is held to a human. Every threshold lives in
// trust.js; these cases pin them so the posture table and the gate cannot
// drift from each other or from the numbers they quote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POSTURE_LABELS, THRESHOLDS, postureFor, recordOutcome, scoreFor } from '../../src/policy/trust.js';

const ROSTER = { action_class: 'campaign-status' };

test('autonomy needs every threshold met, and one failure drops the class to a human', () => {
  const earned = { evaluated: 6, correct: 6, needless: 0, downside_penalties: 0 };
  assert.equal(postureFor('campaign-status', earned, ROSTER, false), 'autonomous-under-micro-limits');

  // One threshold at a time, each failing alone.
  const cases = [
    ['minEvaluated', { evaluated: 2, correct: 2, needless: 0, downside_penalties: 0 }],
    ['minPrecision', { evaluated: 6, correct: 5, needless: 0, downside_penalties: 0 }],
    ['maxFalseIntervention', { evaluated: 100, correct: 90, needless: 10, downside_penalties: 0 }],
    ['maxDownsidePenalties', { evaluated: 6, correct: 6, needless: 0, downside_penalties: 1 }],
  ];
  for (const [name, row] of cases) {
    assert.equal(postureFor('campaign-status', row, ROSTER, false), 'approval-required', `${name} must fail closed`);
  }
});

test('a pinned row is shadow however perfect the score', () => {
  const perfect = { evaluated: 40, correct: 40, needless: 0, downside_penalties: 0 };
  assert.equal(postureFor('creative-refresh', perfect, ROSTER, true), 'shadow');
});

test('a class with NO row is approval-required: the fail-closed default', () => {
  assert.equal(postureFor('campaign-launch', null, ROSTER, false), 'approval-required');
  assert.equal(postureFor('campaign-launch', undefined, ROSTER, false), 'approval-required');
});

test('a class absent from the roster is shadow, because nothing can gate it', () => {
  assert.equal(postureFor('not-a-class', { evaluated: 9, correct: 9, needless: 0, downside_penalties: 0 }, null, false), 'shadow');
});

test('recordOutcome folds one evaluation into the next row', () => {
  const before = { action_class: 'budget-change', evaluated: 2, correct: 2, needless: 0, downside_penalties: 0 };
  const after = recordOutcome(before, { outcome: 'correct' });
  assert.equal(after.evaluated, 3);
  assert.equal(after.correct, 3);
  assert.equal(after.needless, 0);
  assert.equal(after.downside_penalties, 0);
  // The threshold is now met on all four counts, so the posture moves.
  assert.equal(postureFor('budget-change', before, ROSTER, false), 'approval-required');
  assert.equal(postureFor('budget-change', after, ROSTER, false), 'autonomous-under-micro-limits');
});

test('a failed outcome is counted as an error and a needless intervention', () => {
  const after = recordOutcome({ evaluated: 3, correct: 3, needless: 0, downside_penalties: 0 }, { outcome: 'failure', needless: true, downside: true });
  assert.equal(after.evaluated, 4);
  assert.equal(after.correct, 3);
  assert.equal(after.needless, 1);
  assert.equal(after.downside_penalties, 1);
  assert.equal(postureFor('campaign-status', after, ROSTER, false), 'approval-required');
});

test('scoreFor reports precision and false-intervention rate as numbers', () => {
  const score = scoreFor({ evaluated: 4, correct: 3, needless: 1, downside_penalties: 0 });
  assert.equal(score.precision, 0.75);
  assert.equal(score.false_intervention_rate, 0.25);
  assert.equal(score.autonomous, false);
});

test('POSTURE_LABELS holds exactly the three display strings the page renders', () => {
  assert.deepEqual(Object.keys(POSTURE_LABELS).sort(), ['approval-required', 'autonomous-under-micro-limits', 'shadow']);
  assert.equal(POSTURE_LABELS['autonomous-under-micro-limits'], 'autonomous under micro-limits');
  assert.equal(POSTURE_LABELS['approval-required'], 'approval required');
  assert.equal(POSTURE_LABELS.shadow, 'shadow');
  for (const posture of Object.keys(POSTURE_LABELS)) {
    assert.ok(POSTURE_LABELS[posture] === String(POSTURE_LABELS[posture]).toLowerCase(), 'labels are the display strings');
  }
});

test('the thresholds themselves are pinned: they are the numbers the fixtures were chosen against', () => {
  assert.deepEqual(THRESHOLDS, {
    minEvaluated: 3,
    minPrecision: 0.9,
    maxFalseIntervention: 0.05,
    maxDownsidePenalties: 0,
  });
});
