// POST /v1/capabilities and POST /v1/actions/execute (issue #20, TR-3/TR-5).
// The cases here pin two things a surface can get subtly wrong and still look
// healthy: that the two displays of maturity DELIBERATELY differ for a tenant
// with no data, and that the seeded trust rows read the same way through the
// gate as they do through the page.

import { test, after } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import { buildApp } from '../../src/api/routes.js';
import { ACTION_CLASSES, DEFAULT_SIGNING_SECRET } from '../../src/policy/kernel.js';
import { POSTURE_LABELS, postureFor } from '../../src/policy/trust.js';

const dir = mkdtempSync(join(tmpdir(), 'actions-api-'));
const db = openDatabase(join(dir, 'app.db'));
const repositories = createRepositories(db);
const app = buildApp({ repositories });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());

const url = (path) => `http://127.0.0.1:${server.address().port}${path}`;
const TENANT = 'tenant_actions';
const SEEDED = 'tenant_demo';

async function post(path, body) {
  const response = await fetch(url(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() };
}

const issue = (body) => post('/v1/capabilities', { tenant_id: TENANT, ...body });

/** An offline forger, so a forgery does not go through the code that mints
 * capabilities: the exact signed bytes, with the secret the kernel publishes. */
const SIGNED_FIELD_ORDER = [
  'tenant', 'action_class', 'action', 'resource', 'constraints', 'maturity', 'band', 'expiry', 'nonce', 'policy_version', 'authority',
];
function forge(fields) {
  const bytes = JSON.stringify(SIGNED_FIELD_ORDER.map((field) => fields[field] ?? null));
  return { ...fields, signature: createHmac('sha256', DEFAULT_SIGNING_SECRET).update(bytes).digest('hex') };
}

const intents = {
  'campaign-status': { action: 'set_campaign_status', resource: 'campaign_001', constraints: { status: 'PAUSED' } },
  'budget-change': { action: 'update_campaign_budget', resource: 'adset_001', constraints: { delta_micros: 40_000_000 } },
  'creative-refresh': { action: 'update_campaign_creative', resource: 'campaign_001', constraints: { name: 'Brand — RSA B' } },
  'new-geography': { action: 'create_campaign', resource: 'campaign_004', constraints: { name: 'Retargeting — new region' } },
  'campaign-launch': { action: 'create_campaign', resource: 'campaign_005', constraints: { name: 'Brand — new launch' } },
};

// The measured tenant: events first, so the gate has a maturity to read.
repositories.tenants.create({ id: TENANT, name: 'Actions tenant', currency: 'INR' });
for (const [index, event] of [
  { event_id: 'evt_actions_spend_1', event_name: 'spend.observed', value: 7_200_000_000, currency: 'INR' },
  { event_id: 'evt_actions_lead_1', event_name: 'lead_qualified', lead_id: 'lead_actions_1' },
].entries()) {
  await post('/v1/events', { tenant_id: TENANT, ...event, occurred_at: new Date(Date.now() - 96 * 3_600_000).toISOString() });
  void index;
}
repositories.trustLedger.upsert(TENANT, { action_class: 'campaign-status', evaluated: 6, correct: 6, needless: 0, downside_penalties: 0, pinned: false });

// tenant_demo is the seeded tenant, and the coherence case below gates against
// it, so it needs the same measured maturity the real seed gives it.
repositories.tenants.create({ id: SEEDED, name: 'Demo tenant', currency: 'INR' });
for (const event of [
  { event_id: 'evt_seed_spend_1', event_name: 'spend.observed', value: 7_200_000_000, currency: 'INR' },
  { event_id: 'evt_seed_lead_1', event_name: 'lead_qualified', lead_id: 'lead_seed_1' },
]) {
  await post('/v1/events', { tenant_id: SEEDED, ...event, occurred_at: new Date(Date.now() - 96 * 3_600_000).toISOString() });
}

test('POST /v1/capabilities returns a signed envelope that /v1/actions/execute spends once', async () => {
  const issued = await issue({ action_class: 'campaign-status', ...intents['campaign-status'] });
  assert.equal(issued.status, 201);
  assert.equal(issued.body.capability_id.startsWith('cap_'), true);
  assert.equal(issued.body.expiry, issued.body.envelope.expiry);
  // The returned envelope IS the body /v1/actions/execute accepts.
  const envelope = issued.body.envelope;
  assert.equal(envelope.tenant, TENANT);
  assert.equal(envelope.action_class, 'campaign-status');
  assert.equal(typeof envelope.signature, 'string');
  assert.equal(repositories.capabilities.get(TENANT, envelope.capability_id) !== null, true, 'the capability is persisted');

  const first = await post('/v1/actions/execute', envelope);
  assert.equal(first.status, 200);
  assert.equal(first.body.executed, true);
  assert.equal(first.body.receipt_id.startsWith('rcp_'), true);
  assert.equal(first.body.reconciliation, 'agreed');
  assert.equal(first.body.drift, 'none');
  assert.deepEqual(first.body.requested, { campaignId: 'campaign_001', status: 'PAUSED' });

  const second = await post('/v1/actions/execute', envelope);
  assert.equal(second.status, 200);
  assert.equal(second.body.executed, false);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.receipt_id, first.body.receipt_id);
  assert.equal(repositories.actionRecords.getByNonce(TENANT, envelope.nonce).receipt_id, first.body.receipt_id);
});

test('a class with no autonomy is refused on the issuance route, and NO capability is minted', async () => {
  for (const actionClass of ['new-geography', 'budget-change', 'campaign-launch', 'creative-refresh']) {
    const before = repositories.capabilities.listForTenant(TENANT, { limit: 200 }).length;
    const refused = await issue({ action_class: actionClass, ...intents[actionClass] });
    assert.equal(refused.status, 403, actionClass);
    assert.equal(refused.body.code, 'AUTONOMY_NOT_EARNED', actionClass);
    assert.equal(refused.body.details.reason, 'no-approval', actionClass);
    assert.equal(refused.body.envelope, undefined, actionClass);
    assert.equal(repositories.capabilities.listForTenant(TENANT, { limit: 200 }).length, before, actionClass);
  }
});

test('a tampered envelope is refused BAD_SIGNATURE and never reaches the provider', async () => {
  const issued = await issue({ action_class: 'campaign-status', ...intents['campaign-status'] });
  const tampered = { ...issued.body.envelope, resource: 'campaign_002' };
  const { status, body } = await post('/v1/actions/execute', tampered);
  assert.equal(status, 403);
  assert.equal(body.code, 'BAD_SIGNATURE');
  assert.equal(repositories.actionRecords.getByNonce(TENANT, tampered.nonce), null);
});

test('AN ENVELOPE ASSEMBLED BY HAND IS REFUSED OVER HTTP, whatever its signature', async () => {
  // The dev signing secret is published in src/policy/kernel.js, so a caller
  // can produce an envelope that verifies perfectly. These two are the writes
  // worth forging: a new geography (a campaign created where the gate would
  // have asked for a human) and a large budget move.
  const forgeries = [
    { action_class: 'new-geography', action: 'create_campaign', resource: 'campaign_004', constraints: { name: 'Retargeting — forged' } },
    { action_class: 'budget-change', action: 'update_campaign_budget', resource: 'adset_001', constraints: { delta_micros: 900_000_000 } },
  ];
  for (const forged of forgeries) {
    const envelope = forge({
      capability_id: `cap_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
      tenant: TENANT,
      ...forged,
      maturity: 0.83,
      band: 'moderate',
      expiry: new Date(Date.now() + 600_000).toISOString(),
      nonce: `nce_forged_${randomUUID().slice(0, 8)}`,
      policy_version: '1',
      authority: { kind: 'autonomous' },
    });
    const { status, body } = await post('/v1/actions/execute', envelope);
    assert.equal(status, 403, forged.action_class);
    // A STABLE code, not a stack trace and not a provider error: the caller
    // can tell this one apart from a quota problem.
    assert.equal(body.code, 'CAPABILITY_NOT_ISSUED', forged.action_class);
    assert.equal(body.details.reason, 'unknown-capability', forged.action_class);
    assert.equal(body.stack, undefined, forged.action_class);
    assert.equal(repositories.actionRecords.getByNonce(TENANT, envelope.nonce), null, `${forged.action_class} wrote a receipt`);
    assert.equal(repositories.capabilities.get(TENANT, envelope.capability_id), null, `${forged.action_class} was stored`);
  }
});

test('a capability that WAS issued still executes, still writes one receipt, and still dedupes to it', async () => {
  // The positive half, over the same route the forgery above was refused by.
  // Without it, CAPABILITY_NOT_ISSUED could pass by refusing everything.
  const issued = await issue({ action_class: 'campaign-status', ...intents['campaign-status'] });
  assert.equal(issued.status, 201);
  const envelope = issued.body.envelope;
  assert.deepEqual(envelope.authority, { kind: 'autonomous' });

  const first = await post('/v1/actions/execute', envelope);
  assert.equal(first.status, 200);
  assert.equal(first.body.executed, true);
  assert.equal(first.body.reconciliation, 'agreed');
  const receipt = first.body.receipt_id;
  assert.equal(receipt, `rcp_${envelope.capability_id.replace(/^cap_/, '')}`);

  const second = await post('/v1/actions/execute', envelope);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.receipt_id, receipt, 'the same receipt, not a second one');
  assert.equal(repositories.actionRecords.listForTenant(TENANT, { limit: 200 })
    .filter((row) => row.nonce === envelope.nonce).length, 1);
});

test('BUG-6 / AC-13: a spent nonce re-delivered with a different body is refused, and the honest re-delivery is not', async (t) => {
  // The three-step curl QA ran, over the route: mint, spend, and deliver the
  // same nonce again with a body that is not the envelope it was spent on.
  const issued = await issue({ action_class: 'campaign-status', ...intents['campaign-status'] });
  const envelope = issued.body.envelope;
  const first = await post('/v1/actions/execute', envelope);
  assert.equal(first.status, 200);
  assert.equal(first.body.executed, true);
  const receipt = first.body.receipt_id;
  const receiptsAfterSpend = repositories.actionRecords.listForTenant(TENANT, { limit: 200 }).length;

  // (c) The SAME envelope, delivered again. AC-2, and the control that keeps
  // every refusal below from being passed by refusing everything.
  const honest = await post('/v1/actions/execute', envelope);
  assert.equal(honest.status, 200);
  assert.equal(honest.body.executed, false);
  assert.equal(honest.body.duplicate, true);
  assert.equal(honest.body.receipt_id, receipt);

  const impostors = {
    'a different resource': { ...envelope, resource: 'campaign_009' },
    'a different action class': { ...envelope, action_class: 'campaign-launch' },
    'a replaced signature': { ...envelope, signature: 'not-even-a-signature' },
    // Re-signed over its OWN altered bytes with the published dev secret, so
    // it carries a real capability_id and a real spent nonce and still
    // verifies. Nothing but the comparison with the stored envelope refuses it.
    'a body re-signed over its own altered bytes': forge({
      ...envelope,
      action_class: 'new-geography',
      action: 'create_campaign',
      resource: 'campaign_009',
      constraints: { name: 'Retargeting — forged' },
    }),
  };
  const assertRefused = async (label) => {
    for (const [shape, delivered] of Object.entries(impostors)) {
      const { status, body } = await post('/v1/actions/execute', delivered);
      assert.equal(status, 403, `${label} / ${shape}`);
      assert.equal(typeof body.code, 'string', `${label} / ${shape}`);
      assert.equal(body.receipt_id, undefined, `${label} / ${shape} was handed a receipt`);
      assert.equal(body.duplicate, undefined, `${label} / ${shape}`);
      assert.equal(repositories.actionRecords.listForTenant(TENANT, { limit: 200 }).length, receiptsAfterSpend, `${label} / ${shape} wrote a receipt`);
    }
  };
  await assertRefused('no freeze');
  const reSigned = await post('/v1/actions/execute', impostors['a body re-signed over its own altered bytes']);
  assert.equal(reSigned.status, 403);
  assert.equal(reSigned.body.code, 'CAPABILITY_NOT_ISSUED', 'a verifying signature is not what refuses this one');
  assert.equal(reSigned.body.details.reason, 'altered-envelope');

  // (e) A freeze changes neither answer. The refusals do not become
  // duplicates, and the honest re-delivery is still answered — telling an
  // operator their action failed when it succeeded would be the worse bug.
  repositories.killSwitches.upsertFreeze({ tenant_id: TENANT, scope: 'provider', scope_id: 'meta_ads', kind: 'spend-spike', reason: 'spike', actor: 'guardian', frozen_at: new Date().toISOString() });
  t.after(() => repositories.killSwitches.reEnable(TENANT, 'provider', 'meta_ads', { actor: 'test', at: new Date().toISOString() }));
  await assertRefused('under a freeze');
  const frozenHonest = await post('/v1/actions/execute', envelope);
  assert.equal(frozenHonest.status, 200);
  assert.equal(frozenHonest.body.duplicate, true);
  assert.equal(frozenHonest.body.receipt_id, receipt);
});

test('an intent whose action_class is absent or is not a class is refused with a named reason', async () => {
  // Both used to reach the roster lookup as undefined and be reported as an
  // object, which read like a server fault rather than a refusal.
  for (const body of [
    { action: 'set_campaign_status', resource: 'campaign_001' },
    { action_class: { x: 1 }, action: 'set_campaign_status', resource: 'campaign_001' },
  ]) {
    const refused = await issue(body);
    assert.equal(refused.status, 403, JSON.stringify(body));
    assert.equal(refused.body.code, 'AUTONOMY_NOT_EARNED', JSON.stringify(body));
    assert.equal(refused.body.details.reason, 'unknown-class', JSON.stringify(body));
    assert.equal(refused.body.envelope, undefined, JSON.stringify(body));
  }
});

test('an envelope with a field removed is 400 MALFORMED_CAPABILITY', async () => {
  const issued = await issue({ action_class: 'campaign-status', ...intents['campaign-status'] });
  const { capability_id, ...rest } = issued.body.envelope;
  void capability_id;
  const { status, body } = await post('/v1/actions/execute', rest);
  assert.equal(status, 400);
  assert.equal(body.code, 'MALFORMED_CAPABILITY');
});

test('an EXPIRED capability is refused 403', async () => {
  const app2 = buildApp({ repositories, capabilityTtlMs: -1 });
  const shortServer = app2.listen(0, '127.0.0.1');
  await once(shortServer, 'listening');
  const shortUrl = `http://127.0.0.1:${shortServer.address().port}`;
  const issued = await fetch(`${shortUrl}/v1/capabilities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_id: TENANT, action_class: 'campaign-status', ...intents['campaign-status'] }),
  }).then((response) => response.json());
  const refused = await fetch(`${shortUrl}/v1/actions/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(issued.envelope),
  });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'EXPIRED_CAPABILITY');
  // closeAllConnections before close: fetch holds a keep-alive socket open, and
  // a server waiting on it would keep the test process alive past the file.
  shortServer.closeAllConnections();
  shortServer.close();
});

test('a caller may not spend a capability under a tenant it names itself', async () => {
  // The envelope is bearer material that says which tenant it is for, and the
  // route resolves the caller\'s tenant from the body's own tenant_id. So
  // naming somebody else is exactly the over-scope case, and it is refused
  // before the provider is reached.
  const issued = await issue({ action_class: 'campaign-status', ...intents['campaign-status'] });
  const { status, body } = await post('/v1/actions/execute', { ...issued.body.envelope, tenant_id: 'tenant_someone_else' });
  assert.equal(status, 403);
  assert.equal(body.code, 'TENANT_MISMATCH');
  assert.equal(repositories.actionRecords.getByNonce(TENANT, issued.body.envelope.nonce), null, 'nothing was written');
  assert.equal(repositories.actionRecords.getByNonce('tenant_someone_else', issued.body.envelope.nonce), null, 'and nothing was written under the named tenant');

  // The same envelope, posted as what it is, still works — the refusal is
  // about the caller, not about the capability.
  const allowed = await post('/v1/actions/execute', issued.body.envelope);
  assert.equal(allowed.body.executed, true);
});

test('a valid capability issued before a freeze is refused after it, with no write', async () => {
  const issued = await issue({ action_class: 'campaign-status', ...intents['campaign-status'] });
  assert.equal((await post('/v1/actions/execute', issued.body.envelope)).body.executed, true);

  const fresh = await issue({ action_class: 'campaign-status', ...intents['campaign-status'] });
  repositories.killSwitches.upsertFreeze({ tenant_id: TENANT, scope: 'provider', scope_id: 'meta_ads', kind: 'spend-spike', reason: 'spike', actor: 'guardian', frozen_at: new Date().toISOString() });
  const refused = await post('/v1/actions/execute', fresh.body.envelope);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'KILL_SWITCH_ACTIVE');
  assert.equal(refused.body.details.scope, 'provider');
  assert.equal(repositories.actionRecords.getByNonce(TENANT, fresh.body.envelope.nonce), null);

  repositories.killSwitches.reEnable(TENANT, 'provider', 'meta_ads', { actor: 'test', at: new Date().toISOString() });
  const allowed = await post('/v1/actions/execute', fresh.body.envelope);
  assert.equal(allowed.body.executed, true, 'the same capability works once a human re-enables');
});

test('a provider refusal on the execute route is a 502 carrying the adapter envelope', async () => {
  const issued = await issue({ action_class: 'campaign-status', ...intents['campaign-status'] });
  const refused = await post('/v1/actions/execute?meta_error=quota', issued.body.envelope);
  assert.equal(refused.status, 502);
  assert.equal(refused.body.code, 'META_QUOTA_EXHAUSTED');
  assert.equal(refused.body.details.simulated, true);
  assert.equal(repositories.actionRecords.getByNonce(TENANT, issued.body.envelope.nonce), null, 'a refusal writes no receipt');

  // The claim was released, so the same envelope is a genuine retry.
  const retried = await post('/v1/actions/execute', issued.body.envelope);
  assert.equal(retried.body.executed, true);
});

test('a tenant with NO funnel events is refused, while GET /v1/metrics still reports 0 for it', async () => {
  // The two surfaces DELIBERATELY differ, and both are pinned. A display
  // reading "0" means "no data, the number is a placeholder"; the gate
  // reading 0 would mean "we measured nothing and it is worth 0.06" — and
  // policyBand(0) admits an emergency-only class.
  repositories.tenants.create({ id: 'tenant_empty', name: 'Empty', currency: 'INR' });
  repositories.trustLedger.upsert('tenant_empty', { action_class: 'campaign-status', evaluated: 6, correct: 6, needless: 0, downside_penalties: 0, pinned: false });

  const refused = await post('/v1/capabilities', { tenant_id: 'tenant_empty', action_class: 'campaign-status', ...intents['campaign-status'] });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'MATURITY_BAND_BLOCKED');
  assert.equal(refused.body.details.reason, 'maturity-unknown');
  assert.equal(refused.body.details.maturity, null);

  const metrics = await fetch(`${url('/v1/metrics')}?tenant_id=tenant_empty`).then((response) => response.json());
  assert.equal(metrics.maturity, 0, 'the display surface shows the placeholder');
  assert.equal(metrics.band, 'emergency-only');
  assert.equal(metrics.data_through, null);
  assert.equal(metrics.tenant_id, 'tenant_empty');
});

test('the measured tenant reports a real maturity and the same band on both surfaces', async () => {
  const metrics = await fetch(`${url('/v1/metrics')}?tenant_id=${TENANT}`).then((response) => response.json());
  assert.equal(metrics.maturity > 0.35, true);
  const issued = await issue({ action_class: 'campaign-status', ...intents['campaign-status'] });
  assert.equal(issued.body.envelope.maturity > 0, true);
  assert.equal(issued.body.envelope.band, metrics.band, 'the gate and the display read one band');
});

test('THE SEED COHERENCE CASE: the page, the gate and the posture row read the same data', async () => {
  // One assertion over five classes: the label the seeded rows produce, the
  // label the gate reaches for a null-approval intent, and the label the page
  // renders are the same string — or, where the gate refuses for want of
  // evidence, the page says the same thing.
  const EXPECTED = {
    'campaign-status': 'autonomous under micro-limits',
    'budget-change': 'approval required',
    'creative-refresh': 'shadow',
    'new-geography': 'shadow',
    'campaign-launch': 'approval required',
  };
  const rows = [
    { action_class: 'campaign-status', evaluated: 6, correct: 6, needless: 0, downside_penalties: 0, pinned: false },
    { action_class: 'budget-change', evaluated: 3, correct: 2, needless: 1, downside_penalties: 0, pinned: false },
    { action_class: 'creative-refresh', evaluated: 4, correct: 4, needless: 0, downside_penalties: 0, pinned: true },
    { action_class: 'new-geography', evaluated: 2, correct: 2, needless: 0, downside_penalties: 0, pinned: true },
  ];
  for (const row of rows) {
    repositories.trustLedger.upsert(SEEDED, row);
  }
  // campaign-launch deliberately has NO row.

  for (const entry of ACTION_CLASSES) {
    const row = repositories.trustLedger.get(SEEDED, entry.action_class);
    const posture = postureFor(entry.action_class, row, entry, row?.pinned ?? false);
    assert.equal(POSTURE_LABELS[posture], EXPECTED[entry.action_class], `posture for ${entry.action_class}`);

    // The gate's own verdict for a no-approval intent of that class.
    const gated = await post('/v1/capabilities', { tenant_id: SEEDED, action_class: entry.action_class, ...intents[entry.action_class] });
    const admitted = gated.status === 201;
    assert.equal(admitted, posture === 'autonomous-under-micro-limits', `gate verdict for ${entry.action_class}`);
    if (!admitted) {
      assert.equal(gated.body.code, 'AUTONOMY_NOT_EARNED', entry.action_class);
      assert.equal(gated.body.details.reason, 'no-approval', entry.action_class);
      assert.equal(gated.body.details.posture, posture, entry.action_class);
    }
  }
});

test('an unknown /v1 sub-path, and an unknown /v1/guardian sub-path, are the NOT_FOUND envelope', async () => {
  // This is what proves the new routes are not shadowed by the last /v1
  // handler: if the catch-all came first, these would be the same response
  // AND the routes above would never have run at all.
  for (const path of ['/v1/nope', '/v1/guardian/nope', '/v1/approvals', '/v1/actions/nope']) {
    const response = await fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 404, path);
    const body = await response.json();
    assert.equal(body.code, 'NOT_FOUND', path);
    assert.equal(typeof body.message, 'string', path);
    assert.equal(body.stack, undefined, path);
  }
  // A GET on a POST-only path is the same envelope, not a 405 leak.
  const wrongVerb = await fetch(url('/v1/approvals/apv_x/approve'));
  assert.equal(wrongVerb.status, 404);
});

test('a malformed JSON body is the error envelope, never a stack trace', async () => {
  const response = await fetch(url('/v1/approvals/apv_x/approve'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(typeof body.code, 'string');
  assert.equal(body.stack, undefined);
});
