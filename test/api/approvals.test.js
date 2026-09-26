// POST /v1/approvals/:approvalId/approve and /reject (issue #20, TR-3/TR-5).
// The load-bearing cases are the REDELIVERY rule, which is answered BEFORE the
// gate, and the ?meta_error refusal, which is the server half of the browser
// clause and the case that fails if this route ever builds its provider by
// hand instead of through providerForRequest.

import { test, after } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import { buildApp } from '../../src/api/routes.js';
import { createKernel, decisionNonce, DEFAULT_SIGNING_SECRET } from '../../src/policy/kernel.js';

const dir = mkdtempSync(join(tmpdir(), 'approvals-api-'));
const db = openDatabase(join(dir, 'app.db'));
const repositories = createRepositories(db);
const app = buildApp({ repositories });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());

const url = (path) => `http://127.0.0.1:${server.address().port}${path}`;
const TENANT = 'tenant_api';
const REASON = 'CPL doubled on brand terms and stayed there';

let counter = 0;
function fixture(overrides = {}) {
  counter += 1;
  const approvalId = overrides.approval_id ?? `apv_api_${counter}`;
  repositories.approvals.create({
    tenant_id: TENANT,
    approval_id: approvalId,
    action_class: 'campaign-status',
    action: 'set_campaign_status',
    resource: 'campaign_001',
    constraints: { status: 'PAUSED' },
    impact: 'pause brand defence',
    downside: 'brand coverage gap for one day',
    evidence_refs: ['evt_api_1'],
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    status: 'pending',
    ...overrides,
  });
  return approvalId;
}

async function post(path, body) {
  const response = await fetch(url(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() };
}

const approve = (approvalId, body = {}, query = '') => post(`/v1/approvals/${encodeURIComponent(approvalId)}/approve${query}`, { tenant_id: TENANT, reason: REASON, ...body });
const reject = (approvalId, body = {}) => post(`/v1/approvals/${encodeURIComponent(approvalId)}/reject`, { tenant_id: TENANT, reason: REASON, ...body });

const seedTrust = (rows) => {
  for (const row of rows) {
    repositories.trustLedger.upsert(TENANT, row);
  }
};

// The gate needs a measured maturity, and maturity is computed from the
// tenant's own funnel events, so one tenant is set up for the whole file.
await fetch(url('/v1/events'), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tenant_id: TENANT, event_id: 'evt_api_spend_1', event_name: 'spend.observed', occurred_at: new Date(Date.now() - 96 * 3_600_000).toISOString(), value: 7_200_000_000, currency: 'INR' }),
});
await fetch(url('/v1/events'), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tenant_id: TENANT, event_id: 'evt_api_lead_1', event_name: 'lead_qualified', occurred_at: new Date(Date.now() - 96 * 3_600_000).toISOString(), lead_id: 'lead_api_1' }),
});
repositories.tenants.create({ id: TENANT, name: 'API tenant', currency: 'INR' });

test('a successful approve reports agreement on seed data and writes exactly one receipt', async () => {
  const approvalId = fixture();
  const { status, body } = await approve(approvalId);
  assert.equal(status, 200);
  assert.equal(body.status, 'executed');
  assert.equal(body.executed, true);
  assert.equal(body.reconciliation, 'agreed');
  assert.equal(body.drift, 'none');
  assert.equal(body.receipt_id.startsWith('rcp_'), true);

  const receipts = repositories.actionRecords.listByApproval(TENANT, approvalId, { limit: 5 });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].receipt_id, body.receipt_id);
  assert.equal(repositories.approvals.get(TENANT, approvalId).status, 'executed');
  assert.equal(repositories.approvals.get(TENANT, approvalId).reason, REASON, 'the reason is stored verbatim');
});

test('THE REDELIVERY CASE: approving twice answers about the receipt that already exists', async () => {
  const approvalId = fixture();
  const first = await approve(approvalId);
  assert.equal(first.body.executed, true);

  const second = await approve(approvalId, { reason: 'a completely different reason' });
  assert.equal(second.status, 200);
  assert.equal(second.body.executed, false);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.status, 'executed');
  assert.equal(second.body.receipt_id, first.body.receipt_id);
  assert.equal(second.body.reconciliation, first.body.reconciliation);
  // One receipt, and the FIRST reason still stands: a redelivery changes
  // nothing, including the audit record of why.
  assert.equal(repositories.actionRecords.listByApproval(TENANT, approvalId, { limit: 5 }).length, 1);
  assert.equal(repositories.approvals.get(TENANT, approvalId).reason, REASON);
  assert.equal(repositories.actionRecords.getByNonce(TENANT, decisionNonce(approvalId)) !== null, true);
});

test('a provider refusal under ?meta_error=quota leaves the approval PENDING and writes no receipt', async () => {
  // The browser clause, over HTTP, against the same query the page carries.
  // If this route built its provider without providerForRequest, the fake
  // would be healthy here and this case would pass for the wrong reason.
  const approvalId = fixture();
  const { status, body } = await approve(approvalId, {}, '?meta_error=quota');
  assert.equal(status, 200);
  assert.equal(body.outcome, 'provider_refused');
  assert.equal(body.executed, false);
  assert.equal(body.duplicate, false);
  assert.equal(body.status, 'pending');
  assert.equal(body.reconciliation, 'unknown');
  assert.equal(body.error.code, 'META_QUOTA_EXHAUSTED');
  assert.equal(repositories.approvals.get(TENANT, approvalId).status, 'pending', 'a refusal writes no status change');
  assert.equal(repositories.actionRecords.getByNonce(TENANT, decisionNonce(approvalId)), null);

  // ...and the retry, with no simulation, is a genuine one.
  const retried = await approve(approvalId, { reason: 'provider was healthy this time' });
  assert.equal(retried.body.executed, true);
  assert.equal(retried.body.reconciliation, 'agreed');
});

test('a revoked provider is refused the same way, and nothing is half-written', async () => {
  const approvalId = fixture();
  const { status, body } = await approve(approvalId, {}, '?meta_error=revoked');
  assert.equal(status, 200);
  assert.equal(body.error.code, 'META_PERMISSION_REVOKED');
  assert.equal(body.error.retryable, false);
  assert.equal(repositories.approvals.get(TENANT, approvalId).status, 'pending');
  assert.equal(repositories.actionRecords.getByNonce(TENANT, decisionNonce(approvalId)), null);
});

test('a missing, blank or invisible-only reason is 400 REASON_REQUIRED', async () => {
  for (const reason of [undefined, '', '    ', '‌‍', '́̈', 7, null]) {
    const approvalId = fixture();
    const { status, body } = await approve(approvalId, { reason });
    assert.equal(status, 400, JSON.stringify(reason));
    assert.equal(body.code, 'REASON_REQUIRED', JSON.stringify(reason));
    // The check runs before the row is read or written: nothing changed.
    assert.equal(repositories.approvals.get(TENANT, approvalId).status, 'pending');
  }
});

test('a reason over 500 characters is 400 REASON_TOO_LONG, distinctly from a missing one', async () => {
  const approvalId = fixture();
  const { status, body } = await approve(approvalId, { reason: 'x'.repeat(501) });
  assert.equal(status, 400);
  assert.equal(body.code, 'REASON_TOO_LONG');
  assert.equal(body.details.max, 500);
  assert.equal(repositories.approvals.get(TENANT, approvalId).status, 'pending');
});

test('the reason is stored VERBATIM, and on the audit event too', async () => {
  const approvalId = fixture();
  const typed = '  paused because <CPA> doubled & stayed high  ';
  await approve(approvalId, { reason: typed });
  const row = repositories.approvals.get(TENANT, approvalId);
  assert.equal(row.reason, 'paused because <CPA> doubled & stayed high');
  const event = repositories.auditEvents.list(TENANT, { limit: 50 })
    .find((entry) => entry.action === 'approval.approved' && entry.subject === approvalId);
  assert.ok(event, 'an audit event records the decision');
  assert.equal(event.details.reason, row.reason);
  assert.equal(event.details.receipt_id.startsWith('rcp_'), true);
});

test('approving a LAPSED approval is 409 naming the real status', async () => {
  const approvalId = fixture({ expires_at: new Date(Date.now() - 3_600_000).toISOString() });
  const { status, body } = await approve(approvalId);
  assert.equal(status, 409);
  assert.equal(body.code, 'APPROVAL_NOT_PENDING');
  // The stored status is still 'pending' — what lapsed it is the STAMP, and
  // details says so rather than pretending the status changed.
  assert.equal(body.details.status, 'pending');
  assert.equal(body.details.lapsed, true);
  assert.equal(repositories.actionRecords.getByNonce(TENANT, decisionNonce(approvalId)), null);
});

test('re-deciding a REJECTED approval is 409 naming the real status', async () => {
  const approvalId = fixture();
  const rejected = await reject(approvalId);
  assert.equal(rejected.body.status, 'rejected');

  const second = await approve(approvalId);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'APPROVAL_NOT_PENDING');
  assert.equal(second.body.details.status, 'rejected');
  assert.equal(second.body.details.lapsed, false);
});

test('a cross-tenant approval id is 404 and writes nothing', async () => {
  const approvalId = fixture();
  const { status, body } = await post(`/v1/approvals/${approvalId}/approve`, {
    tenant_id: 'tenant_not_mine',
    reason: REASON,
  });
  assert.equal(status, 404);
  assert.equal(body.code, 'APPROVAL_NOT_FOUND');
  assert.equal(body.details.approval_id, approvalId);
  assert.equal(repositories.approvals.get(TENANT, approvalId).status, 'pending');
  assert.equal(repositories.actionRecords.getByNonce('tenant_not_mine', decisionNonce(approvalId)), null);
  assert.equal(repositories.actionRecords.getByNonce(TENANT, decisionNonce(approvalId)), null);
});

test('an unknown approval id is 404 APPROVAL_NOT_FOUND', async () => {
  for (const verb of ['approve', 'reject']) {
    const { status, body } = await post(`/v1/approvals/apv_api_missing/${verb}`, { tenant_id: TENANT, reason: REASON });
    assert.equal(status, 404, verb);
    assert.equal(body.code, 'APPROVAL_NOT_FOUND', verb);
  }
});

test('reject answers 200, mints nothing and touches no provider', async () => {
  const approvalId = fixture();
  const { status, body } = await reject(approvalId);
  assert.equal(status, 200);
  assert.deepEqual(body, { approval_id: approvalId, status: 'rejected', decided: true });
  assert.equal(repositories.approvals.get(TENANT, approvalId).status, 'rejected');
  assert.equal(repositories.actionRecords.getByNonce(TENANT, decisionNonce(approvalId)), null, 'no receipt');
  assert.equal(repositories.capabilities.listForTenant(TENANT, { limit: 50 }).filter((row) => row.approval_id === approvalId).length, 0, 'no capability');
  const event = repositories.auditEvents.list(TENANT, { limit: 50 })
    .find((entry) => entry.action === 'approval.rejected' && entry.subject === approvalId);
  assert.ok(event, 'a rejection is audited');
  assert.equal(event.details.reason, REASON);
});

test('a second reject is 409, and a reject needs a reason too', async () => {
  const approvalId = fixture();
  await reject(approvalId);
  const second = await reject(approvalId, { reason: 'changed my mind' });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'APPROVAL_NOT_PENDING');
  assert.equal(second.body.details.status, 'rejected');

  const other = fixture();
  const missing = await reject(other, { reason: '   ' });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'REASON_REQUIRED');
  assert.equal(repositories.approvals.get(TENANT, other).status, 'pending');
});

test('a shadow-pinned class is admitted by a human approval and refused without one', async () => {
  seedTrust([{ action_class: 'new-geography', evaluated: 2, correct: 2, needless: 0, downside_penalties: 0, pinned: true }]);
  const approvalId = fixture({ action_class: 'new-geography', action: 'create_campaign', resource: 'campaign_004', constraints: { name: 'Retargeting — new region' } });

  // The no-approval issuance route refuses it: shadow means never autonomous.
  const autonomous = await post('/v1/capabilities', {
    tenant_id: TENANT, action_class: 'new-geography', action: 'create_campaign', resource: 'campaign_004', constraints: { name: 'Retargeting — new region' },
  });
  assert.equal(autonomous.status, 403);
  assert.equal(autonomous.body.code, 'AUTONOMY_NOT_EARNED');
  assert.equal(autonomous.body.details.reason, 'no-approval');
  assert.equal(autonomous.body.details.posture, 'shadow');
  assert.equal(autonomous.body.envelope, undefined);

  // ...and the human queue is exactly where a pinned class is decided.
  const { status, body } = await approve(approvalId);
  assert.equal(status, 200);
  assert.equal(body.executed, true);
  assert.equal(body.reconciliation, 'agreed');
});

test('campaign-status is admitted on BOTH routes once its trust row earns autonomy', async () => {
  seedTrust([{ action_class: 'campaign-status', evaluated: 6, correct: 6, needless: 0, downside_penalties: 0, pinned: false }]);
  const issued = await post('/v1/capabilities', {
    tenant_id: TENANT, action_class: 'campaign-status', action: 'set_campaign_status', resource: 'campaign_002', constraints: { status: 'PAUSED' },
  });
  assert.equal(issued.status, 201);
  assert.equal(issued.body.envelope.tenant, TENANT);

  const approvalId = fixture();
  const approved = await approve(approvalId);
  assert.equal(approved.body.executed, true);
  // The receipt names the band that was actually enforced.
  assert.equal(approved.body.band, 'moderate');
  assert.equal(typeof approved.body.maturity, 'number');
  assert.equal(repositories.actionRecords.listByApproval(TENANT, approvalId, { limit: 1 })[0].band_at_decision, 'moderate');
});

test('a budget-change approval inside its micro-limit executes, and one above it is refused', async () => {
  const inside = fixture({ action_class: 'budget-change', action: 'update_campaign_budget', resource: 'adset_001', constraints: { delta_micros: 40_000_000 } });
  const ok = await approve(inside);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.executed, true);

  const above = fixture({ action_class: 'budget-change', action: 'update_campaign_budget', resource: 'adset_001', constraints: { delta_micros: 900_000_000 } });
  const refused = await approve(above);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'MICRO_LIMIT_EXCEEDED');
  assert.equal(refused.body.details.limit_micros, 50_000_000);
  assert.equal(repositories.approvals.get(TENANT, above).status, 'pending', 'a gate refusal leaves it pending');
});

test('an approval whose class no longer matches the row\'s action is refused, not silently rewritten', async () => {
  const approvalId = fixture({ action_class: 'new-geography', action: 'update_campaign_budget', resource: 'adset_001', constraints: { delta_micros: 1 } });
  const { status, body } = await approve(approvalId);
  assert.equal(status, 403);
  assert.equal(body.code, 'AUTONOMY_NOT_EARNED');
  assert.equal(body.details.reason, 'action-mismatch');
});

test('THE WRITE PATH RE-GATES AN APPROVAL-BACKED CAPABILITY against the approval row it names', async () => {
  // The gate used to run only where capabilities were minted, so an envelope
  // outlived the decision that authorised it. The re-gate runs on the write
  // path too, and it is fed the STORED envelope's own authority — the
  // capability below names an approval that is no longer there.
  const approvalId = fixture();
  const kernel = createKernel({ secret: DEFAULT_SIGNING_SECRET, policyVersion: '1', ...{ killSwitches: { isActive: () => false }, nonces: { seen: () => false } } });
  const envelope = kernel.issueCapability({
    tenant_id: TENANT,
    action_class: 'campaign-status',
    action: 'set_campaign_status',
    resource: 'campaign_001',
    constraints: { status: 'PAUSED' },
    maturity: 0.83,
  }, { nowIso: new Date().toISOString(), approvalId, nonce: decisionNonce(approvalId) });
  repositories.capabilities.create({ tenant_id: TENANT, capability_id: envelope.capability_id, envelope, expires_at: envelope.expiry });
  assert.deepEqual(envelope.authority, { kind: 'human-approval', approval_id: approvalId });

  // The row goes away underneath it, which is the whole hazard: a signature
  // does not keep an approval alive.
  db.prepare('DELETE FROM approvals WHERE tenant_id = ? AND approval_id = ?').run(TENANT, approvalId);

  const { status, body } = await post('/v1/actions/execute', envelope);
  assert.equal(status, 403);
  assert.equal(body.code, 'AUTONOMY_NOT_EARNED');
  assert.equal(body.details.reason, 'malformed');
  assert.equal(body.details.approval_id, approvalId);
  assert.equal(repositories.actionRecords.getByNonce(TENANT, envelope.nonce), null, 'no receipt for a write nobody approved');

  // ...and a capability whose approval is still there goes through on the same
  // path, so the re-gate is not simply a wall.
  const live = fixture();
  const admitted = kernel.issueCapability({
    tenant_id: TENANT,
    action_class: 'campaign-status',
    action: 'set_campaign_status',
    resource: 'campaign_001',
    constraints: { status: 'PAUSED' },
    maturity: 0.83,
  }, { nowIso: new Date().toISOString(), approvalId: live, nonce: decisionNonce(live) });
  repositories.capabilities.create({ tenant_id: TENANT, capability_id: admitted.capability_id, envelope: admitted, expires_at: admitted.expiry });
  const allowed = await post('/v1/actions/execute', admitted);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.executed, true);
  // The receipt is filed against the decision the STORED authority names, not
  // against anything the request said about itself.
  assert.equal(repositories.actionRecords.getByNonce(TENANT, admitted.nonce).approval_id, live);
});
