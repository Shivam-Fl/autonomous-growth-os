// Drawer XSS regression (QA BUG-1, issue #19 attempt 2): renderDrawer once
// concatenated attacker-controllable decision fields into
// drawerBody.innerHTML, so a planted row executed stored markup when it
// opened. The fix is output encoding at render — DOM construction with
// textContent — not input rejection: the API keeps accepting and returning
// arbitrary strings verbatim, and /journal (server-side, escapeHtml) plus
// the served client carry the payload only in harmless form.

import { test, after } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import { buildApp } from '../../src/api/routes.js';

const dir = mkdtempSync(join(tmpdir(), 'drawer-xss-'));
const db = openDatabase(join(dir, 'app.db'));
const repositories = createRepositories(db);
const app = buildApp({ repositories });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());

const url = (path) => `http://127.0.0.1:${server.address().port}${path}`;

async function post(path, body) {
  const response = await fetch(url(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

// QA's BUG-1 payload (T-37), exactly as executed against PR #35: img-onerror
// markup placed through POST /v1/decisions in an alternative reason (with the
// window.__xss_evidence set), in an evidence ref, and in the critic result
// (with the window.__xss_critic set). decide inside the lag window so the
// row ships on the page at all times.
const MARK = '<img src=x onerror="window.__xss_evidence=1">';
const CRITIC = '<img src=x onerror="window.__xss_critic=1">';

// Fixture: register the snapshot and post the planted decision before the
// assertions run, same top-level setup as test/api/decisions.test.js.
{
  // The journal page resolves its tenant from the tenants row, and only the
  // events route auto-creates one: a qualified lead stands in for seeding.
  const tenant = await post('/v1/events', {
    event_id: 'evt_xss_demo_tenant',
    event_name: 'lead_qualified',
    tenant_id: 'tenant_demo',
    schema_version: '1',
    occurred_at: new Date().toISOString(),
    payload: { campaign: 'xss-demo', lead_id: 'lead_xss', session_id: 'sess_xss' },
  });
  assert.equal(tenant.status, 202, 'fixture: the demo tenant row exists');

  const snapshot = await post('/v1/snapshots', { snapshot_id: 'state_xss_demo', tenant_id: 'tenant_demo' });
  assert.equal(snapshot.status, 201, 'fixture: the snapshot registers');

  const decision = await post('/v1/decisions', {
    decision_id: 'dec_xss_demo',
    tenant_id: 'tenant_demo',
    state_snapshot_id: 'state_xss_demo',
    decided_at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    action_class: 'budget-change',
    selected_action: 'raise_budget',
    alternatives: [
      {
        action: 'raise_budget',
        reason: `raise 10% if CPL holds — ${MARK}`,
        expected_outcomes: { mean: -0.08, p10: -0.14, p90: 0.02 },
      },
      { action: 'do_nothing', reason: 'CPL < target holds, so hold spend flat', expected_outcomes: { mean: 0, p10: 0, p90: 0 } },
    ],
    risk: { expected_downside_micros: 300_000_000, worst_reasonable_case: `${CRITIC} for a week` },
    evidence_refs: [MARK],
    memory_refs: ['learn_xss_demo'],
    critic_result: CRITIC,
    policy_decision_id: 'policy_xss_demo',
    model_versions: ['strategy-fixture-v1'],
    prompt_versions: ['journal-baseline-v1'],
  });
  assert.equal(decision.status, 201, 'fixture: the planted decision is accepted verbatim');
}

test('the planted decision is stored and served verbatim (the API never rejects HTML-looking input)', async () => {
  const response = await fetch(url('/v1/decisions/dec_xss_demo?tenant_id=tenant_demo'));
  assert.equal(response.status, 200);
  const decision = await response.json();
  assert.equal(decision.alternatives[0].reason, `raise 10% if CPL holds — ${MARK}`);
  assert.deepEqual(decision.evidence_refs, [MARK]);
  assert.equal(decision.critic_result, CRITIC);
});

test('GET /journal never carries the raw payload as markup', async () => {
  const html = await (await fetch(url('/journal'))).text();
  assert.doesNotMatch(html, /<img src=x onerror/, 'no raw payload markup reaches the journal page');
  // The reasons and critic text render only in the client drawer (the server
  // table shows class/action/effect), so the escaped form lives in the
  // drawer's textContent — the zero-innerHTML assertion is the guard here.
});

test('the served /assets/client.js contains zero innerHTML occurrences, so no client sink can execute stored markup', async () => {
  const source = await (await fetch(url('/assets/client.js'))).text();
  assert.equal(innerCount(source), 0, 'the drawer must build DOM, never assign HTML strings');
});

function innerCount(source) {
  const matches = source.match(/innerHTML/g);
  return matches === null ? 0 : matches.length;
}
