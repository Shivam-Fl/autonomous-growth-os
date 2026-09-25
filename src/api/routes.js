// HTTP surface: GET /health, the five server-rendered pages, static assets,
// POST /v1/events ingest, GET /v1/metrics, and a {code,message} error
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
import { FakeMetaAdsProvider, FAILURE_MODES } from '../integrations/meta_ads/fake.js';

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
