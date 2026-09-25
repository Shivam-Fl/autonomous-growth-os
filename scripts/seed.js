// Seed a demo tenant with sample spend, decision and learning rows, written
// through the repository layer only (never direct SQL). Repeat runs are
// idempotent: fixed ids are deduplicated on (tenant_id, event_id).

import { openDatabase, DEFAULT_DB_PATH } from '../src/data/db.js';
import { createRepositories, replayRawToDerived } from '../src/data/repositories.js';
import { validateEvent } from '../src/domain/events.js';
import { validateDecisionRecord } from '../src/domain/decisions.js';
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

// Decision-journal fixtures (TR-6, TR-15): one immutable state snapshot then
// three decisions written through the new repositories with fixed ids, so
// re-seeding is idempotent. The two matured ones carry outcomes; the recent
// one does not. Live calibration totals this produces, pinned by tests and
// read back on /journal: evaluated=2, correct=2 (precision 1.00);
// interventions=1, needless=0 (false-intervention 0.00); awaiting=1.
const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();

const SEED_SNAPSHOT = {
  snapshot_id: 'state_seed_1',
  kpis: {
    qualified_cpl_micros: 2_400_000_000,
    spend_micros: 7_200_000_000,
    qualified_volume: 3,
    maturity: 0.06,
  },
  budgets: [{ ad_set_id: 'adset_001', daily_budget_micros: 500_000_000 }],
  funnel: { leads_created: 3, leads_qualified: 3, deals_won: 1 },
  health: { tracking: 'healthy', provider: 'ok' },
  memories: ['learn_seed_1'],
};

const SEED_DECISIONS = [
  {
    decision_id: 'dec_seed_matured_1',
    action_class: 'budget-change',
    selected_action: 'raise_search_brand_budget_10pct',
    decided_at: hoursAgo(150),
    evaluation: { outcome: 'correct', needless: false, evaluated_at: null }, // filled below
    alternatives: [
      {
        action: 'raise_search_brand_budget_10pct',
        reason: 'search-brand qualified CPL tracks 18% below generic-prospecting with headroom in thedaily budget',
        expected_outcomes: { mean: -0.08, p10: -0.14, p90: 0.02 },
      },
      {
        action: 'do_nothing',
        reason: 'holding spend keeps qualified CPL where it is while the margin evidence matures',
        expected_outcomes: { mean: 0, p10: 0, p90: 0 },
      },
    ],
    risk: {
      expected_downside_micros: 300_000_000,
      worst_reasonable_case: 'raised spend buys saturated impressions and qualified CPL rises 14% for a week',
    },
    evidence_refs: ['evt_seed_journey_spend_1', 'evt_seed_journey_lead_qualified_1'],
    memory_refs: ['learn_seed_1'],
    critic_result: 'critic agrees: the move is reversible and the downside is bounded at ₹300',
    policy_decision_id: 'policy_seed_1',
    model_versions: ['strategy-fixture-v1'],
    prompt_versions: ['journal-baseline-v1'],
  },
  {
    decision_id: 'dec_seed_donothing_1',
    action_class: 'campaign-status',
    selected_action: 'do_nothing',
    decided_at: hoursAgo(150),
    evaluation: { outcome: 'correct', needless: false, evaluated_at: null }, // filled below
    alternatives: [
      {
        action: 'pause_retargeting',
        reason: 'retargeting CPL looks high against generic-prospecting on immature data',
        expected_outcomes: { mean: 0.04, p10: -0.02, p90: 0.12 },
      },
      {
        action: 'do_nothing',
        reason: 'qualified CPL within 15% of target; no frontier move beats holding spend',
        expected_outcomes: { mean: 0, p10: 0, p90: 0 },
      },
    ],
    risk: {
      expected_downside_micros: 0,
      worst_reasonable_case: 'holding a week on a campaign inside its CPL band with no downside spent',
    },
    evidence_refs: ['evt_seed_journey_spend_1'],
    memory_refs: ['learn_seed_1'],
    critic_result: 'critic agrees: no action is the valid outcome here',
    policy_decision_id: 'policy_seed_2',
    model_versions: ['strategy-fixture-v1'],
    prompt_versions: ['journal-baseline-v1'],
  },
  {
    decision_id: 'dec_seed_awaiting_1',
    action_class: 'budget-change',
    selected_action: 'shift_budget_to_retargeting',
    decided_at: null, // filled below: six hours ago keeps it awaiting
    alternatives: [
      {
        action: 'shift_budget_to_retargeting',
        reason: 'retargeting session coverage outruns search-brand on the last 10 qualified leads',
        expected_outcomes: { mean: -0.06, p10: -0.11, p90: 0.03 },
      },
      {
        action: 'do_nothing',
        reason: 'the shift is on immature data; holding avoids moving spend before maturity',
        expected_outcomes: { mean: 0, p10: 0, p90: 0 },
      },
    ],
    risk: {
      expected_downside_micros: 150_000_000,
      worst_reasonable_case: 'the shift lands on immature coverage and retargeting CPL degrades 11% for a week',
    },
    evidence_refs: ['evt_seed_journey_lead_qualified_2'],
    memory_refs: ['learn_seed_1'],
    critic_result: 'critic defers: the move awaits maturity before authority, so shadow only',
    policy_decision_id: 'policy_seed_3',
    model_versions: ['strategy-fixture-v1'],
    prompt_versions: ['journal-baseline-v1'],
  },
];

// Evaluations land at the decision's maturity moment (decided_at + 120h), so
// the seeded outcomes sit exactly on the lag model the journal enforces.
function hydrateSeedDecision(decision) {
  const decidedAt = decision.decision_id === 'dec_seed_awaiting_1' ? occurredAt() : decision.decided_at;
  const hydrated = { ...decision, decided_at: decidedAt, tenant_id: TENANT.id, state_snapshot_id: SEED_SNAPSHOT.snapshot_id };
  if (hydrated.evaluation) {
    hydrated.evaluation = {
      ...hydrated.evaluation,
      evaluated_at: new Date(Date.parse(decidedAt) + 120 * 3_600_000).toISOString(),
    };
  }
  return hydrated;
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

  repositories.snapshots.create({ tenant_id: TENANT.id, ...SEED_SNAPSHOT });
  let decisionRows = 0;
  for (const partial of SEED_DECISIONS.map(hydrateSeedDecision)) {
    const validated = validateDecisionRecord(partial);
    if (!validated.ok) {
      throw validated.error;
    }
    const result = repositories.decisions.create({
      ...validated.record,
      tenant_id: TENANT.id,
      expected_evaluation_at: new Date(Date.parse(validated.record.decided_at) + 120 * 3_600_000).toISOString(),
      status: Date.now() >= Date.parse(validated.record.decided_at) + 120 * 3_600_000 ? 'matured' : 'awaiting-maturity',
    });
    if (result.created) {
      decisionRows += 1;
    }
  }

  replayRawToDerived(db, TENANT.id);

  return {
    tenant: repositories.tenants.get(TENANT.id),
    appended,
    decisions: decisionRows,
    learningsWritten,
    alreadySeeded: appended === 0 && decisionRows === 0 && learningsWritten === 0,
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const result = seed();
  console.log(
    result.alreadySeeded
      ? `seed: tenant ${TENANT.id} already present, nothing new written`
      : `seed: wrote ${result.appended} events, ${result.decisions} decisions and ${result.learningsWritten} learnings for tenant ${TENANT.id}`,
  );
}
