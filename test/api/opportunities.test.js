// POST/GET /v1/opportunities, POST/GET /v1/experiments and POST
// /v1/experiments/:id/evaluate (issue #22): stored-score ranking, idempotent
// re-posts, the {code,message} error envelope, the state rewrite on evaluate,
// and tenant isolation on every read.

import { test, after } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
// MockTimers.setTime takes milliseconds and not a Date: 2026-09-10T12:00:00Z.
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

// A reader debugging a clock collision trusts the gloss above the constant and
// looks in the wrong window if it drifts from the number. The comment quoted
// an instant fifteen days later than the one the constant holds, and every
// test in this file stayed green, because nothing read the comment. Pin the
// two to each other: the date a reader sees is the date the code freezes at.
test('the FROZEN_INSTANT_MS comment names the instant the constant actually is', () => {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const lines = source.split('\n');
  const constant = lines.findIndex((line) => line.includes('FROZEN_INSTANT_MS = 1_789_041_600_000'));
  assert.notEqual(constant, -1, 'the FROZEN_INSTANT_MS constant is still in this file');

  // Walk up over the contiguous comment block to the line that glosses the
  // instant, and take the date off that one rather than off any comment above.
  let gloss = null;
  for (let index = constant - 1; index >= 0 && lines[index].startsWith('//'); index -= 1) {
    if (lines[index].includes('MockTimers')) {
      gloss = lines[index];
      break;
    }
  }
  assert.ok(gloss, 'the MockTimers gloss still sits directly above the constant');

  const named = gloss.match(/(\d{4}-\d{2}-\d{2})T/)?.[1];
  assert.ok(named, `the gloss names an instant as YYYY-MM-DDTHH:MM:SSZ, got: ${gloss}`);
  assert.equal(
    named, new Date(FROZEN_INSTANT_MS).toISOString().slice(0, 10),
    'the instant the comment names is the instant the constant freezes at',
  );
});

// BUG-4 (issue #40, second round). The read rule and the write rule were two
// different rules: the read side asked "is this a number the build can print",
// the write side asked "is this a value this key accepts". A pSuccess of 1.5
// failed the second and passed the first, which is how a body got eight
// readable components beside a null contribution — with no component a client
// could point at. Driven over HTTP rather than in the domain, because the
// self-contradictory body is only observable on the wire.

/** Plant a stored record directly, then re-POST a well-formed body over it, so
 * the response describes the STORED row rather than the discarded one — the way
 * QA drove the running app. */
async function repostStored({ opportunity_id, tenant_id, record, score }) {
  repositories.opportunities.create({ tenant_id, opportunity_id, record, score });
  const body = await (await fetch(url('/v1/opportunities'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...EXPENSIVE, opportunity_id, tenant_id }),
  })).json();
  assert.equal(body.created, false, `${opportunity_id}: the well-formed body did not overwrite the stored row`);
  assert.equal(Object.keys(body.components).length, 8, `${opportunity_id}: eight component keys, whatever the record is missing`);
  return body;
}

/** HEALTHY-ish record with `overrides` written over it and `drop` removed
 * outright — a key that was never stored rather than one stored badly. */
function storedBody({ drop = [], ...overrides }) {
  const record = { name: 'Stored bet', value_micros: 3_000_000_000, pSuccess: 0.5, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost_micros: 1_000_000, downside: 2, delay: 1, ...overrides };
  for (const key of drop) {
    delete record[key];
  }
  return record;
}

test('BUG-4: an out-of-range pSuccess is null on the wire, and the contribution follows it', async () => {
  // The QA fixture, planted verbatim. value_micros is MAX_SAFE_INTEGER and
  // pSuccess is 1.5: on the previous rule every one of the eight components
  // projected non-null, and then the arithmetic's own safe-integer guard
  // returned null — a second path to a null contribution that the wire
  // contract never accounted for. The null is now on pSuccess, where a client
  // can see it.
  const body = await repostStored({
    opportunity_id: 'opp_qa_ovf_014',
    tenant_id: 'tenant_demo',
    score: 0.9208,
    record: {
      name: 'QA overflow contribution',
      value_micros: 9_007_199_254_740_991, pSuccess: 1.5, fit: 0.5, infoValue: 1,
      reversibility: 0.9, cost_micros: 0, downside: 2, delay: 1,
    },
  });

  assert.equal(body.components.pSuccess, null, 'the component the write side would reject is the one reported as unknown');
  assert.equal(body.expected_contribution_micros, null);
  // The money beside it is a perfectly readable amount and stays readable: the
  // record is not wholesale discarded, one component of it is.
  assert.equal(body.components.value_micros, 9_007_199_254_740_991);
  assert.equal(body.components.cost_micros, 0);
  assert.equal(body.score, 0.9208, 'the stored score still rides on the row');
  assert.deepEqual(
    Object.values(body.components).filter((value) => value === null),
    [null],
    'exactly one null, and it is on a key the contribution reads',
  );
});

test('the other direction: a null the formula does not read leaves the contribution a number', async () => {
  // What QA did not file, and the reason a one-direction comment does not
  // work. The contribution reads value_micros, pSuccess and cost_micros and
  // nothing else, so `fit: null` is a real amount reported beside a component
  // this build cannot read — deliberately, with no exception. Any comment
  // claiming the field is null whenever *a* component is null is refuted by
  // this exact body.
  const { fit, ...withoutFit } = storedBody({ value_micros: 3_000_000_000, pSuccess: 0.5, cost_micros: 1_000_000 });
  const body = await repostStored({ opportunity_id: 'opp_gamma_nofit', tenant_id: 'tenant_gamma', score: 0.4, record: withoutFit });

  assert.equal(body.components.fit, null, 'the component the build cannot read is null');
  assert.equal(
    body.expected_contribution_micros,
    1_499_000_000,
    'trunc(3e9 x 0.5) - 1e6: a number, because all three of the formula keys are readable',
  );
  assert.equal(body.components.value_micros, 3_000_000_000, 'the two money components and pSuccess are all real');
  assert.equal(body.components.pSuccess, 0.5);
  assert.equal(body.components.cost_micros, 1_000_000);
});

test('the wire contract holds in BOTH directions across every corrupt shape', async () => {
  // What the two tests above assert, run over a table instead of twice — the
  // contract has two directions and a test of only one of them cannot tell
  // which a change broke. Every row is a stored record; the assertion is on
  // the POSTED body, so it is the wire that is checked.
  const shapes = [
    ['opp_contract_healthy', { tenant_id: 'tenant_gamma', record: storedBody({}) }],
    ['opp_contract_prerename', { tenant_id: 'tenant_gamma', record: { name: 'Pre-rename', value: 6000, cost: 1900, pSuccess: 0.5, fit: 0.9, infoValue: 1.2, reversibility: 0.9, downside: 2, delay: 1 } }],
    ['opp_contract_float_value', { tenant_id: 'tenant_gamma', record: storedBody({ value_micros: 5_000_000.5 }) }],
    ['opp_contract_string_value', { tenant_id: 'tenant_gamma', record: storedBody({ value_micros: '2000000000' }) }],
    ['opp_contract_negative_value', { tenant_id: 'tenant_gamma', record: storedBody({ value_micros: -1_000_000 }) }],
    ['opp_contract_absent_value', { tenant_id: 'tenant_gamma', record: storedBody({ drop: ['value_micros'] }) }],
    ['opp_contract_absent_psuccess', { tenant_id: 'tenant_gamma', record: storedBody({ drop: ['pSuccess'] }) }],
    ['opp_contract_absent_cost', { tenant_id: 'tenant_gamma', record: storedBody({ drop: ['cost_micros'] }) }],
    ['opp_contract_string_psuccess', { tenant_id: 'tenant_gamma', record: storedBody({ pSuccess: '0.5' }) }],
    ['opp_contract_psuccess_high', { tenant_id: 'tenant_gamma', record: storedBody({ pSuccess: 1.5 }) }],
    // The QA overflow shape. It is in the table rather than only in the test
    // above so the biconditional itself is a regression guard: on the old rule
    // every component here is readable and the contribution is null, which is
    // the one row where the table would catch a widening of the read rule back
    // to a number check.
    ['opp_contract_overflow', { tenant_id: 'tenant_gamma', record: storedBody({ value_micros: 9_007_199_254_740_991, pSuccess: 1.5, cost_micros: 0 }) }],
    ['opp_contract_psuccess_low', { tenant_id: 'tenant_gamma', record: storedBody({ pSuccess: -1 }) }],
    ['opp_contract_psuccess_zero', { tenant_id: 'tenant_gamma', record: storedBody({ pSuccess: 0 }) }],
    ['opp_contract_psuccess_one', { tenant_id: 'tenant_gamma', record: storedBody({ pSuccess: 1 }) }],
    ['opp_contract_fit_high', { tenant_id: 'tenant_gamma', record: storedBody({ fit: 2 }) }],
    ['opp_contract_downside_negative', { tenant_id: 'tenant_gamma', record: storedBody({ downside: -1 }) }],
    ['opp_contract_breakeven', { tenant_id: 'tenant_gamma', record: storedBody({ value_micros: 500_000_000, pSuccess: 0.5, cost_micros: 250_000_000 }) }],
  ];
  for (const [opportunity_id, { tenant_id, record }] of shapes) {
    const body = await repostStored({ opportunity_id, tenant_id, score: 0.4, record });
    const formulaReadsANull = ['value_micros', 'pSuccess', 'cost_micros'].some((key) => body.components[key] === null);
    assert.equal(
      body.expected_contribution_micros === null,
      formulaReadsANull,
      `${opportunity_id}: contribution null iff value_micros, pSuccess or cost_micros is null — got ${JSON.stringify(body.expected_contribution_micros)} with ${JSON.stringify(body.components)}`,
    );
    if (!formulaReadsANull) {
      assert.equal(
        Number.isSafeInteger(body.expected_contribution_micros),
        true,
        `${opportunity_id}: all three formula keys readable, so the contribution is a number, never a second null`,
      );
    }
  }
  // The break-even control, which is why null and not 0 has to mean unknown.
  const control = await repostStored({ opportunity_id: 'opp_contract_zero_control', tenant_id: 'tenant_gamma', score: 0.4, record: storedBody({ value_micros: 1_000_000_000, pSuccess: 0.5, cost_micros: 500_000_000 }) });
  assert.equal(control.expected_contribution_micros, 0, 'a genuine zero is a number on the wire, not an unknown');
});

test('a value the domain ACCEPTS is never nulled by the read rule', async () => {
  // The direction the widened rule must not overshoot into. A pSuccess of
  // exactly 0 or exactly 1, an infoValue above 1 and a downside above 1 are all
  // valid, and the projection has to pass every one of them through as itself.
  // These go through the real POST, so they are values validateOpportunity
  // actually accepted rather than shapes invented here.
  for (const [opportunity_id, overrides] of [
    ['opp_gamma_endpoint_low', { pSuccess: 0 }],
    ['opp_gamma_endpoint_high', { pSuccess: 1, fit: 1, reversibility: 1 }],
    ['opp_gamma_wide_multipliers', { infoValue: 4, downside: 2, delay: 3 }],
  ]) {
    const sent = { ...EXPENSIVE, opportunity_id, tenant_id: 'tenant_gamma', ...overrides };
    const response = await fetch(url('/v1/opportunities'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sent),
    });
    assert.equal(response.status, 201, `${opportunity_id}: the write side accepts ${JSON.stringify(overrides)}`);
    const body = await response.json();
    assert.deepEqual(body.components, {
      value_micros: sent.value_micros, pSuccess: sent.pSuccess, fit: sent.fit, infoValue: sent.infoValue,
      reversibility: sent.reversibility, cost_micros: sent.cost_micros, downside: sent.downside, delay: sent.delay,
    }, `${opportunity_id}: the projection is the record the write side accepted, byte for byte — nothing valid is hidden`);
    assert.equal(
      Number.isSafeInteger(body.expected_contribution_micros),
      true,
      `${opportunity_id}: and a record the domain accepts always yields a number`,
    );
  }
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
