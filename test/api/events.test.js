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
import { validateEvent } from '../../src/domain/events.js';
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

// Money integrity (QA BUG-1): non-positive spend is rejected at the boundary
// with a stable code, before tenant auto-creation, so nothing is written.
test('POST negative spend.observed returns 400 NON_POSITIVE_SPEND and creates no tenant row', async () => {
  const response = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_neg_spend', event_name: 'spend.observed', occurred_at: NOW(), tenant_id: 'tenant_neg', value: -100_000_000, currency: 'INR' }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'NON_POSITIVE_SPEND');
  assert.equal(typeof body.message, 'string');
  assert.ok(!('stack' in body));
  assert.equal(repositories.tenants.get('tenant_neg'), null, 'a rejected spend never creates the tenant row');
  assert.equal(repositories.rawEvents.count('tenant_neg'), 0);
});

test('POST zero spend.observed returns 400 NON_POSITIVE_SPEND', async () => {
  const response = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_zero_spend', event_name: 'spend.observed', occurred_at: NOW(), tenant_id: 'tenant_neg', value: 0, currency: 'INR' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'NON_POSITIVE_SPEND');
  assert.equal(repositories.rawEvents.count('tenant_neg'), 0);
});

test('rejected spend leaves the tenant with no money on the books: CPL null, spend 0', async () => {
  // Only a lead_qualified ever ingested for tenant_neg: spend must read as 0
  // (never negative) and the CPL as null, not an inverted number.
  const qualified = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_neg_qual', event_name: 'lead_qualified', occurred_at: NOW(), tenant_id: 'tenant_neg', lead_id: 'lead_neg', session_id: 'sess_neg' }),
  });
  assert.equal(qualified.status, 202);
  const metrics = await (await fetch(url('/v1/metrics?tenant_id=tenant_neg'))).json();
  assert.equal(metrics.spend_micros, 0);
  assert.equal(metrics.qualified_volume, 1);
  assert.equal(metrics.qualified_cpl_micros, null);
});

// Money integrity (QA BUG-2): one unit of account per tenant.
test('POST foreign-currency spend to an existing tenant returns 400 CURRENCY_MISMATCH with unchanged metrics', async () => {
  const before = await (await fetch(url('/v1/metrics?tenant_id=tenant_qa'))).json();
  const response = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_usd_spend', event_name: 'spend.observed', occurred_at: NOW(), tenant_id: 'tenant_qa', value: 1_000_000_000, currency: 'USD' }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'CURRENCY_MISMATCH');
  assert.equal(repositories.rawEvents.count('tenant_qa'), 10, 'a rejected spend writes no raw event');
  const after = await (await fetch(url('/v1/metrics?tenant_id=tenant_qa'))).json();
  assert.equal(after.spend_micros, before.spend_micros, 'tenant spend never moves on a rejected currency');
  assert.equal(after.qualified_cpl_micros, before.qualified_cpl_micros);
});

test('a USD-first journey auto-creates the tenant in USD and resolves CPL in USD', async () => {
  const occurredAt = NOW();
  const bodies = [
    { event_id: 'evt_usd_j_spend', event_name: 'spend.observed', occurred_at: occurredAt, value: 9_000_000_000, currency: 'USD', session_id: 'sess_usd_j' },
    { event_id: 'evt_usd_j_created', event_name: 'lead_created', occurred_at: occurredAt, lead_id: 'lead_usd', session_id: 'sess_usd_j' },
    { event_id: 'evt_usd_j_qualified', event_name: 'lead_qualified', occurred_at: occurredAt, lead_id: 'lead_usd', session_id: 'sess_usd_j' },
  ];
  for (const body of bodies) {
    const response = await fetch(url('/v1/events'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, tenant_id: 'tenant_usd' }),
    });
    assert.equal(response.status, 202, `${body.event_id} must ingest`);
  }
  assert.equal(repositories.tenants.get('tenant_usd').currency, 'USD', 'the first spend seeds the tenant currency');
  const metrics = await (await fetch(url('/v1/metrics?tenant_id=tenant_usd'))).json();
  assert.equal(metrics.spend_micros, 9_000_000_000);
  assert.equal(metrics.qualified_volume, 1);
  assert.equal(metrics.qualified_cpl_micros, 9_000_000_000);
});

test('a tenant first created by a non-spend event keeps the INR default and a later foreign spend is a 400', async () => {
  const created = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_inr_default_created', event_name: 'lead_created', occurred_at: NOW(), tenant_id: 'tenant_inr_default', lead_id: 'lead_default' }),
  });
  assert.equal(created.status, 202);
  assert.equal(repositories.tenants.get('tenant_inr_default').currency, 'INR');
  const spend = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_inr_default_spend', event_name: 'spend.observed', occurred_at: NOW(), tenant_id: 'tenant_inr_default', value: 1, currency: 'USD' }),
  });
  assert.equal(spend.status, 400);
  assert.equal((await spend.json()).code, 'CURRENCY_MISMATCH');
});

// A stored currency code is an arbitrary string: the QA repro sets the column
// with a raw SQL UPDATE, which never reaches tenants.create, so 'usd' and
// ' USD ' reach these two routes as tenant rows. Both name the same unit of
// account as 'USD', and the comparison the routes used was exact string
// equality — so a legitimate USD spend was 400ed against the tenant's own
// currency, and metrics dropped that spend from the sum and reported a null
// CPL. The two genuine-mismatch guards below are what keeps the relaxation
// honest in both directions and keeps the reported string uncorrupted.
test('a tenant row stored as usd accepts a USD spend instead of rejecting its own unit', async () => {
  repositories.tenants.create({ id: 'tenant_casing_usd', name: 'Casing Tenant', currency: 'usd' });
  const response = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_casing_usd_spend', event_name: 'spend.observed', occurred_at: NOW(), tenant_id: 'tenant_casing_usd', value: 1_000_000_000, currency: 'USD' }),
  });
  const body = await response.json();
  assert.equal(response.status, 202, `a usd tenant must accept its own unit, got ${JSON.stringify(body)}`);
  assert.equal(body.appended, true);
  assert.equal(body.duplicate, false);
  // Read-side only: the row stays as it was found, so the next reader of the
  // table sees the real stored value rather than a silently repaired one.
  assert.equal(repositories.tenants.get('tenant_casing_usd').currency, 'usd', 'the stored row is not rewritten');
});

test('a tenant row stored as a padded USD accepts a USD spend too', async () => {
  repositories.tenants.create({ id: 'tenant_casing_padded', name: 'Padded Tenant', currency: ' USD ' });
  const response = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_casing_padded_spend', event_name: 'spend.observed', occurred_at: NOW(), tenant_id: 'tenant_casing_padded', value: 1_000_000_000, currency: 'USD' }),
  });
  const body = await response.json();
  assert.equal(response.status, 202, `a padded code names the same unit, got ${JSON.stringify(body)}`);
  assert.equal(body.appended, true);
});

test('GET /v1/metrics counts a usd tenant\'s own USD spend and resolves a CPL from it', async () => {
  repositories.tenants.create({ id: 'tenant_metrics_usd', name: 'Metrics Tenant', currency: 'usd' });
  for (const event of [
    { event_id: 'evt_metrics_usd_spend', event_name: 'spend.observed', occurred_at: NOW(), value: 2_000_000_000, currency: 'USD' },
    { event_id: 'evt_metrics_usd_qualified', event_name: 'lead_qualified', occurred_at: NOW(), lead_id: 'lead_metrics_usd', session_id: 'sess_metrics_usd' },
  ]) {
    const response = await fetch(url('/v1/events'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...event, tenant_id: 'tenant_metrics_usd' }),
    });
    assert.equal(response.status, 202, `${event.event_id} must ingest`);
  }
  const metrics = await (await fetch(url('/v1/metrics?tenant_id=tenant_metrics_usd'))).json();
  assert.equal(metrics.spend_micros, 2_000_000_000, "the tenant's own spend is no longer read as foreign");
  assert.equal(metrics.qualified_volume, 1);
  assert.equal(metrics.qualified_cpl_micros, 2_000_000_000, 'a CPL, not the null the exclusion produced');
});

test('an unrecognised tenant currency is still a 400 reporting the stored code verbatim', async () => {
  // Canonicalising the comparison must not reach the message or the details:
  // a row naming no ISO currency is still bad data, and an operator reading
  // this 400 needs the code that is actually in the table.
  repositories.tenants.create({ id: 'tenant_odd_code', name: 'Odd Tenant', currency: 'ZZZ' });
  const response = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_odd_spend', event_name: 'spend.observed', occurred_at: NOW(), tenant_id: 'tenant_odd_code', value: 1_000_000_000, currency: 'USD' }),
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.code, 'CURRENCY_MISMATCH');
  assert.equal(body.message, 'tenant tenant_odd_code keeps ZZZ; spend in USD was rejected');
  assert.deepEqual(body.details, { tenant_currency: 'ZZZ', received: 'USD' });
});

test('an unrecognised tenant currency is not silently treated as INR on ingest', async () => {
  // The other direction of the same case, and the one that was untested. The
  // suite pinned ZZZ against USD but never ZZZ against INR, so nothing stopped
  // a read-side INR fallback from reaching the write path: there, 'ZZZ' was
  // compared as if it were INR and this spend was accepted with 202. A 400
  // naming the stored code is the only signal an operator gets that the row is
  // wrong, so an unknown code must never match a validated spend currency.
  repositories.tenants.create({ id: 'tenant_odd_inr', name: 'Odd Tenant', currency: 'ZZZ' });
  const response = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_odd_inr_spend', event_name: 'spend.observed', occurred_at: NOW(), tenant_id: 'tenant_odd_inr', value: 1_000_000_000, currency: 'INR' }),
  });
  const body = await response.json();
  assert.equal(response.status, 400, `a ZZZ tenant must not accept INR spend, got ${JSON.stringify(body)}`);
  assert.equal(body.code, 'CURRENCY_MISMATCH');
  assert.equal(body.message, 'tenant tenant_odd_inr keeps ZZZ; spend in INR was rejected');
  assert.deepEqual(body.details, { tenant_currency: 'ZZZ', received: 'INR' });
  // A rejected spend writes nothing: the 4xx is a real rejection, not a
  // response code over an event that was still appended.
  assert.equal(repositories.rawEvents.count('tenant_odd_inr'), 0, 'a rejected spend appends no raw event');
});

test('a canonical tenant still rejects a genuinely different currency', async () => {
  // The guard in the other direction: canonicalising the tenant side must not
  // loosen a real mismatch, which is what keeps mixed-currency micros from
  // summing into a CPL denominated in no real currency.
  repositories.tenants.create({ id: 'tenant_mismatch', name: 'Mismatch Tenant', currency: 'USD' });
  const response = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_mismatch_eur', event_name: 'spend.observed', occurred_at: NOW(), tenant_id: 'tenant_mismatch', value: 1_000_000_000, currency: 'EUR' }),
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.code, 'CURRENCY_MISMATCH');
  assert.deepEqual(body.details, { tenant_currency: 'USD', received: 'EUR' });
});

/** A validated envelope for a named tenant, for the fixtures that have to put
 * rows into the table ingest itself refuses to write. The assertion names the
 * event that broke, so a malformed fixture never surfaces as a read bug. */
function validatedEnvelope(tenantId, event_id, event_type, payload) {
  const validated = validateEvent({
    event_id, event_type, tenant_id: tenantId, schema_version: '1', occurred_at: NOW(), payload,
  });
  assert.equal(validated.ok, true, `fixture: ${event_id} must validate`);
  return validated.event;
}

/** The journey behind a bad-code row: one INR spend of 7_200_000_000 and three
 * qualified leads. Straight through the repository, because ingest refuses to
 * write either row against a tenant whose stored code names no currency — which
 * is exactly the state under test, and the same route a pre-fix legacy batch
 * took. */
function appendBadCodeJourney(tenantId, prefix) {
  const rows = [
    validatedEnvelope(tenantId, `${prefix}_spend`, 'spend.observed', { campaign: 'legacy', amount_micros: 7_200_000_000, currency: 'INR' }),
    ...[1, 2, 3].map((n) => validatedEnvelope(tenantId, `${prefix}_qualified_${n}`, 'lead_qualified', { campaign: 'legacy', lead_id: `lead_${prefix}_${n}`, session_id: `sess_${prefix}` })),
  ];
  for (const event of rows) {
    assert.equal(repositories.rawEvents.append(event).appended, true, `fixture: ${event.event_id} must append`);
  }
}

// The read side of the unit-of-account rule, which #63 left guessing INR. A
// stored code that names no currency matches no stored spend row, so the
// funnel excludes it — the same answer the write path has always given by
// 400ing a spend against that row. Reading 7_200_000_000 rupees for a tenant
// the API refuses to add a rupee to was the disagreement these close.
test('a tenant row naming no currency reads no spend and a null CPL, and keeps its volume', async () => {
  repositories.tenants.create({ id: 'tenant_read_zzz', name: 'Bad Code Tenant', currency: 'ZZZ' });
  appendBadCodeJourney('tenant_read_zzz', 'evt_read_zzz');
  const metrics = await (await fetch(url('/v1/metrics?tenant_id=tenant_read_zzz'))).json();
  assert.equal(metrics.spend_micros, 0, 'a code naming no currency excludes the INR row');
  assert.equal(metrics.qualified_cpl_micros, null, 'and never a zero CPL over no spend');
  // The volume is deliberately not currency-filtered (computeFunnel filters
  // spend rows only), so a qualified lead survives a currency its spend side
  // cannot name. Suppressing it here would be a second, separate bug.
  assert.equal(metrics.qualified_volume, 3, 'a volume is not currency-filtered and must not become so');
});

test('an empty stored currency excludes like a bad code instead of reading as INR', async () => {
  // The `??`-not-`||` case. tenants.currency is TEXT NOT NULL, so '' is a
  // PRESENT row holding a string — a falsy one. A `||` chain would resolve it
  // to INR and the read would report rupees for the row the write path
  // rejects below, which is the exact collapse this seam exists to prevent.
  repositories.tenants.create({ id: 'tenant_read_blank', name: 'Blank Tenant', currency: '' });
  appendBadCodeJourney('tenant_read_blank', 'evt_read_blank');
  const metrics = await (await fetch(url('/v1/metrics?tenant_id=tenant_read_blank'))).json();
  assert.equal(metrics.spend_micros, 0, 'an empty code names no currency, so it excludes');
  assert.equal(metrics.qualified_cpl_micros, null);
  assert.equal(metrics.qualified_volume, 3);
  // ...and the write side still names the stored value verbatim, so the two
  // surfaces agree about this row rather than one of them guessing.
  const spend = await fetch(url('/v1/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event_id: 'evt_read_blank_spend', event_name: 'spend.observed', occurred_at: NOW(), tenant_id: 'tenant_read_blank', value: 1_000_000_000, currency: 'INR' }),
  });
  const body = await spend.json();
  assert.equal(spend.status, 400);
  assert.equal(body.code, 'CURRENCY_MISMATCH');
  assert.deepEqual(body.details, { tenant_currency: '', received: 'INR' });
});

test('a canonical stored currency still counts its own spend, so this is not a read that refuses everything', async () => {
  // The other arm of the new chain. Without it the change could be passed by
  // a resolveTenantCurrency that returned null for every code, healthy ones
  // included, and this is what says it does not.
  repositories.tenants.create({ id: 'tenant_read_usd', name: 'USD Tenant', currency: 'USD' });
  for (const event of [
    { event_id: 'evt_read_usd_spend', event_name: 'spend.observed', occurred_at: NOW(), value: 2_000_000_000, currency: 'USD' },
    { event_id: 'evt_read_usd_qualified', event_name: 'lead_qualified', occurred_at: NOW(), lead_id: 'lead_read_usd', session_id: 'sess_read_usd' },
  ]) {
    const response = await fetch(url('/v1/events'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...event, tenant_id: 'tenant_read_usd' }),
    });
    assert.equal(response.status, 202, `${event.event_id} must ingest`);
  }
  const metrics = await (await fetch(url('/v1/metrics?tenant_id=tenant_read_usd'))).json();
  assert.equal(metrics.spend_micros, 2_000_000_000, "the tenant's own spend still counts");
  assert.equal(metrics.qualified_cpl_micros, 2_000_000_000, 'a CPL, not the null the exclusion produces');
});

test('a tenant with no row at all still answers, and still excludes foreign spend', async () => {
  // The INR fallback the chain keeps is narrowed to a MISSING row, and it has
  // to stay: computeFunnel skips currency filtering entirely when it is handed
  // undefined (measurement.js), so a legacy batch belonging to a tenant whose
  // row is gone would otherwise sum back in as if it were local spend. The
  // rows below are exactly that shape — appended for a tenant_id no row names.
  for (const event of [
    validatedEnvelope('tenant_row_gone', 'evt_row_gone_spend', 'spend.observed', { campaign: 'legacy', amount_micros: 2_000_000_000, currency: 'USD' }),
    validatedEnvelope('tenant_row_gone', 'evt_row_gone_qualified', 'lead_qualified', { campaign: 'legacy', lead_id: 'lead_row_gone', session_id: 'sess_row_gone' }),
  ]) {
    assert.equal(repositories.rawEvents.append(event).appended, true, `fixture: ${event.event_id} must append`);
  }
  assert.equal(repositories.tenants.get('tenant_row_gone'), null, 'fixture: this tenant really has no row');
  const response = await fetch(url('/v1/metrics?tenant_id=tenant_row_gone'));
  assert.equal(response.status, 200, 'a read must answer for an unknown tenant rather than 500');
  const metrics = await response.json();
  assert.equal(metrics.spend_micros, 0, 'the missing-row fallback still excludes the USD row');
  assert.equal(metrics.qualified_cpl_micros, null);
});
