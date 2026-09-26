// Trust calibration (issue #20, TR-19): one function derives one posture per
// action class from one stored ledger row, and BOTH the approvals page's
// posture table and the policy kernel's gate call it. Two callers, one
// derivation: the label a reader sees on the table is the verdict a write is
// admitted against, and a trust row that moves moves both.
//
// Pure — no IO, no repository import. The ledger row arrives as an argument.

/** The three machine postures, as the display strings the page renders and the
 * acceptance criterion quotes. Kept here rather than in the view so the
 * strings the criterion compares against are the strings the page emits. */
export const POSTURE_LABELS = Object.freeze({
  'autonomous-under-micro-limits': 'autonomous under micro-limits',
  'approval-required': 'approval required',
  shadow: 'shadow',
});

/**
 * The thresholds autonomy is earned at, in one place. A single failing
 * threshold drops the class to approval-required — the thresholds are a
 * conjunction, not an average, because "mostly right" is not a licence to
 * spend the operator's money without asking.
 */
export const THRESHOLDS = Object.freeze({
  /** Below this many evaluations, a class has not demonstrated anything. */
  minEvaluated: 3,
  /** correct / evaluated */
  minPrecision: 0.9,
  /** needless / evaluated */
  maxFalseIntervention: 0.05,
  /** A class that has ever caused a downside penalty never gets autonomy. */
  maxDownsidePenalties: 0,
});

/**
 * Score one stored ledger row. Returns the ratios alongside the verdict so the
 * page can show WHY a class is not autonomous, and so a threshold change
 * shows up in one assertion rather than in a rendered string.
 */
export function scoreFor(row) {
  const evaluated = Number(row?.evaluated ?? 0);
  const correct = Number(row?.correct ?? 0);
  const needless = Number(row?.needless ?? 0);
  const downsidePenalties = Number(row?.downside_penalties ?? 0);
  const precision = evaluated > 0 ? correct / evaluated : null;
  const falseInterventionRate = evaluated > 0 ? needless / evaluated : null;
  const autonomous = evaluated >= THRESHOLDS.minEvaluated
    && precision !== null && precision >= THRESHOLDS.minPrecision
    && falseInterventionRate !== null && falseInterventionRate <= THRESHOLDS.maxFalseIntervention
    && downsidePenalties <= THRESHOLDS.maxDownsidePenalties;
  return {
    evaluated,
    correct,
    needless,
    downside_penalties: downsidePenalties,
    pinned: row?.pinned === true,
    precision,
    false_intervention_rate: falseInterventionRate,
    autonomous,
  };
}

/**
 * The posture for one action class.
 *
 *   actionClass — the class slug, so an unknown class can be named back.
 *   row         — the trust_ledger row, or null when the class has no evidence.
 *   roster      — the class's entry from kernel.ACTION_CLASSES. A class the
 *                 roster does not hold is shadow, which is the fail-closed
 *                 answer for a class this build has no policy about.
 *   pinned      — an explicit pin that overrides the score entirely.
 *
 * A class with NO row is approval-required, never autonomous and never shadow:
 * holding a human at the button is the safe reading of "we have not measured
 * this", and it is the only other path to that label. The pin forces shadow
 * whatever the score says, which is how a class stays in shadow after it has
 * earned autonomy.
 */
export function postureFor(actionClass, row, roster, pinned) {
  if (!roster) {
    return 'shadow';
  }
  const forced = pinned ?? row?.pinned ?? false;
  if (forced) {
    return 'shadow';
  }
  if (!row) {
    return 'approval-required';
  }
  return scoreFor(row).autonomous ? 'autonomous-under-micro-limits' : 'approval-required';
}

/**
 * Fold one evaluation into the next row. This is what a later slice's
 * strategy code calls after a decision matures; it lives beside the scorer so
 * the numbers a fold produces are the numbers the thresholds read.
 */
export function recordOutcome(row, { outcome, needless = false, downside = false }) {
  return {
    evaluated: Number(row?.evaluated ?? 0) + 1,
    correct: Number(row?.correct ?? 0) + (outcome === 'correct' ? 1 : 0),
    needless: Number(row?.needless ?? 0) + (needless ? 1 : 0),
    downside_penalties: Number(row?.downside_penalties ?? 0) + (downside ? 1 : 0),
    pinned: row?.pinned === true,
  };
}
