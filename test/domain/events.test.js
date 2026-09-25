import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, applyOnce } from '../../src/domain/events.js';

const VALID = {
  event_id: 'evt_01J9EXAMPLE',
  event_type: 'spend.observed',
  occurred_at: '2026-09-25T10:30:00.000Z',
  tenant_id: 'tenant_demo',
  schema_version: '1',
  payload: { campaign: 'c1', amount_micros: 5_000_000 },
};

test('valid envelope passes and is normalised to UTC ISO-8601', () => {
  const result = validateEvent(VALID);
  assert.equal(result.ok, true);
  assert.equal(result.event.tenant_id, 'tenant_demo');
  assert.equal(result.event.occurred_at, '2026-09-25T10:30:00.000Z');
  assert.equal(result.event.event_type, 'spend.observed');
});

test('missing event_id, bad timestamp or missing tenant_id return stable codes', () => {
  const cases = [
    [{ ...VALID, event_id: undefined }, 'MISSING_EVENT_ID'],
    [{ ...VALID, event_id: '' }, 'MISSING_EVENT_ID'],
    [{ ...VALID, event_id: 42 }, 'MISSING_EVENT_ID'],
    [{ ...VALID, occurred_at: undefined }, 'MISSING_OCCURRED_AT'],
    [{ ...VALID, occurred_at: 'not-a-date' }, 'BAD_OCCURRED_AT'],
    [{ ...VALID, occurred_at: '2026-09-25T16:00:00+05:30' }, 'NON_UTC_OCCURRED_AT'],
    [{ ...VALID, tenant_id: undefined }, 'MISSING_TENANT_ID'],
    [{ ...VALID, tenant_id: '' }, 'MISSING_TENANT_ID'],
    [{ ...VALID, event_type: '' }, 'MISSING_EVENT_TYPE'],
    [{ ...VALID, schema_version: '' }, 'MISSING_SCHEMA_VERSION'],
    [{ ...VALID, payload: undefined }, 'MISSING_PAYLOAD'],
    [{ ...VALID, payload: 'x' }, 'MISSING_PAYLOAD'],
  ];
  for (const [envelope, code] of cases) {
    const result = validateEvent(envelope);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(typeof result.error.message, 'string');
  }
});

test('non-object envelopes are rejected without throwing', () => {
  for (const bad of [null, undefined, 'x', 7]) {
    const result = validateEvent(bad);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MISSING_EVENT_ID');
  }
});

test('duplicate event_id delivery applies the effect exactly once', async () => {
  const seen = new Set();
  const store = {
    async has(key) {
      return seen.has(key);
    },
    async record(key) {
      seen.add(key);
    },
  };
  let applied = 0;
  const effect = async () => {
    applied += 1;
  };

  const first = await applyOnce(store, VALID, effect);
  const second = await applyOnce(store, VALID, effect);
  assert.deepEqual(first, { applied: true });
  assert.deepEqual(second, { applied: false });
  assert.equal(applied, 1, 'effect ran once despite two deliveries');
});

test('a failing effect does not record the key, so a retry can apply it', async () => {
  const seen = new Set();
  const store = {
    has: (key) => Promise.resolve(seen.has(key)),
    record: (key) => {
      seen.add(key);
      return Promise.resolve();
    },
  };
  let calls = 0;
  await assert.rejects(
    applyOnce(store, VALID, async () => {
      calls += 1;
      throw new Error('transient');
    }),
  );
  assert.equal(calls, 1);
  const retry = await applyOnce(store, VALID, async () => {
    calls += 1;
  });
  assert.equal(retry.applied, true, 'retry after failure is allowed to apply');
  assert.equal(calls, 2);
});
