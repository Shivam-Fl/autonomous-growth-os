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
// The read side has one rule too, and it is the SAME rule as the write-side
// rules above rather than a looser twin: isReadableComponent below answers with
// the per-key table COMPONENT_RULES holds, and validateOpportunity asks the same
// table. Every consumer of a stored record consults it — four consumers each
// re-deriving the rule from whichever keys the bug that motivated them happened
// to name is how one record came to be readable in the projection and
// unreadable in the contribution.

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

/** Money is integer micros: exact, non-negative, and no larger than the
 * largest integer JS can round-trip. Anything else is an amount this build
 * cannot state without lying about it. */
function isReadableMoney(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** pSuccess, fit and reversibility are probabilities: a closed [0,1]. */
function isReadableRatio(value) {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

/** infoValue, downside and delay are multipliers: finite and non-negative.
 * Unlike the probabilities they may exceed 1 — information can be worth more
 * than the immediate profit, and a downside of 2 is a real lever. */
function isReadableMultiplier(value) {
  return isFiniteNumber(value) && value >= 0;
}

/**
 * The domain's per-key rule: what a value must be for this build to stand
 * behind it, keyed in COMPONENTS order. One predicate per key, holding exactly
 * the rule validateOpportunity enforces on the way in — so the read side and
 * the write side cannot drift apart and answer differently about one record.
 *
 * Kept beside COMPONENTS rather than derived from it, and deliberately NOT
 * read back as `Object.keys` to form COMPONENTS: object key order would then
 * decide the wire projection's order, which is part of the contract
 * (test/domain/opportunity-readability.test.js pins all eight keys in order).
 */
const COMPONENT_RULES = {
  value_micros: isReadableMoney,
  pSuccess: isReadableRatio,
  fit: isReadableRatio,
  infoValue: isReadableMultiplier,
  reversibility: isReadableRatio,
  cost_micros: isReadableMoney,
  downside: isReadableMultiplier,
  delay: isReadableMultiplier,
};

/**
 * The read-side rule, and the only definition of it: can this build stand
 * behind this stored value? The verdict is the key's own rule from
 * COMPONENT_RULES, so a key with no rule is unreadable rather than readable.
 *
 * This is the SAME rule validateOpportunity applies, per key, on write — not a
 * looser "is it a number" check beside it. That is what makes the wire
 * contract hold instead of merely being asserted: a readable value_micros is a
 * non-negative safe integer and a readable pSuccess is in [0,1], so
 * `trunc(value_micros x pSuccess) - cost_micros` always lands inside
 * [-MAX_SAFE_INTEGER, MAX_SAFE_INTEGER] and IS a safe integer. A read rule that
 * accepted, say, a pSuccess of 1.5 left the contribution's own overflow guard
 * reachable through the wire — eight readable components beside a null
 * contribution, which no client can reconcile.
 *
 * It remains a number check, not a coercion: a numeric string such as
 * '2000000000' is unreadable rather than silently read as 2e9, and a null or
 * undefined is unreadable for every key.
 */
export function isReadableComponent(key, value) {
  return COMPONENT_RULES[key]?.(value) === true;
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
  // Ranges, decided by the same per-key table the read side asks.
  // pSuccess/fit/reversibility is [0,1]; information value is a multiplier
  // and may exceed 1 (information can be worth more than immediate profit); the
  // two money components are integer micros (the divisor floors land in
  // scoreOpportunity, not here). Asking isReadableComponent rather than
  // re-comparing the range here is what keeps one record from being rejected on
  // the way in and readable on the way out — every code and message below is
  // exactly the one this function has always returned.
  for (const key of RATIO_COMPONENTS.filter((key) => key !== 'infoValue')) {
    if (!isReadableComponent(key, input[key])) {
      return rejected('OPP_BAD_COMPONENT', key, 'must be between 0 and 1');
    }
  }
  if (!isReadableComponent('infoValue', input.infoValue)) {
    return rejected('OPP_BAD_COMPONENT', 'infoValue', 'must be non-negative');
  }
  // Money is integer micros: a fractional rupee, a negative amount and a value
  // above MAX_SAFE_INTEGER are all rejected, so every stored amount is exact.
  for (const key of MONEY_COMPONENTS) {
    if (!isReadableComponent(key, input[key])) {
      return rejected('OPP_BAD_MONEY', key, `must be a non-negative integer number of micros, got ${JSON.stringify(input[key])}`);
    }
  }
  for (const key of ['downside', 'delay']) {
    if (!isReadableComponent(key, input[key])) {
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
  // Unreachable through the wire, and that is the point. A readable value_micros
  // is a non-negative safe integer and a readable pSuccess is in [0,1] (see
  // COMPONENT_RULES), so the product stays inside the safe-integer range and
  // this cannot fail for any record the projection reports as readable. It
  // stays for the direct caller that bypasses the projection entirely.
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
