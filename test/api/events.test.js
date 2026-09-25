// POST /v1/events ingest and GET /v1/metrics read truth, on an isolated
// tenant: the contract face of the measurement slice.

import { test, after } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import { buildApp } from '../../src/api/routes.js';

const dir = mkdtempSync(join(tmpdir(), 'events-'));
const db = openDatabase(join(dir, 'app.db'));
const repositories = createRepositories(db);
const app = buildApp({ repositories });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());

const url = (path) => `http://127.0.0.1:${port}${path}`;
const port = server.address().port;

const NOW = () => new Date().toISOString();

/** The canonical 10-event journey for tenant_qa; the QA script posts the same
 * payloads, only ids and the session differ. */
function journeyBodies({ prefix = 'evt_qa_journey' } = {}) {
  const occurredAt = NOW();
  const leads = ['qa1', 'qa2', 'qa3'];
  const share = { campaign: 'search-brand', session_id: 'sess_qa_journey_1' };
  return [
    { event_id: `${prefix}_click_1`, event_name: 'click', occurred_at: occurredAt, ...share },
    { event_id: `${prefix}_spend_1`, event_name: 'spend.observed', occurred_at: occurredAt, value: 7_200_000_000, currency: 'INR', ...share },
    ...leads.map((lead, index) => ({ event_id: `${prefix}_lead_created_${index + 1}`, event_name: 'lead_created', occurred_at: occurredAt, lead_id: `lead_${lead}`, ...share })),
    ...leads.map((lead, index) => ({ event_id: `${prefix}_lead_qualified_${index + 1}`, event_name: 'lead_qualified', occurred_at: occurredAt, lead_id: `lead_${lead}`, ...share })),
    { event_id: `${prefix}_opp_1`, event_name: 'opportunity_created', occurred_at: occurredAt, opportunity_id: 'opp_qa_1', lead_id: 'lead_qa1', ...share },
    { event_id: `${prefix}_deal_1`, event_name: 'deal_won', occurred_at: occurredAt, order_id: 'order_qa_1', opportunity_id: 'opp_qa_1', ...share },
  ];
}

async function postJourney(prefix) {
  for (const body of journeyBodies({ prefix })) {
    const response = await fetch(url('/v1/events'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, tenant_id: 'tenant_qa' }),
    });
    assert.equal(response.status, 202, `${body.event_id} must ingest`);
    assert.deepEqual(await response.json(), { receipt: body.event_id, appended: true, duplicate: false });
  }
}

test('POST valid lead_qualified returns 202 with the receipt and appended true', async () => {
  // An isolated tenant: later assertions pin tenant_qa's exact volume.
  const response = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_solo_1', event_name: 'lead_qualified', occurred_at: NOW(), tenant_id: 'tenant_solo', lead_id: 'lead_solo', session_id: 'sess_solo' }),
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.receipt, 'evt_solo_1');
  assert.equal(body.appended, true);
  assert.equal(body.duplicate, false);
});

test('the POSTed 10-event journey resolves via GET /v1/metrics to CPL 2400000000 on volume 3', async () => {
  await postJourney('evt_qa_journey');
  const response = await fetch(url('/v1/metrics?tenant_id=tenant_qa'));
  assert.equal(response.status, 200);
  const metrics = await response.json();
  assert.equal(metrics.tenant_id, 'tenant_qa');
  assert.equal(metrics.spend_micros, 7_200_000_000);
  assert.equal(metrics.qualified_volume, 3);
  assert.equal(metrics.qualified_cpl_micros, 2_400_000_000);
  assert.equal(typeof metrics.maturity, 'number');
  assert.equal(typeof metrics.band, 'string');
  assert.equal(metrics.maturity_coverage, 1);
  assert.equal(metrics.stale, false);
  assert.equal(metrics.stale_age, 0);
  assert.equal(typeof metrics.data_through, 'string');
});

test('a just-posted journey is immature: gated strategic, band emergency-only, data_through set', async () => {
  const response = await fetch(url('/v1/metrics?tenant_id=tenant_qa'));
  const metrics = await response.json();
  assert.ok(metrics.maturity < 0.35, `fresh data must be immature, got ${metrics.maturity}`);
  assert.equal(metrics.band, 'emergency-only');
  assert.equal(metrics.gated_strategic, true);
});

test('POSTing the same event_id twice appends once and never double-counts', async () => {
  const body = { event_id: 'evt_qa_journey_deal_1', event_name: 'deal_won', occurred_at: NOW(), tenant_id: 'tenant_qa', order_id: 'order_qa_1', opportunity_id: 'opp_qa_1', campaign: 'search-brand', session_id: 'sess_qa_journey_1' };
  const first = await fetch(url('/v1/events'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const again = await fetch(url('/v1/events'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(again.status, 202);
  assert.deepEqual(await again.json(), { receipt: 'evt_qa_journey_deal_1', appended: false, duplicate: true });
  const metrics = await (await fetch(url('/v1/metrics?tenant_id=tenant_qa'))).json();
  assert.equal(metrics.qualified_volume, 3, 'qualifying volume never moves on a duplicate');
  assert.equal(metrics.spend_micros, 7_200_000_000, 'spend never moves on a duplicate');
  assert.equal(metrics.qualified_cpl_micros, 2_400_000_000);
});

test('POST missing event_id returns 400 MISSING_EVENT_ID, {code,message}, no stack', async () => {
  const response = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_name: 'lead_qualified', occurred_at: NOW(), tenant_id: 'tenant_qa' }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'MISSING_EVENT_ID');
  assert.equal(typeof body.message, 'string');
  assert.ok(!('stack' in body));
  assert.ok(!JSON.stringify(body).includes('at '), 'error body must not carry a stack');
});

test('POST non-UTC occurred_at returns 400 NON_UTC_OCCURRED_AT', async () => {
  const response = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_qa_nz', event_name: 'lead_qualified', occurred_at: '2026-09-25T16:00:00+05:30', tenant_id: 'tenant_qa' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'NON_UTC_OCCURRED_AT');
});

test('POST float value returns 400 INVALID_MONEY', async () => {
  const response = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_qa_float', event_name: 'spend.observed', occurred_at: NOW(), tenant_id: 'tenant_qa', value: 7200.5, currency: 'INR' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_MONEY');
});

test('POST unknown event_name returns 400 UNKNOWN_EVENT and a 4xx writes nothing', async () => {
  const response = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_qa_unknown', event_name: 'spend.deleted', occurred_at: NOW(), tenant_id: 'tenant_qa' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'UNKNOWN_EVENT');
  assert.equal(repositories.rawEvents.count('tenant_qa'), 10, 'a 4xx never writes a raw event');
});
