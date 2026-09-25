// Experiment domain (spec section 27L1): native A/B evaluation as a
// min-sample gate plus a two-proportion z-test, with a FIRST-CLASS
// inconclusive state — an experiment that cannot separate its arms is never
// forced into a binary win/loss. Pure computations over plain records, no IO
// here (conventions: domain modules never import a driver).

export const EXPERIMENT_STATES = Object.freeze([
  'draft',
  'running',
  'matured',
  'stopped',
  'inconclusive',
]);

/** Critial z at two-tailed 95%: |z| >= this separates the arms. */
export const SEPARATION_Z = 1.96;

export function experimentError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function forgot(code, field, message) {
  return { ok: false, error: experimentError(code, `${field}: ${message}`, { field }) };
}

/**
 * Validate one experiment. Returns {ok, experiment} or
 * {ok:false, error:{code,message,details}}. Stable codes: EXP_BAD_ID,
 * EXP_BAD_ARMS, EXP_BAD_CAPS, EXP_BAD_STOP_RULES, EXP_BAD_STATE,
 * EXP_BAD_DATA_THROUGH. `state: 'inconclusive'` is an accepted persisted
 * state — the first-class card state for underpowered or no-separation
 * outcomes, never forced to win or loss.
 */
export function validateExperiment(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return forgot('EXP_BAD_ID', 'experiment', 'body must be an object');
  }
  if (typeof input.experiment_id !== 'string' || !input.experiment_id.startsWith('exp_') || input.experiment_id.length <= 4) {
    return forgot('EXP_BAD_ID', 'experiment_id', `must be a string starting with exp_, got ${JSON.stringify(input.experiment_id)}`);
  }
  if (typeof input.tenant_id !== 'string' || input.tenant_id.length === 0) {
    return forgot('EXP_BAD_ID', 'tenant_id', `must be a non-empty string, got ${JSON.stringify(input.tenant_id)}`);
  }
  if (!Array.isArray(input.arms) || input.arms.length < 2
    || !input.arms.every((arm) => arm && typeof arm.id === 'string' && arm.id.length > 0
      && typeof arm.name === 'string' && arm.name.length > 0)) {
    return forgot('EXP_BAD_ARMS', 'arms', 'must be an array of at least two {id, name} objects');
  }
  if (!input.caps || typeof input.caps !== 'object') {
    return forgot('EXP_BAD_CAPS', 'caps', 'must be an object with max_spend_micros and max_downside_micros');
  }
  for (const key of ['max_spend_micros', 'max_downside_micros']) {
    const micros = input.caps[key];
    if (!Number.isSafeInteger(micros) || micros <= 0) {
      return { ok: false, error: experimentError('EXP_BAD_CAPS', `caps.${key}: must be a positive integer number of micros, got ${JSON.stringify(micros)}`, { field: `caps.${key}` }) };
    }
  }
  if (!input.stopRules || typeof input.stopRules !== 'object') {
    return forgot('EXP_BAD_STOP_RULES', 'stopRules', 'must be an object with min_runtime_hours, min_sample, success_threshold and harm_threshold');
  }
  for (const key of ['min_sample']) {
    const value = input.stopRules[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      return { ok: false, error: experimentError('EXP_BAD_STOP_RULES', `stopRules.${key}: must be a positive integer, got ${JSON.stringify(value)}`, { field: `stopRules.${key}` }) };
    }
  }
  for (const key of ['success_threshold', 'harm_threshold', 'min_runtime_hours']) {
    const value = input.stopRules[key];
    if (!isFiniteNumber(value) || value < 0) {
      return {
        ok: false,
        error: experimentError('EXP_BAD_STOP_RULES', `stopRules.${key}: must be a non-negative finite number, got ${JSON.stringify(value)}`, { field: `stopRules.${key}` }),
      };
    }
  }
  const state = input.state ?? 'draft';
  if (!EXPERIMENT_STATES.includes(state)) {
    return forgot('EXP_BAD_STATE', 'state', `must be one of ${EXPERIMENT_STATES.join('|')}, got ${JSON.stringify(state)}`);
  }
  if (typeof input.data_through !== 'string' || input.data_through.length === 0
    || Number.isNaN(Date.parse(input.data_through))) {
    return forgot('EXP_BAD_DATA_THROUGH', 'data_through', 'must be a parseable UTC ISO-8601 timestamp');
  }
  return {
    ok: true,
    experiment: {
      experiment_id: input.experiment_id,
      tenant_id: input.tenant_id,
      name: typeof input.name === 'string' && input.name.length > 0 ? input.name : input.experiment_id,
      arms: input.arms,
      caps: input.caps,
      stopRules: input.stopRules,
      state,
      data_through: input.data_through,
    },
  };
}

/** The total conversions the min-sample gate reads. */
function totalConversions(counts) {
  return counts.control_conversions + counts.treatment_conversions;
}

function proportions(counts) {
  const controlRate = counts.control_conversions / counts.control_exposures;
  const treatmentRate = counts.treatment_conversions / counts.treatment_exposures;
  return { controlRate, treatmentRate };
}

function pooledRate(counts) {
  const total = totalConversions(counts);
  const exposures = counts.control_exposures + counts.treatment_exposures;
  return total / exposures;
}

/** Two-proportion z statistic, treatment minus control. */
export function zStatistic(counts) {
  const difference = proportions(counts);
  const pooled = pooledRate(counts);
  const standardError = Math.sqrt(
    pooled * (1 - pooled) * (1 / counts.control_exposures + 1 / counts.treatment_exposures),
  );
  if (standardError === 0) {
    return 0;
  }
  return (difference.treatmentRate - difference.controlRate) / standardError;
}

/**
 * Evaluate arm counts against a min-sample gate and a two-proportion z-test
 * (L1). Results are {outcome, reason?, z?, next_state}, never forced:
 * - total conversions below min_sample → {outcome: inconclusive,
 *   reason: underpowered, next_state: inconclusive}
 * - |z| below the separation threshold → {outcome: inconclusive,
 *   reason: no-separation, next_state: inconclusive}
 * - otherwise win (treatment converts better) or loss, next_state matured.
 */
export function evaluateExperiment({ counts, min_sample: minSample, threshold = SEPARATION_Z }) {
  if (!counts || counts.control_conversions === undefined || counts.control_exposures === undefined
    || counts.treatment_conversions === undefined || counts.treatment_exposures === undefined) {
    return forgotChild('EXP_BAD_COUNTS', 'counts');
  }
  for (const key of ['control_conversions', 'control_exposures', 'treatment_conversions', 'treatment_exposures']) {
    const value = counts[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      return forgotChild('EXP_BAD_COUNTS', key);
    }
  }
  if (counts.control_exposures === 0 || counts.treatment_exposures === 0) {
    return forgotChild('EXP_BAD_COUNTS', 'exposures');
  }
  if (!Number.isSafeInteger(minSample) || minSample < 1) {
    return forgotChild('EXP_BAD_COUNTS', 'min_sample');
  }

  if (totalConversions(counts) < minSample) {
    return { outcome: 'inconclusive', reason: 'underpowered', next_state: 'inconclusive' };
  }
  const z = zStatistic(counts);
  if (Math.abs(z) < threshold) {
    return { outcome: 'inconclusive', reason: 'no-separation', next_state: 'inconclusive', z };
  }
  return {
    outcome: z > 0 ? 'win' : 'loss',
    next_state: 'matured',
    z,
  };
}

function forgotChild(code, field) {
  return { ok: false, error: experimentError(code, `${field}: invalid evaluation counts`, { field }) };
}

/**
 * Guard rail (spec section 27): every experiment carries caps and an
 * early-stop harm threshold. Returns {triggered, reason} — reason 'cap' when
 * cumulative spend has reached max_spend_micros, 'harm' when the treatment
 * converts below the control by more than harm_threshold (a fraction).
 */
export function stopRuleTriggered({ counts, stopRules, caps, spend_micros: spendMicros = null }) {
  const { control_conversions, control_exposures, treatment_conversions, treatment_exposures } = counts ?? {};
  const stopRulesPresent = stopRules && stopRules.harm_threshold !== undefined
    && control_exposures > 0 && treatment_exposures > 0;
  if (stopRulesPresent) {
    const controlRate = control_conversions / control_exposures;
    const treatmentRate = treatment_conversions / treatment_exposures;
    if (controlRate > 0 && treatmentRate < controlRate * (1 - stopRules.harm_threshold)) {
      return { triggered: true, reason: 'harm' };
    }
  }
  if (caps && caps.max_spend_micros !== undefined && spendMicros !== null
    && Number.isSafeInteger(spendMicros) && spendMicros >= caps.max_spend_micros) {
    return { triggered: true, reason: 'cap' };
  }
  return { triggered: false, reason: null };
}
