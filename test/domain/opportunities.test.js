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
  value: 6000, pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost: 1900, downside: 2, delay: 1,
};
const CHEAP = {
  opportunity_id: 'opp_seed_cheap',
  tenant_id: 'tenant_demo',
  value: 2000, pSuccess: 0.2, fit: 0.5, infoValue: 0.8, reversibility: 0.5, cost: 100, downside: 2, delay: 1,
};
const LOW = {
  opportunity_id: 'opp_seed_low',
  tenant_id: 'tenant_demo',
  value: 1000, pSuccess: 0.2, fit: 0.4, infoValue: 0.5, reversibility: 0.5, cost: 500, downside: 2, delay: 2,
};
const GENERIC = {
  opportunity_id: 'opp_generic',
  tenant_id: 'tenant_demo',
  value: 1000, pSuccess: 0.5, fit: 0.8, infoValue: 1.2, reversibility: 0.9, cost: 100, downside: 2, delay: 1,
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
    ['cost', 'delay', 'downside', 'fit', 'infoValue', 'name', 'opportunity_id', 'pSuccess', 'reversibility', 'tenant_id', 'value'].sort(),
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

test('a zero cost is floored, never infinite and never throws', () => {
  const validated = validateOpportunity({ ...GENERIC, cost: 0 });
  assert.equal(validated.ok, true);
  const score = scoreOpportunity(validated.opportunity);
  assert.ok(Number.isFinite(score), 'the score is a finite number');
  assert.ok(score > 0);
  assert.equal(score, 216, 'cost 0 acts as the divisor floor 1: 432/1/2/1');
});

test('zero downside and zero delay are floored the same way as cost', () => {
  const validated = validateOpportunity({ ...GENERIC, cost: 100, downside: 0, delay: 0 });
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

test('a negative cost or value rejects with OPP_BAD_MONEY', () => {
  const value = validateOpportunity({ ...GENERIC, opportunity_id: 'opp_bad', value: -5 });
  assert.equal(value.error.code, 'OPP_BAD_MONEY');
  const cost = validateOpportunity({ ...GENERIC, opportunity_id: 'opp_bad', cost: -100 });
  assert.equal(cost.error.code, 'OPP_BAD_MONEY');
});

test('opportunity ids must start with opp_', () => {
  for (const id of ['evt_nope', 'opp', undefined, '']) {
    const result = validateOpportunity({ ...GENERIC, opportunity_id: id });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'OPP_BAD_ID');
  }
});
