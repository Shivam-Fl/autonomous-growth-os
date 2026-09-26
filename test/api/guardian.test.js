// POST /v1/guardian/trigger, /v1/guardian/re-enable and GET /v1/guardian
// (issue #20, TR-4). The load-bearing case is the first one: a freeze that is
// written but not READABLE is the failure this whole surface exists to prevent,
// so trigger, the API read and the re-enable are checked as one round trip
// rather than as three units.

import { test, after } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import { buildApp } from '../../src/api/routes.js';
import { DEFAULT_FREEZE_SCOPE, DEFAULT_FREEZE_SCOPE_ID, GUARDIAN_KINDS } from '../../src/strategy/guardian.js';
import { freezeScopeId } from '../../src/policy/kernel.js';

const dir = mkdtempSync(join(tmpdir(), 'guardian-api-'));
const db = openDatabase(join(dir, 'app.db'));
const repositories = createRepositories(db);
const app = buildApp({ repositories });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => {
  server.closeAllConnections();
  server.close();
});

const url = (path) => `http://127.0.0.1:${server.address().port}${path}`;
const TENANT = 'tenant_guardian';

const call = async (method, path, body) => {
  const response = await fetch(url(path), {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const post = (path, body) => call('POST', path, body);
const get = (path) => call('GET', path);

const trigger = (query, body = {}) => post(`/v1/guardian/trigger${query}`, { tenant_id: TENANT, ...body });
const reEnable = (body = {}) => post('/v1/guardian/re-enable', { tenant_id: TENANT, ...body });
const state = () => get(`/v1/guardian?tenant_id=${TENANT}`);

let approvals = 0;
function approval(overrides = {}) {
  approvals += 1;
  const approval_id = overrides.approval_id ?? `apv_guardian_${approvals}`;
  repositories.approvals.create({
    tenant_id: TENANT,
    approval_id,
    action_class: 'campaign-status',
    action: 'set_campaign_status',
    resource: 'campaign_001',
    constraints: { status: 'PAUSED' },
    impact: 'pause brand defence',
    downside: 'brand coverage gap for one day',
    evidence_refs: [],
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    status: 'pending',
    ...overrides,
  });
  return approval_id;
}

repositories.tenants.create({ id: TENANT, name: 'Guardian tenant', currency: 'INR' });
for (const event of [
  { event_id: 'evt_guardian_spend_1', event_name: 'spend.observed', value: 7_200_000_000, currency: 'INR' },
  { event_id: 'evt_guardian_lead_1', event_name: 'lead_qualified', lead_id: 'lead_guardian_1' },
]) {
  await post('/v1/events', { tenant_id: TENANT, ...event, occurred_at: new Date(Date.now() - 96 * 3_600_000).toISOString() });
}
repositories.trustLedger.upsert(TENANT, { action_class: 'campaign-status', evaluated: 6, correct: 6, needless: 0, downside_penalties: 0, pinned: false });

test('trigger freezes, GET reads the row back, and a re-trigger after a re-enable re-arms the SAME row', async () => {
  const frozen = await trigger('?kind=spend-spike');
  assert.equal(frozen.status, 201);
  assert.equal(frozen.body.frozen, true);
  assert.equal(frozen.body.scope, DEFAULT_FREEZE_SCOPE);
  assert.equal(frozen.body.scope_id, DEFAULT_FREEZE_SCOPE_ID);
  assert.equal(frozen.body.incident_id.startsWith('gin_'), true);
  assert.equal(frozen.body.incidents.length, 1);

  // The write and the read agree, or the banner never appears.
  const read = await state();
  assert.equal(read.status, 200);
  assert.equal(read.body.tenant_id, TENANT);
  assert.equal(read.body.switches.length, 1);
  assert.equal(read.body.switches[0].scope, DEFAULT_FREEZE_SCOPE);
  assert.equal(read.body.switches[0].scope_id, DEFAULT_FREEZE_SCOPE_ID);
  assert.equal(read.body.switches[0].active, 1);
  assert.equal(read.body.incidents.length, 1);
  assert.equal(read.body.incidents[0].incident_id, frozen.body.incident_id);

  // A human clears it, and the second trigger re-freezes without any reset.
  const cleared = await reEnable({ actor: 'Priya' });
  assert.equal(cleared.status, 200);
  assert.equal((await state()).body.switches.length, 0);

  const again = await trigger('?kind=tracking-loss');
  assert.equal(again.status, 201);
  const rows = repositories.killSwitches.listForTenant(TENANT);
  assert.equal(rows.length, 1, 'one switch row, re-armed — not a second active row');
  assert.equal(rows[0].active, 1);
  assert.equal(rows[0].scope, DEFAULT_FREEZE_SCOPE);
  // The incident log is append-only, so the re-freeze is a second incident.
  assert.equal((await state()).body.incidents.length, 2);
  // ...and it is the tracking-loss incident that was added, not a re-run of
  // the spend spike. (Incident order is (frozen_at, incident_id), and two
  // freezes in the same millisecond have no meaningful order between them.)
  assert.deepEqual([...new Set(again.body.incidents.map((entry) => entry.kind))].sort(), ['spend-spike', 'tracking-loss']);
  assert.equal(again.body.incidents.filter((entry) => entry.kind === 'tracking-loss').length, 1);
});

test('every known kind trips, and an unknown kind is 400 GUARDIAN_KIND_UNKNOWN', async () => {
  for (const kind of GUARDIAN_KINDS) {
    await reEnable({ actor: 'Priya' });
    const tripped = await trigger(`?kind=${kind}`);
    assert.equal(tripped.status, 201, kind);
    assert.equal(tripped.body.frozen, true, kind);
  }

  for (const kind of ['meteor-strike', '', 'SPEND-SPIKE']) {
    const refused = await trigger(`?kind=${encodeURIComponent(kind)}`);
    assert.equal(refused.status, 400, JSON.stringify(kind));
    assert.equal(refused.body.code, 'GUARDIAN_KIND_UNKNOWN', JSON.stringify(kind));
    assert.equal(refused.body.details.kind, kind === '' ? '' : kind, JSON.stringify(kind));
    assert.deepEqual(refused.body.details.known, [...GUARDIAN_KINDS]);
    assert.equal(refused.body.stack, undefined);
  }
  // No kind at all is the same refusal, not a 500 on an undefined lookup.
  const missing = await post('/v1/guardian/trigger', { tenant_id: TENANT });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'GUARDIAN_KIND_UNKNOWN');
  assert.equal(missing.body.details.kind, null);
});

test('a re-enable with no actor is 400 and changes nothing at all', async () => {
  await trigger('?kind=spend-spike');
  const before = (await state()).body;
  const auditsBefore = repositories.auditEvents.list(TENANT, { limit: 100 })
    .filter((event) => event.action === 'guardian.re-enable').length;
  for (const actor of [undefined, null, '', '   ', 7]) {
    const refused = await reEnable({ actor });
    assert.equal(refused.status, 400, JSON.stringify(actor));
    assert.equal(refused.body.code, 'RE_ENABLE_ACTOR_REQUIRED', JSON.stringify(actor));
    assert.equal(refused.body.details.field, 'actor', JSON.stringify(actor));
  }
  // The check runs before any write, so the switch is still up and no audit row
  // names a human who never acted. (No re-enable has happened yet in this file,
  // so the honest assertion is that there are none at all.)
  const now = await state();
  assert.equal(now.body.switches.length, before.switches.length);
  assert.equal(now.body.switches[0].active, 1);
  assert.equal(now.body.incidents.length, before.incidents.length, 'a refused re-enable is not an incident');
  const reEnabled = repositories.auditEvents.list(TENANT, { limit: 100 })
    .filter((event) => event.action === 'guardian.re-enable').length;
  assert.equal(reEnabled, auditsBefore, 'not one of the five refused requests wrote an audit row');
});

test('a re-enable naming no scope clears the row the demo wrote, and echoes what it cleared', async () => {
  const frozen = await trigger('?kind=spend-spike');
  assert.equal(frozen.body.scope_id, DEFAULT_FREEZE_SCOPE_ID);

  // No scope named, and the actor the route requires.
  const cleared = await reEnable({ actor: 'Priya' });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body, { re_enabled: true, scope: DEFAULT_FREEZE_SCOPE, scope_id: DEFAULT_FREEZE_SCOPE_ID });
  assert.equal((await state()).body.switches.length, 0);

  // A re-enable for a scope that has NO active row is a REFUSAL, not a 200.
  // This case used to assert the opposite — a provider-scoped re-enable
  // answering 200 while a campaign-scoped freeze was still up, which tells an
  // operator "automation is running again" about an account that is still
  // frozen. The row now has to be the one actually named.
  await trigger('?kind=spend-spike', { scope: 'campaign', scope_id: 'campaign_001' });
  assert.equal((await state()).body.switches[0].scope, 'campaign');
  const wrong = await reEnable({ actor: 'Priya', scope: 'provider', scope_id: 'meta_ads' });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.code, 'NO_ACTIVE_FREEZE');
  assert.equal(wrong.body.details.scope, 'provider');
  assert.equal(wrong.body.details.scope_id, 'meta_ads');
  const stillFrozen = await state();
  assert.equal(stillFrozen.body.switches.length, 1, 'the campaign-scoped row is still up');
  assert.equal(stillFrozen.body.switches[0].active, 1, 'and the refusal did not quietly clear it either');

  const right = await reEnable({ actor: 'Priya', scope: 'campaign', scope_id: 'campaign_001' });
  assert.equal(right.status, 200);
  assert.equal(right.body.scope, 'campaign');
  assert.equal((await state()).body.switches.length, 0);

  // A SECOND re-enable of a row that was really cleared is the same refusal.
  // "Already clear" is not "re-enabled", and saying otherwise is the lie this
  // route used to tell.
  const again = await reEnable({ actor: 'Priya', scope: 'campaign', scope_id: 'campaign_001' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'NO_ACTIVE_FREEZE');
  assert.equal(again.body.re_enabled, undefined);
  assert.equal(repositories.killSwitches.listForTenant(TENANT).filter((row) => row.active === 1).length, 0);
});

test('EVERY SCOPE freezes the writes it covers, and leaves the others writable', async () => {
  // The freeze the gate reads is keyed by (scope, scope_id), so a campaign
  // freeze has to refuse that campaign and NOT the one beside it, and a global
  // freeze has to refuse everything. A scope that froze nothing — or froze
  // everything — would pass the round trips below.
  const mint = (resource) => post('/v1/capabilities', {
    tenant_id: TENANT, action_class: 'campaign-status', action: 'set_campaign_status', resource, constraints: { status: 'PAUSED' },
  });
  for (const [scope, scopeId, blocked, allowed] of [
    ['global', null, 'campaign_001', null],
    ['tenant', null, 'campaign_001', null],
    ['provider', null, 'campaign_001', null],
    ['campaign', 'campaign_001', 'campaign_001', 'campaign_002'],
  ]) {
    // The row from the previous scope is cleared by a re-enable that names it
    // exactly, so each scope is measured from a clean state.
    for (const row of repositories.killSwitches.activeFor(TENANT)) {
      await reEnable({ actor: 'Priya', scope: row.scope, scope_id: row.scope_id });
    }

    const frozen = await trigger('?kind=spend-spike', scopeId === null ? { scope } : { scope, scope_id: scopeId });
    assert.equal(frozen.status, 201, scope);
    // The id in the response is the DERIVED one, never a typed literal: the
    // banner and the re-enable both have to find the row the trigger wrote.
    assert.equal(frozen.body.scope_id, freezeScopeId(scope, { tenant: TENANT, resource: scopeId }) ?? scopeId, scope);
    assert.equal((await state()).body.switches[0].scope_id, frozen.body.scope_id, scope);

    const held = await mint(blocked);
    assert.equal(held.status, 201, `${scope} still admits the class before execution`);
    const refused = await post('/v1/actions/execute', held.body.envelope);
    assert.equal(refused.status, 409, scope);
    assert.equal(refused.body.code, 'KILL_SWITCH_ACTIVE', scope);
    assert.equal(repositories.actionRecords.getByNonce(TENANT, held.body.envelope.nonce), null, `${scope} wrote no receipt`);

    if (allowed !== null) {
      const other = await mint(allowed);
      const through = await post('/v1/actions/execute', other.body.envelope);
      assert.equal(through.body.executed, true, `${scope} must not freeze ${allowed}`);
    }
  }
  for (const row of repositories.killSwitches.activeFor(TENANT)) {
    await reEnable({ actor: 'Priya', scope: row.scope, scope_id: row.scope_id });
  }
});

test('a scope_id that contradicts the derived one is 400 and writes no row', async () => {
  const before = await state();
  const refused = await trigger('?kind=spend-spike', { scope: 'global', scope_id: 'meta_ads' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'FREEZE_SCOPE_ID_MISMATCH');
  assert.equal(refused.body.details.expected_scope_id, TENANT);
  assert.equal(refused.body.stack, undefined);
  const after = await state();
  assert.deepEqual(after.body.switches, before.body.switches, 'a contradiction is a mistake, not a row to store');
  assert.equal(after.body.incidents.length, before.body.incidents.length, 'and not an incident');
});

test('an unknown scope is 400, not a 500', async () => {
  const refused = await trigger('?kind=spend-spike', { scope: 'moon' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'FREEZE_SCOPE_UNKNOWN');
  assert.deepEqual(repositories.killSwitches.activeFor(TENANT), []);
});

test('the freeze scope the route writes is the one the gate asks about, read from one function', async () => {
  // The bug this file exists for was two literals for one key: the guardian
  // wrote 'global' freezes under a provider id and the gate never asked for
  // that one. The two sides are compared through the derivation itself, so a
  // change to either side fails here rather than in production.
  const frozen = await trigger('?kind=spend-spike');
  const switchRow = (await state()).body.switches[0];
  assert.equal(switchRow.scope, DEFAULT_FREEZE_SCOPE);
  assert.equal(switchRow.scope_id, freezeScopeId(DEFAULT_FREEZE_SCOPE, { tenant: TENANT }));
  assert.equal(frozen.body.scope_id, switchRow.scope_id);
  await reEnable({ actor: 'Priya' });
});

test('a re-enable is audited against the human who did it', async () => {
  await trigger('?kind=tracking-loss');
  await reEnable({ actor: '  Priya  ' });
  const event = repositories.auditEvents.list(TENANT, { limit: 100 })
    .find((entry) => entry.action === 'guardian.re-enable');
  assert.ok(event, 'a re-enable is audited');
  assert.equal(event.actor, 'Priya', 'the route trims the actor before it is stored');
  assert.equal(event.subject, `${DEFAULT_FREEZE_SCOPE}:${DEFAULT_FREEZE_SCOPE_ID}`);
  assert.equal(repositories.killSwitches.listForTenant(TENANT)[0].re_enabled_by, 'Priya');
});

test('A FREEZE REFUSES BOTH WRITES, and lifting it lets both through', async () => {
  // The gate on its own would admit both of these: the approvals are
  // campaign-status, whose trust row earns autonomy. It is the freeze that has
  // to refuse them, and it is the only thing standing between a bad hour and a
  // spend.
  const approvalId = approval();
  const approve = () => post(`/v1/approvals/${approvalId}/approve`, { tenant_id: TENANT, reason: 'CPL doubled and stayed there' });

  const before = await approve();
  assert.equal(before.status, 200);
  assert.equal(before.body.executed, true, 'unfrozen, the approval executes');

  const issued = await post('/v1/capabilities', {
    tenant_id: TENANT, action_class: 'campaign-status', action: 'set_campaign_status', resource: 'campaign_002', constraints: { status: 'PAUSED' },
  });
  assert.equal(issued.status, 201, 'the gate admits this class while unfrozen');
  const envelope = issued.body.envelope;

  await trigger('?kind=spend-spike');

  const blocked = await post('/v1/actions/execute', envelope);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'KILL_SWITCH_ACTIVE');
  assert.equal(repositories.actionRecords.getByNonce(TENANT, envelope.nonce), null, 'a refused execution writes no receipt');

  const blockedApproval = approval();
  const refused = await post(`/v1/approvals/${blockedApproval}/approve`, { tenant_id: TENANT, reason: 'CPL doubled and stayed there' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'KILL_SWITCH_ACTIVE');
  assert.equal(repositories.approvals.get(TENANT, blockedApproval).status, 'pending', 'a frozen approval stays pending, not failed');

  // The same capability works the moment a human lifts the freeze.
  await reEnable({ actor: 'Priya' });
  const allowed = await post('/v1/actions/execute', envelope);
  assert.equal(allowed.body.executed, true);
  const retried = await post(`/v1/approvals/${blockedApproval}/approve`, { tenant_id: TENANT, reason: 'CPL doubled and stayed there' });
  assert.equal(retried.body.executed, true);
});

test('a freeze is scoped to its own tenant, over the API as well as in storage', async () => {
  repositories.tenants.create({ id: 'tenant_other', name: 'Other', currency: 'INR' });
  await trigger('?kind=spend-spike');
  const other = await get('/v1/guardian?tenant_id=tenant_other');
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.switches, []);
  assert.deepEqual(other.body.incidents, []);
  assert.equal((await state()).body.switches.length, 1);
  await reEnable({ actor: 'Priya' });
});
