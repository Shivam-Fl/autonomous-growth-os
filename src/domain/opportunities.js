// Opportunity economy (spec section 26): score competing bets from stored
// components, rank them on the stored score alone, and expose every component
// so the ranker's own calibration can be evaluated later. Pure computations
// over plain records — no IO here (conventions: domain modules never import a
// driver, and this module never imports node:sqlite).
//
//   Score = value x pSuccess x fit x infoValue x reversibility
//         / cost / downsideRisk / opportunityDelay
//
// Money is integer micros of the currency's major unit, like every other
// record in this app (TR-1/TR-20, conventions, money.js): value_micros and
// cost_micros are non-negative safe integers, and the other six components are
// dimensionless multipliers. The score is scale-free — value_micros divided by
// cost_micros is the same ratio either way.
//
// Divisor floors: cost is floored at one currency unit in micros and downside
// and delay at 1, so a zero cost can never divide by zero or score infinite.
// The stored score is the ONLY rank key everywhere (score desc, id asc);
// expectedContribution is a stored display field, never a sort key. A record
// this build cannot read reports null on the wire rather than a number it
// cannot stand behind.
//
// The read side has one rule too, and it is the twin of the write-side rules
// above: isReadableComponent below, derived from COMPONENTS, is what every
// consumer of a stored record consults. Four consumers each re-deriving it
// from whichever keys the bug that motivated them happened to name is how one
// record came to be readable in the projection and unreadable in the
// contribution.

const COMPONENTS = ['value_micros', 'pSuccess', 'fit', 'infoValue', 'reversibility', 'cost_micros', 'downside', 'delay'];
const RATIO_COMPONENTS = ['pSuccess', 'fit', 'reversibility', 'infoValue'];
const MONEY_COMPONENTS = ['value_micros', 'cost_micros'];

/** Divisor floor (spec section 26): a zero-cost opportunity is scored with
 * cost treated as one currency unit, never as a divide-by-zero or an infinite
 * score. The floor carries the money unit with it, or the zero-cost score
 * would silently rescale by 1e6. */
const MICROS_PER_UNIT = 1_000_000;

/** downside and delay are multipliers, not money, so their floor is 1. */
const DIMENSIONLESS_FLOOR = 1;

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
 * The read-side rule, and the only definition of it: can this build stand
 * behind this stored number? Money is a non-negative safe integer of micros —
 * the same rule validateOpportunity enforces on the way in — and every other
 * component must be a finite number.
 *
 * It is a number check, not a coercion, so a numeric string such as
 * '2000000000' is unreadable rather than silently read as 2e9, and a null or
 * undefined is unreadable for every key.
 *
 * What it deliberately does NOT answer is "does this record satisfy every
 * domain range". Re-running validateOpportunity on a read would conflate a
 * number the build can print with a record the build endorses: a stored
 * pSuccess of 1.5 is out of range and is still a finite number, so it stays
 * readable and stays on the wire. Range rules stay on the write side.
 */
export function isReadableComponent(key, value) {
  return MONEY_COMPONENTS.includes(key)
    ? Number.isSafeInteger(value) && value >= 0
    : isFiniteNumber(value);
}

/**
 * The component keys of a stored record this build cannot stand behind, in
 * COMPONENTS order. The array rather than a boolean because the seed's
 * operator-facing error has to name the keys that failed, and a record this
 * build cannot read is a specific diagnosis rather than a verdict.
 */
export function unreadableComponents(record) {
  return COMPONENTS.filter((key) => !isReadableComponent(key, record?.[key]));
}

/** True when every component of a stored record is readable — the seed guard's
 * question, and the one answer every consumer of a stored record agrees on. */
export function isReadableOpportunityRecord(record) {
  return unreadableComponents(record).length === 0;
}

/**
 * The wire projection of a stored record's components: all eight keys, always,
 * in COMPONENTS order, each readable value passed through and each unreadable
 * one null.
 *
 * Always-present is the point. An unreadable component is present-and-null,
 * never a dropped key, because JSON.stringify removes an undefined one and a
 * client cannot tell a component the build chose not to return from a
 * component that was never stored. Deriving the projection from COMPONENTS is
 * also what makes it impossible for a key to be left out — the eight
 * hand-written lines this replaced are how a record missing pSuccess reached
 * the wire with seven keys.
 */
export function readableComponents(record) {
  const components = {};
  for (const key of COMPONENTS) {
    components[key] = isReadableComponent(key, record?.[key]) ? record[key] : null;
  }
  return components;
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
  // profit). The two money components are integer micros (the divisor floors
  // land in scoreOpportunity, not here).
  for (const key of RATIO_COMPONENTS.filter((key) => key !== 'infoValue')) {
    if (input[key] < 0 || input[key] > 1) {
      return rejected('OPP_BAD_COMPONENT', key, 'must be between 0 and 1');
    }
  }
  if (input.infoValue < 0) {
    return rejected('OPP_BAD_COMPONENT', 'infoValue', 'must be non-negative');
  }
  // Money is integer micros: a fractional rupee, a negative amount and a value
  // above MAX_SAFE_INTEGER are all rejected, so every stored amount is exact.
  for (const key of MONEY_COMPONENTS) {
    const micros = input[key];
    if (!Number.isSafeInteger(micros) || micros < 0) {
      return rejected('OPP_BAD_MONEY', key, `must be a non-negative integer number of micros, got ${JSON.stringify(micros)}`);
    }
  }
  for (const key of ['downside', 'delay']) {
    if (input[key] < 0) {
      return rejected('OPP_BAD_COMPONENT', key, 'must be non-negative');
    }
  }
  // The score is the product of the five numerator components, so the product
  // is bounded too: individually in-range components (a safe-integer
  // value_micros times infoValue 1e308) overflow to an infinite score, which
  // would rank above every real opportunity and store as null in the score
  // column.
  if (!Number.isFinite(numeratorProduct(input))) {
    return rejected('OPP_BAD_COMPONENT', 'components', 'the product of value_micros, pSuccess, fit, infoValue and reversibility must be a finite number');
  }
  const opportunity = {
    opportunity_id: input.opportunity_id,
    tenant_id: input.tenant_id,
    name: typeof input.name === 'string' && input.name.length > 0 ? input.name : input.opportunity_id,
    value_micros: input.value_micros,
    pSuccess: input.pSuccess,
    fit: input.fit,
    infoValue: input.infoValue,
    reversibility: input.reversibility,
    cost_micros: input.cost_micros,
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
  return opportunity.value_micros * opportunity.pSuccess * opportunity.fit * opportunity.infoValue * opportunity.reversibility;
}

/** Score one validated opportunity from its stored components, divisors
 * floored so a zero cost/downside/delay scores high, not infinite. The money
 * floor is one currency unit in micros; the ratio is scale-free, so the floor
 * moves with the unit and the score does not. */
export function scoreOpportunity(opportunity) {
  const costMicros = Math.max(opportunity.cost_micros, MICROS_PER_UNIT);
  const downside = Math.max(opportunity.downside, DIMENSIONLESS_FLOOR);
  const delay = Math.max(opportunity.delay, DIMENSIONLESS_FLOOR);
  const score = Math.round((numeratorProduct(opportunity) / costMicros / downside / delay) * SCORE_PRECISION) / SCORE_PRECISION;
  // validateOpportunity already rejects a non-finite numerator; this guards
  // direct callers, so an unscorable record ranks last (0), never first.
  return Number.isFinite(score) ? score : 0;
}

/**
 * Derived display field only (integer micros), never a sort key:
 * truncated(value_micros x pSuccess) - cost_micros. Both amounts are already
 * micros, so there is no unit conversion here and none to get wrong.
 *
 * null means the money is UNKNOWN, not zero. A record this build cannot read —
 * one stored before the micros rename, or a direct caller that bypasses
 * validation — gets null, because 0 is a legitimate break-even contribution and
 * a sentinel that collides with a real answer is worse than no answer. That is
 * the opposite of scoreOpportunity above, which still returns 0: a rank key
 * needs a total order and cannot express "unrankable", while a displayed amount
 * can.
 */
export function expectedContribution(opportunity) {
  const valueMicros = opportunity.value_micros;
  const costMicros = opportunity.cost_micros;
  const pSuccess = opportunity.pSuccess;
  // The guard stands IN FRONT of the arithmetic, not after it. A null or
  // undefined reaching `valueMicros * pSuccess` is 0, which would turn "the
  // money is unknown" into a confident break-even — the exact lie this returns
  // null to avoid. It asks the domain's shared rule rather than a local copy,
  // so this and the projection above can never classify a record differently.
  if (!isReadableComponent('value_micros', valueMicros)
    || !isReadableComponent('cost_micros', costMicros)
    || !isReadableComponent('pSuccess', pSuccess)) {
    return null;
  }
  const contribution = Math.trunc(valueMicros * pSuccess) - costMicros;
  // A validated value_micros is a safe integer and pSuccess <= 1, so this
  // cannot overflow; the guard is for direct callers that bypass validation.
  return Number.isSafeInteger(contribution) ? contribution : null;
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
