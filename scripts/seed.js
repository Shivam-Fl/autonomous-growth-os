// Seed a demo tenant with sample spend, decision and learning rows, written
// through the repository layer only (never direct SQL). Repeat runs are
// idempotent: fixed ids are deduplicated on (tenant_id, event_id).

import { openDatabase, DEFAULT_DB_PATH } from '../src/data/db.js';
import { createRepositories, replayRawToDerived } from '../src/data/repositories.js';
import { validateEvent } from '../src/domain/events.js';
import { validateLearning } from '../src/memory/learnings.js';

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
    payload: {
      class: 'budget change',
      expected: 'qualified CPL −8%',
      status: 'shadow',
      evidence_refs: ['ev_seed_1'],
      memory_refs: ['lrn_seed_1'],
    },
  },
  {
    event_id: 'evt_seed_decision_2',
    event_type: 'decision.recorded',
    occurred_at: occurredAt(),
    payload: {
      class: 'campaign status',
      expected: 'no change (do-nothing)',
      status: 'do-nothing',
      evidence_refs: ['ev_seed_2'],
      memory_refs: ['lrn_seed_2'],
    },
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

/** The two accepted learnings the knowledge layer serves. Fixed ids make
 * repeat seeding an upsert no-op; fixed timestamps keep repeated runs from
 * bumping the retrieval gate's age clock. */
const SEED_LEARNINGS = [
  {
    id: 'lrn_seed_1',
    claim: 'search-brand qualified CPL tracks 18% below generic-prospecting',
    scope: { tenant: 'tenant_demo' },
    evidenceRefs: ['ev_seed_1'],
    evidenceType: 'observational',
    confidence: 0.72,
    status: 'accepted',
    validFrom: '2026-09-25T00:00:00.000Z',
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:00.000Z',
    staleAfter: '2027-09-25T00:00:00.000Z',
  },
  {
    id: 'lrn_seed_2',
    claim: 'exact-intent queries convert 2.1x above broad-prospecting',
    scope: { tenant: 'tenant_demo' },
    evidenceRefs: ['ev_seed_2'],
    evidenceType: 'external_research',
    confidence: 0.65,
    status: 'accepted',
    validFrom: '2026-09-25T00:00:00.000Z',
    createdAt: '2026-09-25T00:00:00.000Z',
    updatedAt: '2026-09-25T00:00:00.000Z',
    staleAfter: '2027-09-25T00:00:00.000Z',
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

  // Learnings arrive through the learning repository only (never direct SQL),
  // each validated on the way in so a seed bug fails loudly rather than
  // writing a malformed memory.
  let learningsWritten = 0;
  for (const candidate of SEED_LEARNINGS) {
    const validated = validateLearning(candidate);
    if (!validated.ok) {
      throw validated.error;
    }
    const previous = repositories.learnings.get(TENANT.id, candidate.id);
    repositories.learnings.upsert(TENANT.id, validated.learning);
    if (!previous) {
      learningsWritten += 1;
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
    learningsWritten,
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
