// HTTP surface: GET /health, the five server-rendered pages, static assets,
// POST /v1/events ingest, GET /v1/metrics, GET /v1/learnings, and a {code,message} error
// envelope for every API path that has no handler. Failed handlers never
// leak a stack trace to the response.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { renderPage } from '../web/pages.js';
import {
  computeFunnel,
  coverageOf,
  dataThrough,
  isStale,
  maturityFor,
  normaliseGrowthEvent,
  staleAgeHours,
  policyBand,
} from '../domain/measurement.js';
import { validateEvent } from '../domain/events.js';
import { canonicalCurrency } from '../domain/money.js';
import { utcNow } from '../data/db.js';
import {
  calibrationReport,
  expectedEvaluationAtIso,
  evaluationStatus,
  validateDecisionRecord,
} from '../domain/decisions.js';
import { FakeMetaAdsProvider, FAILURE_MODES } from '../integrations/meta_ads/fake.js';
import { META_ERROR_CODES } from '../integrations/meta_ads/index.js';
import { validateOpportunity, scoreOpportunity, expectedContribution } from '../domain/opportunities.js';
import { validateExperiment, evaluateExperiment } from '../domain/experiments.js';
import { createKernel, DEFAULT_SIGNING_SECRET, decisionNonce, ACTION_CLASSES, freezeScopeId } from '../policy/kernel.js';
import { postureFor } from '../policy/trust.js';
import { visibleReason, reasonRejection, isPendingApproval } from '../domain/approvals.js';
import { createExecutor } from '../executor/executor.js';
import * as guardian from '../strategy/guardian.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ?meta_error=quota|revoked drives the fake provider's failure injection for
// simulation; anything else is ignored, exactly like an unknown ?state=.
const META_ERROR_PARAMS = new Set([...FAILURE_MODES].filter((mode) => mode !== 'ok'));

/** The codes kernel.validateIntent answers with. A refusal from the gate is
 * 403 on every write route, whether it was raised at issuance or by the
 * executor's re-gate on the way to the provider — one set, so a new refusal
 * cannot be handled on one route and fall through to a 409 on the other. */
const GATE_REFUSAL_CODES = new Set([
  'AUTONOMY_NOT_EARNED',
  'MICRO_LIMIT_EXCEEDED',
  'MATURITY_BAND_BLOCKED',
  'CAPABILITY_NOT_ISSUED',
]);

/** The guardian's own refusals, as statuses. The module decides WHAT is
 * refused; this table only decides which number the refusal is. Without it a
 * throw from freeze()/reEnable() reached the 500 handler, so a body naming an
 * unknown scope — or a re-enable that cleared nothing — read as a crash. */
const GUARDIAN_REFUSAL_STATUS = Object.freeze({
  FREEZE_SCOPE_UNKNOWN: 400,
  FREEZE_SCOPE_ID_REQUIRED: 400,
  FREEZE_SCOPE_ID_MISMATCH: 400,
  NO_ACTIVE_FREEZE: 409,
});

/**
 * The ONE place a request's provider is built, and the single source of its
 * failure injection. Every read route AND both write routes call it: the
 * ?meta_error browser clause is a write-path clause, and a convention applied
 * to one write route and forgotten on the next is how a ?meta_error=quota
 * approval silently succeeds instead of producing the failure panel the
 * acceptance criterion names. An unknown value means 'ok', exactly as it does
 * for the page loop.
 */
function providerForRequest(request) {
  const failureMode = META_ERROR_PARAMS.has(request.query.meta_error) ? request.query.meta_error : 'ok';
  return new FakeMetaAdsProvider({ failureMode });
}

/** The package version, read once here so /health and the composition root
 * (src/index.js stamps it onto every capability) can never report different
 * numbers for the same build. */
export function packageVersion() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
}

const FUNNEL_TYPES = ['spend.observed', 'lead_qualified'];

/**
 * The tenant's maturity, computed ONCE and from one helper, because the gate
 * and the metric surface must not be able to drift apart.
 *
 * A tenant with NO events returns maturity: null rather than the 0 the display
 * surface shows. That difference is deliberate and is asserted in
 * test/api/actions.test.js: a display reading "0" means "no data, the number
 * is a placeholder", while the gate reading 0 would mean "we measured nothing
 * and it is worth 0.06" — and policyBand(0) admits an emergency-only class. A
 * missing measurement is not a small measurement (TR-24).
 */
function tenantMaturity(repositories, tenantId, nowIso) {
  const rows = repositories.rawEvents.listByTypes(tenantId, FUNNEL_TYPES);
  const latest = dataThrough(rows);
  if (latest === null) {
    return { maturity: null, band: null, data_through: null };
  }
  const ageHours = (Date.parse(nowIso) - Date.parse(latest)) / 3_600_000;
  const maturity = maturityFor(ageHours);
  return { maturity, band: policyBand(maturity).label, data_through: latest };
}

/**
 * Single-operator v1 tenant resolution: an explicit tenant_id (the POST route
 * auto-creates unknown tenants), else the sole existing tenant, else the demo
 * tenant. No auth layer in this slice.
 */
function resolveTenantId(repositories, requested) {
  if (typeof requested === 'string' && requested.length > 0) {
    return requested;
  }
  const tenants = repositories.tenants.list();
  return tenants.length === 1 ? tenants[0].id : 'tenant_demo';
}

/**
 * The read side's answer to "what unit of account should this draw in?" — the
 * funnel's foreign-spend exclusion on GET /v1/metrics. A stored code is an
 * arbitrary string — the QA repro sets it with raw SQL, which never reaches
 * tenants.create — so it is resolved through the domain's read-time boundary
 * here, in one rule for every code: a code that NAMES a currency is
 * canonicalised ('usd' -> 'USD'), a code that names none is passed through
 * VERBATIM so it matches no stored spend row THAT CARRIES A CURRENCY, and only
 * a MISSING row falls back to INR (tenants.currency is TEXT NOT NULL, so a
 * present row always holds a string).
 *
 * A bad code therefore reads as an honest unknown — no spend, a null CPL — for
 * every spend row that CARRIES a currency, rather than as rupees this row
 * cannot be said to hold. The one row it does not cover is a spend row carrying
 * NO currency: computeFunnel skips a row only when its payload names a
 * currency and it differs (src/domain/measurement.js:203), so a currency-less
 * row is still summed as tenant-currency, and ingest accepts that shape because
 * normaliseGrowthEvent validates payload.currency only when it is present
 * (src/domain/measurement.js:136). That leniency is computeFunnel's, is
 * unchanged on main, and is the same rule the dashboard read applies.
 *
 * The write guard below already answered the same way: for a bad row it
 * refuses to add a rupee the read will not report, so the two surfaces now
 * AGREE about what the row is.
 *
 * The chain is `??`, not `||`: a stored '' names no currency either, and must
 * exclude exactly as 'ZZZ' does. `||` would read it as INR — the very collapse
 * of read and write this seam exists to keep.
 *
 * Issue #66's AC-1/AC-4 and its QA run pinned a 'ZZZ' tenant reading
 * 7_200_000_000 spend and a ₹2,400.00 tile as the unchanged baseline. PR #70
 * (issue #68) deliberately REVERSED that pin: a tenant row already holding a
 * non-ISO code now reads 0 spend and a null CPL, which is intended and matches
 * what POST /v1/events has done to that row since #66.
 */
function resolveTenantCurrency(row) {
  const stored = row?.currency;
  return canonicalCurrency(stored) ?? stored ?? 'INR';
}

/**
 * The write side's answer to "does this spend event's currency match the
 * tenant's?" A stored code that names an ISO currency is compared canonically,
 * so 'usd', 'Usd' and ' USD ' accept the USD spend they name — mis-casing a
 * currency is not a currency error. A stored code naming NO currency is
 * compared VERBATIM, which can never match: a validated spend currency is
 * always in ISO_CURRENCIES by the time it reaches here (measurement.js
 * rejects anything else first), so 'ZZZ' is always a mismatch and the 400
 * below fires with the raw stored code in its message and details.
 *
 * The call site guarantees a row (the `existingTenant &&` guard in the ingest
 * handler below), so this states that precondition rather than half-guarding a
 * read whose result the canonical arm discards. The `??` chain is the same rule
 * as resolveTenantCurrency above, one rule rather than two arms with different
 * left operands.
 */
function tenantCurrencyMismatch(row, spendCurrency) {
  const canonical = canonicalCurrency(row.currency);
  return (canonical ?? row.currency) !== spendCurrency;
}

function errorResponse(response, status, error) {
  // Stable codes only: a stack trace never crosses the HTTP boundary.
  response
    .status(status)
    .json({ code: error.code ?? 'INTERNAL', message: error.message, ...(error.details ? { details: error.details } : {}) });
}

/**
 * Run a guardian call, turning the refusals it names into HTTP answers, and
 * returning null once it has done so. Anything it does not recognise is
 * rethrown: a table that swallowed every error would convert a real bug into
 * a tidy 4xx.
 */
function tryGuardian(call, response) {
  try {
    return call();
  } catch (error) {
    const status = GUARDIAN_REFUSAL_STATUS[error?.code];
    if (status === undefined) {
      throw error;
    }
    errorResponse(response, status, error);
    return null;
  }
}

/** The five parameters client.js hands the /approvals navigation, as the
 * object the renderer reads. Everything arrives as a STRING from the query and
 * is escaped there; an absent, empty or unrecognised decision is null, which
 * is what makes the page a normal page again the moment they are gone. */
function decisionFromQuery(query) {
  if (query.decision !== 'approved' && query.decision !== 'rejected') {
    return null;
  }
  return {
    decision: query.decision,
    receipt: typeof query.receipt === 'string' && query.receipt.length > 0 ? query.receipt : null,
    reconciliation: typeof query.reconciliation === 'string' ? query.reconciliation : null,
    drift: typeof query.drift === 'string' ? query.drift : null,
    approval: typeof query.approval === 'string' && query.approval.length > 0 ? query.approval : null,
  };
}

/**
 * The min-sample gate an evaluation runs against. The experiment's own
 * persisted stop rule is the floor: a caller may demand MORE sample than the
 * stored rule (a stricter, voluntary hold) but never less, because a body
 * min_sample below the rule would let thin counts reach the z-test and be
 * persisted as a win or loss that the experiment's own stop rule forbids.
 */
function evaluationMinSample(experiment, requested) {
  const stored = experiment.record?.stopRules?.min_sample;
  const ask = Number.isSafeInteger(requested) && requested > 0 ? requested : null;
  if (stored === undefined) {
    return ask;
  }
  return ask === null ? stored : Math.max(ask, stored);
}

export function buildApp({ repositories, policySecret = DEFAULT_SIGNING_SECRET, policyVersion = '1', capabilityTtlMs = 900_000 }) {
  const app = express();
  app.disable('x-powered-by');

  // The policy kernel, bound to the two READ-ONLY ports. The nonce port is
  // backed by action_records rather than by capabilities: a capability row
  // exists from the moment of issuance, so binding there would report every
  // nonce as already spent and refuse every execution.
  const kernel = createKernel({
    secret: policySecret,
    policyVersion,
    ttlMs: capabilityTtlMs,
    killSwitches: { isActive: (tenantId, scope, scopeId) => repositories.killSwitches.isActive(tenantId, scope, scopeId) },
    nonces: { seen: (tenantId, nonce) => repositories.actionRecords.getByNonce(tenantId, nonce) !== null },
  });

  /** The posture for a class, from the same row the page renders. The class is
   * coerced to null when it is not a string: the trust ledger's primary key is
   * (tenant_id, action_class) and node:sqlite refuses to bind an object or an
   * absent value to it, so an unvalidated body field is a 500 where the
   * kernel's fail-closed unknown-class refusal is the answer this endpoint owes
   * every class it cannot reason about. */
  function postureForClass(tenantId, actionClass) {
    const name = typeof actionClass === 'string' && actionClass.length > 0 ? actionClass : null;
    const roster = ACTION_CLASSES.find((entry) => entry.action_class === name) ?? null;
    return postureFor(name, name === null ? null : repositories.trustLedger.get(tenantId, name), roster, null);
  }

  app.get('/health', (request, response) => {
    response.status(200).json({ status: 'ok', version: packageVersion() });
  });

  app.get('/assets/styles.css', (request, response) => {
    response.type('text/css').sendFile(join(PACKAGE_ROOT, 'src', 'web', 'styles.css'));
  });
  app.get('/assets/client.js', (request, response) => {
    response.type('application/javascript').sendFile(join(PACKAGE_ROOT, 'src', 'web', 'client.js'));
  });

  for (const route of ['/', '/journal', '/opportunities', '/experiments', '/approvals']) {
    app.get(route, async (request, response) => {
      // A per-request provider: the fake holds no state across requests, so
      // one browser tab cannot see another's simulated failure. Built by the
      // same helper the write routes use, so the ?meta_error convention has
      // exactly one definition.
      const metaProvider = providerForRequest(request);
      response
        .type('html')
        .send(await renderPage(route, {
          repositories,
          override: request.query.state ?? null,
          metaProvider,
          metaError: META_ERROR_PARAMS.has(request.query.meta_error) ? request.query.meta_error : null,
          // The outcome of a decision travels through the navigation that
          // follows it, so the page the operator lands on is the page that
          // says what happened. Only /approvals renders it, and only these
          // five parameters: an unknown one renders nothing.
          decision: route === '/approvals' ? decisionFromQuery(request.query) : null,
          // The journal's class/status filters come from the two GET selects;
          // unknown values are ignored downstream.
          filters: route === '/journal'
            ? { class: request.query.class ?? null, status: request.query.status ?? null }
            : null,
        }));
    });
  }

  // The versioned API: events ingest plus readable measurement truth. Unknown
  // /v1 paths return the error envelope, never a stack trace. Express strips
  // the mount prefix from request.path, so the reported path is rebuilt from
  // baseUrl.
  app.use('/v1', express.json({ strict: true }));

  app.post('/v1/events', (request, response) => {
    const input = request.body ?? {};
    const tenantId = resolveTenantId(repositories, input.tenant_id);
    const normalised = normaliseGrowthEvent(input, tenantId);
    if (!normalised.ok) {
      return errorResponse(response, 400, normalised.error);
    }
    const validated = validateEvent(normalised.event);
    if (!validated.ok) {
      return errorResponse(response, 400, validated.error);
    }
    // Money integrity (QA BUG-2): one unit of account per tenant. A spend
    // event whose currency differs from the tenant row's currency is a 400 —
    // mixed-currency micros would sum into a CPL denominated in no real
    // currency. Validation runs before tenant auto-creation, so the 400 still
    // writes nothing.
    const spendCurrency = validated.event.event_type === 'spend.observed'
      ? validated.event.payload.currency
      : undefined;
    const existingTenant = repositories.tenants.get(tenantId);
    if (spendCurrency !== undefined && existingTenant && tenantCurrencyMismatch(existingTenant, spendCurrency)) {
      return errorResponse(response, 400, {
        code: 'CURRENCY_MISMATCH',
        message: `tenant ${tenantId} keeps ${existingTenant.currency}; spend in ${spendCurrency} was rejected`,
        details: { tenant_currency: existingTenant.currency, received: spendCurrency },
      });
    }
    // An unknown explicit tenant auto-creates its row, idempotently, and only
    // after the event validated: a 4xx write-failure leaves no tenant row.
    // A first spend event seeds the tenant currency; anything else defaults
    // to INR as before.
    if (!existingTenant) {
      repositories.tenants.create({ id: tenantId, name: tenantId, currency: spendCurrency ?? 'INR' });
    }
    const { appended } = repositories.rawEvents.append(validated.event);
    // 202 both times; the duplicate flag tells the sender which delivery stuck.
    response.status(202).json({ receipt: validated.event.event_id, appended, duplicate: !appended });
  });

  app.get('/v1/metrics', (request, response) => {
    const tenantId = resolveTenantId(repositories, request.query.tenant_id);
    const rows = repositories.rawEvents.listByTypes(tenantId, FUNNEL_TYPES);
    // The tenant row's currency excludes any foreign-currency spend rows
    // legacy batches may still hold. A stored code naming no ISO currency is
    // used verbatim, so it matches no spend row; INR applies only when the
    // tenant has no row at all.
    const tenantCurrency = resolveTenantCurrency(repositories.tenants.get(tenantId));
    const funnel = computeFunnel(rows, tenantCurrency);
    const now = utcNow();
    const measured = tenantMaturity(repositories, tenantId, now);
    // The wire shape is unchanged: the display surface shows 0 for a tenant
    // with no data because the card needs a number, while the GATE refuses the
    // same tenant outright. The two deliberately differ, and
    // test/api/actions.test.js pins both halves in one case so they cannot
    // quietly converge or quietly diverge.
    const maturity = measured.maturity ?? 0;
    const band = policyBand(maturity);
    response.json({
      tenant_id: tenantId,
      spend_micros: funnel.spend_micros,
      qualified_volume: funnel.qualified_volume,
      qualified_cpl_micros: funnel.qualified_cpl_micros,
      maturity,
      band: band.label,
      gated_strategic: band.gated,
      maturity_coverage: coverageOf(rows),
      data_through: measured.data_through,
      stale: isStale(now, measured.data_through),
      stale_age: staleAgeHours(now, measured.data_through) ?? null,
    });
  });

  // The decision-journal surface (TR-6, TR-15): snapshot registration,
  // decision posts, and the live calibration aggregate. Nothing here
  // executes or approves anything — shadow mode records, it does not act,
  // and no route imports test fixtures.

  app.post('/v1/snapshots', (request, response) => {
    const body = request.body ?? {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return errorResponse(response, 400, { code: 'BAD_SNAPSHOT', message: 'snapshot body must be an object' });
    }
    if (typeof body.snapshot_id !== 'string' || body.snapshot_id.length === 0) {
      return errorResponse(response, 400, {
        code: 'BAD_SNAPSHOT',
        message: 'snapshot_id is missing or empty',
        details: { field: 'snapshot_id' },
      });
    }
    const tenantId = resolveTenantId(repositories, body.tenant_id);
    const snapshot = repositories.snapshots.create({
      tenant_id: tenantId,
      snapshot_id: body.snapshot_id,
      kpis: body.kpis ?? {},
      budgets: body.budgets ?? [],
      funnel: body.funnel ?? {},
      health: body.health ?? {},
      memories: body.memories ?? [],
    });
    // 201 both times: re-registering an existing snapshot_id is a no-op.
    response.status(201).json({ snapshot_id: snapshot.snapshot_id });
  });

  app.post('/v1/decisions', (request, response) => {
    const body = request.body ?? {};
    const validated = validateDecisionRecord(body);
    if (!validated.ok) {
      return errorResponse(response, 400, validated.error);
    }
    const record = validated.record;
    const tenantId = resolveTenantId(repositories, body.tenant_id);
    // Unknown snapshot id is a 422 (TR-6): nothing is written without the
    // immutable world the decision was made in.
    const snapshot = repositories.snapshots.get(tenantId, record.state_snapshot_id);
    if (!snapshot) {
      return errorResponse(response, 422, {
        code: 'UNKNOWN_SNAPSHOT',
        message: `unknown state snapshot ${record.state_snapshot_id}`,
        details: { state_snapshot_id: record.state_snapshot_id },
      });
    }
    const status = evaluationStatus(record, utcNow());
    const result = repositories.decisions.create({
      ...record,
      tenant_id: tenantId,
      expected_evaluation_at: expectedEvaluationAtIso(record.decided_at),
      status,
    });
    // Idempotent re-post (TR-5): the same decision_id returns the same row.
    response.status(201).json({
      decision_id: result.decision_id,
      status: result.status,
      expected_evaluation_at: result.expected_evaluation_at,
      created: result.created,
    });
  });

  app.get('/v1/decisions', (request, response) => {
    const tenantId = resolveTenantId(repositories, request.query.tenant_id);
    const rows = repositories.decisions.list(tenantId, {
      class: request.query.class ?? null,
      status: request.query.status ?? null,
    });
    response.json({
      tenant_id: tenantId,
      count: rows.length,
      decisions: rows.map((row) => ({
        decision_id: row.decision_id,
        decided_at: row.decided_at,
        action_class: row.action_class,
        selected_action: row.selected_action,
        status: row.status,
        expected_evaluation_at: row.expected_evaluation_at,
      })),
    });
  });

  app.get('/v1/decisions/:decisionId', (request, response) => {
    const tenantId = resolveTenantId(repositories, request.query.tenant_id);
    const row = repositories.decisions.get(tenantId, request.params.decisionId);
    if (!row) {
      return errorResponse(response, 404, { code: 'UNKNOWN_DECISION', message: `no decision ${request.params.decisionId}` });
    }
    // The full record: alternatives (each with its expected effect
    // distribution and the do-nothing reason), risk, evidence and memory
    // refs, critic result, policy id, model and prompt versions, and the
    // evaluation when the decision has matured into one.
    response.json({
      decision_id: row.decision_id,
      tenant_id: row.tenant_id,
      state_snapshot_id: row.state_snapshot_id,
      decided_at: row.decided_at,
      action_class: row.action_class,
      selected_action: row.selected_action,
      alternatives: row.alternatives,
      risk: row.risk,
      evidence_refs: row.evidence_refs,
      memory_refs: row.memory_refs,
      critic_result: row.critic_result,
      policy_decision_id: row.policy_decision_id,
      model_versions: row.model_versions,
      prompt_versions: row.prompt_versions,
      evaluation: row.evaluation ?? null,
      status: row.status,
      expected_evaluation_at: row.expected_evaluation_at,
    });
  });

  app.get('/v1/calibration', (request, response) => {
    const tenantId = resolveTenantId(repositories, request.query.tenant_id);
    // LIVE truth only: computed from the decisions repository through the
    // outcomes on the records (work order). The frozen replay's 0.70/0.33
    // report is CI-only and never reaches a live surface.
    const report = calibrationReport(repositories.decisions.list(tenantId));
    response.json({
      tenant_id: tenantId,
      precision: report.precision,
      false_intervention_rate: report.falseInterventionRate,
      evaluated: report.evaluated,
      correct: report.correct,
      interventions: report.interventions,
      needless: report.needless,
      awaiting_maturity: report.awaitingMaturity,
    });
  });

  // The learnings listing (TR-10): tenant-scoped only, deterministic by
  // (updated_at, id) from the repository, tamper-proof against cross-tenant
  // reads because every query binds tenant_id.
  app.get('/v1/learnings', (request, response) => {
    const tenantId = resolveTenantId(repositories, request.query.tenant_id);
    response.json({
      tenant_id: tenantId,
      learnings: repositories.learnings.list(tenantId),
    });
  });

  // The opportunity-experiment surface (issue #22, spec sections 26/27):
  // posted bets are validated in the domain, scored and stored with all eight
  // components, and read back ranked by stored score (desc, id asc). The
  // evaluation endpoint appends an evaluation row and rewrites the mutable
  // experiment state in place. Idempotent re-posts return created:false and
  // never duplicate rows.

  app.post('/v1/opportunities', (request, response) => {
    const body = request.body ?? {};
    const validated = validateOpportunity(body);
    if (!validated.ok) {
      return errorResponse(response, 400, validated.error);
    }
    const tenantId = resolveTenantId(repositories, body.tenant_id);
    const opportunity = validated.opportunity;
    const score = scoreOpportunity(opportunity);
    const result = repositories.opportunities.create({
      tenant_id: tenantId,
      opportunity_id: opportunity.opportunity_id,
      record: { ...opportunity, tenant_id: tenantId },
      score,
    });
    response.status(201).json({
      opportunity_id: result.opportunity_id,
      name: result.name,
      components: result.components,
      score: result.score,
      // From the STORED row, not the request body: on an idempotent re-post
      // the body is discarded, and the response must describe the record that
      // exists rather than the one that was ignored.
      // CONTRACT: components and this field are two halves of one rule, and
      // both come from the same domain predicate, so they agree. This field is
      // null exactly when value_micros, pSuccess or cost_micros is null in
      // this same body — the three keys the formula reads, and no others. The
      // other five components do not enter `trunc(value x p) - cost` at all,
      // so a null among them leaves this field a number, deliberately and
      // with no exception: a client cannot infer anything about this field
      // from those five keys, in either direction. When all three are
      // readable the result is a number rather than null, because a readable
      // value_micros is a non-negative safe integer and a readable pSuccess is
      // in [0,1], so the product cannot leave the safe-integer range. A client
      // that null-checks this field can rely on those three agreeing — a body
      // never reports an unknown contribution and then hands the client a
      // float or a string it cannot trust.
      //
      // null, never 0: a row stored before the micros rename has no
      // value_micros/cost_micros to compute from. null is an honest unknown;
      // 0 is not, because a break-even bet legitimately contributes zero, so a
      // client doing arithmetic on this field must null-check it.
      expected_contribution_micros: expectedContribution(result.components),
      created: result.created,
    });
  });

  app.get('/v1/opportunities', (request, response) => {
    const tenantId = resolveTenantId(repositories, request.query.tenant_id);
    const rows = repositories.opportunities.list(tenantId);
    response.json({
      tenant_id: tenantId,
      count: rows.length,
      // Already stored-score desc / id asc from the repository: the one rank
      // key everywhere. Rows carry all eight components plus the score.
      opportunities: rows.map((row) => ({
        opportunity_id: row.opportunity_id,
        name: row.name,
        components: row.components,
        score: row.score,
      })),
    });
  });

  app.post('/v1/experiments', (request, response) => {
    const body = request.body ?? {};
    const validated = validateExperiment(body);
    if (!validated.ok) {
      return errorResponse(response, 400, validated.error);
    }
    const tenantId = resolveTenantId(repositories, body.tenant_id);
    const experiment = validated.experiment;
    const result = repositories.experiments.create({
      tenant_id: tenantId,
      experiment_id: experiment.experiment_id,
      record: { ...experiment, tenant_id: tenantId },
      state: experiment.state,
      data_through: experiment.data_through,
    });
    response.status(201).json({
      experiment_id: result.experiment_id,
      name: result.name,
      state: result.state,
      caps: result.record.caps,
      stop_rules: result.record.stopRules,
      data_through: result.data_through,
      created: result.created,
    });
  });

  app.get('/v1/experiments', (request, response) => {
    const tenantId = resolveTenantId(repositories, request.query.tenant_id);
    const rows = repositories.experiments.list(tenantId);
    response.json({
      tenant_id: tenantId,
      count: rows.length,
      experiments: rows.map((row) => ({
        experiment_id: row.experiment_id,
        name: row.name,
        state: row.state,
        evaluation_result: row.evaluation_result,
        evaluation_reason: row.evaluation_reason,
        evaluated_at: row.evaluated_at,
        caps: row.record.caps,
        stop_rules: row.record.stopRules,
        data_through: row.data_through,
      })),
    });
  });

  app.post('/v1/experiments/:experimentId/evaluate', (request, response) => {
    const tenantId = resolveTenantId(repositories, request.body?.tenant_id ?? request.query.tenant_id);
    const experiment = repositories.experiments.get(tenantId, request.params.experimentId);
    if (!experiment) {
      return errorResponse(response, 422, {
        code: 'UNKNOWN_EXPERIMENT',
        message: `unknown experiment ${request.params.experimentId}`,
        details: { experiment_id: request.params.experimentId },
      });
    }
    const body = request.body ?? {};
    const counts = {
      control_conversions: body.control_conversions,
      control_exposures: body.control_exposures,
      treatment_conversions: body.treatment_conversions,
      treatment_exposures: body.treatment_exposures,
    };
    const minSample = evaluationMinSample(experiment, body.min_sample);
    const evaluated = evaluateExperiment({ counts, min_sample: minSample });
    if (evaluated.error) {
      return errorResponse(response, 400, evaluated.error);
    }
    const evaluatedAt = utcNow();
    // evaluateExperiment always returns a truthy outcome on the non-error path
    // (inconclusive, win or loss), so the append below always runs before the
    // 200 and the response always carries both flags.
    const { appended } = repositories.evaluations.append({
      tenant_id: tenantId,
      experiment_id: experiment.experiment_id,
      evaluated_at: evaluatedAt,
      result: evaluated.outcome,
      reason: evaluated.reason ?? null,
      counts,
    });
    // State updates on the experiments table itself are legal here and only
    // here: the row is mutable working state, outcomes live on the append-only
    // evaluation rows.
    repositories.experiments.updateState(tenantId, experiment.experiment_id, {
      state: evaluated.next_state,
      evaluation_result: evaluated.outcome,
      evaluation_reason: evaluated.reason ?? null,
      evaluated_at: evaluatedAt,
      data_through: evaluatedAt,
    });
    response.status(200).json({
      experiment_id: experiment.experiment_id,
      outcome: evaluated.outcome,
      reason: evaluated.reason ?? null,
      next_state: evaluated.next_state,
      z: evaluated.z ?? null,
      // The evaluation row is append-only: a same-millisecond collision is
      // deduplicated, not overwritten, and the wire says which it was (the
      // raw-events POST precedent).
      appended,
      duplicate: !appended,
    });
  });

  // The write path (issue #20, TR-3/4/5/19/24). Nothing here touches a
  // provider except through the executor, and nothing mints a capability
  // except through the kernel — the two routes that can produce one are the
  // autonomous issuance route and the human approval route below.

  /** The intent an approval row authorises, in the shape the gate reads. */
  function intentFor(tenantId, { action_class: actionClass, action, resource, constraints }) {
    return { tenant_id: tenantId, action_class: actionClass, action, resource, constraints: constraints ?? {} };
  }

  /**
   * THE assembly of the gate's inputs, defined ONCE in the repository.
   *
   * Every caller of kernel.validateIntent comes through here: both issuance
   * routes, and — through the executor's injected port — the write path itself,
   * which re-runs this exact function on the STORED envelope when a capability
   * is spent. So the four values the gate reads (the live posture, the named
   * approval row, the tenant's maturity measured now, and the clock) have one
   * definition rather than one per call site, and a fix to any of them cannot
   * reach the minting route while missing the write.
   *
   * approvalId is null on the autonomous route. A NAMED row that is not there
   * is a refusal rather than a fallback to "no approval at all": an envelope
   * claiming a human decision nobody can produce is not an autonomous one.
   */
  function autonomyVerdict(tenantId, intent, { nowIso, approvalId = null }) {
    const approval = approvalId === null ? null : repositories.approvals.get(tenantId, approvalId);
    if (approvalId !== null && !approval) {
      return {
        ok: false,
        error: {
          code: 'AUTONOMY_NOT_EARNED',
          message: 'the capability names an approval row this server does not hold',
          details: { reason: 'malformed', approval_id: approvalId },
        },
      };
    }
    return kernel.validateIntent(intent, {
      nowIso,
      posture: postureForClass(tenantId, intent.action_class),
      approval,
      maturity: tenantMaturity(repositories, tenantId, nowIso).maturity,
    });
  }

  /** The executor's gate port, bound to the ONE definition above. */
  const revalidate = autonomyVerdict;

  /** A provider refusal rather than a gate refusal, decided by the contract's
   * own error codes so a new adapter code is a refusal too. */
  function isProviderError(error) {
    return Boolean(error) && Object.values(META_ERROR_CODES).includes(error.code);
  }

  app.post('/v1/capabilities', (request, response) => {
    const body = request.body ?? {};
    const tenantId = resolveTenantId(repositories, body.tenant_id);
    const nowIso = utcNow();
    const intent = intentFor(tenantId, {
      action_class: body.action_class,
      action: body.action,
      resource: body.resource,
      constraints: body.constraints,
    });
    // NOTHING ELSE mints a capability: this route, with the approval row
    // deliberately null, and the approve route below with it supplied.
    const maturity = tenantMaturity(repositories, tenantId, nowIso).maturity;
    const validated = autonomyVerdict(tenantId, intent, { nowIso });
    if (!validated.ok) {
      return errorResponse(response, 403, validated.error);
    }
    const capability = kernel.issueCapability({ ...intent, maturity }, { nowIso });
    repositories.capabilities.create({
      tenant_id: tenantId,
      capability_id: capability.capability_id,
      envelope: capability,
      expires_at: capability.expiry,
    });
    repositories.auditEvents.append({
      tenant_id: tenantId,
      actor: 'operator',
      action: 'capability.issued',
      subject: capability.capability_id,
      capability_id: capability.capability_id,
      details: { action_class: intent.action_class, action: intent.action, resource: intent.resource, band: capability.band },
      occurred_at: nowIso,
    });
    response.status(201).json({
      capability_id: capability.capability_id,
      // The whole signed capability, so a caller can POST this body straight
      // back to /v1/actions/execute without reconstructing it.
      envelope: capability,
      expiry: capability.expiry,
    });
  });

  app.post('/v1/approvals/:approvalId/approve', async (request, response) => {
    const body = request.body ?? {};
    const approvalId = request.params.approvalId;
    // An explicit tenant is what makes a cross-tenant id 404 below rather than
    // execute somebody else's approval, and what the browser sends on the
    // control it rendered the card from.
    const tenantId = resolveTenantId(repositories, body.tenant_id);
    const nowIso = utcNow();

    // (0) REDELIVERY, first and deliberately outside the gate. The gate
    // refuses an approval row whose status is 'executed' as terminal, so a
    // duplicate resolved after it would 403 forever and the browser's
    // re-decide control could never be answered. It is not a second owner of
    // the gate: it mints nothing, issues no capability, calls no provider and
    // mutates no row — it answers about a receipt that already exists.
    const prior = repositories.actionRecords.getByNonce(tenantId, decisionNonce(approvalId));
    if (prior) {
      return response.status(200).json({
        approval_id: approvalId,
        status: 'executed',
        executed: false,
        duplicate: true,
        receipt_id: prior.receipt_id,
        reconciliation: prior.reconciliation,
        drift: prior.drift,
      });
    }

    // (1) REASON.
    const reason = visibleReason(body.reason);
    if (reason === null) {
      return errorResponse(response, 400, reasonRejection(body.reason));
    }

    // (2) THE ROW.
    const row = repositories.approvals.get(tenantId, approvalId);
    if (!row) {
      return errorResponse(response, 404, { code: 'APPROVAL_NOT_FOUND', message: `no approval ${approvalId}`, details: { approval_id: approvalId } });
    }
    if (!isPendingApproval(row, { nowIso })) {
      return errorResponse(response, 409, {
        code: 'APPROVAL_NOT_PENDING',
        message: `approval ${approvalId} is not awaiting a decision`,
        details: { approval_id: approvalId, status: row.status, lapsed: Date.parse(row.expires_at) <= Date.parse(nowIso) },
      });
    }

    // (3) THE GATE, with the row it is executing supplied as the approval.
    const intent = intentFor(tenantId, row);
    const maturity = tenantMaturity(repositories, tenantId, nowIso).maturity;
    const validated = autonomyVerdict(tenantId, intent, { nowIso, approvalId });
    if (!validated.ok) {
      return errorResponse(response, 403, validated.error);
    }

    // (4) ISSUE AND EXECUTE. The nonce is the one definition of the approval
    // decision's nonce, and the provider comes from the SAME helper the execute
    // route uses, named here so the omission that made the ?meta_error failure
    // clause unobservable cannot recur. The approval id goes INTO the signed
    // envelope, so the executor can re-present this row to the gate without
    // being told which row it is by the caller.
    const actor = typeof body.actor === 'string' && body.actor.trim().length > 0 ? body.actor.trim() : 'operator';
    const capability = kernel.issueCapability({ ...intent, maturity }, {
      nowIso,
      // The approval's own stamp caps the authority it granted.
      expiresAtCap: row.expires_at,
      nonce: decisionNonce(approvalId),
      approvalId,
    });
    repositories.capabilities.create({
      tenant_id: tenantId,
      capability_id: capability.capability_id,
      envelope: capability,
      expires_at: capability.expiry,
    });
    const executor = createExecutor({ repositories, provider: providerForRequest(request), kernel, auditClock: utcNow, revalidate });
    const result = await executor.execute(capability, { actor, tenantId });

    // (5) PERSIST. A provider refusal writes NO status change: the item stays
    // pending, which is what the criterion asserts and what a genuine retry
    // needs.
    if (result.executed) {
      repositories.approvals.decide(tenantId, approvalId, { status: 'executed', reason, actor, decided_at: nowIso });
      repositories.auditEvents.append({
        tenant_id: tenantId,
        actor,
        action: 'approval.approved',
        subject: approvalId,
        capability_id: capability.capability_id,
        details: { reason, receipt_id: result.receipt_id, reconciliation: result.reconciliation, drift: result.drift },
        occurred_at: nowIso,
      });
      return response.status(200).json({
        approval_id: approvalId,
        status: 'executed',
        executed: true,
        receipt_id: result.receipt_id,
        reconciliation: result.reconciliation,
        drift: result.drift,
        band: capability.band,
        maturity: capability.maturity,
      });
    }
    if (result.error?.code === 'KILL_SWITCH_ACTIVE') {
      return errorResponse(response, 409, result.error);
    }
    if (isProviderError(result.error)) {
      return response.status(200).json({
        approval_id: approvalId,
        status: 'pending',
        executed: false,
        duplicate: false,
        outcome: 'provider_refused',
        error: result.error,
        reconciliation: 'unknown',
      });
    }
    // A gate refusal is 403 here for the same reason it is on the execute route
    // — it is the policy declining, not a conflict to retry. The 200
    // provider-refused shape above is unchanged, and it is the reason the
    // ?meta_error failure clause is observable at all.
    const status = GATE_REFUSAL_CODES.has(result.error?.code) || result.error?.code === 'TENANT_MISMATCH' ? 403 : 409;
    return errorResponse(response, status, result.error);
  });

  app.post('/v1/approvals/:approvalId/reject', (request, response) => {
    const body = request.body ?? {};
    const approvalId = request.params.approvalId;
    const tenantId = resolveTenantId(repositories, body.tenant_id);
    const nowIso = utcNow();

    const reason = visibleReason(body.reason);
    if (reason === null) {
      return errorResponse(response, 400, reasonRejection(body.reason));
    }
    const row = repositories.approvals.get(tenantId, approvalId);
    if (!row) {
      return errorResponse(response, 404, { code: 'APPROVAL_NOT_FOUND', message: `no approval ${approvalId}`, details: { approval_id: approvalId } });
    }
    if (!isPendingApproval(row, { nowIso })) {
      return errorResponse(response, 409, {
        code: 'APPROVAL_NOT_PENDING',
        message: `approval ${approvalId} is not awaiting a decision`,
        details: { approval_id: approvalId, status: row.status, lapsed: Date.parse(row.expires_at) <= Date.parse(nowIso) },
      });
    }
    // A rejection mints no capability and never reaches the executor, so it
    // cannot fail for any reason a provider could invent.
    const actor = typeof body.actor === 'string' && body.actor.trim().length > 0 ? body.actor.trim() : 'operator';
    repositories.approvals.decide(tenantId, approvalId, { status: 'rejected', reason, actor, decided_at: nowIso });
    repositories.auditEvents.append({
      tenant_id: tenantId,
      actor,
      action: 'approval.rejected',
      subject: approvalId,
      details: { reason },
      occurred_at: nowIso,
    });
    response.status(200).json({ approval_id: approvalId, status: 'rejected', decided: true });
  });

  app.post('/v1/actions/execute', async (request, response) => {
    const body = request.body ?? {};
    // This route's body is the signed envelope, and the tenant it names is a
    // SIGNED field - so a caller that sends the envelope and nothing else has
    // already said which tenant it is for. Falling through to the single-tenant
    // default instead would resolve 'tenant_demo' on any database that has
    // grown a second tenant, and refuse the caller's own capability. An
    // explicit tenant_id still wins, which is what makes a caller that claims
    // somebody else's tenant fail closed on the executor's TENANT_MISMATCH.
    const tenantId = resolveTenantId(repositories, body.tenant_id ?? body.tenant);
    // ONE provider for the write AND the re-read, so one request reconciles
    // against the state it just wrote.
    const executor = createExecutor({ repositories, provider: providerForRequest(request), kernel, auditClock: utcNow, revalidate });
    const result = await executor.execute(body, {
      actor: typeof body?.actor === 'string' ? body.actor : 'executor',
      tenantId,
    });

    if (result.executed) {
      return response.status(200).json({
        executed: true,
        receipt_id: result.receipt_id,
        requested: result.requested,
        reported: result.reported,
        reconciliation: result.reconciliation,
        drift: result.drift,
      });
    }
    if (result.duplicate) {
      return response.status(200).json({
        executed: false,
        duplicate: true,
        receipt_id: result.receipt_id,
        reconciliation: result.reconciliation,
        drift: result.drift,
      });
    }
    const code = result.error?.code;
    if (code === 'MALFORMED_CAPABILITY') {
      return errorResponse(response, 400, result.error);
    }
    if (isProviderError(result.error)) {
      return errorResponse(response, 502, result.error);
    }
    // Every GATE refusal is a 403 on this route, including the two the write
    // path's own checks raise: a capability this server did not issue is
    // refused as firmly as one it did, and it must not fall through to the
    // 409 that a freeze produces — 409 says "try again later", and neither of
    // these gets better later.
    if (GATE_REFUSAL_CODES.has(code) || code === 'EXPIRED_CAPABILITY' || code === 'BAD_SIGNATURE' || code === 'OVER_SCOPE' || code === 'REPLAYED_NONCE' || code === 'TENANT_MISMATCH') {
      return errorResponse(response, 403, result.error);
    }
    return errorResponse(response, 409, result.error);
  });

  app.post('/v1/guardian/trigger', (request, response) => {
    const body = request.body ?? {};
    const kind = request.query.kind ?? body.kind;
    const fixture = guardian.GUARDIAN_FIXTURES[kind];
    if (!fixture) {
      return errorResponse(response, 400, {
        code: 'GUARDIAN_KIND_UNKNOWN',
        message: `no guardian detector for ${kind}`,
        details: { kind: kind ?? null, known: [...guardian.GUARDIAN_KINDS] },
      });
    }
    const nowIso = utcNow();
    const evaluation = guardian.evaluate(fixture, { nowIso });
    if (!evaluation.tripped) {
      return response.status(200).json({ frozen: false, kind, details: evaluation.details });
    }
    const tenantId = resolveTenantId(repositories, body.tenant_id);
    const scope = typeof body.scope === 'string' && body.scope.length > 0 ? body.scope : guardian.DEFAULT_FREEZE_SCOPE;
    const suppliedScopeId = typeof body.scope_id === 'string' && body.scope_id.length > 0 ? body.scope_id : null;
    // A scope_id that contradicts its scope is REFUSED here rather than
    // forwarded, so the row the operator asked for is never written to a key no
    // reader derives. The same kernel derivation the gate reads is the one
    // this check reads; a contradiction is a 400, not a silently corrected body.
    if (suppliedScopeId !== null) {
      const canonical = freezeScopeId(scope, { tenant: tenantId });
      if (canonical !== null && canonical !== suppliedScopeId) {
        return errorResponse(response, 400, {
          code: 'FREEZE_SCOPE_ID_MISMATCH',
          message: `a ${scope} freeze is stored under ${canonical}, not ${suppliedScopeId}`,
          details: { scope, scope_id: suppliedScopeId, expected_scope_id: canonical },
        });
      }
    }
    // The scope falls back to guardian.freeze's OWN defaults, so the row the
    // demo writes is the row the banner and GET /v1/guardian read back.
    // The kill-switch write is an ON CONFLICT upsert, so a second trigger
    // after a re-enable re-freezes the SAME row with no database reset.
    const frozen = tryGuardian(() => guardian.freeze({
      repositories,
      tenantId,
      kind,
      details: { ...evaluation.details, reason: `${kind} tripped` },
      actor: typeof body.actor === 'string' && body.actor.trim().length > 0 ? body.actor.trim() : 'guardian',
      scope,
      ...(suppliedScopeId === null ? {} : { scopeId: suppliedScopeId }),
      at: nowIso,
    }), response);
    if (frozen === null) {
      return undefined;
    }
    response.status(201).json({
      ...frozen,
      incidents: repositories.guardianIncidents.listForTenant(tenantId, { limit: 20 }),
    });
  });

  app.post('/v1/guardian/re-enable', (request, response) => {
    const body = request.body ?? {};
    // The actor check runs BEFORE any write, so a request without one changes
    // nothing at all.
    if (typeof body.actor !== 'string' || body.actor.trim().length === 0) {
      return errorResponse(response, 400, {
        code: 'RE_ENABLE_ACTOR_REQUIRED',
        message: 'a re-enable needs an explicit human actor',
        details: { field: 'actor' },
      });
    }
    const result = tryGuardian(() => guardian.reEnable({
      repositories,
      tenantId: resolveTenantId(repositories, body.tenant_id),
      actor: body.actor.trim(),
      ...(typeof body.scope === 'string' && body.scope.length > 0 ? { scope: body.scope } : {}),
      ...(typeof body.scope_id === 'string' && body.scope_id.length > 0 ? { scopeId: body.scope_id } : {}),
    }), response);
    if (result === null) {
      return undefined;
    }
    // The response echoes the RESOLVED scope, not the requested one, so a
    // caller that guessed wrong can see what it actually cleared — and a
    // re-enable that matched no active row is a 409 above, never a 200
    // claiming automation is running again.
    response.status(200).json({ re_enabled: result.re_enabled, scope: result.scope, scope_id: result.scope_id });
  });

  app.get('/v1/guardian', (request, response) => {
    const tenantId = resolveTenantId(repositories, request.query.tenant_id);
    response.json({
      tenant_id: tenantId,
      // activeFor returns every scope for the tenant, so this answers with the
      // provider-scoped row the demo's trigger writes.
      switches: repositories.killSwitches.activeFor(tenantId),
      incidents: repositories.guardianIncidents.listForTenant(tenantId, { limit: 20 }),
    });
  });

  app.use('/v1', (request, response) => {
    response.status(404).json({ code: 'NOT_FOUND', message: `no API route for ${request.method} ${request.baseUrl}${request.path}` });
  });

  app.use((request, response) => {
    response.status(404).json({ code: 'NOT_FOUND', message: `no route for ${request.method} ${request.path}` });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, request, response, next) => {
    if (error?.type === 'entity.parse.failed') {
      errorResponse(response, 400, { code: 'BAD_JSON', message: 'request body must be valid JSON' });
      return;
    }
    console.error('unhandled request error:', error);
    response.status(500).json({ code: 'INTERNAL', message: 'internal error' });
  });

  return app;
}
