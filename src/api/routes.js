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
import { utcNow } from '../data/db.js';
import {
  calibrationReport,
  expectedEvaluationAtIso,
  evaluationStatus,
  validateDecisionRecord,
} from '../domain/decisions.js';
import { FakeMetaAdsProvider, FAILURE_MODES } from '../integrations/meta_ads/fake.js';
import { validateOpportunity, scoreOpportunity, expectedContribution } from '../domain/opportunities.js';
import { validateExperiment, evaluateExperiment } from '../domain/experiments.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ?meta_error=quota|revoked drives the fake provider's failure injection for
// simulation; anything else is ignored, exactly like an unknown ?state=.
const META_ERROR_PARAMS = new Set([...FAILURE_MODES].filter((mode) => mode !== 'ok'));

function packageVersion() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
}

const FUNNEL_TYPES = ['spend.observed', 'lead_qualified'];

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

function errorResponse(response, status, error) {
  // Stable codes only: a stack trace never crosses the HTTP boundary.
  response
    .status(status)
    .json({ code: error.code ?? 'INTERNAL', message: error.message, ...(error.details ? { details: error.details } : {}) });
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

export function buildApp({ repositories }) {
  const app = express();
  app.disable('x-powered-by');

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
      // one browser tab cannot see another's simulated failure.
      const metaError = META_ERROR_PARAMS.has(request.query.meta_error)
        ? request.query.meta_error
        : null;
      const metaProvider = new FakeMetaAdsProvider({ failureMode: metaError ?? 'ok' });
      response
        .type('html')
        .send(await renderPage(route, {
          repositories,
          override: request.query.state ?? null,
          metaProvider,
          metaError,
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
    if (spendCurrency !== undefined && existingTenant && existingTenant.currency !== spendCurrency) {
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
    // The tenant row's currency (INR default when absent) excludes any
    // foreign-currency spend rows legacy batches may still hold.
    const tenantCurrency = repositories.tenants.get(tenantId)?.currency ?? 'INR';
    const funnel = computeFunnel(rows, tenantCurrency);
    const latest = dataThrough(rows);
    const now = utcNow();
    const ageHours = latest ? (Date.parse(now) - Date.parse(latest)) / 3_600_000 : 0;
    const maturity = maturityFor(ageHours);
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
      data_through: latest,
      stale: isStale(now, latest),
      stale_age: staleAgeHours(now, latest) ?? null,
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
