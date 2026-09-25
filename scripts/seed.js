// Seed a demo tenant with sample spend, decision and learning rows, written
// through the repository layer only (never direct SQL). Repeat runs are
// idempotent: fixed ids are deduplicated on (tenant_id, event_id).

import { openDatabase, DEFAULT_DB_PATH } from '../src/data/db.js';
import { createRepositories, replayRawToDerived } from '../src/data/repositories.js';
import { validateEvent } from '../src/domain/events.js';

const TENANT = { id: 'tenant_demo', name: 'Demo Tenant', currency: 'INR' };

const OCCURRED = '2026-09-25T08:00:00.000Z';

const EVENTS = [
  {
    event_id: 'evt_seed_spend_c1_1',
    event_type: 'spend.observed',
    payload: { campaign: 'search-brand', amount_micros: 2_500_000_000, currency: 'INR' },
  },
  {
    event_id: 'evt_seed_spend_c1_2',
    event_type: 'spend.observed',
    payload: { campaign: 'search-brand', amount_micros: 1_500_000_000, currency: 'INR' },
  },
  {
    event_id: 'evt_seed_spend_c2_1',
    event_type: 'spend.observed',
    payload: { campaign: 'generic-prospecting', amount_micros: 3_200_000_000, currency: 'INR' },
  },
  {
    event_id: 'evt_seed_qualified_1',
    event_type: 'lead.qualified',
    payload: { campaign: 'search-brand', lead_id: 'lead_seed_1' },
  },
  {
    event_id: 'evt_seed_qualified_2',
    event_type: 'lead.qualified',
    payload: { campaign: 'search-brand', lead_id: 'lead_seed_2' },
  },
  {
    event_id: 'evt_seed_decision_1',
    event_type: 'decision.recorded',
    payload: { class: 'budget change', expected: 'qualified CPL −8%', status: 'shadow' },
  },
  {
    event_id: 'evt_seed_decision_2',
    event_type: 'decision.recorded',
    payload: { class: 'campaign status', expected: 'no change (do-nothing)', status: 'do-nothing' },
  },
  {
    event_id: 'evt_seed_learning_1',
    event_type: 'learning.recorded',
    payload: {
      claim: 'search-brand qualified CPL tracks 18% below generic-prospecting',
      scope: 'campaign-level', evidence: 'raw_events spend + qualified leads',
    },
  },
];

export function seed({ dbPath = process.env.DB_PATH || DEFAULT_DB_PATH } = {}) {
  const db = openDatabase(dbPath);
  const repositories = createRepositories(db);

  const tenant = repositories.tenants.create(TENANT);
  let appended = 0;
  for (const partial of EVENTS) {
    const envelope = validateEvent({
      ...partial,
      occurred_at: OCCURRED,
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
