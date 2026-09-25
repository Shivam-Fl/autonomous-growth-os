import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFunnel,
  coverageOf,
  dataThrough,
  isStale,
  linkJourney,
  maturityFor,
  normaliseGrowthEvent,
  policyBand,
  staleAgeHours,
} from '../../src/domain/measurement.js';
import { validateEvent } from '../../src/domain/events.js';

const SIX_HOURS_AGO = () => new Date(Date.now() - 6 * 3_600_000).toISOString();

/** The canonical 10-event click-to-revenue journey: one spend of INR 7200 and
 * three qualified leads out of three created, so tenant spend / volume must
 * resolve to 7_200_000_000 / 3 = 2_400_000_000 micros exactly. */
function journeyRows({ tenantId = 'tenant_demo', occurredAt = SIX_HOURS_AGO(), suffix = '' } = {}) {
  const ids = ['j1', 'j2', 'j3'];
  return [
    { event_id: `evt${suffix}_click_1`, event_type: 'click', occurred_at: occurredAt, payload: { campaign: 'search-brand' } },
    { event_id: `evt${suffix}_spend_1`, event_type: 'spend.observed', occurred_at: occurredAt, payload: { campaign: 'search-brand', amount_micros: 7_200_000_000, currency: 'INR' } },
    ...ids.map((id, index) => ({
      event_id: `evt${suffix}_lead_created_${index + 1}`,
      event_type: 'lead_created',
      occurred_at: occurredAt,
      payload: { campaign: 'search-brand', lead_id: `lead_${id}` },
    })),
    ...ids.map((id, index) => ({
      event_id: `evt${suffix}_lead_qualified_${index + 1}`,
      event_type: 'lead_qualified',
      occurred_at: occurredAt,
      payload: { campaign: 'search-brand', lead_id: `lead_${id}`, session_id: 'sess_journey_1' },
    })),
    { event_id: `evt${suffix}_opp_1`, event_type: 'opportunity_created', occurred_at: occurredAt, payload: { opportunity_id: 'opp_1', lead_id: 'lead_j1' } },
    { event_id: `evt${suffix}_deal_1`, event_type: 'deal_won', occurred_at: occurredAt, payload: { order_id: 'order_1', opportunity_id: 'opp_1' } },
  ];
}

test('tenant-wide funnel over the canonical journey resolves to qualified CPL 2400000000 exactly', () => {
  const funnel = computeFunnel(journeyRows());
  assert.equal(funnel.spend_micros, 7_200_000_000);
  assert.equal(funnel.qualified_volume, 3);
  assert.equal(funnel.qualified_cpl_micros, 2_400_000_000);
});

test('legacy dot-spelled lead.qualified rows are excluded from qualified volume', () => {
  const rows = [
    ...journeyRows(),
    { event_id: 'evt_legacy_q1', event_type: 'lead.qualified', occurred_at: '2026-09-25T08:00:00.000Z', payload: { lead_id: 'lead_legacy_1' } },
    { event_id: 'evt_legacy_q2', event_type: 'lead.qualified', occurred_at: '2026-09-25T08:00:00.000Z', payload: { lead_id: 'lead_legacy_2' } },
  ];
  const funnel = computeFunnel(rows);
  assert.equal(funnel.qualified_volume, 3);
  assert.equal(funnel.qualified_cpl_micros, 2_400_000_000);
});

test('volume-zero returns a null CPL instead of dividing by zero', () => {
  const funnel = computeFunnel([
    { event_id: 'evt_spend', event_type: 'spend.observed', occurred_at: '2026-09-25T08:00:00.000Z', payload: { amount_micros: 5_000_000, currency: 'INR' } },
  ]);
  assert.equal(funnel.spend_micros, 5_000_000);
  assert.equal(funnel.qualified_volume, 0);
  assert.equal(funnel.qualified_cpl_micros, null);
});

test('a duplicate event_id inside a batch counts once', () => {
  const rows = journeyRows();
  const funnel = computeFunnel([...rows, ...rows]);
  assert.equal(funnel.qualified_volume, 3);
  assert.equal(funnel.spend_micros, 7_200_000_000);
  assert.equal(funnel.qualified_cpl_micros, 2_400_000_000);
});

test('the same event_id on two tenants are distinct events, not duplicates', () => {
  // Tenant isolation holds for the funnel key too.
  const demo = journeyRows({ tenantId: 'tenant_demo' });
  const other = journeyRows({ tenantId: 'tenant_other', occurredAt: '2026-09-25T08:00:00.000Z', suffix: '_x' });
  const funnel = computeFunnel([...demo, ...other]);
  assert.equal(funnel.qualified_volume, 6);
});

test('policy bands map 0.2/0.5/0.8/0.95 and strategic gating holds below 0.90', () => {
  assert.deepEqual(policyBand(0.2), { label: 'emergency-only', gated: true });
  assert.deepEqual(policyBand(0.5), { label: 'protective', gated: true });
  assert.deepEqual(policyBand(0.8), { label: 'moderate', gated: true });
  assert.deepEqual(policyBand(0.95), { label: 'strategic', gated: false });
  // Exactly at the band edge strategic actions are no longer gated.
  assert.deepEqual(policyBand(0.9), { label: 'strategic', gated: false });
});

test('maturityFor hits the piecewise anchors (0,0.5 at 48h, 1 at 120h)', () => {
  assert.equal(maturityFor(0), 0);
  assert.equal(maturityFor(48), 0.5);
  assert.equal(maturityFor(120), 1);
  assert.equal(maturityFor(200), 1, 'clamped at 1');
});

test('six-hour-old data is gated at maturity about 0.06 (p50 48h / p90 120h)', () => {
  const maturity = maturityFor(6);
  assert.ok(Math.abs(maturity - 0.0625) < 1e-9, `6h must give 0.0625, got ${maturity}`);
  assert.equal(policyBand(maturity).gated, true);
});

test('a cheap low-quality campaign never outranks an expensive high-quality one', () => {
  // Cheap campaign: tiny spend, zero qualified leads — its CPL is undefined,
  // and under the tenant-wide rule its spend can only raise the tenant's CPL.
  const cheap = [{ event_id: 'evt_cheap_1', event_type: 'spend.observed', occurred_at: '2026-09-25T08:00:00.000Z', payload: { campaign: 'cheap-garbage', amount_micros: 60_000_000, currency: 'INR' } }];
  const highQuality = journeyRows();
  const cheapFunnel = computeFunnel(cheap);
  assert.equal(cheapFunnel.qualified_cpl_micros, null, 'no qualified volume, no CPL');
  const both = computeFunnel([...cheap, ...highQuality]);
  assert.equal(cheapFunnel.qualified_volume, 0);
  // Tenant-wide: mixed CPL (7 260 000 000 / 3 = 2 420 000 000) is WORSE than
  // the high-quality campaign alone, so a cheap zero-quality campaign can
  // never drag the tenant's qualified CPL below the proven one.
  assert.equal(cheapFunnel.spend_micros, 60_000_000);
  assert.equal(both.qualified_cpl_micros, 2_420_000_000);
  assert.ok(both.qualified_cpl_micros > 2_400_000_000);
});

test('stale detection flags data-through older than 24h with age copy', () => {
  const now = '2026-09-25T12:00:00.000Z';
  const old = '2026-09-24T10:00:00.000Z'; // 26h old
  const fresh = '2026-09-25T09:00:00.000Z'; // 3h old
  assert.equal(isStale(now, old), true);
  assert.equal(isStale(now, fresh), false);
  assert.equal(isStale(now, null), false, 'no data is not stale');
  assert.equal(staleAgeHours(now, old), 26);
  assert.equal(staleAgeHours(now, fresh), 3);
});

test('coverageOf is the share of qualified rows carrying a session or user reference', () => {
  const attached = journeyRows(); // all three qualified rows carry session_id
  assert.equal(coverageOf(attached), 1);
  // Drop the reference off the middle qualified row: 2 of 3 remain attached.
  const unattachedRows = journeyRows().slice(5, 8).map((row, index) => (
    index === 1 ? { ...row, payload: { campaign: 'search-brand', lead_id: row.payload.lead_id } } : row
  ));
  assert.equal(coverageOf(unattachedRows), 2 / 3);
  const spendOnly = [{ event_id: 'evt_spend_2', event_type: 'spend.observed', occurred_at: '2026-09-25T08:00:00.000Z', payload: { amount_micros: 1 } }];
  assert.equal(coverageOf(spendOnly), 0, 'no qualified rows means zero coverage');
});

test('dataThrough is the max occurred_at or null', () => {
  assert.equal(dataThrough([]), null);
  assert.equal(
    dataThrough([
      { event_id: 'evt_a', event_type: 'click', occurred_at: '2026-09-25T08:00:00.000Z' },
      { event_id: 'evt_b', event_type: 'click', occurred_at: '2026-09-25T10:00:00.000Z' },
    ]),
    '2026-09-25T10:00:00.000Z',
  );
});

test('journey linker drops raw email/phone PII and groups only on reference ids', () => {
  const rows = [
    {
      event_id: 'evt_click_1', event_type: 'click', occurred_at: '2026-09-25T08:00:00.000Z',
      payload: { email: 'a@b.example', phone: '+91 90000 00000', session_id: 'sess_9' },
    },
    {
      event_id: 'evt_lead_1', event_type: 'lead_created', occurred_at: '2026-09-25T08:05:00.000Z',
      payload: { email: 'c@d.example', session_id: 'sess_9', lead_id: 'lead_1' },
    },
    {
      event_id: 'evt_lead_2', event_type: 'lead_created', occurred_at: '2026-09-25T09:00:00.000Z',
      payload: { user_id: 'user_1', lead_id: 'lead_2' },
    },
  ];
  const journeys = linkJourney(rows);
  assert.equal(journeys.length, 2, 'grouped by session_id then user_id only');
  const grouped = journeys.find((journey) => journey.session_id === 'sess_9');
  assert.equal(grouped.user_id, null);
  assert.equal(grouped.order_id, null);
  assert.equal(grouped.events.length, 2);
  for (const journey of journeys) {
    for (const event of journey.events) {
      assert.equal('email' in event.payload, false, 'raw email never survives the link');
      assert.equal('phone' in event.payload, false, 'raw phone never survives the link');
    }
  }
});

test('normaliseGrowthEvent maps the growth shape onto a valid envelope', () => {
  const result = normaliseGrowthEvent({
    event_id: 'evt_qa_1',
    event_name: 'spend.observed',
    occurred_at: '2026-09-25T10:30:00.000Z',
    tenant_id: 'tenant_qa',
    value: 7_200_000_000,
    currency: 'INR',
    session_id: 'sess_1',
  }, 'tenant_qa');
  assert.equal(result.ok, true);
  const validated = validateEvent(result.event);
  assert.equal(validated.ok, true);
  assert.equal(result.event.event_type, 'spend.observed');
  assert.equal(result.event.tenant_id, 'tenant_qa');
  assert.equal(result.event.payload.amount_micros, 7_200_000_000);
  assert.equal(result.event.payload.currency, 'INR');
  assert.equal(result.event.payload.session_id, 'sess_1');
});

test('normaliseGrowthEvent rejects unknown names, non-UTC stamps, float money and missing references', () => {
  const base = {
    event_id: 'evt_qa_2',
    event_name: 'lead_qualified',
    occurred_at: '2026-09-25T10:30:00.000Z',
  };
  const cases = [
    [{ ...base, event_name: 'nonsense' }, 'UNKNOWN_EVENT'],
    [{ ...base, event_name: undefined }, 'MISSING_EVENT_NAME'],
    [{ ...base, event_id: undefined }, 'MISSING_EVENT_ID'],
    [{ ...base, occurred_at: undefined }, 'MISSING_OCCURRED_AT'],
    [{ ...base, occurred_at: 'yesterday' }, 'BAD_OCCURRED_AT'],
    [{ ...base, occurred_at: '2026-09-25T16:00:00+05:30' }, 'NON_UTC_OCCURRED_AT'],
    [{ ...base, value: 1.5, currency: 'INR' }, 'INVALID_MONEY'],
    [{ ...base, value: '7200', currency: 'INR' }, 'INVALID_MONEY'],
    [{ ...base, value: 7_200_000_000 }, 'INVALID_CURRENCY'],
  ];
  for (const [body, code] of cases) {
    const result = normaliseGrowthEvent(body, 'tenant_qa');
    assert.equal(result.ok, false, `${code} expected`);
    assert.equal(result.error.code, code);
  }
});

test('normaliseGrowthEvent drops email and phone even when sent inside payload', () => {
  const result = normaliseGrowthEvent({
    event_id: 'evt_qa_3',
    event_name: 'lead_qualified',
    occurred_at: '2026-09-25T10:30:00.000Z',
    payload: { email: 'p@q.example', phone: '+91', lead_id: 'lead_9' },
  }, 'tenant_qa');
  assert.equal(result.ok, true);
  assert.equal('email' in result.event.payload, false);
  assert.equal('phone' in result.event.payload, false);
  assert.equal(result.event.payload.lead_id, 'lead_9');
});
