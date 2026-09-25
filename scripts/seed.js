// Seed a demo tenant with sample spend, decision and learning rows, written
// through the repository layer only (never direct SQL). Repeat runs are
// idempotent: fixed ids are deduplicated on (tenant_id, event_id).

import { openDatabase, DEFAULT_DB_PATH } from '../src/data/db.js';
import { createRepositories, replayRawToDerived } from '../src/data/repositories.js';
import { validateEvent } from '../src/domain/events.js';

const TENANT = { id: 'tenant_demo', name: 'Demo Tenant', currency: 'INR' };

const JOURNEY = [
  {
    event_id: 'evt_seed_journey_click_1',
    event_type: 'click',
    payload: { campaign: 'search-brand' },
  },
  {
    event_id: 'evt_seed_journey_spend_1',
    event_type: 'spend.observed',
    payload: { campaign: 'search-brand', amount_micros: 7_200_000_000, currency: 'INR' },
  },
  {
    event_id: 'evt_seed_journey_lead_created_1',
    event_type: 'lead_created',
    payload: { campaign: 'search-brand', lead_id: 'lead_seed_j1' },
  },
  {
    event_id: 'evt_seed_journey_lead_created_2',
    event_type: 'lead_created',
    payload: { campaign: 'search-brand', lead_id: 'lead_seed_j2' },
  },
  {
    event_id: 'evt_seed_journey_lead_created_3',
    event_type: 'lead_created',
    payload: { campaign: 'search-brand', lead_id: 'lead_seed_j3' },
  },
  {
    event_id: 'evt_seed_journey_lead_qualified_1',
    event_type: 'lead_qualified',
    payload: { campaign: 'search-brand', lead_id: 'lead_seed_j1', session_id: 'sess_seed_journey_1' },
  },
  {
    event_id: 'evt_seed_journey_lead_qualified_2',
    event_type: 'lead_qualified',
    payload: { campaign: 'search-brand', lead_id: 'lead_seed_j2', session_id: 'sess_seed_journey_1' },
  },
  {
    event_id: 'evt_seed_journey_lead_qualified_3',
    event_type: 'lead_qualified',
    payload: { campaign: 'search-brand', lead_id: 'lead_seed_j3', session_id: 'sess_seed_journey_1' },
  },
  {
    event_id: 'evt_seed_journey_opp_1',
    event_type: 'opportunity_created',
    payload: { campaign: 'search-brand', opportunity_id: 'opp_seed_1', lead_id: 'lead_seed_j1' },
  },
  {
    event_id: 'evt_seed_journey_deal_1',
    event_type: 'deal_won',
    payload: { campaign: 'search-brand', order_id: 'order_seed_1', opportunity_id: 'opp_seed_1' },
  },
];

const DECISIONS = [
  {
    event_id: 'evt_seed_decision_1',
    event_type: 'decision.recorded',
    occurred_at: occurredAt(),
    payload: { class: 'budget change', expected: 'qualified CPL −8%', status: 'shadow' },
  },
  {
    event_id: 'evt_seed_decision_2',
    event_type: 'decision.recorded',
    occurred_at: occurredAt(),
    payload: { class: 'campaign status', expected: 'no change (do-nothing)', status: 'do-nothing' },
  },
  {
    event_id: 'evt_seed_learning_1',
    event_type: 'learning.recorded',
    occurred_at: occurredAt(),
    payload: {
      claim: 'search-brand qualified CPL tracks 18% below generic-prospecting',
      scope: 'campaign-level', evidence: 'raw_events spend + qualified leads',
    },
  },
];

/** Occurred_at is derived at seed time: six hours ago keeps the demo inside
 * the lag window (maturity ~0.06, so strategic actions gate). */
function occurredAt() {
  return new Date(Date.now() - 6 * 3_600_000).toISOString();
}

const EVENTS = [
  ...JOURNEY.map((event) => ({
    ...event,
    occurred_at: occurredAt(),
    payload: { ...event.payload, session_id: 'sess_seed_journey_1' },
  })),
  ...DECISIONS,
];

export function seed({ dbPath = process.env.DB_PATH || DEFAULT_DB_PATH } = {}) {
  const db = openDatabase(dbPath);
  const repositories = createRepositories(db);

  const tenant = repositories.tenants.create(TENANT);
  let appended = 0;
  for (const partial of EVENTS) {
    const envelope = validateEvent({
      ...partial,
      tenant_id: TENANT.id,
      schema_version: '1',
    });
    if (!envelope.ok) {
      throw envelope.error;
    }
    if (repositories.rawEvents.append(envelope.event).appended) {
      appended += 1;
    }
  }

  if (appended > 0) {
    repositories.auditEvents.append({
      tenant_id: TENANT.id,
      actor: 'seed',
      action: 'seed.run',
      subject: TENANT.id,
      capability_id: null,
      details: { events: appended },
      occurred_at: new Date().toISOString(),
    });
  }

  replayRawToDerived(db, TENANT.id);

  return {
    tenant: repositories.tenants.get(TENANT.id),
    appended,
    alreadySeeded: appended === 0,
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const result = seed();
  console.log(
    result.alreadySeeded
      ? `seed: tenant ${TENANT.id} already present, nothing new written`
      : `seed: wrote ${result.appended} events for tenant ${TENANT.id}`,
  );
}
