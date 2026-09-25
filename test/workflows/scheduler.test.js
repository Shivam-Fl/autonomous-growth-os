import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import { createScheduler } from '../../src/workflows/scheduler.js';

const TENANT = 'tenant_demo';

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-'));
  const db = openDatabase(join(dir, 'app.db'));
  const repos = createRepositories(db);
  const scheduler = createScheduler({ repos });
  return { db, repos, scheduler };
}

const event = (eventId, tenantId = TENANT) => ({
  event_id: eventId,
  event_type: 'spend.observed',
  occurred_at: '2026-09-25T09:00:00.000Z',
  tenant_id: tenantId,
  schema_version: '1',
  payload: {},
});

async function until(fn, message = 'condition never became true') {
  for (let i = 0; i < 400; i += 1) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test('duplicate delivery of the same event_id to a consumer applies once', async () => {
  const { repos, scheduler } = boot();
  let applied = 0;
  scheduler.register('record_spend', async (eventEnvelope) => {
    applied += 1;
    return { applied_event: eventEnvelope.event_id };
  });

  const envelope = event('evt_dup_1');
  const first = await scheduler.consume(envelope, 'record_spend');
  const second = await scheduler.consume(envelope, 'record_spend');
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(applied, 1);

  const receipt = repos.idempotency.get(TENANT, 'evt_dup_1', 'record_spend');
  assert.equal(receipt.effect.applied_event, 'evt_dup_1', 'receipt recorded with the effect');
});

test('the same event_id delivered for a different consumer still applies', async () => {
  const { scheduler } = boot();
  let applied = 0;
  scheduler.register('consumer_a', async () => { applied += 1; });
  scheduler.register('consumer_b', async () => { applied += 1; });
  await scheduler.consume(event('evt_multi'), 'consumer_a');
  await scheduler.consume(event('evt_multi'), 'consumer_b');
  assert.equal(applied, 2, 'idempotency is per event_id per consumer');
});

test('a saga failing mid-run executes compensating actions in reverse', async () => {
  const { scheduler } = boot();
  const effects = [];
  scheduler.registerSaga('place_order', [
    { name: 'reserve', run: () => { effects.push('reserve'); }, compensate: () => { effects.push('release'); } },
    { name: 'charge', run: () => { effects.push('charge'); }, compensate: () => { effects.push('refund'); } },
    { name: 'notify', run: () => { throw new Error('channel down'); }, compensate: () => { effects.push('notify-undo'); } },
  ]);

  const result = await scheduler.startSaga('place_order', { tenantId: TENANT, payload: { sku: 'x' } });
  assert.equal(result.status, 'compensated');
  assert.equal(result.failedStep, 'notify');
  assert.deepEqual(effects, ['reserve', 'charge', 'refund', 'release'],
    'completed steps unwind in reverse order: the last effect is undone first');

  const run = scheduler.getRun(TENANT, result.runId);
  assert.equal(run.status, 'compensated');
});

test('a saga that completes records its effects exactly once', async () => {
  const { scheduler } = boot();
  const effects = [];
  scheduler.registerSaga('finish', [
    { name: 'one', run: () => { effects.push('one'); } },
    { name: 'two', run: () => { effects.push('two'); } },
  ]);
  const result = await scheduler.startSaga('finish', { tenantId: TENANT, payload: {} });
  assert.equal(result.status, 'completed');
  assert.deepEqual(effects, ['one', 'two']);
});

test('a saga interrupted mid-run resumes to exactly-once effects on restart', async () => {
  const { repos, scheduler: crashedScheduler } = boot();
  const effects = [];
  const signal = {};
  const appliedB = new Promise((resolve) => { signal.appliedB = resolve; });

  crashedScheduler.registerSaga('resume_demo', [
    { name: 'step_a', run: () => { effects.push('step_a'); } },
    {
      name: 'step_b',
      run: async () => {
        effects.push('step_b'); // effect applied...
        signal.appliedB();      // ...then the process "crashes" mid-run
        await new Promise(() => {}); // never resolves
      },
    },
    { name: 'step_c', run: () => { effects.push('step_c'); } },
  ]);

  const crashedPromise = crashedScheduler.startSaga('resume_demo', { tenantId: TENANT, payload: {} });
  await until(() => effects.includes('step_b'));
  await appliedB.catch(() => {});
  crashedScheduler.stopAll(); // the crashed process dies with step_b claimed but unrecorded

  const restartedScheduler = createScheduler({ repos });
  // A restarted process re-registers its saga definitions from code; only
  // durable state (saga_runs, idempotency_keys) survives the crash.
  restartedScheduler.registerSaga('resume_demo', [
    { name: 'step_a', run: () => { effects.push('step_a'); } },
    { name: 'step_b', run: () => { effects.push('step_b'); } },
    { name: 'step_c', run: () => { effects.push('step_c'); } },
  ]);
  const resume = await restartedScheduler.resumeSagas();
  assert.equal(resume.resumed, 1, 'the interrupted saga is found and resumed');

  // step_b already claimed pre-crash: skipped, not re-applied; step_c now runs.
  assert.deepEqual(effects, ['step_a', 'step_b', 'step_c'], 'every effect applied exactly once');
  const run = restartedScheduler.getRun(TENANT, resume.runs[0].runId);
  assert.equal(run.status, 'completed');

  // A second resume finds nothing left to do and applies nothing again.
  await restartedScheduler.resumeSagas();
  assert.deepEqual(effects, ['step_a', 'step_b', 'step_c'], 'resume is itself exactly-once');
});
