// The guardian (issue #20, TR-4): the detectors, the freeze they raise, and the
// human re-enable that clears it. The load-bearing case here is the last one:
// the WRITE side and the READ side must agree on the row, or a re-enable
// clears nothing and still reports success.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import {
  DEFAULT_FREEZE_SCOPE,
  DEFAULT_FREEZE_SCOPE_ID,
  FREEZE_SCOPES,
  GUARDIAN_FIXTURES,
  GUARDIAN_KINDS,
  evaluate,
  freeze,
  reEnable,
  recoveryHolds,
  spendSpike,
  trackingLoss,
} from '../../src/strategy/guardian.js';

const TENANT = 'tenant_demo';
const NOW = '2026-09-25T10:00:00.000Z';

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-'));
  const db = openDatabase(join(dir, 'app.db'));
  const repositories = createRepositories(db);
  repositories.tenants.create({ id: TENANT, name: 'Demo', currency: 'INR' });
  return { db, repositories };
}

/** assert.throws returns undefined, so the code under test is read here. */
function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

const freezeAt = (repositories, overrides = {}) => freeze({
  repositories,
  tenantId: TENANT,
  kind: 'spend-spike',
  details: { reason: 'over baseline' },
  actor: 'guardian',
  at: NOW,
  ...overrides,
});

test('both detectors trip on the fixtures the plan names, and stay quiet otherwise', () => {
  const spike = spendSpike(GUARDIAN_FIXTURES['spend-spike'], { nowIso: NOW });
  assert.equal(spike.tripped, true);
  assert.equal(spike.details.observed_spend_micros, 9_000_000_000);
  assert.equal(spike.details.baseline_spend_micros, 7_200_000_000);
  assert.equal(spike.details.ratio, 1.25);
  assert.equal(Number.isSafeInteger(spike.details.observed_spend_micros), true);

  const loss = trackingLoss(GUARDIAN_FIXTURES['tracking-loss'], { nowIso: NOW });
  assert.equal(loss.tripped, true);
  assert.equal(loss.details.stale_age_hours, 72);
  assert.equal(loss.details.threshold_hours, 24);

  // The same window UNDER baseline, and a qualified event inside the
  // threshold, both stay quiet.
  const quiet = spendSpike({ ...GUARDIAN_FIXTURES['spend-spike'], spend_hours_ago: [{ hours: 1, amount_micros: 1_000_000_000 }] }, { nowIso: NOW });
  assert.equal(quiet.tripped, false);
  const fresh = trackingLoss({ kind: 'tracking-loss', qualified_hours_ago: [{ hours: 2, lead_id: 'lead_1' }] }, { nowIso: NOW });
  assert.equal(fresh.tripped, false);
});

test('spend outside the window is not counted against the baseline', () => {
  // A spike 40 hours ago is not a spike in the last 6 hours, and a detector
  // that counted it would freeze on history rather than on now.
  const stale = spendSpike({ ...GUARDIAN_FIXTURES['spend-spike'], spend_hours_ago: [{ hours: 40, amount_micros: 9_000_000_000 }] }, { nowIso: NOW });
  assert.equal(stale.tripped, false);
  assert.equal(stale.details.observed_spend_micros, 0);
});

test('evaluate dispatches on kind, and an unknown kind trips nothing rather than throwing', () => {
  for (const kind of GUARDIAN_KINDS) {
    assert.equal(evaluate(GUARDIAN_FIXTURES[kind], { nowIso: NOW }).kind, kind);
  }
  const unknown = evaluate({ kind: 'meteor-strike' }, { nowIso: NOW });
  assert.equal(unknown.tripped, false);
  assert.equal(unknown.details.reason, 'unknown-kind');
  assert.throws(() => evaluate(GUARDIAN_FIXTURES['spend-spike'], { nowIso: 'not-a-date' }));
});

test('recoveryHolds is the INVERSE of evaluate, for both kinds', () => {
  for (const kind of GUARDIAN_KINDS) {
    const fixture = GUARDIAN_FIXTURES[kind];
    assert.equal(recoveryHolds(fixture, { nowIso: NOW }), !evaluate(fixture, { nowIso: NOW }).tripped, kind);
    // A fixture that is NOT tripping is one whose recovery criterion holds.
    const quiet = kind === 'spend-spike'
      ? { ...fixture, spend_hours_ago: [{ hours: 1, amount_micros: 1 }] }
      : { kind, qualified_hours_ago: [{ hours: 1, lead_id: 'lead_1' }] };
    assert.equal(recoveryHolds(quiet, { nowIso: NOW }), true, kind);
  }
});

test('freeze writes a real, non-NULL scope_id and appends an incident and an audit event', () => {
  const { repositories } = boot();
  const result = freezeAt(repositories);
  assert.equal(result.frozen, true);
  assert.equal(result.scope, DEFAULT_FREEZE_SCOPE);
  assert.equal(result.scope_id, DEFAULT_FREEZE_SCOPE_ID);
  assert.equal(result.incident_id.startsWith('gin_'), true);

  const incidents = repositories.guardianIncidents.listForTenant(TENANT, { limit: 10 });
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].tenant_id, TENANT);
  assert.equal(incidents[0].incident_id, result.incident_id);
  assert.equal(incidents[0].frozen_at, NOW);

  const audit = repositories.auditEvents.list(TENANT, { limit: 10 });
  assert.ok(audit.some((event) => event.action === 'guardian.freeze' && event.subject === result.incident_id));
});

test('a NULL scope_id is refused, because it could never be matched by a re-enable', () => {
  const { repositories } = boot();
  // undefined is NOT in this list: an omitted scope_id is how the caller asks
  // for the default, and a default parameter treats undefined as absent. A
  // null and an empty string are both "you named a scope_id and it was not
  // one", and both are refused rather than written.
  for (const scopeId of [null, '']) {
    const error = thrown(() => freezeAt(repositories, { scopeId }));
    assert.equal(error.code, 'FREEZE_SCOPE_ID_REQUIRED', String(scopeId));
  }
  assert.equal(thrown(() => freezeAt(repositories, { scope: 'moon' })).code, 'FREEZE_SCOPE_UNKNOWN');
});

test('a re-trigger after a re-enable UPDATES the same row rather than appending a second one', () => {
  const { repositories } = boot();
  freezeAt(repositories);
  reEnable({ repositories, tenantId: TENANT, actor: 'me', at: NOW });
  const second = freezeAt(repositories);

  const all = repositories.killSwitches.listForTenant(TENANT);
  assert.equal(all.length, 1, 'one row, re-armed — not two active rows');
  assert.equal(all[0].active, 1);
  assert.equal(all[0].scope, DEFAULT_FREEZE_SCOPE);
  assert.equal(all[0].scope_id, DEFAULT_FREEZE_SCOPE_ID);
  assert.equal(repositories.killSwitches.activeFor(TENANT).length, 1);
  // The incident log is append-only, so the second freeze is a second
  // incident: that is the record, not a second switch.
  assert.equal(repositories.guardianIncidents.listForTenant(TENANT, { limit: 10 }).length, 2);
  assert.equal(second.frozen, true);
});

test('THE WRITE AND READ SIDES AGREE, for all four scopes', () => {
  // This is the case a previous revision failed: freeze wrote one shape and
  // activeFor read another, so the banner never appeared and a re-enable
  // cleared nothing while reporting success.
  for (const [index, scope] of FREEZE_SCOPES.entries()) {
    const { repositories } = boot();
    const scopeId = scope === 'global' || scope === 'tenant' ? TENANT : scope === 'provider' ? 'meta_ads' : 'campaign_001';
    freezeAt(repositories, { scope, scopeId });

    const active = repositories.killSwitches.activeFor(TENANT);
    assert.equal(active.length, 1, `${scope} must be visible to activeFor`);
    assert.equal(active[0].scope, scope);
    assert.equal(active[0].scope_id, scopeId);
    assert.equal(repositories.killSwitches.isActive(TENANT, scope, scopeId), true, `${scope} ${scopeId}`);

    // ...and the matching re-enable clears exactly that row.
    reEnable({ repositories, tenantId: TENANT, actor: 'me', scope, scopeId });
    assert.equal(repositories.killSwitches.isActive(TENANT, scope, scopeId), false, `${scope} after re-enable`);
    assert.deepEqual(repositories.killSwitches.activeFor(TENANT), [], `${scope} still active`);
    assert.equal(index >= 0, true);
  }
});

test("reEnable's defaults are freeze's defaults, so a re-enable naming no scope clears the demo's row", () => {
  const { repositories } = boot();
  freezeAt(repositories);
  const result = reEnable({ repositories, tenantId: TENANT, actor: 'me' });
  assert.equal(result.re_enabled, true);
  assert.equal(result.scope, DEFAULT_FREEZE_SCOPE);
  assert.equal(result.scope_id, DEFAULT_FREEZE_SCOPE_ID);
  assert.deepEqual(repositories.killSwitches.activeFor(TENANT), []);
});

test('a re-enable with no actor is refused and writes nothing', () => {
  const { repositories } = boot();
  freezeAt(repositories);
  const before = repositories.auditEvents.list(TENANT, { limit: 50 }).length;
  for (const actor of [undefined, null, '', '   ', 7]) {
    const error = thrown(() => reEnable({ repositories, tenantId: TENANT, actor }));
    assert.equal(error.code, 'RE_ENABLE_ACTOR_REQUIRED', String(actor));
  }
  assert.equal(repositories.killSwitches.isActive(TENANT, DEFAULT_FREEZE_SCOPE, DEFAULT_FREEZE_SCOPE_ID), true);
  assert.equal(repositories.auditEvents.list(TENANT, { limit: 50 }).length, before, 'no audit row for a refused re-enable');
});

test('a re-enable appends an audit event naming the human who did it', () => {
  const { repositories } = boot();
  freezeAt(repositories);
  reEnable({ repositories, tenantId: TENANT, actor: 'Priya', at: NOW });
  const audit = repositories.auditEvents.list(TENANT, { limit: 10 });
  const event = audit.find((entry) => entry.action === 'guardian.re-enable');
  assert.ok(event, 'an audit row is appended');
  assert.equal(event.actor, 'Priya');
  assert.equal(event.subject, `${DEFAULT_FREEZE_SCOPE}:${DEFAULT_FREEZE_SCOPE_ID}`);
  const row = repositories.killSwitches.listForTenant(TENANT)[0];
  assert.equal(row.active, 0);
  assert.equal(row.re_enabled_by, 'Priya');
  // A padded actor is a human and is recorded verbatim; the ROUTE is what
  // trims, so what the audit row holds is what the caller sent.
  reEnable({ repositories, tenantId: TENANT, actor: '  Priya  ', at: NOW });
  assert.equal(repositories.killSwitches.listForTenant(TENANT)[0].re_enabled_by, '  Priya  ');
});

test('incidents are never updated, and the repository exposes no mutator for them', () => {
  const { repositories } = boot();
  freezeAt(repositories);
  for (const forbidden of ['update', 'delete', 'remove', 'purge', 'clear', 'truncate']) {
    assert.equal(repositories.guardianIncidents[forbidden], undefined, `guardianIncidents.${forbidden} must not exist`);
  }
  assert.throws(() => repositories.db.exec("UPDATE guardian_incidents SET kind = 'other'"));
  assert.throws(() => repositories.db.exec('DELETE FROM guardian_incidents'));
});

test('a freeze is scoped to its own tenant, never a global sentinel row', () => {
  const { repositories } = boot();
  repositories.tenants.create({ id: 'tenant_other', name: 'Other', currency: 'INR' });
  freezeAt(repositories);
  assert.deepEqual(repositories.killSwitches.activeFor('tenant_other'), []);
  assert.equal(repositories.killSwitches.isActive('tenant_other', DEFAULT_FREEZE_SCOPE, DEFAULT_FREEZE_SCOPE_ID), false);
  assert.equal(repositories.killSwitches.activeFor(TENANT).length, 1);
});
