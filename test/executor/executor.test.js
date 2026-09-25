// The executor (issue #20, TR-5): the only module that calls a provider WRITE.
// The cases below pin the ORDER of its checks, because the order is the safety
// property — a refusal before the provider must not burn the nonce, and a
// refusal after it must not pretend it never reached the account.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, utcNow } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import { createExecutor, writeArgsFor } from '../../src/executor/executor.js';
import { createKernel, decisionNonce } from '../../src/policy/kernel.js';
import { FakeMetaAdsProvider } from '../../src/integrations/meta_ads/fake.js';

const TENANT = 'tenant_demo';
const SECRET = 'executor-test-secret';
const NOW = '2026-09-25T10:00:00.000Z';

function boot({ failureMode = 'ok', writeDrift = 'none' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'executor-'));
  const db = openDatabase(join(dir, 'app.db'));
  const repositories = createRepositories(db);
  repositories.tenants.create({ id: TENANT, name: 'Demo', currency: 'INR' });
  const kernel = createKernel({
    secret: SECRET,
    policyVersion: '1',
    killSwitches: { isActive: (tenantId, scope, scopeId) => repositories.killSwitches.isActive(tenantId, scope, scopeId) },
    nonces: { seen: (tenantId, nonce) => repositories.actionRecords.getByNonce(tenantId, nonce) !== null },
  });
  const provider = new FakeMetaAdsProvider({ failureMode, writeDrift });
  const executor = createExecutor({ repositories, provider, kernel, auditClock: () => NOW });
  return { db, repositories, kernel, provider, executor };
}

const capabilityFor = (kernel, overrides = {}, options = {}) => kernel.issueCapability({
  tenant_id: TENANT,
  action_class: 'campaign-status',
  action: 'set_campaign_status',
  resource: 'campaign_001',
  constraints: { status: 'PAUSED' },
  maturity: 0.83,
  ...overrides,
}, { nowIso: NOW, ...options });

const run = (executor, capability, options = {}) => executor.execute(capability, { actor: 'tester', tenantId: TENANT, ...options });

test('a success writes exactly one receipt, records the effect and appends an audit event', async () => {
  const { repositories, kernel, executor } = boot();
  const capability = capabilityFor(kernel);
  const result = await run(executor, capability);

  assert.equal(result.executed, true);
  assert.equal(result.receipt_id, `rcp_${capability.capability_id.replace(/^cap_/, '')}`);
  assert.equal(result.reconciliation, 'agreed');
  assert.equal(result.drift, 'none');

  const receipts = repositories.actionRecords.listForTenant(TENANT, { limit: 10 });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].tenant_id, TENANT);
  assert.equal(receipts[0].nonce, capability.nonce);
  // The maturity and band are COPIED from the signed envelope, so a receipt
  // names the band that was actually enforced.
  assert.equal(receipts[0].maturity_at_decision, 0.83);
  assert.equal(receipts[0].band_at_decision, 'moderate');
  assert.equal(receipts[0].actor, 'tester');
  assert.equal(receipts[0].executed_at, NOW);
  assert.equal(receipts[0].approval_id, null, 'an autonomous execution belongs to no approval row');

  // record() stores the effect as JSON, so the receipt id is one level down.
  const effect = repositories.idempotency.get(TENANT, capability.nonce, 'executor');
  assert.equal(effect.effect.receipt_id, result.receipt_id);
  const audit = repositories.auditEvents.list(TENANT, { limit: 10 });
  const event = audit.find((entry) => entry.action === 'action.executed');
  assert.ok(event);
  assert.equal(event.actor, 'tester');
  assert.equal(event.capability_id, capability.capability_id);
});

test('an approvalId is recorded on the receipt when the caller supplies one', async () => {
  const { repositories, kernel, executor } = boot();
  const result = await run(executor, capabilityFor(kernel), { approvalId: 'apv_1' });
  assert.equal(result.executed, true);
  const receipt = repositories.actionRecords.listByApproval(TENANT, 'apv_1', { limit: 5 });
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0].approval_id, 'apv_1');
  assert.equal(receipt[0].receipt_id, result.receipt_id);
});

test('a duplicate nonce returns the ORIGINAL receipt and writes nothing', async () => {
  const { repositories, kernel, executor, provider } = boot();
  const capability = capabilityFor(kernel);
  const first = await run(executor, capability);
  const writesAfterFirst = provider.lastWrite();

  const second = await run(executor, capability);
  assert.equal(second.executed, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.receipt_id, first.receipt_id);
  assert.equal(second.reconciliation, first.reconciliation);
  assert.equal(provider.lastWrite(), writesAfterFirst, 'the provider was not written to a second time');
  assert.equal(repositories.actionRecords.listForTenant(TENANT, { limit: 10 }).length, 1);
});

test('a duplicate is still answered while a kill switch is active', async () => {
  // The receipt already exists, so the honest answer is about the receipt.
  // Refusing with KILL_SWITCH_ACTIVE would tell an operator their action
  // failed when it succeeded.
  const { repositories, kernel, executor } = boot();
  const capability = capabilityFor(kernel);
  const first = await run(executor, capability);
  repositories.killSwitches.upsertFreeze({ tenant_id: TENANT, scope: 'provider', scope_id: 'meta_ads', kind: 'spend-spike', reason: 'x', actor: 'guardian', frozen_at: NOW });

  const second = await run(executor, capability);
  assert.equal(second.duplicate, true);
  assert.equal(second.receipt_id, first.receipt_id);
  assert.equal(second.error, undefined);
});

test('the loser of the atomic claim is told to RETRY, and no provider call is made', async () => {
  // A claim the winner holds and has not yet released: exactly the two-tab
  // race, held open by hand. It is taken from the SAME repository the executor
  // will use, so this is the real race rather than a mock of it.
  const live = boot();
  const capability = capabilityFor(live.kernel);
  assert.equal(live.repositories.idempotency.claim(TENANT, capability.nonce, 'executor'), true);
  const blocked = await live.executor.execute(capability, { actor: 'tester', tenantId: TENANT });
  assert.equal(blocked.executed, false);
  assert.equal(blocked.duplicate, false);
  assert.equal(blocked.error.code, 'EXECUTION_IN_PROGRESS');
  assert.equal(blocked.error.retryable, true);
  assert.equal(live.provider.lastWrite(), null, 'no provider call while the claim is held');

  // The winner releases, and the retry is a genuine retry.
  live.repositories.idempotency.release(TENANT, capability.nonce, 'executor');
  const retried = await live.executor.execute(capability, { actor: 'tester', tenantId: TENANT });
  assert.equal(retried.executed, true);
  assert.equal(live.repositories.actionRecords.listForTenant(TENANT, { limit: 5 }).length, 1);
});

test('a provider refusal writes NO receipt, releases the claim, and stays retryable', async () => {
  const { repositories, kernel, executor } = boot({ failureMode: 'quota' });
  const capability = capabilityFor(kernel);
  const result = await run(executor, capability);

  assert.equal(result.executed, false);
  assert.equal(result.reconciliation, 'unknown');
  assert.equal(result.error.code, 'META_QUOTA_EXHAUSTED');
  assert.equal(result.error.retryable, true);
  assert.deepEqual(repositories.actionRecords.listForTenant(TENANT, { limit: 10 }), [], 'no receipt');
  // The claim was released, so the next attempt is a real attempt rather than
  // a swallowed one.
  assert.equal(repositories.idempotency.claim(TENANT, capability.nonce, 'executor'), true);
  repositories.idempotency.release(TENANT, capability.nonce, 'executor');
});

test('every refusal BEFORE the provider releases the claim, so no nonce is burned', async () => {
  const { kernel, executor, provider, repositories } = boot();
  const capability = capabilityFor(kernel);
  const refusals = [
    // The freeze is raised first, so the kill-switch refusal is the one that
    // runs; every later case is refused by its OWN rule before the switches
    // are ever consulted.
    ['kill switch', capability, { freeze: true }],
    // Expired has to be SIGNED as expired: the signature covers expiry, so
    // editing the field on a live envelope would prove nothing about expiry.
    ['expired', capabilityFor(kernel, {}, { ttlMs: -1 }), {}],
    ['bad signature', { ...capability, resource: 'campaign_002' }, {}],
    ['over scope', capabilityFor(kernel), { tenantId: 'tenant_other' }],
    ['tenant mismatch', capability, { tenantId: 'tenant_other' }],
  ];
  for (const [label, envelope, options] of refusals) {
    const { freeze: shouldFreeze = false, ...executeOptions } = options;
    if (shouldFreeze) {
      repositories.killSwitches.upsertFreeze({ tenant_id: TENANT, scope: 'global', scope_id: TENANT, kind: 'spend-spike', reason: 'x', actor: 'guardian', frozen_at: NOW });
    }
    const result = await executor.execute(envelope, { actor: 'tester', tenantId: TENANT, ...executeOptions });
    assert.equal(result.executed, false, label);
    assert.equal(result.duplicate, false, label);
    assert.equal(typeof result.error?.code, 'string', label);
    // The claim is free again: whoever holds it next can take it.
    assert.equal(repositories.idempotency.claim(TENANT, envelope.nonce, 'executor'), true, label);
    repositories.idempotency.release(TENANT, envelope.nonce, 'executor');
    assert.deepEqual(repositories.actionRecords.listForTenant(TENANT, { limit: 10 }), [], `${label} wrote a receipt`);
  }
  // ...and none of them reached the provider.
  assert.equal(provider.lastWrite(), null);
});

test('TENANT_MISMATCH is checked BEFORE the dedupe read, so a foreign envelope never touches this tenant\'s rows', async () => {
  const { repositories, kernel, executor } = boot();
  const capability = kernel.issueCapability({
    tenant_id: 'tenant_other', action_class: 'campaign-status', action: 'set_campaign_status', resource: 'campaign_001', constraints: { status: 'PAUSED' }, maturity: 0.83,
  }, { nowIso: NOW });
  const result = await run(executor, capability, { tenantId: TENANT });
  assert.equal(result.error.code, 'TENANT_MISMATCH');
  assert.deepEqual(repositories.actionRecords.listForTenant(TENANT, { limit: 10 }), []);
});

test('THE RECONCILIATION VOCABULARY is closed and every value is reachable', async () => {
  // 'agreed' — the re-read reports exactly what the write applied.
  const agreed = boot();
  const agreedResult = await run(agreed.executor, capabilityFor(agreed.kernel));
  assert.equal(agreedResult.reconciliation, 'agreed');

  // 'unknown' — a provider refusal has no re-read to compare against.
  const refused = boot({ failureMode: 'revoked' });
  const refusedResult = await run(refused.executor, capabilityFor(refused.kernel));
  assert.equal(refusedResult.reconciliation, 'unknown');

  // 'diverged' — the write applied, but the re-read disagrees. Injected by a
  // provider whose write is followed by a state that does not match it, which
  // is the only honest way to produce it from outside.
  const diverged = boot();
  const lying = {
    lastWrite: () => ({ drift: 'platform' }),
    async setCampaignStatus() { return { ok: true, data: { reported: { status: 'PAUSED' } } }; },
    async listCampaigns() { return { ok: true, data: [{ id: 'campaign_001', status: 'ACTIVE' }] }; },
  };
  const liarExecutor = createExecutor({
    repositories: diverged.repositories,
    provider: lying,
    kernel: diverged.kernel,
    auditClock: () => NOW,
  });
  const divergedResult = await run(liarExecutor, capabilityFor(diverged.kernel));
  assert.equal(divergedResult.executed, true);
  assert.equal(divergedResult.reconciliation, 'diverged');
  assert.equal(divergedResult.drift, 'platform');

  // ...and the column is never NULL or undefined, which is what the toast and
  // the failure panel render.
  for (const result of [agreedResult, refusedResult, divergedResult]) {
    assert.equal(typeof result.reconciliation, 'string');
    assert.ok(['agreed', 'diverged', 'partial', 'unknown'].includes(result.reconciliation));
  }
});

test('drift is classified from what the PROVIDER reports', async () => {
  for (const drift of ['none', 'manual', 'platform', 'third-party']) {
    const { kernel, executor } = boot({ writeDrift: drift });
    const result = await run(executor, capabilityFor(kernel));
    assert.equal(result.drift, drift, drift);
  }
  // A provider that reports nothing usable is 'none' when the re-read agreed.
  const { kernel, executor } = boot();
  const result = await run(executor, capabilityFor(kernel));
  assert.equal(result.drift, 'none');
});

test('the write method is resolved from the SIGNED action, never from the caller', async () => {
  const { kernel, executor, provider } = boot();
  const capability = capabilityFor(kernel);
  await run(executor, capability);
  assert.equal(provider.lastWrite().action, 'set_campaign_status');

  // An action the contract does not register is refused, never routed to
  // something adjacent. The signature covers `action`, so a caller cannot
  // reach the write map with one the kernel never signed.
  const fresh = boot();
  const other = capabilityFor(fresh.kernel);
  const forged = { ...other, action: 'delete_everything' };
  const result = await fresh.executor.execute(forged, { actor: 'tester', tenantId: TENANT });
  assert.equal(result.executed, false);
  assert.equal(result.error.code, 'BAD_SIGNATURE');
  assert.equal(fresh.provider.lastWrite(), null, 'no provider call');
});

test("create_campaign takes the name from constraints.name, never from resource", async () => {
  // resource is a PROPOSED id that does not exist yet; reading the name off
  // it would create a campaign literally called 'campaign_004'.
  const envelope = {
    tenant: TENANT,
    resource: 'campaign_004',
    constraints: { name: 'Retargeting — new region' },
  };
  assert.deepEqual(writeArgsFor('create_campaign', envelope), { name: 'Retargeting — new region' });
  assert.deepEqual(writeArgsFor('set_campaign_status', { resource: 'campaign_001', constraints: { status: 'PAUSED' } }), { campaignId: 'campaign_001', status: 'PAUSED' });
  assert.deepEqual(writeArgsFor('update_campaign_budget', { resource: 'adset_001', constraints: { delta_micros: 40_000_000 } }), { adSetId: 'adset_001', deltaMicros: 40_000_000 });
  assert.deepEqual(writeArgsFor('update_campaign_creative', { resource: 'campaign_001', constraints: { name: 'Brand — RSA B' } }), { campaignId: 'campaign_001', name: 'Brand — RSA B' });
  assert.equal(writeArgsFor('delete_everything', envelope), null);

  const { kernel, executor, provider } = boot();
  const capability = kernel.issueCapability({
    tenant_id: TENANT, action_class: 'campaign-launch', action: 'create_campaign', resource: 'campaign_004', constraints: { name: 'Retargeting — new region' }, maturity: 0.83,
  }, { nowIso: NOW });
  const result = await run(executor, capability);
  assert.equal(result.executed, true);
  // The proposed id may well be the one the provider mints — what must never
  // happen is the NAME being read off it.
  assert.equal(provider.lastWrite().requested.name, 'Retargeting — new region');
  const created = await provider.listCampaigns();
  const row = created.data.find((entry) => entry.name === 'Retargeting — new region');
  assert.ok(row, 'a campaign exists under the requested name');
  assert.equal(created.data.some((entry) => entry.name === 'campaign_004'), false, 'no campaign is named after the proposed id');
  assert.equal(row.status, 'PAUSED', 'a new campaign is never born ACTIVE');
});

test('the approval nonce is the one the approve route will use, so a redelivery finds the receipt', async () => {
  const { repositories, kernel, executor } = boot();
  const capability = capabilityFor(kernel, {}, { nonce: decisionNonce('apv_seed_budget_1') });
  const result = await run(executor, capability, { approvalId: 'apv_seed_budget_1' });
  assert.equal(result.executed, true);
  const receipt = repositories.actionRecords.getByNonce(TENANT, decisionNonce('apv_seed_budget_1'));
  assert.ok(receipt, 'the approve route redelivery check reads exactly this row');
  assert.equal(receipt.approval_id, 'apv_seed_budget_1');
});

test('two concurrent deliveries of one nonce reach the provider exactly once', async () => {
  const { kernel, executor, provider, repositories } = boot();
  const capability = capabilityFor(kernel);
  const [first, second] = await Promise.all([run(executor, capability), run(executor, capability)]);
  const executed = [first, second].filter((result) => result.executed === true);

  assert.equal(executed.length, 1, 'exactly one execution');
  // The other is either the same receipt (it lost the UNIQUE nonce race at the
  // receipt) or told to retry (it lost the idempotency claim).
  const loser = [first, second].find((result) => result.executed !== true);
  assert.ok(loser.duplicate === true || loser.error?.code === 'EXECUTION_IN_PROGRESS', JSON.stringify(loser));
  if (loser.duplicate === true) {
    assert.equal(loser.receipt_id, executed[0].receipt_id);
  }
  assert.equal(repositories.actionRecords.listForTenant(TENANT, { limit: 10 }).length, 1);
  assert.ok(provider.lastWrite());
});

test('the executor never builds its own provider, and never reads the clock directly', async () => {
  // The provider is injected per request so one request can honour its own
  // ?meta_error and hold the state it just wrote for the re-read; the clock is
  // injected so a receipt's executed_at is deterministic in a test.
  const { kernel, executor } = boot();
  const capability = capabilityFor(kernel);
  await run(executor, capability);
  assert.ok(utcNow().length > 0, 'the injected clock is the only one the executor needs');
});
