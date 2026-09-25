import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOpportunity,
  scoreOpportunity,
  rankOpportunities,
  expectedContribution,
} from '../../src/domain/opportunities.js';

const EXPENSIVE = {
  opportunity_id: 'opp_seed_expensive',
  tenant_id: 'tenant_demo',
  value_micros: 6_000_000_000, pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost_micros: 1_900_000_000, downside: 2, delay: 1,
};
const CHEAP = {
  opportunity_id: 'opp_seed_cheap',
  tenant_id: 'tenant_demo',
  value_micros: 2_000_000_000, pSuccess: 0.2, fit: 0.5, infoValue: 0.8, reversibility: 0.5, cost_micros: 100_000_000, downside: 2, delay: 1,
};
const LOW = {
  opportunity_id: 'opp_seed_low',
  tenant_id: 'tenant_demo',
  value_micros: 1_000_000_000, pSuccess: 0.2, fit: 0.4, infoValue: 0.5, reversibility: 0.5, cost_micros: 500_000_000, downside: 2, delay: 2,
};
const GENERIC = {
  opportunity_id: 'opp_generic',
  tenant_id: 'tenant_demo',
  value_micros: 1_000_000_000, pSuccess: 0.5, fit: 0.8, infoValue: 1.2, reversibility: 0.9, cost_micros: 100_000_000, downside: 2, delay: 1,
};

test('scores the pinned examples exactly: generic 2.16, expensive 0.9208, cheap 0.40, low 0.01', () => {
  for (const [fixture, pinned] of [[GENERIC, 2.16], [EXPENSIVE, 0.9208], [CHEAP, 0.4], [LOW, 0.01]]) {
    const validated = validateOpportunity(fixture);
    assert.equal(validated.ok, true, `fixture ${fixture.opportunity_id} must validate: ${validated.ok ? '' : validated.error.message}`);
    assert.equal(scoreOpportunity(validated.opportunity), pinned, fixture.opportunity_id);
  }
});

test('ranks the pinned fixtures highest-score-first with a deterministic id tiebreak', () => {
  const ranked = rankOpportunities([
    { opportunity_id: 'opp_seed_cheap', score: 0.4 },
    { opportunity_id: 'opp_seed_low', score: 0.01 },
    { opportunity_id: 'opp_seed_expensive', score: 0.9208 },
  ]);
  assert.deepEqual(
    ranked.map((row) => row.opportunity_id),
    ['opp_seed_expensive', 'opp_seed_cheap', 'opp_seed_low'],
  );
  // Ids are not sorted lexicographically first — the stored score decides.
  // Two equal scores fall back to opportunity_id asc, never insertion order.
  const tied = rankOpportunities([
    { opportunity_id: 'opp_b', score: 0.5 },
    { opportunity_id: 'opp_a', score: 0.5 },
  ]);
  assert.deepEqual(tied.map((row) => row.opportunity_id), ['opp_a', 'opp_b']);
});

test('the validated record stores all eight score components plus the computed score', () => {
  const validated = validateOpportunity(EXPENSIVE);
  assert.equal(validated.ok, true);
  const opportunity = validated.opportunity;
  assert.deepEqual(
    Object.keys(opportunity).sort(),
    ['cost_micros', 'delay', 'downside', 'fit', 'infoValue', 'name', 'opportunity_id', 'pSuccess', 'reversibility', 'tenant_id', 'value_micros'].sort(),
  );
  const score = scoreOpportunity(opportunity);
  assert.ok(Number.isFinite(score) && score > 0, 'scores are finite positive numbers');
  assert.equal(score, 0.9208);
});

test('cheap low-quality vs expensive high-quality: the expensive campaign wins on stored score and on contribution', () => {
  const expensive = validateOpportunity(EXPENSIVE).opportunity;
  const cheap = validateOpportunity(CHEAP).opportunity;
  const expensiveScore = scoreOpportunity(expensive);
  const cheapScore = scoreOpportunity(cheap);
  assert.ok(expensiveScore > cheapScore, `stored score decides: ${expensiveScore} > ${cheapScore}`);
  assert.equal(expensiveScore, 0.9208);
  assert.equal(cheapScore, 0.4);
  assert.equal(expectedContribution(expensive), 1_700_000_000, '1700M micros');
  assert.equal(expectedContribution(cheap), 300_000_000, '300M micros');
  assert.ok(expectedContribution(expensive) > expectedContribution(cheap));
});

test('expectedContribution says unknown: a record it cannot read is null, never 0, NaN or Infinity', () => {
  // validation rejects these shapes, so the records are built by hand here — the
  // same defence-in-depth scoreOpportunity has. The unrepresentable cases used
  // to answer 0, which is also what a genuine break-even bet contributes, so
  // the sentinel was indistinguishable from a real answer. null is the only
  // honest one, and JSON carries it rather than dropping the key.
  const overflowing = expectedContribution({ ...GENERIC, value_micros: 1e303, pSuccess: 1, cost_micros: 0 });
  assert.equal(overflowing, null, 'not 0, not Infinity, not NaN');
  assert.equal(JSON.stringify({ expected_contribution_micros: overflowing }), '{"expected_contribution_micros":null}');
  // A record stored before the micros rename reads null too, not NaN.
  const { value_micros, cost_micros, ...withoutMoney } = GENERIC;
  const legacy = expectedContribution({ ...withoutMoney, value: 1000, cost: 100 });
  assert.equal(legacy, null);
});

test('expectedContribution returns null for a half-unreadable record, never a half-confident number', () => {
  // Exactly one money key present: the arithmetic would happily produce a
  // number from whatever survived, which is the half-known answer the fix exists
  // to stop reporting.
  const { cost_micros, ...noCost } = GENERIC;
  assert.equal(expectedContribution(noCost), null, 'cost missing');
  const { value_micros, ...noValue } = GENERIC;
  assert.equal(expectedContribution(noValue), null, 'value missing');
  // Present but not safe-integer micros: a raw-unit amount from the pre-micros
  // shape, and a float a provider or snapshot row could carry.
  assert.equal(expectedContribution({ ...GENERIC, value_micros: 1000.5 }), null, 'a fractional rupee is not micros');
  assert.equal(expectedContribution({ ...GENERIC, cost_micros: 1e303 }), null, 'an overflowing cost is not micros');
  assert.equal(expectedContribution({ ...GENERIC, value_micros: '6000000000' }), null, 'a string is not micros');
  assert.equal(expectedContribution({ ...GENERIC, cost_micros: null }), null, 'an explicit null is unknown, not zero');
});

test('expectedContribution returns null when pSuccess is not a finite number', () => {
  // Math.trunc(value * undefined) is NaN; the guard stands in front of the
  // arithmetic, so a null cost_micros cannot turn 'unknown' into a confident 0.
  for (const pSuccess of [undefined, NaN, Infinity, -Infinity, null, '0.6']) {
    assert.equal(expectedContribution({ ...GENERIC, pSuccess }), null, `pSuccess ${JSON.stringify(pSuccess)}`);
  }
  // The repository now projects an unreadable money key as null, so this is the
  // exact shape a pre-rename row reaches the domain in.
  const { value_micros, ...preRename } = GENERIC;
  assert.equal(expectedContribution({ ...preRename, value_micros: null, cost_micros: null, pSuccess: 0.5 }), null);
});

test('expectedContribution still answers for a real record, and 0 stays a real answer', () => {
  assert.equal(expectedContribution(GENERIC), 400_000_000, 'trunc(1e9 x 0.5) - 1e8');
  // Break-even: value x pSuccess exactly equals the cost, so the true
  // contribution is zero. This is why null — not 0 — has to mean unknown: if 0
  // were the sentinel, this record and an unreadable one would be identical.
  const breakEven = { ...GENERIC, value_micros: 200_000_000, pSuccess: 0.5, cost_micros: 100_000_000 };
  assert.equal(expectedContribution(breakEven), 0, 'a genuine break-even contributes 0, not null');
});

test('a negative amount is a number this build cannot stand behind, so the contribution is null', () => {
  // A negative micros is a safe integer, so the guard this replaced let it
  // through and reported a confident NEGATIVE contribution for a record the
  // wire projection calls unknown — the two halves of the same response
  // disagreeing about one record. Money is a non-negative safe integer here
  // for the same reason validateOpportunity rejects a negative on the way in.
  for (const key of ['value_micros', 'cost_micros']) {
    assert.equal(
      expectedContribution({ ...GENERIC, [key]: -1_000_000 }),
      null,
      `${key}: a negative amount is unknown money, not a negative contribution`,
    );
  }
  // The renderer half of the same rule — a negative amount renders '—' rather
  // than '-1.00' — is pinned in test/domain/opportunity-readability.test.js,
  // where the projection and the page are checked against this predicate for
  // the same fixtures.
});

test('a zero cost is floored at one currency unit in micros, never infinite and never throws', () => {
  const validated = validateOpportunity({ ...GENERIC, cost_micros: 0 });
  assert.equal(validated.ok, true);
  const score = scoreOpportunity(validated.opportunity);
  assert.ok(Number.isFinite(score), 'the score is a finite number');
  assert.ok(score > 0);
  // The money unit travels with the floor: 432_000_000 micros of numerator over
  // a 1_000_000-micros floor is 432, not 432_000_000. A floor left at 1 would
  // silently rescale this to 216_000_000.
  assert.equal(score, 216, 'cost_micros 0 acts as the one-unit floor: 432M/1M/2/1');
});

test('zero downside and zero delay are floored the same way as cost', () => {
  const validated = validateOpportunity({ ...GENERIC, cost_micros: 100_000_000, downside: 0, delay: 0 });
  const score = scoreOpportunity(validated.opportunity);
  assert.ok(Number.isFinite(score) && score > 0, 'no divide-by-zero and no infinite score');
});

test('invalid components reject with OPP_BAD_COMPONENT', () => {
  for (const bad of [
    { ...GENERIC, opportunity_id: 'opp_bad', pSuccess: 1.5 },
    { ...GENERIC, opportunity_id: 'opp_bad', fit: -1 },
    { ...GENERIC, opportunity_id: 'opp_bad', infoValue: Number.NaN },
    { ...GENERIC, opportunity_id: 'opp_bad', reversibility: 'high' },
  ]) {
    const result = validateOpportunity(bad);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'OPP_BAD_COMPONENT');
    assert.ok(result.error.message.length > 0);
  }
});

test('a negative, fractional or unsafe cost or value rejects with OPP_BAD_MONEY', () => {
  // Money is integer micros: a fractional rupee and anything above
  // MAX_SAFE_INTEGER cannot be stored exactly, so it is rejected at the door
  // rather than rounded into a different amount than the caller sent.
  for (const bad of [
    { value_micros: -5 },
    { value_micros: 6_000_000.5 },
    { value_micros: Number.MAX_SAFE_INTEGER + 2 },
    { cost_micros: -100 },
    { cost_micros: 1_900_000_000.5 },
    { cost_micros: 1e303 },
  ]) {
    const result = validateOpportunity({ ...GENERIC, opportunity_id: 'opp_bad', ...bad });
    assert.equal(result.ok, false, `${Object.keys(bad)[0]} ${bad[Object.keys(bad)[0]]} must reject`);
    assert.equal(result.error.code, 'OPP_BAD_MONEY', `${JSON.stringify(bad)} reports the money code`);
    assert.ok(result.error.message.length > 0);
  }
});

test('components whose product overflows are rejected, so an infinite score is never stored', () => {
  // Every component is finite and in range on its own: a safe-integer
  // value_micros times infoValue 1e308 overflows only as a product. Unbounded,
  // the score would be Infinity, which serialises as null and sorts above every
  // real bet.
  const result = validateOpportunity({ ...GENERIC, value_micros: 9_007_199_254_740_991, infoValue: 1e308 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'OPP_BAD_COMPONENT');
  assert.ok(result.error.message.length > 0);
});

test('an unscorable record scores finite and ranks last, never above a real bet', () => {
  // validateOpportunity is the gate for that shape, so the record is built by
  // hand here: scoreOpportunity must still return a finite number and the rank
  // function must place it below every real score (SQL would sort it first).
  const overflow = scoreOpportunity({ ...GENERIC, value_micros: 9_007_199_254_740_991, infoValue: 1e308 });
  assert.equal(overflow, 0, 'an overflow scores 0 — finite, and the lowest rank');
  const ranked = rankOpportunities([
    { opportunity_id: 'opp_overflow', score: overflow },
    { opportunity_id: 'opp_ok', score: 2.16 },
    { opportunity_id: 'opp_nan', score: Number.NaN },
  ]);
  assert.deepEqual(
    ranked.map((row) => row.opportunity_id),
    ['opp_ok', 'opp_overflow', 'opp_nan'],
    'real scores first, unscorable rows last, deterministic by id',
  );
  // The deliberate contrast with expectedContribution, which returns null for
  // the same class of record: 0 is a LAST PLACE in a total order, so it can
  // only ever lose to something, while 0 in a displayed amount is a claim that
  // the bet breaks even.
  assert.equal(expectedContribution({ ...GENERIC, value_micros: 1e303, pSuccess: 1, cost_micros: 0 }), null);
});

test('opportunity ids must start with opp_', () => {
  for (const id of ['evt_nope', 'opp', undefined, '']) {
    const result = validateOpportunity({ ...GENERIC, opportunity_id: id });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'OPP_BAD_ID');
  }
});
