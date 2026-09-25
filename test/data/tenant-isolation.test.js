import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories, replayRawToDerived } from '../../src/data/repositories.js';
import { createScheduler } from '../../src/workflows/scheduler.js';
import { validateEvent } from '../../src/domain/events.js';

const A = 'tenant_a';
const B = 'tenant_b';

const envelope = (tenantId, eventId, amountMicros) => validateEvent({
  event_id: eventId,
  event_type: 'spend.observed',
  occurred_at: '2026-09-25T09:00:00.000Z',
  tenant_id: tenantId,
  schema_version: '1',
  payload: { campaign: 'shared', amount_micros: amountMicros },
}).event;

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'isolation-'));
  const db = openDatabase(join(dir, 'app.db'));
  const repos = createRepositories(db);
  return { db, repos, scheduler: createScheduler({ repos }) };
}

test('two tenants write rows and every query path returns only its own rows', () => {
  const { db, repos } = boot();
  repos.tenants.create({ id: A, name: 'Tenant A', currency: 'INR' });
  repos.tenants.create({ id: B, name: 'Tenant B', currency: 'USD' });

  repos.rawEvents.append(envelope(A, 'evt_a_1', 1_000_000));
  repos.rawEvents.append(envelope(B, 'evt_b_1', 2_000_000));
  repos.auditEvents.append({ tenant_id: A, actor: 'test', action: 'audit.a', details: {} });
  repos.auditEvents.append({ tenant_id: B, actor: 'test', action: 'audit.b', details: {} });
  replayRawToDerived(db, A);
  replayRawToDerived(db, B);

  for (const tenant of [A, B]) {
    const other = tenant === A ? B : A;
    const ownId = tenant === A ? 'evt_a_1' : 'evt_b_1';
    const ownAction = tenant === A ? 'audit.a' : 'audit.b';
    const ownAmount = tenant === A ? 1_000_000 : 2_000_000;

    assert.deepEqual(repos.rawEvents.list(tenant).map((event) => event.tenant_id), [tenant],
      'raw_events list returns only the tenant’s rows');
    assert.equal(repos.rawEvents.count(tenant), 1);
    assert.deepEqual(repos.auditEvents.list(tenant).map((row) => row.action), [ownAction],
      'audit_events list returns only the tenant’s rows');
    const derived = repos.derived.list(tenant);
    assert.deepEqual(derived.map((row) => row.tenant_id), [tenant],
      'derived_metrics list returns only the tenant’s rows');
    assert.equal(derived.find((row) => row.metric === 'spend_micros').value_micros, ownAmount);
    assert.equal(repos.sagas.listRunning().filter((run) => run.tenant_id === other).length, 0,
      'saga listing is tenant-scoped');
  }
});

test('cross-tenant event_id reuse does not leak effects across tenants', async () => {
  const { repos, scheduler } = boot();
  const applied = new Map();
  scheduler.register('record_spend', async (event) => {
    applied.set(event.tenant_id, (applied.get(event.tenant_id) ?? 0) + 1);
  });

  // The SAME event_id delivered for two tenants is two distinct deliveries.
  const firstA = await scheduler.consume(envelope(A, 'evt_shared_id', 1), 'record_spend');
  const firstB = await scheduler.consume(envelope(B, 'evt_shared_id', 1), 'record_spend');
  assert.equal(firstA.applied, true);
  assert.equal(firstB.applied, true, 'tenant B’s delivery is not deduped against tenant A’s');
  assert.deepEqual([...applied.entries()], [[A, 1], [B, 1]]);

  // Each tenant's idempotency receipt is visible only through its own key.
  assert.equal(repos.idempotency.get(A, 'evt_shared_id', 'record_spend').claimed_at !== null, true);
  assert.equal(repos.idempotency.get(A, 'evt_shared_id', 'record_spend').tenant_id, A);
  assert.equal(repos.idempotency.get(B, 'evt_shared_id', 'record_spend').tenant_id, B);
  // A distinct event_id under tenant B is still free to apply.
  assert.equal((await scheduler.consume(envelope(B, 'evt_b_2', 1), 'record_spend')).applied, true);
  assert.deepEqual([...applied.entries()], [[A, 1], [B, 2]]);
});

test('saga runs are isolated per tenant', async () => {
  const { repos, scheduler } = boot();
  scheduler.registerSaga('solo', [{ name: 'only', run: () => {} }]);
  const runA = await scheduler.startSaga('solo', { tenantId: A, payload: {} });
  assert.equal(runA.status, 'completed');
  assert.equal(scheduler.getRun(B, runA.runId), null, 'tenant B cannot read tenant A’s saga run');
  assert.equal(scheduler.getRun(A, runA.runId).tenant_id, A);
});
