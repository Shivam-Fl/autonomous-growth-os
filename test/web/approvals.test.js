// The /approvals page and the guardian banner (issue #20, TR-4/TR-6). These
// cases are about what a HUMAN can do from the page, so they are written
// against the rendered HTML rather than against the renderer's return value:
// the control contract (which attributes are ON the control, not on an
// ancestor) only matters once the browser has parsed it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import { renderPage } from '../../src/web/pages.js';
import { seed, SEEDED_APPROVAL_IDS, SEEDED_LAPSED_ID, SEEDED_PENDING_IDS } from '../../scripts/seed.js';
import { ACTION_CLASSES } from '../../src/policy/kernel.js';
import { POSTURE_LABELS, postureFor } from '../../src/policy/trust.js';

const ROUTES = ['/', '/journal', '/opportunities', '/experiments', '/approvals'];
const STATES = ['empty', 'ideal', 'loading', 'partial', 'error'];

function freshRepos() {
  const dir = mkdtempSync(join(tmpdir(), 'approvals-web-'));
  return createRepositories(openDatabase(join(dir, 'app.db')));
}

function seededRepos() {
  const dir = mkdtempSync(join(tmpdir(), 'approvals-seeded-'));
  seed({ dbPath: join(dir, 'app.db') });
  const repositories = createRepositories(openDatabase(join(dir, 'app.db')));
  return { repositories, tenant: repositories.tenants.list()[0] };
}

const count = (html, needle) => html.split(needle).length - 1;
const tenantOf = (repositories) => repositories.tenants.list()[0];

test('the SEEDED page shows three pending cards, one lapsed row, and no executed panel', async () => {
  const { repositories } = seededRepos();
  const html = await renderPage('/approvals', { repositories });

  assert.equal(count(html, 'data-testid="approval-card"'), 3, 'three pending cards, and the lapsed one is not one of them');
  assert.equal(count(html, 'data-testid="approval-queue"'), 1);
  assert.match(html, /Pending approvals · 3/);
  assert.equal(count(html, 'data-testid="executed-receipt"'), 0);
  assert.equal(html.includes('data-testid="approval-executed"'), false, 'an empty executed panel is absent, not rendered empty');
  assert.equal(count(html, 'data-testid="lapsed-row"'), 1);
  assert.match(html, /Lapsed approvals · 1/);
  assert.match(html, new RegExp(SEEDED_LAPSED_ID));
  // The three pending ids are the ones on the cards, and the lapsed id is not.
  for (const approvalId of SEEDED_PENDING_IDS) {
    assert.match(html, new RegExp(`data-approval-id="${approvalId}"`), approvalId);
  }
  assert.equal(count(html, `data-approval-card data-approval-id="${SEEDED_LAPSED_ID}"`), 0);
  assert.equal(html.includes('data-testid="approvals-empty"'), false, 'a non-empty queue does not also render the empty state');
  // The result region exists on the seeded page too, because client.js writes
  // the decision outcome into it and there is nothing else for it to target.
  assert.equal(count(html, 'data-testid="approval-decision-result"'), 1);
});

test('every decision control carries its OWN approval id and tenant id', async () => {
  // The contract client.js depends on: it reads control.dataset, with no
  // closest() walk, so an attribute on the <li> alone produces a request with
  // no approval id and a 404 that looks like a bad row.
  const { repositories, tenant } = seededRepos();
  const html = await renderPage('/approvals', { repositories });

  const controls = [...html.matchAll(/<(?:button|input)[^>]*data-action="(approve-decision|reject-decision)"[^>]*>/g)];
  assert.equal(controls.length, 6, 'two controls on each of the three cards');
  for (const [, action] of controls) {
    assert.ok(['approve-decision', 'reject-decision'].includes(action), action);
  }
  for (const [tag] of controls) {
    assert.match(tag, /data-approval-id="apv_seed_/, tag);
    assert.match(tag, new RegExp(`data-tenant-id="${tenant.id}"`), tag);
  }
  // Each card's two controls name the SAME row as the <li> they sit in.
  const cards = [...html.matchAll(/<li[^>]*data-approval-card[^>]*data-approval-id="([^"]+)"[^>]*>(.*?)<\/li>/gs)];
  assert.equal(cards.length, 3);
  for (const [, approvalId, body] of cards) {
    const named = [...body.matchAll(/data-action="(?:approve-decision|reject-decision)"[^>]*data-approval-id="([^"]+)"/g)];
    assert.equal(named.length, 2, approvalId);
    for (const [, controlId] of named) {
      assert.equal(controlId, approvalId);
    }
    // The reason the client reads, on the same card.
    assert.match(body, /<input[^>]*name="reason"/, approvalId);
  }
  // The pre-issue control names are GONE, not renamed alongside the new ones:
  // a leftover data-action="approve" would be a live-looking button no handler
  // claims.
  for (const retired of ['data-action="approve"', 'data-action="reject"']) {
    assert.equal(html.includes(retired), false, `${retired} must not survive`);
  }
});

test('the executed section is driven by receipts, and a null approval_id is NOT one of them', async () => {
  const { repositories, tenant } = seededRepos();
  // An autonomous execution: a real receipt, and no queue row behind it.
  repositories.actionRecords.append({
    tenant_id: tenant.id,
    receipt_id: 'rcp_autonomous_1',
    approval_id: null,
    capability_id: 'cap_autonomous_1',
    nonce: 'nc_autonomous_1',
    action_class: 'campaign-status',
    action: 'set_campaign_status',
    resource: 'campaign_001',
    requested: { status: 'PAUSED' },
    reported: { status: 'PAUSED' },
    reconciliation: 'agreed',
    drift: 'none',
    maturity_at_decision: 0.83,
    band_at_decision: 'moderate',
    actor: 'executor',
    executed_at: new Date().toISOString(),
  });
  // A decided queue row: receipt plus the approval behind it.
  const decided = SEEDED_PENDING_IDS[0];
  repositories.approvals.decide(tenant.id, decided, { status: 'executed', reason: 'CPL doubled on brand terms', actor: 'Priya', decided_at: new Date().toISOString() });
  repositories.actionRecords.append({
    tenant_id: tenant.id,
    receipt_id: 'rcp_queue_1',
    approval_id: decided,
    capability_id: 'cap_queue_1',
    nonce: 'nc_queue_1',
    action_class: 'budget-change',
    action: 'update_campaign_budget',
    resource: 'adset_001',
    requested: { deltaMicros: 40_000_000 },
    reported: { deltaMicros: 40_000_000 },
    reconciliation: 'diverged',
    drift: 'platform',
    maturity_at_decision: 0.62,
    band_at_decision: 'protective',
    actor: 'Priya',
    executed_at: new Date().toISOString(),
  });

  const html = await renderPage('/approvals', { repositories });
  assert.equal(count(html, 'data-testid="approval-executed"'), 1);
  assert.match(html, /Executed receipts · 1/);
  assert.equal(count(html, 'data-testid="executed-receipt"'), 1, 'the autonomous receipt is filtered out');
  assert.equal(html.includes('rcp_autonomous_1'), false, 'and is nowhere on the page');

  // Everything the row shows is read off the receipt, which is the only place
  // it exists.
  assert.match(html, /data-testid="executed-receipt" data-approval-id="apv_seed_budget_1" data-tenant-id="tenant_demo"/);
  assert.match(html, /rcp_queue_1/);
  assert.match(html, /reconciliation diverged · drift platform/);
  assert.match(html, /budget-change/, 'the class is read from the approval row behind the receipt');
  // ...and the one control it carries is the redelivery control.
  const redeliver = [...html.matchAll(/<button[^>]*data-action="re-decide"[^>]*>/g)];
  assert.equal(redeliver.length, 1);
  assert.match(redeliver[0][0], /data-approval-id="apv_seed_budget_1"/);
  assert.match(redeliver[0][0], new RegExp(`data-tenant-id="${tenant.id}"`));
  // The decided row left the queue, so there are two pending cards, not three.
  assert.equal(count(html, 'data-testid="approval-card"'), 2);
});

test('a lapsed row carries NO control of any kind', async () => {
  const { repositories } = seededRepos();
  const html = await renderPage('/approvals', { repositories });
  const lapsed = html.match(/<li[^>]*data-testid="lapsed-row"[^>]*>.*?<\/li>/s);
  assert.ok(lapsed, 'the lapsed row renders');
  assert.equal(lapsed[0].includes('data-action'), false, 'the decision window has closed');
  assert.equal(lapsed[0].includes('<input'), false);
  assert.equal(lapsed[0].includes('name="reason"'), false);
  // It is readable rather than vanished, which is the whole point of the panel.
  assert.match(lapsed[0], new RegExp(SEEDED_LAPSED_ID));
  assert.match(lapsed[0], /expired /);
});

test('the posture table renders every class in roster order, with the label trust.js produces', async () => {
  const { repositories } = seededRepos();
  const html = await renderPage('/approvals', { repositories });
  const rows = [...html.matchAll(/data-testid="posture-row-([a-z-]+)"/g)].map(([, actionClass]) => actionClass);
  assert.deepEqual(rows, ACTION_CLASSES.map((entry) => entry.action_class), 'the roster order, not an alphabetical or a stored order');

  const tenant = tenantOf(repositories);
  for (const entry of ACTION_CLASSES) {
    const row = repositories.trustLedger.get(tenant.id, entry.action_class);
    const label = POSTURE_LABELS[postureFor(entry.action_class, row, entry, row?.pinned ?? false)];
    assert.match(html, new RegExp(`<td>${entry.action_class}</td>\\s*<td>${label}</td>`), `${entry.action_class} must render as ${label}`);
  }
  // A pinned class is held to shadow whatever its numbers say, and the table
  // says so in words rather than only in a column.
  assert.match(html, /<td>shadow<\/td>\s*<td>Policy only: this slice can never write it/);
  // The class with no row at all is the fail-closed reading, and the Why says
  // that is why.
  assert.match(html, /<td>campaign-launch<\/td>\s*<td>approval required<\/td>\s*<td>No trust evidence yet/);
});

test('empty, executed and lapsed render beside each other, and the table survives a null tenant', async () => {
  const { repositories, tenant } = seededRepos();
  // Everything decided: nothing pending, something executed, something lapsed.
  for (const approvalId of SEEDED_PENDING_IDS) {
    repositories.approvals.decide(tenant.id, approvalId, { status: 'rejected', reason: 'not this week', actor: 'Priya', decided_at: new Date().toISOString() });
  }
  repositories.actionRecords.append({
    tenant_id: tenant.id,
    receipt_id: 'rcp_only',
    approval_id: SEEDED_PENDING_IDS[0],
    capability_id: 'cap_only',
    nonce: 'nc_only',
    action_class: 'campaign-launch',
    action: 'create_campaign',
    resource: 'campaign_009',
    requested: { name: 'Brand — new launch' },
    reported: {},
    reconciliation: 'agreed',
    drift: 'none',
    maturity_at_decision: 0.91,
    band_at_decision: 'strategic',
    actor: 'Priya',
    executed_at: new Date().toISOString(),
  });

  const html = await renderPage('/approvals', { repositories });
  assert.equal(html.includes('data-testid="approvals-empty"'), true);
  assert.equal(count(html, 'data-testid="approval-card"'), 0);
  assert.equal(count(html, 'data-testid="executed-receipt"'), 1);
  assert.equal(count(html, 'data-testid="lapsed-row"'), 1);
  assert.match(html, /Emptiness here is healthy/, 'the empty state explains why it is not an error');
  // The three regions coexist rather than one replacing another.
  assert.equal(count(html, 'data-testid="posture-table"'), 1);
  assert.equal(count(html, 'data-testid="approval-decision-result"'), 1);

  // A database with no tenant at all: the page still renders the table, with
  // every class held to approval-required rather than crashing on tenant.id.
  const empty = await renderPage('/approvals', { repositories: freshRepos() });
  assert.match(empty, /data-testid="posture-table"/);
  assert.equal(count(empty, 'data-testid="posture-row-campaign-launch"'), 1);
  for (const entry of ACTION_CLASSES) {
    assert.match(empty, new RegExp(`<td>${entry.action_class}</td>\\s*<td>approval required</td>`), entry.action_class);
  }
  assert.equal(empty.includes('data-testid="executed-receipt"'), false);
  assert.equal(empty.includes('data-testid="lapsed-row"'), false);
});

test('the guardian banner appears on every route while the freeze holds, and on none of them after it lifts', async () => {
  const { repositories, tenant } = seededRepos();
  repositories.killSwitches.upsertFreeze({
    tenant_id: tenant.id,
    scope: 'provider',
    scope_id: 'meta_ads',
    kind: 'spend-spike',
    reason: 'spend-spike tripped',
    actor: 'guardian',
    frozen_at: new Date().toISOString(),
  });

  for (const route of ROUTES) {
    const html = await renderPage(route, { repositories });
    assert.equal(count(html, 'data-testid="guardian-banner"'), 1, route);
    assert.match(html, /role="status"/, route);
    // The banner NAMES the hold: the scope, the id and the detector, so an
    // operator knows what is frozen without opening the API.
    assert.match(html, /provider meta_ads — spend-spike/, route);
    assert.match(html, /Approve nothing until a human re-enables it/, route);
  }

  repositories.killSwitches.reEnable(tenant.id, 'provider', 'meta_ads', { actor: 'Priya', at: new Date().toISOString() });
  for (const route of ROUTES) {
    const html = await renderPage(route, { repositories });
    assert.equal(html.includes('data-testid="guardian-banner"'), false, route);
  }
});

test('EVERY route in EVERY state renders on a null-tenant database, banner included', async () => {
  // 25 renders: the composition point runs before the page body, so a
  // `tenant.id` dereference in the banner would throw on every one of them.
  for (const route of ROUTES) {
    for (const state of STATES) {
      const html = await renderPage(route, { repositories: freshRepos(), override: state });
      assert.match(html, new RegExp(`data-page="${route}"`), `${route} ${state}`);
      assert.equal(html.includes('data-testid="guardian-banner"'), false, `${route} ${state}`);
    }
  }
});

test('the error and partial shells keep their retry control and their wording', async () => {
  const { repositories } = seededRepos();
  const error = await renderPage('/approvals', { repositories, override: 'error' });
  assert.match(error, /data-state="error"/);
  assert.match(error, /Approval action failed/);
  assert.match(error, /The approval store could not be read \(source: approval store\)/);
  assert.match(error, /No approval was decided and no receipt was written\./);
  assert.match(error, /the pending queue, the executed receipts and the lapsed items are unchanged\./);
  assert.match(error, /<button[^>]*data-action="retry"[^>]*data-retry-href="\/approvals"/, 'the retry control survives');

  const partial = await renderPage('/approvals', { repositories, override: 'partial' });
  assert.match(partial, /data-state="partial"/);
  assert.match(partial, /Expired approvals are shown as lapsed instead of vanishing\./);
  // A degraded read still renders the queue, and still names the lapsed item
  // rather than dropping it: the degradation is about freshness, not content.
  assert.equal(count(partial, 'data-testid="approval-card"'), 3);
  assert.equal(count(partial, 'data-testid="lapsed-row"'), 1);
  assert.equal(count(partial, 'data-testid="posture-table"'), 1);
  assert.equal(count(partial, 'data-testid="approval-decision-result"'), 1);
});
