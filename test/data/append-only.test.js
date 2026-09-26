import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories, replayRawToDerived } from '../../src/data/repositories.js';
import { validateEvent } from '../../src/domain/events.js';

const TENANT = 'tenant_demo';

const envelope = (eventId, amountMicros) => validateEvent({
  event_id: eventId,
  event_type: 'spend.observed',
  occurred_at: '2026-09-25T09:00:00.000Z',
  tenant_id: TENANT,
  schema_version: '1',
  payload: { campaign: 'c1', amount_micros: amountMicros },
}).event;

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'append-only-'));
  const db = openDatabase(join(dir, 'app.db'));
  return { db, repos: createRepositories(db) };
}

test('raw_events and audit_events expose no update or delete function', () => {
  const { repos } = boot();
  for (const surface of ['rawEvents', 'auditEvents']) {
    for (const forbidden of ['update', 'delete', 'remove', 'purge', 'clear', 'truncate']) {
      assert.equal(repos[surface][forbidden], undefined, `${surface}.${forbidden} must not exist`);
    }
  }
});

test('capabilities and guardian_incidents are append-only on BOTH verbs', () => {
  // capabilities are the authority to write: if one could be edited after it
  // was signed, the signature would stop meaning anything. guardian_incidents
  // is the record that something went wrong, which is worth exactly nothing if
  // it can be rewritten.
  const { db, repos } = boot();
  repos.capabilities.create({
    tenant_id: TENANT,
    capability_id: 'cap_append_only_1',
    envelope: { tenant: TENANT, nonce: 'nc_append_only_1' },
    expires_at: '2026-09-25T10:15:00.000Z',
  });
  repos.guardianIncidents.append({
    tenant_id: TENANT,
    incident_id: 'gin_append_only_1',
    kind: 'spend-spike',
    details: { ratio: 1.25 },
    frozen_at: '2026-09-25T10:00:00.000Z',
    detected_by: 'guardian',
  });

  for (const [sql, params] of [
    ['UPDATE capabilities SET expires_at = ? WHERE capability_id = ?', ['2099-01-01T00:00:00.000Z', 'cap_append_only_1']],
    ['DELETE FROM capabilities WHERE capability_id = ?', ['cap_append_only_1']],
    ['UPDATE guardian_incidents SET kind = ? WHERE incident_id = ?', ['other', 'gin_append_only_1']],
    ['DELETE FROM guardian_incidents WHERE incident_id = ?', ['gin_append_only_1']],
  ]) {
    assert.throws(() => db.prepare(sql).run(...params), undefined, `storage must reject: ${sql}`);
  }

  // The attempts left both rows exactly as written.
  assert.equal(repos.capabilities.get(TENANT, 'cap_append_only_1').expires_at, '2026-09-25T10:15:00.000Z');
  assert.equal(repos.guardianIncidents.listForTenant(TENANT, { limit: 5 })[0].kind, 'spend-spike');
  // ...and neither repository exposes a mutator to try it a softer way.
  for (const surface of ['capabilities', 'guardianIncidents']) {
    for (const forbidden of ['update', 'delete', 'remove', 'purge', 'clear', 'truncate']) {
      assert.equal(repos[surface][forbidden], undefined, `${surface}.${forbidden} must not exist`);
    }
  }
});

test('action_records refuses UPDATE, ALLOWS DELETE, and purgeSeeded is the only way to delete', () => {
  // The asymmetry is deliberate and is the ONE delete in the delete-free
  // repository surface: `seed --reset-approvals` must be able to clear a
  // seeded receipt so the QA script can approve the same approval twice. The
  // UPDATE trigger still holds, because a receipt that a caller could edit
  // after the provider was written would be an edit to history.
  const { db, repos } = boot();
  repos.approvals.create({
    tenant_id: TENANT,
    approval_id: 'apv_append_only_1',
    action_class: 'campaign-status',
    action: 'set_campaign_status',
    resource: 'campaign_001',
    constraints: { status: 'PAUSED' },
    impact: 'pause brand defence',
    downside: 'a coverage gap for a day',
    evidence_refs: [],
    expires_at: '2026-09-26T10:00:00.000Z',
  });
  const append = (receiptId, nonce) => repos.actionRecords.append({
    tenant_id: TENANT,
    receipt_id: receiptId,
    approval_id: 'apv_append_only_1',
    capability_id: `cap_${receiptId}`,
    nonce,
    action_class: 'campaign-status',
    action: 'set_campaign_status',
    resource: 'campaign_001',
    requested: { status: 'PAUSED' },
    reported: { status: 'PAUSED' },
    reconciliation: 'agreed',
    drift: 'none',
    actor: 'tester',
    executed_at: '2026-09-25T10:00:00.000Z',
  });
  append('rcp_seeded_1', 'nc_seeded_1');
  append('rcp_other_1', 'nc_other_1');

  assert.throws(
    () => db.prepare('UPDATE action_records SET reconciliation = ? WHERE receipt_id = ?').run('agreed', 'rcp_seeded_1'),
    undefined,
    'storage must reject an UPDATE against action_records',
  );
  assert.equal(repos.actionRecords.get(TENANT, 'rcp_seeded_1').reconciliation, 'agreed');

  // purgeSeeded deletes by NONCE and only the nonces it is handed, so a caller
  // cannot pass a list that reaches past the seeded receipts.
  assert.equal(repos.actionRecords.purgeSeeded(TENANT, ['nc_seeded_1']), 1);
  assert.equal(repos.actionRecords.purgeSeeded(TENANT, ['nc_seeded_1']), 0, 'a second purge of the same nonce deletes nothing');
  assert.equal(repos.actionRecords.purgeSeeded(TENANT, []), 0, 'an empty nonce list is not a DELETE with no WHERE');
  assert.equal(repos.actionRecords.get(TENANT, 'rcp_seeded_1'), null);
  assert.ok(repos.actionRecords.get(TENANT, 'rcp_other_1'), 'a receipt outside the list survives');

  // And the raw DELETE the reset relies on is genuinely permitted, so the
  // asymmetry above is the schema's and not the repository's discretion.
  assert.equal(db.prepare('DELETE FROM action_records WHERE tenant_id = ?').run(TENANT).changes, 1);
  assert.deepEqual(repos.actionRecords.listForTenant(TENANT, { limit: 10 }), []);

  for (const forbidden of ['update', 'remove', 'clear', 'truncate']) {
    assert.equal(repos.actionRecords[forbidden], undefined, `actionRecords.${forbidden} must not exist`);
  }
  assert.equal(typeof repos.actionRecords.purgeSeeded, 'function', 'purgeSeeded is the one deleting method');
});

test('attempted direct UPDATE or DELETE against those tables fails at the storage level', () => {
  const { db, repos } = boot();
  repos.rawEvents.append(envelope('evt_immutable_1', 1_000_000));
  repos.auditEvents.append({
    tenant_id: TENANT,
    actor: 'test',
    action: 'audit.test',
    subject: 'subject-1',
    details: {},
  });

  for (const [sql, params] of [
    ["UPDATE raw_events SET event_type = 'tampered' WHERE event_id = 'evt_immutable_1'", []],
    ["DELETE FROM raw_events WHERE event_id = 'evt_immutable_1'", []],
    ["UPDATE audit_events SET action = 'tampered' WHERE tenant_id = ?", [TENANT]],
    ['DELETE FROM audit_events WHERE tenant_id = ?', [TENANT]],
  ]) {
    assert.throws(
      () => db.prepare(sql).run(...params),
      undefined,
      `storage must reject: ${sql}`,
    );
  }

  // The tampering attempts left the rows exactly as appended.
  assert.equal(repos.rawEvents.count(TENANT), 1);
  assert.equal(repos.rawEvents.list(TENANT)[0].event_type, 'spend.observed');
  assert.equal(repos.auditEvents.list(TENANT)[0].action, 'audit.test');
});

test('replayRawToDerived rebuilds derived values identically after derived_metrics is wiped', () => {
  const { db, repos } = boot();
  repos.rawEvents.append(envelope('evt_replay_1', 2_500_000_000));
  repos.rawEvents.append(envelope('evt_replay_2', 1_500_000_000));
  const first = replayRawToDerived(db, TENANT);
  assert.equal(first.value_micros, 4_000_000_000);

  const before = repos.derived.list(TENANT);
  assert.equal(before.filter((row) => row.metric === 'spend_micros').reduce((total, row) => total + row.value_micros, 0), 4_000_000_000);

  repos.derived.clear(TENANT);
  assert.deepEqual(repos.derived.list(TENANT), []);

  const second = replayRawToDerived(db, TENANT);
  assert.equal(second.value_micros, first.value_micros, 'replay rebuilds the same totals from raw alone');
  const after = repos.derived.list(TENANT);
  assert.deepEqual(
    after.map(({ metric, dimension, value_micros: v }) => [metric, dimension, v]),
    before.map(({ metric, dimension, value_micros: v }) => [metric, dimension, v]),
    'the rebuilt derived rows match the original ones (timestamps excepted)',
  );
});

test('replay never reads derived state, only raw_events', () => {
  const { db, repos } = boot();
  repos.rawEvents.append(envelope('evt_replay_only_raw_1', 1_000_000));
  replayRawToDerived(db, TENANT);
  const rows = repos.derived.list(TENANT);
  assert.equal(rows.length, 1);
  // Corrupt derived state directly, then replay: raw wins.
  repos.derived.upsert(TENANT, 'spend_micros', 'c1', 999_999_999_999);
  replayRawToDerived(db, TENANT);
  assert.equal(
    repos.derived.list(TENANT).find((row) => row.dimension === 'c1').value_micros,
    1_000_000,
    'a replay repairs corrupted derived values from raw_events',
  );
});
