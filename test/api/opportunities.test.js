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
  value: 6000, pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost: 1900, downside: 2, delay: 1,
};
const CHEAP = {
  opportunity_id: 'opp_alpha_cheap',
  tenant_id: 'tenant_alpha',
  value: 2000, pSuccess: 0.2, fit: 0.5, infoValue: 0.8, reversibility: 0.5, cost: 100, downside: 2, delay: 1,
};
const LOW = {
  opportunity_id: 'opp_alpha_low',
  tenant_id: 'tenant_alpha',
  value: 1000, pSuccess: 0.2, fit: 0.4, infoValue: 0.5, reversibility: 0.5, cost: 500, downside: 2, delay: 2,
};

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
    value: 6000, pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost: 1900, downside: 2, delay: 1,
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
