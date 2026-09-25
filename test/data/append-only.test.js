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
