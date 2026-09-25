// POST/GET /v1/opportunities, POST/GET /v1/experiments and POST
// /v1/experiments/:id/evaluate (issue #22): stored-score ranking, idempotent
// re-posts, the {code,message} error envelope, the state rewrite on evaluate,
// and tenant isolation on every read.

import { test, after } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import { buildApp } from '../../src/api/routes.js';

const dir = mkdtempSync(join(tmpdir(), 'opps-'));
const repositories = createRepositories(openDatabase(join(dir, 'app.db')));
const app = buildApp({ repositories });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());

const url = (path) => `http://127.0.0.1:${server.address().port}${path}`;

const EXPENSIVE = {
  opportunity_id: 'opp_alpha_expensive',
  tenant_id: 'tenant_alpha',
  value_micros: 6_000_000_000, pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost_micros: 1_900_000_000, downside: 2, delay: 1,
};
const CHEAP = {
  opportunity_id: 'opp_alpha_cheap',
  tenant_id: 'tenant_alpha',
  value_micros: 2_000_000_000, pSuccess: 0.2, fit: 0.5, infoValue: 0.8, reversibility: 0.5, cost_micros: 100_000_000, downside: 2, delay: 1,
};
const LOW = {
  opportunity_id: 'opp_alpha_low',
  tenant_id: 'tenant_alpha',
  value_micros: 1_000_000_000, pSuccess: 0.2, fit: 0.4, infoValue: 0.5, reversibility: 0.5, cost_micros: 500_000_000, downside: 2, delay: 2,
};

// A fixed instant for the frozen-clock test below, as a number because
// MockTimers.setTime takes milliseconds and not a Date: 2026-09-25T12:00:00Z.
const FROZEN_INSTANT_MS = 1_789_041_600_000;

const EXPERIMENT = {
  experiment_id: 'exp_alpha_budget',
  tenant_id: 'tenant_alpha',
  arms: [{ id: 'arm_control', name: 'Control' }, { id: 'arm_exact', name: 'Exact-intent' }],
  caps: { max_spend_micros: 500_000_000, max_downside_micros: 200_000_000 },
  stopRules: { min_runtime_hours: 48, min_sample: 100, success_threshold: 0.1, harm_threshold: 0.2 },
  state: 'running',
  data_through: '2026-09-25T08:00:00.000Z',
};

test('POST /v1/opportunities stores the record, computed score and all eight components', async () => {
  const response = await fetch(url('/v1/opportunities'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(EXPENSIVE),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.opportunity_id, 'opp_alpha_expensive');
  assert.equal(body.created, true);
  assert.equal(body.score, 0.9208);
  assert.equal(body.expected_contribution_micros, 1_700_000_000);
  assert.deepEqual(body.components, {
    value_micros: 6_000_000_000, pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost_micros: 1_900_000_000, downside: 2, delay: 1,
  });
});

test('GET /v1/opportunities returns the ranked list in stored-score order with components and score', async () => {
  for (const opportunity of [CHEAP, LOW]) {
    const response = await fetch(url('/v1/opportunities'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opportunity),
    });
    assert.equal(response.status, 201);
  }
  // Posted cheap then low — insertion order must not decide the ranking.
  const response = await fetch(url('/v1/opportunities?tenant_id=tenant_alpha'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.opportunities.map((row) => row.opportunity_id),
    ['opp_alpha_expensive', 'opp_alpha_cheap', 'opp_alpha_low'],
    'stored score desc (0.9208 > 0.4 > 0.01), regardless of insert order',
  );
  assert.deepEqual(body.opportunities[0].score, 0.9208);
  for (const row of body.opportunities) {
    assert.equal(Object.keys(row.components).length, 8, 'all eight components per row');
    assert.equal(typeof row.score, 'number');
  }
});

test('re-posting the same opp_ and exp_ id is idempotent: created:false, the same row', async () => {
  const first = await (await fetch(url('/v1/experiments'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(EXPERIMENT),
  })).json();
  assert.equal(first.created, true);
  assert.equal(first.state, 'running');

  const second = await (await fetch(url('/v1/experiments'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(EXPERIMENT),
  })).json();
  assert.equal(second.created, false, 'the re-post created nothing new');
  assert.equal(second.experiment_id, first.experiment_id);
  assert.deepEqual(second.caps, first.caps);

  const reOpp = await (await fetch(url('/v1/opportunities'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(EXPENSIVE),
  })).json();
  assert.equal(reOpp.created, false, 'the opportunity re-post created nothing new');
  assert.equal(reOpp.score, 0.9208, 'the stored row keeps its stored score');

  const listing = await (await fetch(url('/v1/experiments?tenant_id=tenant_alpha'))).json();
  assert.equal(listing.count, 1, 'no duplicate experiment row');
});

test('invalid bodies return 400 with a stable code, never a stack', async () => {
  const opportunities = await fetch(url('/v1/opportunities'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...CHEAP, opportunity_id: 'evt_nope' }),
  });
  assert.equal(opportunities.status, 400);
  const body = await opportunities.json();
  assert.equal(body.code, 'OPP_BAD_ID');
  assert.ok(body.message.length > 0);
  assert.equal(body.stack, undefined, 'no stack trace crosses the HTTP boundary');

  const experiments = await fetch(url('/v1/experiments'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...EXPERIMENT, experiment_id: 'exp_alpha_bad', caps: { max_spend_micros: 0, max_downside_micros: 1 } }),
  });
  assert.equal(experiments.status, 400);
  assert.equal((await experiments.json()).code, 'EXP_BAD_CAPS');

  const unknownEvaluated = await fetch(url('/v1/experiments/exp_alpha_missing/evaluate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ control_conversions: 1, control_exposures: 10, treatment_conversions: 1, treatment_exposures: 1, min_sample: 10 }),
  });
  assert.equal(unknownEvaluated.status, 422);
  assert.equal((await unknownEvaluated.json()).code, 'UNKNOWN_EXPERIMENT');
});

test('evaluating a known experiment appends an evaluation row and updates state in place', async () => {
  // First: an underpowered evaluation persists the inconclusive state — an
  // UPDATE to the experiments row, which no trigger blocks because the table
  // is deliberately mutable working state.
  const underpowered = await (await fetch(url('/v1/experiments/exp_alpha_budget/evaluate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'tenant_alpha',
      control_conversions: 10, control_exposures: 1000, treatment_conversions: 12, treatment_exposures: 1000, min_sample: 100,
    }),
  })).json();
  assert.equal(underpowered.outcome, 'inconclusive');
  assert.equal(underpowered.reason, 'underpowered');
  assert.equal(underpowered.next_state, 'inconclusive');
  assert.equal(underpowered.appended, true, 'the evaluation row landed');
  assert.equal(underpowered.duplicate, false);

  const after1 = await (await fetch(url('/v1/experiments?tenant_id=tenant_alpha'))).json();
  assert.equal(after1.experiments[0].state, 'inconclusive', 'inconclusive persists as the card state');
  assert.equal(after1.experiments[0].evaluation_result, 'inconclusive');
  assert.equal(after1.experiments[0].evaluation_reason, 'underpowered');
  assert.ok(after1.experiments[0].evaluated_at);
  const evaluations = repositories.evaluations.listForExperiment('tenant_alpha', 'exp_alpha_budget');
  assert.equal(evaluations.length, 1, 'the evaluation row was appended');
  assert.equal(evaluations[0].result, 'inconclusive');
  assert.equal(evaluations[0].reason, 'underpowered');

  // Then: a clear winner matures the same row — evidence that the state
  // UPDATE keeps working on a mutable table.
  const win = await (await fetch(url('/v1/experiments/exp_alpha_budget/evaluate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'tenant_alpha',
      control_conversions: 30, control_exposures: 1000, treatment_conversions: 70, treatment_exposures: 1000, min_sample: 100,
    }),
  })).json();
  assert.equal(win.outcome, 'win');
  assert.equal(win.next_state, 'matured');
  assert.equal(win.appended, true);
  assert.equal(win.duplicate, false);
  const matured = repositories.experiments.get('tenant_alpha', 'exp_alpha_budget');
  assert.equal(matured.state, 'matured');
  assert.equal(matured.evaluation_result, 'win');
});

test('the evaluation row resists mutation through the repository surface too', () => {
  // Append-only by design: repositories.evaluations exposes only append and
  // listForExperiment — there is no update or delete to call. The storage
  // triggers that extend that guarantee to raw SQL are asserted in
  // test/data/append-only.test.js pattern; assert the row is intact.
  const rows = repositories.evaluations.listForExperiment('tenant_alpha', 'exp_alpha_budget');
  assert.equal(rows.length, 2, 'both evaluations survived, unmutated');
  assert.deepEqual(rows.map((row) => row.result), ['inconclusive', 'win']);
});

test('a duplicate evaluation append is a no-op the caller is told about', () => {
  // The value the evaluate route now puts on the wire: two settlements of the
  // same experiment at the same millisecond collide on the append-only row, and
  // the second is deduplicated rather than overwriting the first (TR-20).
  const at = '2026-09-25T10:00:00.000Z';
  const append = (result) => repositories.evaluations.append({
    tenant_id: 'tenant_alpha',
    experiment_id: 'exp_alpha_dupe',
    evaluated_at: at,
    result,
    reason: null,
    counts: { control_conversions: 30, control_exposures: 1000, treatment_conversions: 70, treatment_exposures: 1000 },
  });
  const first = append('win');
  assert.deepEqual(first, { appended: true });
  const second = append('win');
  assert.deepEqual(second, { appended: false }, 'the duplicate is reported, not silently dropped');
  const rows = repositories.evaluations.listForExperiment('tenant_alpha', 'exp_alpha_dupe');
  assert.equal(rows.length, 1, 'one row, not two');
});

test('a body min_sample below the stored stop rule cannot force a verdict', async () => {
  // exp_alpha_gate stores min_sample 100. The same thin counts are inconclusive
  // under that gate and a clear win under a body min_sample of 1 — so a caller
  // that lowers the gate would persist a win the experiment's own stop rule
  // forbids. The stored rule is the floor: a body may demand more, never less.
  const created = await (await fetch(url('/v1/experiments'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...EXPERIMENT, experiment_id: 'exp_alpha_gate' }),
  })).json();
  assert.equal(created.created, true);

  const thinCounts = {
    tenant_id: 'tenant_alpha',
    control_conversions: 1, control_exposures: 100, treatment_conversions: 10, treatment_exposures: 100,
  };
  const lowered = await (await fetch(url('/v1/experiments/exp_alpha_gate/evaluate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...thinCounts, min_sample: 1 }),
  })).json();
  assert.equal(lowered.outcome, 'inconclusive', 'a body min_sample of 1 does not beat the stored rule');
  assert.equal(lowered.reason, 'underpowered');
  assert.equal(lowered.next_state, 'inconclusive');

  const stored = repositories.experiments.get('tenant_alpha', 'exp_alpha_gate');
  assert.equal(stored.state, 'inconclusive', 'no win or matured was persisted');
  assert.equal(stored.evaluation_result, 'inconclusive');

  // A stricter gate than the stored rule is honoured: the caller may hold the
  // experiment longer than its stop rule requires, just not shorter.
  const raised = await (await fetch(url('/v1/experiments/exp_alpha_gate/evaluate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...thinCounts, min_sample: 1000 }),
  })).json();
  assert.equal(raised.outcome, 'inconclusive');
  assert.equal(raised.reason, 'underpowered');
});

test('impossible counts return 400 and leave the experiment state untouched', async () => {
  const before = repositories.experiments.get('tenant_alpha', 'exp_alpha_gate');
  const response = await fetch(url('/v1/experiments/exp_alpha_gate/evaluate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'tenant_alpha',
      control_conversions: 99, control_exposures: 10, treatment_conversions: 1, treatment_exposures: 10,
      min_sample: 1,
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'EXP_BAD_COUNTS');
  assert.equal(body.outcome, undefined, 'no verdict on the wire');
  assert.equal(body.stack, undefined);

  const after = repositories.experiments.get('tenant_alpha', 'exp_alpha_gate');
  assert.equal(after.state, before.state, 'the state is untouched');
  assert.equal(after.evaluation_result, before.evaluation_result);
  assert.equal(after.evaluated_at, before.evaluated_at);
  assert.equal(
    repositories.evaluations.listForExperiment('tenant_alpha', 'exp_alpha_gate').length,
    2,
    'only the two inconclusive evaluations were appended',
  );
});

test('an idempotent re-post reports the stored row, not the discarded body', async () => {
  const ignored = await (await fetch(url('/v1/opportunities'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...EXPENSIVE,
      opportunity_id: 'opp_alpha_repost',
      value_micros: 6_000_000_000, pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost_micros: 1_900_000_000, downside: 2, delay: 1,
    }),
  })).json();
  assert.equal(ignored.created, true);
  assert.equal(ignored.expected_contribution_micros, 1_700_000_000);

  // Same id, entirely different components: the row is not overwritten, and
  // every field of the response — the contribution included — describes the
  // row that exists.
  const repost = await (await fetch(url('/v1/opportunities'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...EXPENSIVE,
      opportunity_id: 'opp_alpha_repost',
      value_micros: 100_000_000, pSuccess: 0.1, fit: 0.1, infoValue: 0.1, reversibility: 0.1, cost_micros: 9_999_000_000, downside: 9, delay: 9,
    }),
  })).json();
  assert.equal(repost.created, false);
  assert.equal(repost.score, 0.9208, 'the stored score, not the discarded body');
  assert.equal(repost.components.value_micros, 6_000_000_000, 'the stored components, not the discarded body');
  assert.equal(
    repost.expected_contribution_micros,
    1_700_000_000,
    'the contribution is computed from the stored components too',
  );
});

test('an opportunity whose component product overflows is rejected and never ranks', async () => {
  const response = await fetch(url('/v1/opportunities'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...CHEAP,
      opportunity_id: 'opp_alpha_overflow',
      value_micros: 9_007_199_254_740_991, infoValue: 1e308,
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'OPP_BAD_COMPONENT');

  const listing = await (await fetch(url('/v1/opportunities?tenant_id=tenant_alpha'))).json();
  assert.equal(
    listing.opportunities.some((row) => row.opportunity_id === 'opp_alpha_overflow'),
    false,
    'nothing was stored',
  );
  for (const row of listing.opportunities) {
    assert.equal(Number.isFinite(row.score), true, `${row.opportunity_id} has a finite stored score`);
  }
});

test('money that is not integer micros is rejected, never stored and never nulled on the wire', async () => {
  // The failure this closes: a raw-unit float as large as 1e308 validated, and
  // its contribution came back Infinity, which JSON.stringify turned into null
  // on the response. Money is safe-integer micros now, so the request is
  // refused before anything is written.
  for (const bad of [{ value_micros: 6_000_000_000.5 }, { value_micros: 1e303 }, { cost_micros: -1 }]) {
    const response = await fetch(url('/v1/opportunities'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...CHEAP, opportunity_id: 'opp_alpha_bad_money', ...bad }),
    });
    assert.equal(response.status, 400, JSON.stringify(bad));
    const body = await response.json();
    assert.equal(body.code, 'OPP_BAD_MONEY', JSON.stringify(bad));
    assert.equal(body.expected_contribution_micros, undefined, 'no contribution on a rejected post');
  }

  const listing = await (await fetch(url('/v1/opportunities?tenant_id=tenant_alpha'))).json();
  assert.equal(
    listing.opportunities.some((row) => row.opportunity_id === 'opp_alpha_bad_money'),
    false,
    'nothing was stored',
  );
});

test('tenant B cannot read tenant A rows through either listing', async () => {
  const betaOpps = await (await fetch(url('/v1/opportunities?tenant_id=tenant_beta'))).json();
  assert.deepEqual(betaOpps.opportunities, [], 'tenant_beta sees none of tenant_alpha rank');
  assert.equal(JSON.stringify(betaOpps).includes('opp_alpha'), false);

  const betaExperiments = await (await fetch(url('/v1/experiments?tenant_id=tenant_beta'))).json();
  assert.deepEqual(betaExperiments.experiments, []);
  assert.equal(JSON.stringify(betaExperiments).includes('exp_alpha'), false);

  // And tenant_beta cannot evaluate tenant_alpha's experiment.
  const evaluated = await fetch(url('/v1/experiments/exp_alpha_budget/evaluate?tenant_id=tenant_beta'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ control_conversions: 10, control_exposures: 1000, treatment_conversions: 12, treatment_exposures: 1000, min_sample: 100 }),
  });
  assert.equal(evaluated.status, 422, 'the cross-tenant evaluation is an unknown experiment');
});

test('two evaluations in the same millisecond report the collision instead of a second append', async (t) => {
  // The false branch of the append. experiment_evaluations is keyed on
  // (tenant_id, experiment_id, evaluated_at), so the second insert is a no-op
  // — but only if both land in the same millisecond, which two real requests
  // usually do not. Freezing the Date API the route's utcNow() reads is the way
  // to reach the branch over HTTP. node:test's own MockTimers: stdlib, no new
  // dependency, and it prints one ExperimentalWarning and nothing else.
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.setTime(FROZEN_INSTANT_MS);

  const created = await (await fetch(url('/v1/experiments'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...EXPERIMENT, experiment_id: 'exp_alpha_same_ms' }),
  })).json();
  assert.equal(created.created, true, 'a fresh experiment id, so the shared database is undisturbed');

  const counts = {
    tenant_id: 'tenant_alpha',
    control_conversions: 30, control_exposures: 1000, treatment_conversions: 70, treatment_exposures: 1000, min_sample: 100,
  };
  const first = await (await fetch(url('/v1/experiments/exp_alpha_same_ms/evaluate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(counts),
  })).json();
  assert.equal(first.appended, true);
  assert.equal(first.duplicate, false);

  const second = await (await fetch(url('/v1/experiments/exp_alpha_same_ms/evaluate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(counts),
  })).json();
  assert.equal(second.appended, false, 'the collision is reported, not swallowed');
  assert.equal(second.duplicate, true);
  assert.equal(second.outcome, first.outcome, 'the same counts in, the same verdict out');

  const stored = repositories.evaluations.listForExperiment('tenant_alpha', 'exp_alpha_same_ms');
  assert.equal(stored.length, 1, 'exactly one evaluation row, however many POSTs arrived');
  assert.equal(stored[0].evaluated_at, new Date(FROZEN_INSTANT_MS).toISOString(), 'the frozen clock is what both rows collided on');

  // Reset before returning so every later test in this file keeps real
  // timestamps — the mock is per-test, but the shared database outlives it.
  t.mock.timers.reset();
});

test('a pre-rename row comes back with all eight component keys and explicit nulls', async () => {
  // A row stored before the micros rename carries value/cost, not
  // value_micros/cost_micros. The repository projects both money keys as null
  // rather than leaving them undefined, because JSON.stringify drops an
  // undefined key: a caller could not tell "this build chose not to return it"
  // from "it was never stored".
  repositories.opportunities.create({
    tenant_id: 'tenant_gamma',
    opportunity_id: 'opp_gamma_prerename',
    score: 0.9208,
    record: {
      name: 'Pre-rename bet', value: 6000, pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost: 1900, downside: 2, delay: 1,
    },
  });

  const listing = await (await fetch(url('/v1/opportunities?tenant_id=tenant_gamma'))).json();
  const row = listing.opportunities.find((entry) => entry.opportunity_id === 'opp_gamma_prerename');
  assert.equal(Object.keys(row.components).length, 8, 'eight components, not the six a dropped key leaves behind');
  assert.deepEqual(
    Object.keys(row.components).sort(),
    ['cost_micros', 'delay', 'downside', 'fit', 'infoValue', 'pSuccess', 'reversibility', 'value_micros'],
  );
  assert.equal(row.components.value_micros, null, 'present-and-null, not an absent key');
  assert.equal(row.components.cost_micros, null);
  assert.equal(row.components.pSuccess, 0.6, 'the dimensionless components are untouched');
  assert.equal(row.score, 0.9208, 'the stored score still rides on the row');
});

test('an idempotent re-post of a pre-rename id reports a null contribution, never 0', async () => {
  const response = await fetch(url('/v1/opportunities'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...EXPENSIVE, opportunity_id: 'opp_gamma_prerename', tenant_id: 'tenant_gamma' }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.created, false, 'the correctly-shaped body did not overwrite the stored row');
  assert.equal(body.score, 0.9208, 'the stored score, not the discarded body');
  assert.equal(
    body.expected_contribution_micros,
    null,
    'the stored record has no micros to compute from: an honest unknown, not a break-even 0',
  );
  assert.equal(body.components.value_micros, null);
  // The 0 this replaced is a real answer, and the route still produces it: a
  // bet whose value x pSuccess exactly equals its cost contributes zero. That
  // is why the field cannot overload 0 to mean "I could not compute this".
  const breakEven = await (await fetch(url('/v1/opportunities'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...EXPENSIVE,
      opportunity_id: 'opp_gamma_breakeven',
      tenant_id: 'tenant_gamma',
      value_micros: 1_000_000_000, pSuccess: 0.5, cost_micros: 500_000_000,
    }),
  })).json();
  assert.equal(breakEven.created, true);
  assert.equal(breakEven.expected_contribution_micros, 0, 'a genuine break-even still reads 0, not null');
});

test('a half-migrated row keeps its real money key, nulls the missing one and reports a null contribution', async () => {
  repositories.opportunities.create({
    tenant_id: 'tenant_gamma',
    opportunity_id: 'opp_gamma_partial',
    score: 0.4,
    record: {
      name: 'Half-migrated bet', value_micros: 2_000_000_000, pSuccess: 0.2, fit: 0.5, infoValue: 0.8, reversibility: 0.5, cost: 100, downside: 2, delay: 2,
    },
  });

  const listing = await (await fetch(url('/v1/opportunities?tenant_id=tenant_gamma'))).json();
  const row = listing.opportunities.find((entry) => entry.opportunity_id === 'opp_gamma_partial');
  assert.equal(Object.keys(row.components).length, 8);
  assert.equal(row.components.value_micros, 2_000_000_000, 'the key that did migrate keeps its value');
  assert.equal(row.components.cost_micros, null, 'the one that did not is null, not absent');

  // One real key and one missing key is still an unknown: the arithmetic would
  // happily invent an answer from whichever survived.
  const repost = await (await fetch(url('/v1/opportunities'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...CHEAP, opportunity_id: 'opp_gamma_partial', tenant_id: 'tenant_gamma' }),
  })).json();
  assert.equal(repost.created, false);
  assert.equal(repost.score, 0.4);
  assert.equal(repost.expected_contribution_micros, null, 'half a record never reports half a number');
  assert.equal(repost.components.value_micros, 2_000_000_000);
  assert.equal(repost.components.cost_micros, null);
});

// BUG-1 and BUG-2 on the PR branch (issue #40): the projection normalised the
// two money keys and passed the other six through untouched, so it was the one
// consumer that disagreed with the contribution, the renderer and the seed
// guard about the same stored record. These are the QA repro shapes, driven
// through HTTP rather than the domain, because the wire is where the
// self-contradictory body was observable.

const READABLE_BASE = { pSuccess: 0.2, fit: 0.5, infoValue: 0.8, reversibility: 0.5, downside: 2, delay: 2 };

test('a stored record missing pSuccess still carries all eight keys, with pSuccess null', async () => {
  // Valid safe-integer money on both keys and one dimensionless component
  // never written. The projection wrote `pSuccess: record.pSuccess`, and
  // JSON.stringify drops an undefined value — so this row went out with SEVEN
  // keys and a client could not tell "this build could not read it" from "it
  // was never stored". It is the exact fixture QA planted as opp_qa_nop_005.
  const { pSuccess, ...withoutSuccess } = READABLE_BASE;
  repositories.opportunities.create({
    tenant_id: 'tenant_gamma',
    opportunity_id: 'opp_gamma_nopsuccess',
    score: 0.4,
    record: { name: 'No success probability', value_micros: 2_000_000_000, cost_micros: 100_000_000, ...withoutSuccess },
  });

  const listing = await (await fetch(url('/v1/opportunities?tenant_id=tenant_gamma'))).json();
  const row = listing.opportunities.find((entry) => entry.opportunity_id === 'opp_gamma_nopsuccess');
  assert.equal(Object.keys(row.components).length, 8, 'eight keys, whatever the record is missing');
  assert.ok('pSuccess' in row.components, 'present-and-null, never a dropped key');
  assert.equal(row.components.pSuccess, null);
  assert.equal(row.components.value_micros, 2_000_000_000, 'and the money it CAN read is untouched');
  assert.equal(row.components.cost_micros, 100_000_000);
});

test('money this build cannot stand behind is null on the wire, in the same body as the null contribution', async () => {
  // BUG-2: a float and a numeric string both reached the client intact
  // alongside a null contribution. That body tells a reader the money is
  // unknown and then hands it a number it cannot trust — the two fields come
  // from the same domain predicate now, so they agree.
  const corrupt = {
    opp_gamma_float: { record: { name: 'Fractional money', value_micros: 5_000_000.5, cost_micros: 1_000_000.5 }, unreadable: ['value_micros', 'cost_micros'] },
    opp_gamma_string: { record: { name: 'String money', value_micros: '2000000000', cost_micros: '500000000' }, unreadable: ['value_micros', 'cost_micros'] },
    // A negative amount is a safe integer, which is why the old money guard
    // passed it and the page rendered '-1.00' for it.
    opp_gamma_negative: { record: { name: 'Negative money', value_micros: -1_000_000, cost_micros: 100_000_000 }, unreadable: ['value_micros'] },
  };
  for (const [opportunity_id, { record }] of Object.entries(corrupt)) {
    repositories.opportunities.create({ tenant_id: 'tenant_gamma', opportunity_id, score: 0.4, record: { ...READABLE_BASE, ...record } });
  }

  for (const [opportunity_id, { record, unreadable }] of Object.entries(corrupt)) {
    // An idempotent re-post, so the response describes the STORED row.
    const body = await (await fetch(url('/v1/opportunities'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...CHEAP, opportunity_id, tenant_id: 'tenant_gamma' }),
    })).json();
    assert.equal(body.created, false, `${opportunity_id}: the well-formed body did not overwrite the stored row`);
    assert.equal(Object.keys(body.components).length, 8);
    for (const key of ['value_micros', 'cost_micros']) {
      assert.equal(
        body.components[key],
        unreadable.includes(key) ? null : record[key],
        `${opportunity_id}.${key}: an unreadable amount is null, never ${JSON.stringify(record[key])}`,
      );
    }
    assert.equal(
      body.expected_contribution_micros,
      null,
      `${opportunity_id}: the two halves of the body agree — a null contribution never sits beside a number`,
    );
  }
});

test('a dimensionless component stored as a numeric string is null, not the string', async () => {
  // The non-money half of the same rule, which no test covered: a numeric
  // string is not a number this build can stand behind, whether it sits in a
  // money key or a multiplier. Without this the renderer would print '0.5'.
  repositories.opportunities.create({
    tenant_id: 'tenant_gamma',
    opportunity_id: 'opp_gamma_pstr',
    score: 0.4,
    record: { name: 'String probability', value_micros: 2_000_000_000, cost_micros: 100_000_000, ...READABLE_BASE, pSuccess: '0.5' },
  });

  const listing = await (await fetch(url('/v1/opportunities?tenant_id=tenant_gamma'))).json();
  const row = listing.opportunities.find((entry) => entry.opportunity_id === 'opp_gamma_pstr');
  assert.equal(Object.keys(row.components).length, 8);
  assert.equal(row.components.pSuccess, null, "never '0.5'");
  assert.equal(row.components.fit, 0.5, 'the components that are real numbers are untouched');

  const body = await (await fetch(url('/v1/opportunities'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...CHEAP, opportunity_id: 'opp_gamma_pstr', tenant_id: 'tenant_gamma' }),
  })).json();
  assert.equal(body.expected_contribution_micros, null, 'and the contribution follows it to null');
});
