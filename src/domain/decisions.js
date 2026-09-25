// Decision domain (TR-6, TR-15): the decision record shipped with every
// consequential decision, its validation, maturity evaluation and calibration
// math. Pure computations over plain records — no IO here (conventions: domain
// modules never import a driver), and the frozen replay path imports nothing
// that can mutate: no executor, no policy kernel, no fetch.
//
// ONE calibration source for every live surface (rejected alternative (a),
// work order): the /journal panel and GET /v1/calibration are computed from
// the decisions repository through the outcome carried on the record itself.
// The frozen replay evaluator below is CI-only and reads no fixture — the
// fixture stays under test/ so src/ never imports it.

export function decisionError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

/** TR-13/14 action classes this slice records. The journal filters on them. */
export const DECISION_CLASSES = Object.freeze([
  'budget-change',
  'campaign-status',
  'creative-refresh',
  'campaign-launch',
]);

/** Hours between a decision and the moment it is evaluated (TR-15): the
 * maximum conversion lag the default lag model credits before maturity. */
export const EVALUATION_LAG_HOURS = 120;
const EVALUATION_LAG_MS = EVALUATION_LAG_HOURS * 3_600_000;

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// Same rule the event envelope validator applies: UTC ISO-8601 only.
function timestampCode(value) {
  if (!nonEmptyString(value)) {
    return 'MISSING_DECIDED_AT';
  }
  if (Number.isNaN(Date.parse(value))) {
    return 'BAD_DECIDED_AT';
  }
  if (!value.endsWith('Z') && !/[+-]00:?00$/.test(value)) {
    return 'NON_UTC_DECIDED_AT';
  }
  return null;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function round2(ratio) {
  return Math.round(ratio * 100) / 100;
}

/** The chosen alternative's expected effect distribution: {mean, p10, p90}
 * numbers, expected deltas of the objective (e.g. qualified CPL change). */
function validateDistribution(distribution, field) {
  if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution)) {
    return `alternative ${field}: expected_outcomes must be a {mean,p10,p90} object`;
  }
  for (const key of ['mean', 'p10', 'p90']) {
    if (!isFiniteNumber(distribution[key])) {
      return `alternative ${field}: expected_outcomes.${key} must be a finite number`;
    }
  }
  return null;
}

/**
 * Validate one decision record. Returns {ok, record} (field defaults filled)
 * or {ok:false, error:{code,message,details}}. Stable codes:
 * MISSING_STATE_SNAPSHOT, MISSING_DO_NOTHING, BAD_DISTRIBUTION, INVALID_MONEY,
 * BAD_EVALUATION — anything else is a missing or malformed field the caller
 * sent, and names the field.
 */
export function validateDecisionRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      error: decisionError('MISSING_DO_NOTHING', 'decision record must be an object'),
    };
  }

  if (!nonEmptyString(input.decision_id) || !input.decision_id.startsWith('dec_')) {
    return {
      ok: false,
      error: decisionError(
        'MISSING_DO_NOTHING',
        'decision record is missing or has a badly prefixed decision_id',
        { field: 'decision_id' },
      ),
    };
  }
  if (!nonEmptyString(input.tenant_id)) {
    return {
      ok: false,
      error: decisionError('MISSING_DO_NOTHING', 'decision record is missing tenant_id', { field: 'tenant_id' }),
    };
  }
  if (!nonEmptyString(input.state_snapshot_id)) {
    return {
      ok: false,
      error: decisionError(
        'MISSING_STATE_SNAPSHOT',
        'every decision references an immutable state snapshot (TR-6); state_snapshot_id is missing',
        { field: 'state_snapshot_id' },
      ),
    };
  }
  const decidedAtCode = timestampCode(input.decided_at);
  if (decidedAtCode) {
    return {
      ok: false,
      error: decisionError(
        decidedAtCode,
        `decided_at must be a UTC ISO-8601 timestamp, got ${JSON.stringify(input.decided_at)}`,
        { field: 'decided_at' },
      ),
    };
  }
  if (!DECISION_CLASSES.includes(input.action_class)) {
    return {
      ok: false,
      error: decisionError(
        'UNKNOWN_ACTION_CLASS',
        `action_class must be one of ${DECISION_CLASSES.join(', ')}, got ${JSON.stringify(input.action_class)}`,
        { field: 'action_class' },
      ),
    };
  }

  if (!Array.isArray(input.alternatives) || input.alternatives.length < 2) {
    return {
      ok: false,
      error: decisionError(
        'MISSING_DO_NOTHING',
        'alternatives must include exactly one do_nothing entry and at least one non-do-nothing alternative (TR-6)',
        { field: 'alternatives' },
      ),
    };
  }
  const doNothingEntries = input.alternatives.filter((entry) => entry?.action === 'do_nothing');
  if (doNothingEntries.length !== 1 || !nonEmptyString(doNothingEntries[0].reason)) {
    return {
      ok: false,
      error: decisionError(
        'MISSING_DO_NOTHING',
        'exactly one do_nothing alternative carrying a non-empty reason is required (TR-6)',
        { field: 'alternatives' },
      ),
    };
  }
  const nonDoNothing = input.alternatives.filter((entry) => entry?.action !== 'do_nothing');
  if (nonDoNothing.length === 0) {
    return {
      ok: false,
      error: decisionError(
        'MISSING_DO_NOTHING',
        'at least one non-do-nothing alternative is required (TR-6)',
        { field: 'alternatives' },
      ),
    };
  }
  for (const [index, entry] of input.alternatives.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        ok: false,
        error: decisionError('BAD_DISTRIBUTION', `alternatives[${index}] must be an object`, { field: 'alternatives' }),
      };
    }
    // Every alternative surfaces an expected effect distribution in the
    // journal drawer, so the do-nothing baseline is comparable to the move.
    for (const field of ['action', 'expected_outcomes']) {
      if (!(field in entry) || entry[field] === null) {
        return {
          ok: false,
          error: decisionError(
            field === 'expected_outcomes' ? 'BAD_DISTRIBUTION' : 'MISSING_DO_NOTHING',
            `alternatives[${index}] is missing ${field}`,
            { field },
          ),
        };
      }
    }
    if (!nonEmptyString(entry.action)) {
      return {
        ok: false,
        error: decisionError('MISSING_DO_NOTHING', `alternatives[${index}].action must be a non-empty string`, { field: 'alternatives' }),
      };
    }
    const distributionCode = validateDistribution(entry.expected_outcomes, String(entry.action));
    if (distributionCode) {
      return {
        ok: false,
        error: decisionError('BAD_DISTRIBUTION', distributionCode, { field: 'alternatives' }),
      };
    }
  }
  const actions = input.alternatives.map((entry) => entry.action);
  if (new Set(actions).size !== actions.length) {
    return {
      ok: false,
      error: decisionError('MISSING_DO_NOTHING', 'alternative actions must be unique', { field: 'alternatives' }),
    };
  }
  // selected_action names which alternative was chosen and is what the
  // journal's Selected column and the intervention rate count on.
  if (!actions.includes(input.selected_action)) {
    return {
      ok: false,
      error: decisionError(
        'MISSING_DO_NOTHING',
        `selected_action must match an alternative, got ${JSON.stringify(input.selected_action)}`,
        { field: 'selected_action' },
      ),
    };
  }

  const risk = input.risk;
  if (!risk || typeof risk !== 'object' || Array.isArray(risk)) {
    return {
      ok: false,
      error: decisionError('INVALID_MONEY', 'risk must be an object with expected_downside_micros and worst_reasonable_case', { field: 'risk' }),
    };
  }
  if (!Number.isSafeInteger(risk.expected_downside_micros)) {
    return {
      ok: false,
      error: decisionError(
        'INVALID_MONEY',
        `risk.expected_downside_micros must be an integer number of micros, got ${JSON.stringify(risk.expected_downside_micros)}`,
        { field: 'risk.expected_downside_micros' },
      ),
    };
  }
  if (!nonEmptyString(risk.worst_reasonable_case)) {
    return {
      ok: false,
      error: decisionError('INVALID_MONEY', 'risk.worst_reasonable_case must be a non-empty string', { field: 'risk' }),
    };
  }

  for (const field of ['evidence_refs', 'memory_refs', 'model_versions', 'prompt_versions']) {
    if (!Array.isArray(input[field])) {
      return {
        ok: false,
        error: decisionError('MISSING_DO_NOTHING', `${field} must be an array (TR-6, TR-12)`, { field }),
      };
    }
  }
  if (!nonEmptyString(input.critic_result)) {
    return {
      ok: false,
      error: decisionError('MISSING_DO_NOTHING', 'critic_result must be a non-empty string (TR-12)', { field: 'critic_result' }),
    };
  }
  if (!nonEmptyString(input.policy_decision_id)) {
    return {
      ok: false,
      error: decisionError('MISSING_DO_NOTHING', 'policy_decision_id must be a non-empty string (TR-12)', { field: 'policy_decision_id' }),
    };
  }

  const evaluation = input.evaluation;
  if (evaluation !== undefined && evaluation !== null) {
    if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) {
      return {
        ok: false,
        error: decisionError(
          'BAD_EVALUATION',
          'evaluation must be an {outcome, needless, evaluated_at} object',
          { field: 'evaluation' },
        ),
      };
    }
    if (!['correct', 'incorrect'].includes(evaluation.outcome)) {
      return {
        ok: false,
        error: decisionError(
          'BAD_EVALUATION',
          `evaluation.outcome must be correct or incorrect, got ${JSON.stringify(evaluation.outcome)}`,
          { field: 'evaluation.outcome' },
        ),
      };
    }
    if (typeof evaluation.needless !== 'boolean') {
      return {
        ok: false,
        error: decisionError(
          'BAD_EVALUATION',
          `evaluation.needless must be a boolean, got ${JSON.stringify(evaluation.needless)}`,
          { field: 'evaluation.needless' },
        ),
      };
    }
    const evaluatedAtCode = timestampCode(evaluation.evaluated_at);
    if (evaluatedAtCode) {
      return {
        ok: false,
        error: decisionError(
          'BAD_EVALUATION',
          `evaluation.evaluated_at must be a UTC ISO-8601 timestamp, got ${JSON.stringify(evaluation.evaluated_at)}`,
          { field: 'evaluation.evaluated_at' },
        ),
      };
    }
    // An outcome exists only once the decision matured: the evaluation came
    // at or after decided_at + 120h, never inside the lag window.
    if (Date.parse(evaluation.evaluated_at) < expectedEvaluationAt(input.decided_at).getTime()) {
      return {
        ok: false,
        error: decisionError(
          'BAD_EVALUATION',
          `evaluation.evaluated_at ${evaluation.evaluated_at} is before the decision matured (${expectedEvaluationAtIso(input.decided_at)}); outside the lag window no outcome exists yet`,
          { field: 'evaluation.evaluated_at' },
        ),
      };
    }
  }

  return {
    ok: true,
    record: {
      decision_id: input.decision_id,
      tenant_id: input.tenant_id,
      state_snapshot_id: input.state_snapshot_id,
      decided_at: new Date(input.decided_at).toISOString(),
      action_class: input.action_class,
      selected_action: input.selected_action,
      alternatives: input.alternatives,
      risk: risk,
      evidence_refs: input.evidence_refs,
      memory_refs: input.memory_refs,
      critic_result: input.critic_result,
      policy_decision_id: input.policy_decision_id,
      model_versions: input.model_versions,
      prompt_versions: input.prompt_versions,
      ...(evaluation ? { evaluation } : {}),
    },
  };
}

/** The moment a decision's outcome is due: decided_at + 120h (the default lag
 * model's full-maturity point). Computed example, pinned by tests:
 * decided 2026-09-20T00:00:00.000Z -> expected evaluation 2026-09-25T00:00:00.000Z. */
export function expectedEvaluationAt(decidedAt) {
  return new Date(Date.parse(decidedAt) + EVALUATION_LAG_MS);
}

/** Same as expectedEvaluationAt but as a UTC ISO-8601 string. */
export function expectedEvaluationAtIso(decidedAt) {
  return expectedEvaluationAt(decidedAt).toISOString();
}

/** A decision is matured once now is past its evaluation moment. */
export function evaluationStatus(decision, nowIso) {
  return Date.parse(nowIso) >= expectedEvaluationAt(decision.decided_at).getTime()
    ? 'matured'
    : 'awaiting-maturity';
}

/**
 * LIVE calibration aggregate over validated decision records (repository
 * rows). An outcome counts strictly when the record carries an evaluation:
 * precision = correct / evaluated, and the false-intervention rate =
 * needless / interventions where an intervention is an evaluated record
 * whose selected_action is anything but do_nothing — an awaiting decision
 * has produced no observable outcome, so it cannot sharpen either rate.
 * Both rates round to two decimals and are null when their denominator is
 * zero (rendered as an em-dash). Invariants: correct <= evaluated and
 * needless <= interventions.
 */
export function calibrationReport(records) {
  const rows = records ?? [];
  const evaluated = rows.filter((record) => record.evaluation !== undefined && record.evaluation !== null);
  const correct = evaluated.filter((record) => record.evaluation.outcome === 'correct').length;
  const interventions = evaluated.filter((record) => record.selected_action !== 'do_nothing');
  const needless = interventions.filter((record) => record.evaluation.needless === true).length;
  return {
    precision: evaluated.length > 0 ? round2(correct / evaluated.length) : null,
    falseInterventionRate: interventions.length > 0 ? round2(needless / interventions.length) : null,
    evaluated: evaluated.length,
    correct,
    interventions: interventions.length,
    needless,
    awaitingMaturity: rows.length - evaluated.length,
  };
}

/** Whole-integer correction: calibrationReport's output rates come out
 * rounded; the raw ratios are what the page renders through toFixed(2). */
export function rateOrDash(rate, dashboard = false) {
  if (rate === null || rate === undefined) {
    return '—';
  }
  return dashboard ? rate.toFixed(2) : String(rate);
}

/**
 * TR-8: a simulator episode that meets its target keeps proposing frontier
 * moves and records a valid do-nothing decision. An episode carries
 * {target_cpl_met, decisions: [{action, reason?}]}. Returns
 * {keepProposing, doNothing, valid} — doNothing is the do-nothing entry that
 * carries a reason, null otherwise; valid is false when a target that was
 * met produced no reasoned do-nothing decision.
 */
export function frontierCheck(episode) {
  const decisions = episode?.decisions ?? [];
  const doNothing = decisions.find((entry) =>
    entry?.action === 'do_nothing' && nonEmptyString(entry.reason)) ?? null;
  return {
    keepProposing: true,
    doNothing: doNothing === null ? null : { action: doNothing.action, reason: doNothing.reason },
    valid: doNothing !== null,
  };
}

/**
 * Fold frozen replay scenarios into the single AGGREGATE calibration report
 * plus the per-scenario breakdown. CI-only — the /journal page never renders
 * this. Import-pure: nothing here can mutate anything, and the function
 * returns mutationsExecuted: 0 as that claim's shape.
 */
export function evaluateReplay(scenarios) {
  const list = scenarios ?? [];
  const perScenario = list.map((scenario) => {
    const decisions = scenario?.decisions ?? [];
    // A matured decision has reached its evaluation moment and carries an
    // outcome; an awaiting one is excluded from every rate (same rule the
    // live aggregate applies to unevaluated records).
    const matured = decisions.filter((decision) => decision.matured === true);
    const interventions = matured.filter((decision) => decision.selected_action !== 'do_nothing');
    return {
      id: scenario.id,
      evaluated: matured.length,
      correct: matured.filter((decision) => decision.evaluation?.outcome === 'correct').length,
      interventions: interventions.length,
      needless: interventions.filter((decision) => decision.evaluation?.needless === true).length,
      awaiting: decisions.length - matured.length,
    };
  });

  const totals = calibrationReport(
    list.flatMap((scenario) =>
      (scenario?.decisions ?? [])
        .filter((decision) => decision.matured === true)
        .map((decision) => ({
          // The live shape calibrationReport folds over.
          selected_action: decision.selected_action,
          evaluation: decision.evaluation ?? undefined,
        }))),
  );

  return {
    ...totals,
    perScenario,
    mutationsExecuted: 0,
  };
}
