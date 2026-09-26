// The seed and `seed --reset-approvals` (issue #20, TR-6). The QA script runs
// the whole demo, then approves something, then runs the reset to get back to
// the state a reviewer should see. These cases are that loop: the reset has to
// restore the queue EXACTLY, including the one row that must stay lapsed, or
// the second pass of the demo shows four cards and no lapsed row.

import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import { renderPage } from '../../src/web/pages.js';
import { decisionNonce } from '../../src/policy/kernel.js';
import { partitionApprovals } from '../../src/domain/approvals.js';
import {
  SEEDED_APPROVAL_IDS,
  SEEDED_LAPSED_ID,
  SEEDED_PENDING_IDS,
  resetApprovals,
  seed,
} from '../../scripts/seed.js';

const TENANT = 'tenant_demo';
const DEFAULT_DB = join(process.cwd(), 'data', 'app.db');
const count = (html, needle) => html.split(needle).length - 1;

function seeded(prefix = 'seed-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, 'app.db');
  const first = seed({ dbPath });
  return { dbPath, first, repositories: createRepositories(openDatabase(dbPath)) };
}

test('the seed writes four approvals and four trust rows, and a second run writes nothing', async () => {
  const { dbPath, first, repositories } = seeded();

  assert.equal(first.approvalsWritten, 4);
  assert.equal(first.trustRowsWritten, 4);
  assert.equal(first.alreadySeeded, false);
  for (const approvalId of SEEDED_APPROVAL_IDS) {
    const row = repositories.approvals.get(TENANT, approvalId);
    assert.ok(row, `${approvalId} is seeded`);
    assert.equal(row.status, 'pending', approvalId);
    assert.equal(row.tenant_id, TENANT);
    // The three pending fixtures sit inside their decision window and the
    // lapsed one is lapsed from the first second, so the page has something to
    // say on a fresh clone.
    const ahead = Date.parse(row.expires_at) > Date.now();
    assert.equal(ahead, approvalId !== SEEDED_LAPSED_ID, approvalId);
  }
  // campaign-launch deliberately has NO row, which is what makes the posture
  // table's last line read as the fail-closed default.
  for (const actionClass of ['campaign-status', 'budget-change', 'creative-refresh', 'new-geography']) {
    assert.ok(repositories.trustLedger.get(TENANT, actionClass), actionClass);
  }
  assert.equal(repositories.trustLedger.get(TENANT, 'campaign-launch'), null);

  const html = await renderPage('/approvals', { repositories });
  assert.equal(count(html, 'data-testid="approval-card"'), 3);
  assert.equal(count(html, 'data-testid="lapsed-row"'), 1);

  const second = seed({ dbPath });
  assert.equal(second.approvalsWritten, 0);
  assert.equal(second.trustRowsWritten, 0);
  assert.equal(second.alreadySeeded, true, 'a re-seed says so rather than reporting four approvals again');
});

test('the seed never touches ./data/app.db', () => {
  // A test that seeded the real database would leave a reviewer's clone with
  // rows they never asked for, and no way to tell.
  const before = existsSync(DEFAULT_DB) ? statSync(DEFAULT_DB).mtimeMs : null;
  const { dbPath } = seeded('seed-isolation-');
  assert.notEqual(dbPath, DEFAULT_DB);
  if (before !== null) {
    assert.equal(statSync(DEFAULT_DB).mtimeMs, before, 'the default database is untouched by a seed({dbPath})');
  }
});

test('the reset restores three pending at +24h and keeps the lapsed one at -72h', () => {
  const { repositories } = seeded('seed-reset-');
  const tenant = repositories.tenants.list()[0];

  // Stand in for a QA pass that approved one of them and tripped the freeze.
  const decided = SEEDED_PENDING_IDS[0];
  repositories.approvals.decide(tenant.id, decided, {
    status: 'executed',
    reason: 'CPL doubled on brand terms and stayed there',
    actor: 'Priya',
    decided_at: new Date().toISOString(),
  });
  repositories.actionRecords.append({
    tenant_id: tenant.id,
    receipt_id: 'rcp_seed_qa_1',
    approval_id: decided,
    capability_id: 'cap_seed_qa_1',
    nonce: decisionNonce(decided),
    action_class: 'budget-change',
    action: 'update_campaign_budget',
    resource: 'adset_001',
    requested: { deltaMicros: 40_000_000 },
    reported: { deltaMicros: 40_000_000 },
    reconciliation: 'agreed',
    drift: 'none',
    maturity_at_decision: 0.83,
    band_at_decision: 'moderate',
    actor: 'Priya',
    executed_at: new Date().toISOString(),
  });
  // The claim the executor takes on that nonce, held open by hand — the same
  // state a real QA pass leaves, and what a re-run would otherwise collide
  // with.
  assert.equal(repositories.idempotency.claim(tenant.id, decisionNonce(decided), 'executor'), true, 'the decision nonce is claimed');
  repositories.killSwitches.upsertFreeze({
    tenant_id: tenant.id, scope: 'provider', scope_id: 'meta_ads', kind: 'spend-spike', reason: 'spend-spike tripped', actor: 'guardian', frozen_at: new Date().toISOString(),
  });

  const summary = resetApprovals(repositories);

  assert.equal(summary.purged_receipts, 1, 'the seeded receipt is purged by its own nonce');
  assert.equal(summary.released_claims, 1, 'and the claim it held is released');
  assert.equal(summary.pending, 3, 'three, not four: the lapsed fixture is not restored as pending');
  assert.equal(summary.lapsed, 1);
  assert.equal(summary.kill_switch_cleared, 1, 'the seeded provider-scoped row is the one cleared');
  assert.equal(summary.kill_switch_scope, 'provider meta_ads');
  assert.equal(repositories.killSwitches.activeFor(tenant.id).length, 0);
  assert.equal(repositories.actionRecords.getByNonce(tenant.id, decisionNonce(decided)), null);

  const now = Date.now();
  for (const approvalId of SEEDED_PENDING_IDS) {
    const row = repositories.approvals.get(tenant.id, approvalId);
    assert.equal(row.status, 'pending', approvalId);
    assert.equal(row.reason, null, `${approvalId} is back to undecided, reason and all`);
    assert.equal(row.decided_by, null, approvalId);
    assert.equal(row.decided_at, null, approvalId);
    const offset = (Date.parse(row.expires_at) - now) / 3_600_000;
    assert.ok(offset > 23 && offset < 25, `${approvalId} is stamped 24h out (was ${offset})`);
  }
  // The lapsed fixture keeps its own stamp, or the queue would render four
  // cards and zero lapsed rows and contradict the seed's defining property.
  const lapsed = repositories.approvals.get(tenant.id, SEEDED_LAPSED_ID);
  const lapsedOffset = (Date.parse(lapsed.expires_at) - now) / 3_600_000;
  assert.ok(lapsedOffset < -71 && lapsedOffset > -73, `the lapsed fixture is stamped 72h back (was ${lapsedOffset})`);
  const buckets = partitionApprovals(repositories.approvals.list(tenant.id), { nowIso: new Date().toISOString() });
  assert.deepEqual(buckets.pending.map((row) => row.approval_id).sort(), [...SEEDED_PENDING_IDS].sort());
  assert.deepEqual(buckets.lapsed.map((row) => row.approval_id), [SEEDED_LAPSED_ID]);
  assert.deepEqual(buckets.executed, []);
  assert.deepEqual(buckets.rejected, []);
});

test('after a reset the page is back to three cards, one lapsed row and no receipts', async () => {
  const { repositories } = seeded('seed-reset-page-');
  const tenant = repositories.tenants.list()[0];
  const decided = SEEDED_PENDING_IDS[1];
  repositories.approvals.decide(tenant.id, decided, { status: 'executed', reason: 'ok', actor: 'Priya', decided_at: new Date().toISOString() });
  repositories.actionRecords.append({
    tenant_id: tenant.id,
    receipt_id: 'rcp_seed_page_1',
    approval_id: decided,
    capability_id: 'cap_seed_page_1',
    nonce: decisionNonce(decided),
    action_class: 'new-geography',
    action: 'create_campaign',
    resource: 'campaign_004',
    requested: { name: 'Retargeting — new region' },
    reported: {},
    reconciliation: 'agreed',
    drift: 'none',
    maturity_at_decision: 0.83,
    band_at_decision: 'moderate',
    actor: 'Priya',
    executed_at: new Date().toISOString(),
  });

  const before = await renderPage('/approvals', { repositories });
  assert.equal(count(before, 'data-testid="executed-receipt"'), 1, 'the QA pass left a receipt behind');

  resetApprovals(repositories);
  const after = await renderPage('/approvals', { repositories });
  assert.equal(count(after, 'data-testid="approval-card"'), 3);
  assert.equal(count(after, 'data-testid="lapsed-row"'), 1);
  assert.equal(count(after, 'data-testid="executed-receipt"'), 0, 'the executed panel is gone, not merely empty of the old row');
  assert.equal(after.includes('rcp_seed_page_1'), false);
  assert.equal(after.includes('data-testid="approval-executed"'), false);
});

test('the reset nonce list is decisionNonce over the fixture ids, so a rename cannot miss', () => {
  // Not a restatement of the implementation: this is the property the QA loop
  // depends on. A purge list built from anything other than these nonces would
  // leave the receipt standing and the executed panel would never empty.
  assert.equal(SEEDED_APPROVAL_IDS.length, 4);
  assert.equal(SEEDED_PENDING_IDS.length, 3);
  assert.deepEqual([...SEEDED_PENDING_IDS, SEEDED_LAPSED_ID].sort(), [...SEEDED_APPROVAL_IDS].sort());

  const { repositories } = seeded('seed-nonces-');
  const tenant = repositories.tenants.list()[0];
  for (const approvalId of SEEDED_APPROVAL_IDS) {
    repositories.actionRecords.append({
      tenant_id: tenant.id,
      receipt_id: `rcp_nonce_${approvalId}`,
      approval_id: approvalId,
      capability_id: `cap_nonce_${approvalId}`,
      nonce: decisionNonce(approvalId),
      action_class: 'campaign-status',
      action: 'set_campaign_status',
      resource: 'campaign_001',
      requested: {},
      reported: {},
      reconciliation: 'agreed',
      drift: 'none',
      actor: 'Priya',
      executed_at: new Date().toISOString(),
    });
  }
  // A receipt the reset must NOT touch: an autonomous execution is not on the
  // queue, and purging it would erase the audit of something a human never
  // approved.
  repositories.actionRecords.append({
    tenant_id: tenant.id,
    receipt_id: 'rcp_autonomous_keep',
    approval_id: null,
    capability_id: 'cap_autonomous_keep',
    nonce: 'nc_autonomous_keep',
    action_class: 'campaign-status',
    action: 'set_campaign_status',
    resource: 'campaign_001',
    requested: {},
    reported: {},
    reconciliation: 'agreed',
    drift: 'none',
    actor: 'executor',
    executed_at: new Date().toISOString(),
  });

  const summary = resetApprovals(repositories);
  assert.equal(summary.purged_receipts, 4, 'exactly the four decision nonces, and nothing else');
  for (const approvalId of SEEDED_APPROVAL_IDS) {
    assert.equal(repositories.actionRecords.getByNonce(tenant.id, decisionNonce(approvalId)), null, approvalId);
  }
  assert.ok(repositories.actionRecords.get(tenant.id, 'rcp_autonomous_keep'), 'an autonomous receipt survives the reset');
});

test('the CLI reports pending and lapsed separately, and writes to DB_PATH only', () => {
  const { dbPath, repositories } = seeded('seed-cli-');
  const tenant = repositories.tenants.list()[0];
  const decided = SEEDED_PENDING_IDS[0];
  repositories.approvals.decide(tenant.id, decided, { status: 'rejected', reason: 'not this week', actor: 'Priya', decided_at: new Date().toISOString() });
  repositories.killSwitches.upsertFreeze({
    tenant_id: tenant.id, scope: 'provider', scope_id: 'meta_ads', kind: 'spend-spike', reason: 'x', actor: 'guardian', frozen_at: new Date().toISOString(),
  });

  const out = execFileSync(process.execPath, ['scripts/seed.js', '--reset-approvals'], {
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  });
  // "four rows restored" must never be readable as "four pending".
  assert.match(out, /seed --reset-approvals:/);
  assert.match(out, /3 approvals pending, 1 lapsed/);
  assert.match(out, /kill switch cleared \(provider meta_ads\)/);

  const after = createRepositories(openDatabase(dbPath));
  assert.equal(after.approvals.get(TENANT, decided).status, 'pending');
  assert.equal(after.killSwitches.activeFor(TENANT).length, 0);

  // A second run of the same command is a no-op, not a second purge: the QA
  // script may be walked more than once.
  const again = execFileSync(process.execPath, ['scripts/seed.js', '--reset-approvals'], {
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  });
  assert.match(again, /purged 0 receipts, released 0 claims/);
  assert.match(again, /3 approvals pending, 1 lapsed/);
});
