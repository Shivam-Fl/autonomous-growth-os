// Opportunity economy (spec section 26): score competing bets from stored
// components, rank them on the stored score alone, and expose every component
// so the ranker's own calibration can be evaluated later. Pure computations
// over plain records — no IO here (conventions: domain modules never import a
// driver, and this module never imports node:sqlite).
//
//   Score = value x pSuccess x fit x infoValue x reversibility
//         / cost / downsideRisk / opportunityDelay
//
// Divisor floors: cost, downside and delay each act as a divisor floored at
// 1, so a zero cost can never divide by zero or score infinite. The stored
// score is the ONLY rank key everywhere (score desc, id asc);
// expectedContribution is a stored display field, never a sort key.

const COMPONENTS = ['value', 'pSuccess', 'fit', 'infoValue', 'reversibility', 'cost', 'downside', 'delay'];
const RATIO_COMPONENTS = ['pSuccess', 'fit', 'reversibility', 'infoValue'];
const DIVISORS = ['cost', 'downside', 'delay'];

/** Divisor floor (spec section 26): a zero-cost opportunity is scored with
 * cost treated as 1, never as a divide-by-zero or an infinite score. */
const DIVISOR_FLOOR = 1;

/** Stored score precision: four decimals keeps seeded rows exactly equal to
 * the pinned examples (0.9208) and re-seeding byte-stable. */
const SCORE_PRECISION = 10_000;

export function opportunityError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate one opportunity. Returns {ok, opportunity} (defaults filled) or
 * {ok:false, error:{code,message,details}}. Stable codes: OPP_BAD_ID,
 * OPP_BAD_COMPONENT, OPP_BAD_MONEY — each names the field the caller sent.
 */
export function validateOpportunity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: opportunityError('OPP_BAD_COMPONENT', 'opportunity body must be an object') };
  }
  if (typeof input.opportunity_id !== 'string' || !input.opportunity_id.startsWith('opp_') || input.opportunity_id.length <= 4) {
    return rejected('OPP_BAD_ID', 'opportunity_id', `must be a string starting with opp_, got ${JSON.stringify(input.opportunity_id)}`);
  }
  if (typeof input.tenant_id !== 'string' || input.tenant_id.length === 0) {
    return rejected('OPP_BAD_COMPONENT', 'tenant_id', `must be a non-empty string, got ${JSON.stringify(input.tenant_id)}`);
  }
  for (const key of COMPONENTS) {
    const value = input[key];
    if (!isFiniteNumber(value)) {
      return rejected('OPP_BAD_COMPONENT', key, `must be a finite number, got ${JSON.stringify(value)}`);
    }
  }
  // Ranges: probabilities/fit/reversibility are [0,1]; information value is a
  // multiplier and may exceed 1 (information can be worth more than immediate
  // profit). Money-style components are positive finite numbers (raw, in
  // currency units: the divisor floors land in scoreOpportunity, not here).
  for (const key of RATIO_COMPONENTS.filter((key) => key !== 'infoValue')) {
    if (input[key] < 0 || input[key] > 1) {
      return rejected('OPP_BAD_COMPONENT', key, 'must be between 0 and 1');
    }
  }
  if (input.infoValue < 0) {
    return rejected('OPP_BAD_COMPONENT', 'infoValue', 'must be non-negative');
  }
  for (const key of ['value', 'cost']) {
    if (input[key] < 0) {
      return rejected('OPP_BAD_MONEY', key, 'must be non-negative');
    }
  }
  for (const key of ['downside', 'delay']) {
    if (input[key] < 0) {
      return rejected('OPP_BAD_COMPONENT', key, 'must be non-negative');
    }
  }
  // The score is the product of the five numerator components, so the product
  // is bounded too: individually in-range components (value 1e308 times
  // infoValue 1e308) overflow to an infinite score, which would rank above
  // every real opportunity and store as null in the score column.
  if (!Number.isFinite(numeratorProduct(input))) {
    return rejected('OPP_BAD_COMPONENT', 'components', 'the product of value, pSuccess, fit, infoValue and reversibility must be a finite number');
  }
  const opportunity = {
    opportunity_id: input.opportunity_id,
    tenant_id: input.tenant_id,
    name: typeof input.name === 'string' && input.name.length > 0 ? input.name : input.opportunity_id,
    value: input.value,
    pSuccess: input.pSuccess,
    fit: input.fit,
    infoValue: input.infoValue,
    reversibility: input.reversibility,
    cost: input.cost,
    downside: input.downside,
    delay: input.delay,
  };
  return { ok: true, opportunity };
}

function rejected(code, field, message) {
  return { ok: false, error: opportunityError(code, `${field}: ${message}`, { field }) };
}

/** The score's numerator: the five multiplied components (spec section 26). */
function numeratorProduct(opportunity) {
  return opportunity.value * opportunity.pSuccess * opportunity.fit * opportunity.infoValue * opportunity.reversibility;
}

/** Score one validated opportunity from its stored components, divisors
 * floored so a zero cost/downside/delay scores high, not infinite. */
export function scoreOpportunity(opportunity) {
  const [cost, downside, delay] = DIVISORS.map((key) => Math.max(opportunity[key], DIVISOR_FLOOR));
  const score = Math.round((numeratorProduct(opportunity) / cost / downside / delay) * SCORE_PRECISION) / SCORE_PRECISION;
  // validateOpportunity already rejects a non-finite numerator; this guards
  // direct callers, so an unscorable record ranks last (0), never first.
  return Number.isFinite(score) ? score : 0;
}

/**
 * Derived display field only (integer micros), never a sort key:
 * truncated(value in micros x pSuccess) - truncated cost in micros. `value`
 * and `cost` are recorded in currency units, so micros are x 1e6.
 */
export function expectedContribution(opportunity) {
  const valueMicros = Math.trunc(opportunity.value * 1_000_000);
  const costMicros = Math.trunc(opportunity.cost * 1_000_000);
  return Math.trunc(valueMicros * opportunity.pSuccess) - costMicros;
}

/**
 * The one rank key everywhere: stored score desc, then opportunity_id asc as
 * a deterministic tiebreak. Rows already carry their stored score; ties never
 * depend on insertion order. A non-finite score is unscorable and ranks last
 * (validation rejects one on the way in), so the comparator never subtracts
 * NaN and falls through to the tiebreak.
 */
export function rankOpportunities(rows) {
  const rankable = (row) => (Number.isFinite(row.score) ? row.score : null);
  return [...rows].sort((a, b) => {
    const scoreA = rankable(a);
    const scoreB = rankable(b);
    if (scoreA !== scoreB) {
      if (scoreA === null) {
        return 1;
      }
      if (scoreB === null) {
        return -1;
      }
      return scoreB - scoreA;
    }
    if (a.opportunity_id === b.opportunity_id) {
      return 0;
    }
    return a.opportunity_id < b.opportunity_id ? -1 : 1;
  });
}
