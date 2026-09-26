// The executor (issue #20, TR-5): the only module that calls a provider WRITE.
// The cases below pin the ORDER of its checks, because the order is the safety
// property — a refusal before the provider must not burn the nonce, and a
// refusal after it must not pretend it never reached the account.
//
// Two of those checks are the load-bearing ones this revision added: the write
// path proves the envelope was ISSUED by this server, and it re-runs the gate on
// the values the server itself holds. A capability here is therefore minted
// AND STORED, because a stored one is what the write path acts on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, utcNow } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import { createExecutor, writeArgsFor } from '../../src/executor/executor.js';
import { createKernel, decisionNonce, DEFAULT_SIGNING_SECRET } from '../../src/policy/kernel.js';
import { FakeMetaAdsProvider } from '../../src/integrations/meta_ads/fake.js';

const TENANT = 'tenant_demo';
const SECRET = 'executor-test-secret';
const NOW = '2026-09-25T10:00:00.000Z';

const INTENT = {
  tenant_id: TENANT,
  action_class: 'campaign-status',
  action: 'set_campaign_status',
  resource: 'campaign_001',
  constraints: { status: 'PAUSED' },
  maturity: 0.83,
};

/** An offline forger: the SAME bytes the kernel would sign, with the dev secret
 * the kernel publishes. Reimplemented here rather than imported, because a
 * forgery that calls the kernel is not a forgery. */
const SIGNED_FIELD_ORDER = [
  'tenant', 'action_class', 'action', 'resource', 'constraints', 'maturity', 'band', 'expiry', 'nonce', 'policy_version', 'authority',
];
function forge(fields, secret = DEFAULT_SIGNING_SECRET) {
  const bytes = JSON.stringify(SIGNED_FIELD_ORDER.map((field) => fields[field] ?? null));
  return { ...fields, signature: createHmac('sha256', secret).update(bytes).digest('hex') };
}

function boot({ failureMode = 'ok', writeDrift = 'none', gate, secret = SECRET } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'executor-'));
  const db = openDatabase(join(dir, 'app.db'));
  const repositories = createRepositories(db);
  repositories.tenants.create({ id: TENANT, name: 'Demo', currency: 'INR' });
  const kernel = createKernel({
    secret,
    policyVersion: '1',
    killSwitches: { isActive: (tenantId, scope, scopeId) => repositories.killSwitches.isActive(tenantId, scope, scopeId) },
    nonces: { seen: (tenantId, nonce) => repositories.actionRecords.getByNonce(tenantId, nonce) !== null },
  });
  const provider = new FakeMetaAdsProvider({ failureMode, writeDrift });
  // The executor's gate port, recorded so a test can assert WHAT it was asked.
  // It is the same pure kernel.validateIntent the API binds in; here it is a
  // stand-in that admits unless the test says otherwise.
  const calls = [];
  const revalidate = (tenantId, intent, options) => {
    calls.push({ tenantId, intent, options });
    return gate ? gate(tenantId, intent, options) : { ok: true, intent };
  };
  const executor = createExecutor({ repositories, provider, kernel, auditClock: () => NOW, revalidate });
  return { db, repositories, kernel, provider, executor, calls };
}

/** Mint AND STORE: a capability the write path will act on is one the
 * capabilities table holds, so a test that skips this is testing a forgery. */
const capabilityFor = (repositories, kernel, overrides = {}, options = {}) => {
  const capability = kernel.issueCapability({ ...INTENT, ...overrides }, { nowIso: NOW, ...options });
  repositories.capabilities.create({
    tenant_id: capability.tenant,
    capability_id: capability.capability_id,
    envelope: capability,
    expires_at: capability.expiry,
  });
  return capability;
};

const run = (executor, capability, options = {}) => executor.execute(capability, { actor: 'tester', tenantId: TENANT, ...options });

test('a success writes exactly one receipt, records the effect and appends an audit event', async () => {
  const { repositories, kernel, executor } = boot();
  const capability = capabilityFor(repositories, kernel);
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

test('the receipt names the approval the STORED authority names, never one the caller supplies', async () => {
  // There is no approvalId option to supply: which queue row this execution
  // satisfies is signed into the envelope, so a delivery cannot file its
  // receipt against a decision somebody else made.
  const { repositories, kernel, executor, calls } = boot();
  const capability = capabilityFor(repositories, kernel, {}, { approvalId: 'apv_1' });
  assert.deepEqual(capability.authority, { kind: 'human-approval', approval_id: 'apv_1' });

  const result = await run(executor, capability);
  assert.equal(result.executed, true);
  const receipt = repositories.actionRecords.listByApproval(TENANT, 'apv_1', { limit: 5 });
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0].approval_id, 'apv_1');
  assert.equal(receipt[0].receipt_id, result.receipt_id);
  // ...and the gate was handed that same id, read off the stored envelope.
  assert.equal(calls.at(-1).options.approvalId, 'apv_1');
  assert.equal(calls.at(-1).options.nowIso, NOW);

  // An autonomous capability names no approval at all, and its receipt stays
  // out of the queue's executed-receipts panel.
  const other = boot();
  const autonomous = capabilityFor(other.repositories, other.kernel);
  assert.deepEqual(autonomous.authority, { kind: 'autonomous' });
  assert.equal((await run(other.executor, autonomous)).executed, true);
  assert.equal(other.repositories.actionRecords.listForTenant(TENANT, { limit: 5 })[0].approval_id, null);
});

test('THE WRITE PATH REFUSES A CAPABILITY THIS SERVER DID NOT ISSUE, whatever its signature', async () => {
  // The hand-built envelope, signed with the secret the kernel PUBLISHES. It
  // verifies, it is unexpired, and before this revision it executed.
  const { executor, provider, repositories } = boot({ secret: DEFAULT_SIGNING_SECRET });
  const envelope = forge({
    capability_id: `cap_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    tenant: TENANT,
    action_class: 'new-geography',
    action: 'create_campaign',
    resource: 'campaign_004',
    constraints: { name: 'Retargeting — new region' },
    maturity: 0.83,
    band: 'moderate',
    expiry: new Date(Date.parse(NOW) + 600_000).toISOString(),
    nonce: 'nce_forged_1',
    policy_version: '1',
    authority: { kind: 'autonomous' },
  });
  const result = await run(executor, envelope);
  assert.equal(result.executed, false);
  assert.equal(result.error.code, 'CAPABILITY_NOT_ISSUED');
  assert.equal(result.error.details.reason, 'unknown-capability');
  assert.equal(provider.lastWrite(), null, 'no campaign was created');
  assert.deepEqual(repositories.actionRecords.listForTenant(TENANT, { limit: 10 }), []);
});

test('a REAL capability id, re-signed with altered fields, is an altered envelope rather than an unknown one', async () => {
  const { repositories, kernel, executor, provider } = boot({ secret: DEFAULT_SIGNING_SECRET });
  const genuine = capabilityFor(repositories, kernel);
  // A capability_id this server issued, carrying a spend move it never signed
  // for, with a signature computed over exactly those bytes.
  const altered = forge({ ...genuine, resource: 'campaign_002' });
  const result = await run(executor, altered);
  assert.equal(result.executed, false);
  assert.equal(result.error.code, 'CAPABILITY_NOT_ISSUED');
  assert.equal(result.error.details.reason, 'altered-envelope');
  assert.equal(provider.lastWrite(), null, 'no provider call');
  assert.deepEqual(repositories.actionRecords.listForTenant(TENANT, { limit: 10 }), []);
});

test('THE POSITIVE HALF: what the provenance check refuses, an issued capability still does', async () => {
  // A check that passes by refusing everything is not a check. Both routes
  // this product uses — the autonomous mint and the human approval — still
  // execute, and the gate runs on both of them.
  const autonomous = boot();
  const issued = capabilityFor(autonomous.repositories, autonomous.kernel);
  const first = await run(autonomous.executor, issued);
  assert.equal(first.executed, true);
  assert.equal(autonomous.calls.length, 1, 'the re-gate ran on the write path');
  assert.equal(autonomous.provider.lastWrite().action, 'set_campaign_status');

  const approved = boot();
  const backed = capabilityFor(approved.repositories, approved.kernel, {}, { approvalId: 'apv_seed_budget_1' });
  assert.equal((await run(approved.executor, backed)).executed, true);
  assert.equal(approved.calls.at(-1).options.approvalId, 'apv_seed_budget_1');
});

test('THE RE-GATE RUNS ON THE WRITE PATH, on the STORED envelope, and a refusal reaches no provider', async () => {
  // A capability minted while its class was autonomous and spent after the
  // posture moved: the signature still verifies, so only a re-gate running on
  // the server's own reading of the world can refuse it.
  const refusal = { ok: false, error: { code: 'AUTONOMY_NOT_EARNED', message: 'no autonomy for campaign-status', details: { reason: 'no-approval' } } };
  const { repositories, kernel, executor, provider, calls } = boot({ gate: () => refusal });
  const capability = capabilityFor(repositories, kernel);
  const result = await run(executor, capability);

  assert.equal(result.executed, false);
  assert.equal(result.error.code, 'AUTONOMY_NOT_EARNED');
  assert.equal(provider.lastWrite(), null, 'no provider call');
  assert.deepEqual(repositories.actionRecords.listForTenant(TENANT, { limit: 10 }), [], 'no receipt');

  // The gate was asked about the STORED envelope's values, not the delivered
  // body's: same fields here, because a mismatch is refused earlier, and the
  // intent it received is the shape the issuance route builds.
  const asked = calls.at(-1);
  assert.equal(asked.tenantId, capability.tenant);
  assert.deepEqual(asked.intent, {
    tenant_id: capability.tenant,
    action_class: capability.action_class,
    action: capability.action,
    resource: capability.resource,
    constraints: capability.constraints,
  });
  // A refused capability is a genuine retry, not a swallowed nonce.
  assert.equal(repositories.idempotency.claim(TENANT, capability.nonce, 'executor'), true);
  repositories.idempotency.release(TENANT, capability.nonce, 'executor');
});

test('a duplicate nonce returns the ORIGINAL receipt and writes nothing', async () => {
  const { repositories, kernel, executor, provider } = boot();
  const capability = capabilityFor(repositories, kernel);
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
  const capability = capabilityFor(repositories, kernel);
  const first = await run(executor, capability);
  repositories.killSwitches.upsertFreeze({ tenant_id: TENANT, scope: 'provider', scope_id: 'meta_ads', kind: 'spend-spike', reason: 'x', actor: 'guardian', frozen_at: NOW });

  const second = await run(executor, capability);
  assert.equal(second.duplicate, true);
  assert.equal(second.receipt_id, first.receipt_id);
  assert.equal(second.error, undefined);
});

test('BUG-6: a spent nonce is answered ONLY to the envelope it was spent on', async () => {
  // The delivery this server issued and spent, and the four bodies that reuse
  // its nonce without being it. Every one of the four was answered with the
  // receipt for a mutation it did not describe, because the dedupe read ran
  // before anything had looked at the body asking.
  const { repositories, kernel, executor, provider } = boot({ secret: DEFAULT_SIGNING_SECRET });
  const spent = capabilityFor(repositories, kernel);
  const first = await run(executor, spent);
  assert.equal(first.executed, true);
  const writeAfterSpend = provider.lastWrite();
  const receiptsAfterSpend = repositories.actionRecords.listForTenant(TENANT, { limit: 10 }).length;
  // The spend owns the idempotency row for this nonce, and records the receipt
  // on it. Every refusal below has to leave that row exactly as it found it.
  const claimAfterSpend = repositories.idempotency.get(TENANT, spent.nonce, 'executor');
  assert.equal(claimAfterSpend.effect.receipt_id, first.receipt_id);

  // The control, in the same breath: the SAME envelope, delivered again, is
  // answered with the SAME receipt (AC-2).
  const honest = await run(executor, spent);
  assert.equal(honest.executed, false);
  assert.equal(honest.duplicate, true);
  assert.equal(honest.receipt_id, first.receipt_id);
  assert.equal(honest.reconciliation, first.reconciliation);
  assert.equal(honest.drift, first.drift);

  const impostors = {
    'a different resource': { ...spent, resource: 'campaign_009' },
    'a different action class': { ...spent, action_class: 'campaign-launch' },
    'a replaced signature': { ...spent, signature: 'not-even-a-signature' },
    // The case a test that only tampers a FIELD cannot reach: the bytes are
    // re-signed over themselves with the published dev secret, so the HMAC
    // agrees and a real capability_id rides along. The only thing left to
    // catch it is the comparison against the envelope the server stored.
    'a body re-signed over its own altered bytes': forge({
      ...spent,
      action_class: 'new-geography',
      action: 'create_campaign',
      resource: 'campaign_009',
      constraints: { name: 'Retargeting — new region' },
    }),
  };
  const refusals = {};
  for (const [label, delivered] of Object.entries(impostors)) {
    const result = await run(executor, delivered);
    refusals[label] = result;
    assert.equal(result.executed, false, label);
    assert.equal(result.duplicate, false, label);
    assert.equal(result.receipt_id, undefined, `${label} was told the mutation is done`);
    assert.equal(typeof result.error?.code, 'string', label);
    assert.equal(provider.lastWrite(), writeAfterSpend, `${label} reached the provider`);
    assert.equal(repositories.actionRecords.listForTenant(TENANT, { limit: 10 }).length, receiptsAfterSpend, `${label} wrote a receipt`);
    // A refused body takes no idempotency claim either, asserted through the
    // real repository rather than a stub: the row the spend left is untouched.
    assert.deepEqual(repositories.idempotency.get(TENANT, spent.nonce, 'executor'), claimAfterSpend, label);
  }
  // ...and the re-signed forgery is refused on the capabilities table, by the
  // comparison rather than by the signature, which is what its own bytes
  // agreed with.
  const resigned = refusals['a body re-signed over its own altered bytes'];
  assert.equal(resigned.error.code, 'CAPABILITY_NOT_ISSUED');
  assert.equal(resigned.error.details.reason, 'altered-envelope');
  assert.equal(resigned.error.details.capability_id, spent.capability_id);

  // The same refusal on a nonce that was never spent leaves it CLAIMABLE,
  // which is what "an unauthenticated body takes no claim" has to mean where
  // there is no earlier spend to leave a row behind.
  const unspent = capabilityFor(repositories, kernel);
  const refusedFirstTime = await run(executor, { ...unspent, resource: 'campaign_009' });
  assert.equal(refusedFirstTime.error.code, 'BAD_SIGNATURE');
  assert.equal(repositories.idempotency.claim(TENANT, unspent.nonce, 'executor'), true, 'a refused body took no claim');
  repositories.idempotency.release(TENANT, unspent.nonce, 'executor');
});

test('BUG-6 under a freeze: the altered delivery is refused, the honest one is still answered', async () => {
  // Both halves of the identity/admission split at once. A freeze is an
  // admission condition, so it must not turn an impostor into something the
  // server will talk about — and it must not stop the server telling an
  // operator that a mutation which really happened did happen.
  const { repositories, kernel, executor } = boot();
  const spent = capabilityFor(repositories, kernel);
  const first = await run(executor, spent);
  repositories.killSwitches.upsertFreeze({ tenant_id: TENANT, scope: 'provider', scope_id: 'meta_ads', kind: 'spend-spike', reason: 'x', actor: 'guardian', frozen_at: NOW });

  const altered = await run(executor, { ...spent, resource: 'campaign_009' });
  assert.equal(altered.executed, false);
  assert.equal(altered.duplicate, false);
  assert.equal(altered.receipt_id, undefined);

  const honest = await run(executor, spent);
  assert.equal(honest.duplicate, true);
  assert.equal(honest.receipt_id, first.receipt_id);
  assert.equal(honest.error, undefined);
});

test('the loser of the atomic claim is told to RETRY, and no provider call is made', async () => {
  // A claim the winner holds and has not yet released: exactly the two-tab
  // race, held open by hand. It is taken from the SAME repository the executor
  // will use, so this is the real race rather than a mock of it.
  const live = boot();
  const capability = capabilityFor(live.repositories, live.kernel);
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
  const capability = capabilityFor(repositories, kernel);
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
  const capability = capabilityFor(repositories, kernel);
  const refusals = [
    // The freeze is raised first, so the kill-switch refusal is the one that
    // runs; every later case is refused by its OWN rule before the switches
    // are ever consulted.
    ['kill switch', capability, { freeze: true }],
    // Expired has to be SIGNED as expired: the signature covers expiry, so
    // editing the field on a live envelope would prove nothing about expiry.
    ['expired', capabilityFor(repositories, kernel, {}, { ttlMs: -1 }), {}],
    ['bad signature', { ...capability, resource: 'campaign_002' }, {}],
    ['over scope', capabilityFor(repositories, kernel), { tenantId: 'tenant_other' }],
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

test('the two NEW refusals release the claim too, so a re-gate that says no is retryable', async () => {
  // The provenance and re-gate refusals sit AFTER the claim, so a bug there
  // would burn a nonce the caller can never spend again. A fresh boot each
  // time: the case above leaves a global freeze standing, which would refuse
  // both of these for the wrong reason.
  const forged = forge({
    capability_id: `cap_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    tenant: TENANT,
    action_class: INTENT.action_class,
    action: INTENT.action,
    resource: INTENT.resource,
    constraints: INTENT.constraints,
    maturity: 0.83,
    band: 'moderate',
    expiry: new Date(Date.parse(NOW) + 600_000).toISOString(),
    nonce: `nce_forged_${randomUUID().slice(0, 8)}`,
    policy_version: '1',
    authority: { kind: 'autonomous' },
  });
  const notIssued = boot({ secret: DEFAULT_SIGNING_SECRET });
  const unknown = await run(notIssued.executor, forged);
  assert.equal(unknown.error.code, 'CAPABILITY_NOT_ISSUED');
  // The claim was taken and released, so the nonce is spendable: nothing was
  // executed, and nothing will ever be for this envelope.
  assert.equal(notIssued.repositories.idempotency.claim(TENANT, forged.nonce, 'executor'), true, 'a refused forgery burns no nonce');
  notIssued.repositories.idempotency.release(TENANT, forged.nonce, 'executor');

  const gated = boot({ gate: () => ({ ok: false, error: { code: 'MATURITY_BAND_BLOCKED', message: 'no measured maturity', details: { reason: 'maturity-unknown' } } }) });
  const genuine = capabilityFor(gated.repositories, gated.kernel);
  const refused = await run(gated.executor, genuine);
  assert.equal(refused.error.code, 'MATURITY_BAND_BLOCKED');
  assert.equal(gated.repositories.idempotency.claim(TENANT, genuine.nonce, 'executor'), true, 'the claim is free again');
  gated.repositories.idempotency.release(TENANT, genuine.nonce, 'executor');
});

test('TENANT_MISMATCH is checked BEFORE the dedupe read, so a foreign envelope never touches this tenant\'s rows', async () => {
  const { repositories, kernel, executor } = boot();
  const capability = capabilityFor(repositories, kernel, { tenant_id: 'tenant_other' });
  const result = await run(executor, capability, { tenantId: TENANT });
  assert.equal(result.error.code, 'TENANT_MISMATCH');
  assert.deepEqual(repositories.actionRecords.listForTenant(TENANT, { limit: 10 }), []);
});

test('THE RECONCILIATION VOCABULARY is closed and every value is reachable', async () => {
  // 'agreed' — the re-read reports exactly what the write applied.
  const agreed = boot();
  const agreedResult = await run(agreed.executor, capabilityFor(agreed.repositories, agreed.kernel));
  assert.equal(agreedResult.reconciliation, 'agreed');

  // 'unknown' — a provider refusal has no re-read to compare against.
  const refused = boot({ failureMode: 'revoked' });
  const refusedResult = await run(refused.executor, capabilityFor(refused.repositories, refused.kernel));
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
    revalidate: (tenantId, intent) => ({ ok: true, intent }),
  });
  const divergedResult = await run(liarExecutor, capabilityFor(diverged.repositories, diverged.kernel));
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
    const { repositories, kernel, executor } = boot({ writeDrift: drift });
    const result = await run(executor, capabilityFor(repositories, kernel));
    assert.equal(result.drift, drift, drift);
  }
  // A provider that reports nothing usable is 'none' when the re-read agreed.
  const { repositories, kernel, executor } = boot();
  const result = await run(executor, capabilityFor(repositories, kernel));
  assert.equal(result.drift, 'none');
});

test('the write method is resolved from the SIGNED action, never from the caller', async () => {
  const { repositories, kernel, executor, provider } = boot();
  const capability = capabilityFor(repositories, kernel);
  await run(executor, capability);
  assert.equal(provider.lastWrite().action, 'set_campaign_status');

  // An action the contract does not register is refused, never routed to
  // something adjacent. The signature covers `action`, so a caller cannot
  // reach the write map with one the kernel never signed.
  const fresh = boot();
  const other = capabilityFor(fresh.repositories, fresh.kernel);
  const forgedAction = { ...other, action: 'delete_everything' };
  const result = await fresh.executor.execute(forgedAction, { actor: 'tester', tenantId: TENANT });
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

  const { repositories, kernel, executor, provider } = boot();
  const capability = capabilityFor(repositories, kernel, {
    action_class: 'campaign-launch', action: 'create_campaign', resource: 'campaign_004', constraints: { name: 'Retargeting — new region' },
  });
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
  const capability = capabilityFor(repositories, kernel, {}, { nonce: decisionNonce('apv_seed_budget_1'), approvalId: 'apv_seed_budget_1' });
  const result = await run(executor, capability);
  assert.equal(result.executed, true);
  const receipt = repositories.actionRecords.getByNonce(TENANT, decisionNonce('apv_seed_budget_1'));
  assert.ok(receipt, 'the approve route redelivery check reads exactly this row');
  assert.equal(receipt.approval_id, 'apv_seed_budget_1');
});

test('two concurrent deliveries of one nonce reach the provider exactly once', async () => {
  const { repositories, kernel, executor, provider } = boot();
  const capability = capabilityFor(repositories, kernel);
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

test('the executor refuses to be built without a gate port, and never builds its own provider', async () => {
  // The provider is injected per request so one request can honour its own
  // ?meta_error and hold the state it just wrote for the re-read; the clock is
  // injected so a receipt's executed_at is deterministic in a test. The gate
  // port is NOT optional: an executor that silently stopped re-gating would be
  // indistinguishable from one that is working.
  const { repositories, kernel, provider, executor } = boot();
  const capability = capabilityFor(repositories, kernel);
  await run(executor, capability);
  assert.ok(utcNow().length > 0, 'the injected clock is the only one the executor needs');
  assert.ok(provider.lastWrite());
  assert.throws(() => createExecutor({ repositories, provider, kernel, auditClock: () => NOW }), /revalidate/);
});
