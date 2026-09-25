// POST /v1/snapshots, POST /v1/decisions, GET /v1/decisions(/:id) and
// GET /v1/calibration: the decision-journal contract face (TR-6, TR-15).
// Rejections write nothing; calibration reads the repository only.

import { test, after } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import { buildApp } from '../../src/api/routes.js';

const dir = mkdtempSync(join(tmpdir(), 'decisions-api-'));
const db = openDatabase(join(dir, 'app.db'));
const repositories = createRepositories(db);
const app = buildApp({ repositories });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());

const url = (path) => `http://127.0.0.1:${server.address().port}${path}`;
// Decided six hours ago keeps a decision inside the 120h lag window no
// matter when the suite runs; 2026-09-20T00:00:00Z is the work order's
// pinned maturity example (evaluates exactly 2026-09-25T00:00:00Z).
const NOW = () => new Date(Date.now() - 6 * 3_600_000).toISOString();
const PINNED = '2026-09-20T00:00:00.000Z';

async function post(path, body) {
  const response = await fetch(url(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function decisionBody(overrides = {}) {
  return {
    decision_id: 'dec_api_1',
    tenant_id: 'tenant_api',
    state_snapshot_id: 'state_api_1',
    decided_at: NOW(),
    action_class: 'budget-change',
    selected_action: 'raise_budget',
    alternatives: [
      { action: 'raise_budget', reason: 'qualified CPL tracks below target', expected_outcomes: { mean: -0.08, p10: -0.14, p90: 0.02 } },
      { action: 'do_nothing', reason: 'holding keeps spend flat while evidence matures', expected_outcomes: { mean: 0, p10: 0, p90: 0 } },
    ],
    risk: { expected_downside_micros: 300_000_000, worst_reasonable_case: 'qualified CPL rises 14% for a week' },
    evidence_refs: ['evt_1'],
    memory_refs: ['learn_1'],
    critic_result: 'critic agrees',
    policy_decision_id: 'policy_api_1',
    model_versions: ['strategy-fixture-v1'],
    prompt_versions: ['journal-baseline-v1'],
    ...overrides,
  };
}

/** A matured, correctly-evaluated decision. decided_at (200h ago) and
 * evaluation.evaluated_at (72h ago) are both derived from ONE sampled instant
 * and the evaluation sits 8h past the 120h maturity point, so the maturity
 * gate in validateDecision holds with real slack — it never depends on where
 * the millisecond boundary falls between two separate Date.now() samples. */
function maturedBody(overrides = {}) {
  const t = Date.now();
  return decisionBody({
    decided_at: new Date(t - 200 * 3_600_000).toISOString(),
    evaluation: { outcome: 'correct', needless: false, evaluated_at: new Date(t - 72 * 3_600_000).toISOString() },
    ...overrides,
  });
}

async function decisionCount() {
  const response = await fetch(url('/v1/decisions?tenant_id=tenant_api'));
  return (await response.json()).count;
}

test('POST /v1/snapshots registers a snapshot and re-registering is a no-op', async () => {
  const first = await post('/v1/snapshots', { snapshot_id: 'state_api_1', tenant_id: 'tenant_api', kpis: { qualified_cpl_micros: 2_400_000_000 } });
  assert.equal(first.status, 201);
  assert.deepEqual(first.body, { snapshot_id: 'state_api_1' });

  const again = await post('/v1/snapshots', { snapshot_id: 'state_api_1', tenant_id: 'tenant_api', kpis: { qualified_cpl_micros: 1 } });
  assert.equal(again.status, 201, 'idempotent re-post returns success');
  assert.equal(repositories.snapshots.get('tenant_api', 'state_api_1').kpis.qualified_cpl_micros, 2_400_000_000, 'the first write wins: snapshots are immutable');
});

test('POST /v1/snapshots without a snapshot_id returns 400', async () => {
  const { status, body } = await post('/v1/snapshots', { kpis: {} });
  assert.equal(status, 400);
  assert.equal(body.code, 'BAD_SNAPSHOT');
});

test('a valid decision returns 201 with status and expected_evaluation_at; the re-post returns the same id', async () => {
  const decidedAt = NOW();
  const first = await post('/v1/decisions', decisionBody({ decided_at: PINNED }));
  assert.equal(first.status, 201);
  assert.equal(first.body.decision_id, 'dec_api_1');
  assert.equal(first.body.expected_evaluation_at, '2026-09-25T00:00:00.000Z', 'the pinned example: decided 2026-09-20 evaluates 2026-09-25');
  // Status follows the wall clock: 2026-09-20 is matured after 2026-09-25,
  // so assert against the computed expectation instead of a literal.
  const expectedStatus = Date.now() >= Date.parse('2026-09-25T00:00:00.000Z') ? 'matured' : 'awaiting-maturity';
  assert.equal(first.body.status, expectedStatus);

  const repost = await post('/v1/decisions', decisionBody({ decided_at: PINNED, evaluation: { outcome: 'incorrect', needless: false, evaluated_at: '2026-09-25T00:00:00.000Z' } }));
  assert.equal(repost.status, 201);
  assert.equal(repost.body.decision_id, 'dec_api_1', 'idempotent on decision_id');
  assert.equal(await decisionCount(), 1, 'a re-post never duplicates the row');
  const stored = repositories.decisions.get('tenant_api', 'dec_api_1');
  assert.equal(stored.evaluation, undefined, 'the re-post does not mutate the first write: decisions are append-only');
});

// AC-1: rejections write nothing.
test('a decision without state_snapshot_id is a 400 MISSING_STATE_SNAPSHOT and writes nothing', async () => {
  const body = decisionBody();
  delete body.state_snapshot_id;
  const { status, body: error } = await post('/v1/decisions', body);
  assert.equal(status, 400);
  assert.equal(error.code, 'MISSING_STATE_SNAPSHOT');
  assert.equal(await decisionCount(), 1, 'nothing written');
});

test('a decision without a do-nothing alternative is a 400 MISSING_DO_NOTHING and writes nothing', async () => {
  const { status, body } = await post('/v1/decisions', decisionBody({
    decision_id: 'dec_api_nodonothing',
    alternatives: [{ action: 'raise_budget', reason: 'x', expected_outcomes: { mean: 0, p10: 0, p90: 0 } }],
  }));
  assert.equal(status, 400);
  assert.equal(body.code, 'MISSING_DO_NOTHING');
  assert.equal(await decisionCount(), 1, 'nothing written');
});

test('a malformed evaluation is a 400 BAD_EVALUATION and writes nothing', async () => {
  const { status, body } = await post('/v1/decisions', decisionBody({
    decision_id: 'dec_api_badeval',
    decided_at: PINNED,
    evaluation: { outcome: 'correct', needless: false, evaluated_at: '2026-09-21T00:00:00.000Z' },
  }));
  assert.equal(status, 400);
  assert.equal(body.code, 'BAD_EVALUATION');
  assert.equal(await decisionCount(), 1, 'nothing written');
});

test('a decision on an unknown snapshot is a 422 UNKNOWN_SNAPSHOT and writes nothing', async () => {
  const { status, body } = await post('/v1/decisions', decisionBody({ decision_id: 'dec_api_unknown', state_snapshot_id: 'state_ghost' }));
  assert.equal(status, 422);
  assert.equal(body.code, 'UNKNOWN_SNAPSHOT');
  assert.equal(await decisionCount(), 1, 'nothing written');
  assert.equal(repositories.snapshots.get('tenant_api', 'state_ghost'), null, 'no snapshot row is invented either');
});

test('GET /v1/decisions filters by class and status in deterministic order', async () => {
  await post('/v1/decisions', decisionBody({ decision_id: 'dec_api_a', action_class: 'campaign-status', decided_at: new Date(Date.now() - 130 * 3_600_000).toISOString() }));
  await post('/v1/decisions', decisionBody({ decision_id: 'dec_api_b', action_class: 'campaign-status' }));
  await post('/v1/decisions', decisionBody({ decision_id: 'dec_api_c', action_class: 'budget-change' }));

  const byClass = await (await fetch(url('/v1/decisions?tenant_id=tenant_api&class=campaign-status'))).json();
  assert.deepEqual(byClass.decisions.map((row) => row.decision_id), ['dec_api_a', 'dec_api_b'], 'decided_at, decision_id order');

  const byStatus = await (await fetch(url('/v1/decisions?tenant_id=tenant_api&status=awaiting-maturity'))).json();
  assert.ok(byStatus.decisions.every((row) => row.status === 'awaiting-maturity'));
  assert.ok(byStatus.decisions.length >= 2, `fixture: dec_api_b and dec_api_c are inside the lag window (got ${byStatus.decisions.length})`);
});

test('GET /v1/decisions/:id returns the full record: alternatives, downside, evidence, critic and policy', async () => {
  const response = await fetch(url('/v1/decisions/dec_api_c?tenant_id=tenant_api'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.decision_id, 'dec_api_c');
  assert.deepEqual(body.alternatives.map((entry) => entry.action), ['raise_budget', 'do_nothing']);
  assert.equal(body.risk.expected_downside_micros, 300_000_000);
  assert.deepEqual(body.evidence_refs, ['evt_1']);
  assert.deepEqual(body.memory_refs, ['learn_1']);
  assert.equal(body.critic_result, 'critic agrees');
  assert.equal(body.policy_decision_id, 'policy_api_1');
  assert.deepEqual(body.model_versions, ['strategy-fixture-v1']);
  assert.equal(body.evaluation, null, 'no evaluation yet');

  const missing = await fetch(url('/v1/decisions/dec_ghost?tenant_id=tenant_api'));
  assert.equal(missing.status, 404);
});

// AC-5 seed totals at the API boundary: precision 1.00, false-intervention 0.00.
test('GET /v1/calibration returns the LIVE repository aggregate and never a fixture number', async () => {
  // tenant_api holds two matured decisions (one intervention, one do-nothing,
  // both correct) — the same shape the seed writes for the demo tenant.
  const matured1 = await post('/v1/decisions', maturedBody({ decision_id: 'dec_api_matured_1' }));
  assert.equal(matured1.status, 201, 'the matured intervention was accepted, not silently rejected');
  const matured2 = await post('/v1/decisions', maturedBody({
    decision_id: 'dec_api_matured_2',
    action_class: 'campaign-status',
    selected_action: 'do_nothing',
  }));
  assert.equal(matured2.status, 201, 'the matured do-nothing was accepted, not silently rejected');

  const response = await fetch(url('/v1/calibration?tenant_id=tenant_api'));
  const body = await response.json();
  assert.equal(body.precision, 1, '2 correct of 2 evaluated');
  assert.equal(body.false_intervention_rate, 0, '0 needless of 1 intervention');
  assert.equal(body.evaluated, 2);
  assert.equal(body.correct, 2);
  assert.equal(body.interventions, 1);
  assert.equal(body.needless, 0);
  assert.ok(body.awaiting_maturity >= 1, 'the early decisions are still awaiting');

  const emptyTenant = await (await fetch(url('/v1/calibration?tenant_id=tenant_nobody'))).json();
  assert.equal(emptyTenant.precision, null, 'no rows: rates are null, never a fixture number');
  assert.equal(emptyTenant.false_intervention_rate, null);
  assert.notEqual(emptyTenant.precision, 0.7, 'the frozen 0.70 replay report is CI-only');
});

// AC-2: the replay path executes zero mutations — no capability, no
// executor, no spend event exists on it.
test('the frozen replay path executes zero mutations', async () => {
  const { evaluateReplay } = await import('../../src/domain/decisions.js');
  const scenarios = [
    { id: 's1', decisions: [{ selected_action: 'raise_budget', matured: true, evaluation: { outcome: 'correct', needless: false, evaluated_at: new Date().toISOString() } }] },
  ];
  const before = repositories.rawEvents.count('tenant_api');
  const report = evaluateReplay(scenarios);
  assert.equal(report.mutationsExecuted, 0);
  assert.equal(report.precision, 1);
  assert.equal(repositories.rawEvents.count('tenant_api'), before, 'no spend event written');
  assert.equal(repositories.auditEvents.list('tenant_api').filter((row) => row.action.includes('execut')).length, 0, 'no executor call recorded');
});
