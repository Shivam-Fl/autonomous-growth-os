// Server-rendered pages: layout plus the five screens (TR-21), each with
// ideal, empty, loading, partial and error variants selected from store
// state. The ?state= preview override (empty|ideal|loading|partial|error)
// renders a shell for QA to drive on a fresh database; it never writes.
// The dashboard additionally reads the Meta provider passed in at render
// (per request, from routes) and renders its campaign regions from the typed
// read envelopes; ?meta_error=quota|revoked simulates a provider failure.

import { META_ERROR_CODES } from '../integrations/meta_ads/index.js';
import { DECISION_CLASSES, calibrationReport } from '../domain/decisions.js';
import { computeFunnel, coverageOf, dataThrough, maturityFor, policyBand, staleAgeHours } from '../domain/measurement.js';
import { canonicalCurrency, formatMoney, fromMicros } from '../domain/money.js';
import { isReadableComponent } from '../domain/opportunities.js';
import { gateForRetrieval, EVIDENCE_TYPE_TIERS } from '../memory/learnings.js';

const OVERRIDES = new Set(['empty', 'ideal', 'loading', 'partial', 'error']);
const ROUTES = ['/', '/journal', '/opportunities', '/experiments', '/approvals'];

export function resolveState(route, override, repositories) {
  const state = OVERRIDES.has(override) ? override : null;
  if (state) {
    return state;
  }
  const tenant = firstTenant(repositories);
  return tenant ? 'ideal' : 'empty';
}

function firstTenant(repositories) {
  return repositories?.tenants?.list?.()[0] ?? null;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout({ route, state, title, tenantName, content }) {
  const nav = [
    ['/', 'Dashboard'],
    ['/journal', 'Decision journal'],
    ['/opportunities', 'Opportunities'],
    ['/experiments', 'Experiments'],
    ['/approvals', 'Approvals'],
  ].map(([href, label]) => {
    const current = href === route ? ' aria-current="page"' : '';
    return `<a href="${href}"${current}>${label}</a>`;
  }).join('');

  // Exactly one h1 per document, and it is the only page-level heading any
  // screen gets: panel()'s <h2> is the level beneath it. Add a second h1 or
  // re-level the panels and the hierarchy breaks — the invariant is locked per
  // route and state in test/web/pages.test.js.
  const heading = `<h1 class="page-title" data-testid="page-title">${escapeHtml(title)}</h1>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Autonomous Growth OS</title>
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body data-page="${escapeHtml(route)}" data-state="${escapeHtml(state)}">
<a class="skip-link" href="#main">Skip to content</a>
<header class="app-header">
<a class="brand" href="/">Autonomous Growth OS</a>
<nav aria-label="Primary">${nav}</nav>
<div class="header-status" id="tenant-status">
<span class="tenant-name" id="tenant-name" data-testid="tenant-name">${escapeHtml(tenantName)}</span>
</div>
</header>
<div id="live-region" class="visually-hidden" aria-live="polite" role="status"></div>
<main id="main" tabindex="-1">
${heading}
${content}
</main>
<footer class="page-footer">
<p>Preview: add <code>?state=loading</code>, <code>?state=partial</code> or <code>?state=error</code> to any page to see that shell. The override changes nothing stored.</p>
</footer>
<script src="/assets/client.js" defer></script>
</body>
</html>`;
}

function panel({ kind = '', title, body, testid }) {
  return `<section class="panel ${kind}"${testid ? ` data-testid="${testid}"` : ''}>
<h2>${escapeHtml(title)}</h2>
${body}
</section>`;
}

function emptyState({ title, message, action, testid }) {
  return panel({
    kind: 'panel-empty',
    title,
    body: `<p class="empty-copy">${message}</p>${action ?? ''}`,
    testid,
  });
}

function errorPanel({ failed, stillTrue, retryHref }) {
  return panel({
    kind: 'panel-error',
    title: failed.title,
    body: `<p>${failed.detail}</p>
<p>What is still true: ${escapeHtml(stillTrue)}</p>
<button type="button" class="button" data-action="retry" data-retry-href="${escapeHtml(retryHref)}">Retry</button>`,
  });
}

function skeletonRows(count, className = 'skeleton-row') {
  return `<div class="skeleton-stack" aria-hidden="true">${Array.from({ length: count ?? 3 }, () => `<div class="skeleton ${className}"></div>`).join('')}</div>`;
}

export async function renderPage(route, { repositories, override = null, metaProvider = null, metaError = null, filters = null } = {}) {
  if (!ROUTES.includes(route)) {
    throw new Error(`unknown page route ${route}`);
  }
  const state = resolveState(route, override, repositories);
  const tenant = firstTenant(repositories);
  const content = await PAGES[route](state, { repositories, tenant, metaProvider, metaError, filters });
  // The header must never disagree with the body: chrome follows the effective
  // (post-override) state, so ?state=empty reads 'No connected account' even
  // when the store holds a tenant.
  const tenantName = state === 'empty' ? 'No connected account' : tenant ? tenant.name : 'No connected account';
  return layout({ route, state, title: TITLES[route], tenantName, content });
}

const TITLES = {
  '/': 'Command dashboard',
  '/journal': 'Decision journal',
  '/opportunities': 'Opportunities',
  '/experiments': 'Experiments',
  '/approvals': 'Approvals',
};

const PAGES = {
  '/': dashboard,
  '/journal': journal,
  '/opportunities': opportunities,
  '/experiments': experiments,
  '/approvals': approvals,
};

function eventsOf(repositories, tenant, type) {
  if (!tenant) {
    return [];
  }
  return repositories.rawEvents.list(tenant.id, { limit: 200 })
    .filter((event) => event.event_type === type);
}

function maturityBar(score) {
  const width = Math.round(score * 100);
  const label = score < 0.35 ? 'immature' : score < 0.7 ? 'protective' : score < 0.9 ? 'moderate' : 'strategic';
  return `<div class="maturity" role="img" aria-label="Maturity ${width}%: ${label}">
<span class="maturity-bar"><span class="maturity-fill" style="width:${width}%"></span></span>
<span class="maturity-label">Maturity ${width}% · ${label}</span>
</div>`;
}

// The Meta campaign regions (TR-13): four tables read through the typed
// adapter interface, each with headers and a row count, rows sorted by id.
// A failed read renders the error panel naming the failing check and keeps
// the prior rows visible from the provider's last-good snapshot.

const META_CHECKS = {
  [META_ERROR_CODES.QUOTA]: 'provider-sync/quota',
  [META_ERROR_CODES.PERMISSION]: 'provider-sync/permission',
};

// The ?meta_error= simulation names the same checks the typed envelope does,
// so the panel renders even if a simulation is wired to a provider that did
// not fail. Unknown values are ignored, like an unknown ?state=.
const META_SIMULATIONS = new Set(['quota', 'revoked']);
const META_SIMULATION_CHECKS = { quota: 'provider-sync/quota', revoked: 'provider-sync/permission' };

const META_TABLES = [
  ['campaigns', 'Meta campaigns', ['Id', 'Name', 'Status', 'Objective']],
  ['adSets', 'Meta ad sets', ['Id', 'Campaign', 'Name', 'Status', 'Daily budget']],
  ['ads', 'Meta ads', ['Id', 'Ad set', 'Name', 'Status']],
  ['insights', 'Meta insights', ['Id', 'Campaign', 'Spend', 'Impressions', 'Clicks']],
];

const META_CELLS = {
  campaigns: (row) => [row.id, row.name, row.status, row.objective],
  adSets: (row, currency) => [row.id, row.campaign_id, row.name, row.status, money(row.daily_budget_micros, currency)],
  ads: (row) => [row.id, row.ad_set_id, row.name, row.status],
  insights: (row, currency) => [row.id, row.campaign_id, money(row.spend_micros, currency), String(row.impressions), String(row.clicks)],
};

/**
 * The one place in this file that reads a tenant row's currency. A stored code
 * is an arbitrary string — tenants.create takes any string, and nothing the
 * app writes produces a non-canonical one — so it is resolved through the
 * domain's read-time boundary here rather than at each of the eight call
 * sites. A code naming no ISO currency at all falls back to INR, as before.
 */
function tenantCurrency(tenant) {
  return canonicalCurrency(tenant?.currency) ?? 'INR';
}

/**
 * The one money renderer in this file, over the repo's currency-aware
 * formatter, so every amount on every screen agrees with the dashboard's
 * Qualified CPL. Two guards keep a page strictly safer than the hand-rolled
 * rupee version it replaces: a value the domain's readability rule rejects
 * degrades to the em-dash (today's ₹NaN), and a currency naming no ISO
 * 4217 code at all falls back to INR rather than throwing — a page render
 * must not 500 on bad data. That fallback is a relabelling, not a
 * pass-through: a currency this build cannot render is drawn as INR, so a
 * tenant whose stored currency is bad data reads its amounts in rupees
 * rather than in its own code. That is a deliberate choice — the
 * alternative, printing the bare code ('ZZZ 1,000.00'), puts a
 * mislabelled-but-honest amount in front of a reader; this puts a
 * correctly-formatted amount whose unit is the repo default. The trade is
 * knowingly wrong-unit over knowingly unformatted.
 *
 * The fallback is for a code that names no currency, NOT for a code spelled
 * differently: 'usd', 'Usd' and ' USD ' are the same unit of account as 'USD'
 * and render as dollars, because canonicalCurrency resolves a stored code
 * before the membership test. Mis-casing a currency is not a currency error,
 * and a renderer that drew a tenant's amounts in the wrong unit over three
 * letters of case would be the bug, not the fix.
 *
 * The readability guard is the domain's, not a local re-derivation: it is the
 * same rule the wire projection and the contribution use, so an amount the API
 * reports as null cannot render as a number here. That rule is stricter than a
 * bare safe-integer check — a negative amount is a safe integer, and rendering
 * '-1.00' would be standing behind a number the rest of the app calls unknown.
 */
function money(micros, currency = 'INR') {
  if (!isReadableComponent('value_micros', micros)) {
    return '—';
  }
  return formatMoney(fromMicros(micros, canonicalCurrency(currency) ?? 'INR'));
}

function metaTable(collection, title, headers, rows, currency) {
  const cells = META_CELLS[collection];
  const body = rows.length === 0
    ? `<p class="empty-copy">No ${escapeHtml(title.toLowerCase())} in the last good sync.</p>`
    : `<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>
${rows.map((row) => `<tr>${cells(row, currency).map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}
</tbody></table>`;
  return panel({
    title: `${title} · ${rows.length} row${rows.length === 1 ? '' : 's'}`,
    body,
    testid: `meta-${collection}`,
  });
}

function metaSyncLine(syncedAt) {
  return `<p data-testid="meta-last-good">Meta last good sync ${escapeHtml(syncedAt)}</p>`;
}

function metaErrorPanel({ check, error }) {
  return errorPanel({
    failed: {
      title: 'Meta provider sync failed',
      detail: `Meta data could not be read (check: ${escapeHtml(check)}).${error ? ` ${escapeHtml(error.message)}` : ''}`,
    },
    stillTrue: 'nothing was changed by the failed read and no spend was recorded since.',
    retryHref: '/',
  });
}

async function metaRegions({ metaProvider, metaError, currency }) {
  if (!metaProvider) {
    return panel({
      title: 'Meta campaigns',
      body: `<p class="empty-copy">Meta data is not connected yet. Connect a Meta ad account to fill campaigns, ad sets, ads and insights here.</p>`,
      testid: 'meta-unavailable',
    });
  }

  const reads = {
    campaigns: await metaProvider.listCampaigns(),
    adSets: await metaProvider.listAdSets(),
    ads: await metaProvider.listAds(),
    insights: await metaProvider.getInsights(),
  };
  const failed = Object.values(reads).find((read) => !read.ok);
  const simulation = META_SIMULATIONS.has(metaError) ? metaError : null;

  if (!failed && !simulation) {
    const syncedAt = metaProvider.lastGood?.()?.synced_at ?? 'unknown';
    return `${metaSyncLine(syncedAt)}
${META_TABLES.map(([collection, title, headers]) => metaTable(collection, title, headers, reads[collection].data, currency)).join('')}`;
  }

  const check = failed ? META_CHECKS[failed.error.code] ?? 'provider-sync' : META_SIMULATION_CHECKS[simulation];
  const snapshot = metaProvider.lastGood?.() ?? null;
  const syncedAt = snapshot?.synced_at ?? 'unknown';
  const tables = META_TABLES
    .map(([collection, title, headers]) => {
      const rows = snapshot ? snapshot[collection] : reads[collection].ok ? reads[collection].data : null;
      return rows ? metaTable(collection, title, headers, rows, currency) : null;
    })
    .filter(Boolean);
  return `${metaErrorPanel({ check, error: failed?.error ?? null })}
${tables.length > 0 ? `${metaSyncLine(syncedAt)}
${tables.join('')}` : ''}`;
}

async function dashboard(state, { repositories, tenant, metaProvider, metaError }) {
  if (state === 'loading') {
    return `${panel({
      title: 'Loading KPIs',
      body: `<div class="skeleton-stack" aria-hidden="true">
<div class="skeleton kpi-card"></div><div class="skeleton kpi-card"></div><div class="skeleton kpi-card"></div>
<div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div>
</div>`,
    })}
${panel({
    title: 'Loading Meta campaigns',
    body: skeletonRows(4),
  })}`;
  }

  if (state === 'error') {
    return errorPanel({
      failed: {
        title: 'Provider sync failed',
        detail: 'Meta insights could not be reached: connection to graph.facebook.com timed out after 30s (check: provider-sync).',
      },
      stillTrue: 'budgets and campaign statuses are unchanged; no spend was recorded since the last good sync.',
      retryHref: '/',
    });
  }

  if (state === 'partial') {
    const through = tenant
      ? dataThrough(repositories.rawEvents.listByTypes(tenant.id, ['spend.observed', 'lead_qualified']))
      : null;
    const nowIso = new Date().toISOString();
    const age = tenant && through ? `${staleAgeHours(nowIso, through)}h ago` : 'unknown';
    return `<div class="banner banner-warn" role="status">Provider data is stale — last good sync ${escapeHtml(through ?? 'unknown')} (${escapeHtml(age)})</div>
${kpiStrip(state, { repositories, tenant, stale: true })}
${await metaRegions({ metaProvider, metaError, currency: tenantCurrency(tenant) })}
${decisionFeed(state, { repositories, tenant })}
${experimentsPanel(state, { repositories, tenant })}
${guardianPanel(state)}`;
  }

  if (!tenant || state === 'empty') {
    return emptyState({
      title: 'No connected ad account yet',
      message: 'Connect your ad platform and install measurement to bring this dashboard alive. Nothing is spent and nothing is changed by setup.',
      action: `<ol class="checklist">
<li><span class="check-step">Connect Meta Ads — approve read-only access</span><span class="check-time">about 5 minutes</span></li>
<li><span class="check-step">Install the pixel on your funnel pages</span><span class="check-time">about 15 minutes</span></li>
<li><span class="check-step">Confirm first spend appears here</span><span class="check-time">about 1 minute</span></li>
</ol>`,
      testid: 'dashboard-empty',
    });
  }

  return `${kpiStrip(state, { repositories, tenant })}
${await metaRegions({ metaProvider, metaError, currency: tenantCurrency(tenant) })}
${decisionFeed(state, { repositories, tenant })}
${experimentsPanel(state, { repositories, tenant })}
${guardianPanel(state)}`;
}

function maturityBadge(maturity) {
  const { label } = policyBand(maturity);
  // The emergency-only band reads as immature on a dashboard; the badge names
  // the data state, not the policy action it permits.
  const badge = label === 'emergency-only' ? 'immature' : label;
  return `<span class="maturity-label" data-testid="kpi-band">${escapeHtml(badge)}</span>`;
}

function kpiCard(label, value, maturity, dataThrough) {
  return `<div class="kpi-card">
<span class="kpi-label">${escapeHtml(label)}</span>
<span class="kpi-value">${escapeHtml(value)}</span>
${maturityBadge(maturity)}
${maturityBar(maturity)}
<span class="maturity-label">data through ${escapeHtml(dataThrough ?? '—')}</span>
</div>`;
}

function kpiStrip(state, { repositories, tenant }) {
  if (!tenant) {
    return `<section class="kpi-strip" aria-label="KPIs"></section>`;
  }
  const rows = repositories.rawEvents.listByTypes(tenant.id, ['spend.observed', 'lead_qualified']);
  // Same tenant-currency exclusion GET /v1/metrics applies (routes.js): the
  // tenant row's currency leaves foreign-currency legacy spend out of the sum.
  const funnel = computeFunnel(rows, tenantCurrency(tenant));
  const coverage = coverageOf(rows);
  const through = dataThrough(rows);
  const nowIso = new Date().toISOString();
  const ageHours = through ? (Date.parse(nowIso) - Date.parse(through)) / 3_600_000 : 0;
  const maturity = maturityFor(ageHours);
  const { gated } = policyBand(maturity);
  const cpl = funnel.qualified_cpl_micros;
  const cards = [
    // Same tenant-wide rule GET /v1/metrics applies, and now the same renderer
    // as every other amount on every other screen: integer micros divided,
    // formatted without floats, em-dash while the volume is zero (money()'
    // safe-integer guard).
    kpiCard('Qualified CPL', money(cpl, tenantCurrency(tenant)), maturity, through),
    kpiCard('Qualified volume', String(funnel.qualified_volume), maturity, through),
    kpiCard('Maturity coverage', coverage.toFixed(2), maturity, through),
  ];

  return `<section class="kpi-strip" aria-label="KPIs">
${cards.join('')}
${gated ? `<p class="maturity-label" data-testid="maturity-gate">Strategic actions blocked until maturity passes 0.90</p>` : ''}
</section>`;
}

function decisionFeed(state, { repositories, tenant }) {
  const decisions = eventsOf(repositories, tenant, 'decision.recorded');
  const rows = decisions.map((event) => `<tr>
<td>${escapeHtml(event.occurred_at)}</td>
<td>${escapeHtml(event.payload.class ?? 'unknown')}</td>
<td>${escapeHtml(event.payload.expected ?? '—')}</td>
<td>${escapeHtml(event.payload.status ?? 'shadow')} ${evidenceRefsCell(event)}</td>
</tr>`).join('');
  return panel({
    title: `Decision feed · ${decisions.length} row${decisions.length === 1 ? '' : 's'}`,
    body: decisions.length === 0
      ? `<p class="empty-copy">No decisions recorded yet. Decisions appear here once shadow mode starts.</p>`
      : `<table><thead><tr><th>When</th><th>Action class</th><th>Expected</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`,
  });
}

function experimentsPanel(state, { repositories, tenant }) {
  // Same source the /experiments page reads (issue #22): the repository, not
  // the dead experiment.started raw-event stream nothing ever wrote.
  const experiments = tenant ? repositories.experiments.list(tenant.id) : [];
  const cards = experiments.map((experiment) => {
    const badge = STATE_BADGES[experiment.state] ?? experiment.state;
    const arms = experiment.record?.arms?.length ?? 0;
    return `<li class="experiment-card" data-experiment-id="${escapeHtml(experiment.experiment_id)}">
<strong>${escapeHtml(experiment.name)}</strong>
<span>State: ${escapeHtml(badge)} · arms: ${escapeHtml(String(arms))}</span>
</li>`;
  }).join('');
  return panel({
    title: `Open experiments · ${experiments.length}`,
    body: experiments.length === 0
      ? `<p class="empty-copy">No open experiments. Nothing is being tested right now.</p>`
      : `<ul class="experiment-list">${cards}</ul>`,
  });
}

function guardianPanel(state) {
  return panel({
    title: 'Guardian incidents',
    body: `<p class="empty-copy">No guardian incidents in the last 24 hours.</p>`,
  });
}

// The decision journal (TR-15) reads the decisions repository, never the
// frozen replay fixture: rows come from the journals table, the calibration
// summary is computed live from the same rows, and the frozen-replay report
// (0.70 precision over the CI fixtures) is deliberately absent — it belongs
// to test runs, not to the page.

const DECISION_SCENARIOS = ['replay-cpl-hold', 'replay-tracking-outage'];

function percent(part) {
  const value = Math.round(part * 100);
  if (value === 0) {
    return '0%';
  }
  const sign = value > 0 ? '+' : '−';
  return `${sign}${Math.abs(value)}%`;
}

function expectedEffectOf(row) {
  const selected = (row.alternatives ?? []).find((entry) => entry.action === row.selected_action);
  if (!selected?.expected_outcomes) {
    return '—';
  }
  const { mean, p10, p90 } = selected.expected_outcomes;
  return `${percent(mean)} (${percent(p10)} … ${percent(p90)})`;
}

function decisionsOf(repositories, tenant) {
  if (!tenant) {
    return [];
  }
  return repositories.decisions?.list?.(tenant.id) ?? [];
}

function journalTable(rows, filters) {
  const body = rows.length === 0
    ? `<p class="empty-copy">No decisions match the current filters. Widen the class or status filter, or clear both, to see the full journal.</p>`
    : `<table><thead><tr><th><span class="visually-hidden">Open</span></th><th>When</th><th>Action class</th><th>Selected</th><th>Expected</th><th>Matured</th><th>Status</th></tr></thead><tbody>
${rows.map(journalRow).join('')}
</tbody></table>`;
  return panel({
    title: `Decision journal · ${rows.length} row${rows.length === 1 ? '' : 's'}`,
    body,
  });
}

function journalDrawerShell() {
  // Empty, hidden server-side; client.js fills it from GET /v1/decisions/:id
  // when a row is opened and moves focus in. Close returns focus to the row.
  return `<aside id="journal-drawer" data-testid="journal-drawer" role="dialog" aria-modal="true" aria-labelledby="journal-drawer-title" hidden>
<h2 id="journal-drawer-title">Decision detail</h2>
<div class="journal-drawer-body" id="journal-drawer-body"></div>
<button type="button" class="button" data-action="close-drawer">Close</button>
</aside>`;
}

function journalCalibration(rows) {
  const report = calibrationReport(rows);
  const precision = report.precision === null
    ? 'Precision — (no matured evaluations yet)'
    : `Precision ${report.precision.toFixed(2)} over ${report.evaluated} matured decisions`;
  const falseIntervention = report.falseInterventionRate === null
    ? 'False-intervention rate — (no interventions evaluated yet)'
    : `False-intervention rate ${report.falseInterventionRate.toFixed(2)} over ${report.interventions} interventions`;
  return panel({
    title: 'Calibration',
    body: `<p data-testid="journal-precision">${escapeHtml(precision)}</p>
<p data-testid="journal-false-intervention">${escapeHtml(falseIntervention)}</p>
<p data-testid="journal-awaiting">${report.awaitingMaturity} awaiting maturity</p>`,
  });
}

function journal(state, { repositories, tenant, filters }) {
  if (state === 'loading') {
    return `${panel({ title: 'Loading decisions', body: skeletonRows(4) })}
${panel({ title: 'Calibration', body: `<p class="empty-copy" data-testid="journal-calibration-refreshing">Cached calibration — refreshing…</p>` })}`;
  }

  // The error shell is a preview: it names the frozen scenario that failed,
  // keeps every prior journal entry on screen (rows read live below the
  // panel), and offers a Retry per scenario.
  if (state === 'error') {
    const rows = decisionsOf(repositories, tenant);
    return `${errorPanel({
      failed: {
        title: 'Replay evaluation failed for scenario replay-tracking-outage',
        detail: 'The replay evaluation could not run for this scenario (check: replay-runner).',
      },
      stillTrue: 'every prior journal entry is preserved and untouched.',
      retryHref: '/journal',
    })}
${rows.length > 0 ? journalTable(rows, filters) : `<section class="panel"><h2>Decision journal</h2><p class="empty-copy">Shadow mode has not started. Once it starts, every decision the system considers appears here, and a failed replay leaves prior entries untouched.</p></section>`}
<div class="journal-retries">
${DECISION_SCENARIOS.map((scenario) => `<button type="button" class="button button-secondary" data-action="retry" data-retry-href="/journal">Retry replay evaluation for ${escapeHtml(scenario)}</button>`).join('')}
</div>
${journalDrawerShell()}`;
  }

  const rows = decisionsOf(repositories, tenant);

  if (state === 'partial') {
    const awaiting = rows.filter((row) => !row.evaluation);
    return `<div class="banner banner-warn" role="status">Some recent decisions have not reached maturity yet, so they carry no evaluation.</div>
${journalTable(rows, filters)}
${panel({
    title: 'Awaiting maturity',
    body: awaiting.length === 0
      ? `<p class="empty-copy">No recent decisions awaiting maturity. Once shadow mode runs, unevaluated decisions appear here with their expected evaluation dates.</p>`
      : `<ul class="awaiting-list">${awaiting.map((row) => `<li data-decision-id="${escapeHtml(row.decision_id)}">
<strong>${escapeHtml(row.decision_id)}</strong>
<span>Awaiting maturity — expected evaluation ${escapeHtml(formatDate(row.expected_evaluation_at))}</span>
</li>`).join('')}</ul>`,
  })}
${journalCalibration(rows)}
${journalDrawerShell()}`;
  }

  if (state === 'empty' || rows.length === 0) {
    return emptyState({
      title: 'Shadow mode has not started',
      message: 'Before shadow mode starts this journal is empty. Once it starts, every decision the system considers appears here: the alternatives it weighed (including do-nothing), the expected effect, and how the matured outcome compared.',
      action: `<a class="button" href="/journal?state=partial">Start the first replay</a>`,
      testid: 'journal-empty',
    });
  }

  // Ideal: filter form, journal table and live calibration read from the
  // decisions repository. The frozen replay's aggregate never reaches here.
  const filtered = repositories.decisions.list(tenant.id, {
    class: DECISION_CLASSES.includes(filters?.class) ? filters.class : null,
    status: ['awaiting-maturity', 'matured'].includes(filters?.status) ? filters.status : null,
  });
  return `${journalFilters(filters)}
${journalTable(filtered, filters)}
${journalCalibration(rows)}
${journalDrawerShell()}`;
}

function formatDate(iso) {
  if (!iso) {
    return '—';
  }
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
  return `${at.getUTCDate()} ${months[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}


function journalFilters(filters) {
  // Two native selects with a GET submit: the browser does the filtering, so
  // no JS is required. Unknown values degrade to the unfiltered options.
  const classValue = DECISION_CLASSES.includes(filters?.class) ? filters.class : '';
  const statusValue = ['awaiting-maturity', 'matured'].includes(filters?.status) ? filters.status : '';
  return `<form class="journal-filters" method="get" action="/journal" data-testid="journal-filters">
<div class="journal-filter-control">
<label for="journal-filter-class">Action class</label>
<select id="journal-filter-class" name="class">
<option value="">All classes</option>
${DECISION_CLASSES.map((cls) => `<option value="${cls}"${cls === classValue ? ' selected' : ''}>${escapeHtml(cls.replaceAll('-', ' '))}</option>`).join('')}
</select>
</div>
<div class="journal-filter-control">
<label for="journal-filter-status">Status</label>
<select id="journal-filter-status" name="status">
<option value="">All statuses</option>
<option value="awaiting-maturity"${statusValue === 'awaiting-maturity' ? ' selected' : ''}>awaiting maturity</option>
<option value="matured"${statusValue === 'matured' ? ' selected' : ''}>matured</option>
</select>
</div>
<button type="submit" class="button button-secondary">Apply filters</button>
</form>`;
}

function journalRow(row, index) {
  return `<tr class="journal-row" data-decision-id="${escapeHtml(row.decision_id)}">
<td>
<button type="button" class="button button-secondary journal-open" data-action="open-decision" data-decision-id="${escapeHtml(row.decision_id)}" aria-haspopup="dialog" aria-label="Open decision detail for ${escapeHtml(row.decision_id)}">Open</button>
</td>
<td>${escapeHtml(row.decided_at)}</td>
<td>${escapeHtml(row.action_class.replaceAll('-', ' '))}</td>
<td>${escapeHtml(row.selected_action.replaceAll('_', ' '))}</td>
<td>${escapeHtml(expectedEffectOf(row))}</td>
<td>${row.evaluation ? 'evaluated' : 'pending'}</td>
<td>${escapeHtml(row.status ?? 'shadow')}</td>
</tr>`;
}

/** The research-observations panel (TR-10): the tenant's accepted learnings,
 * run through the retrieval gate — only rows that survive scoping, freshness
 * and confidence reach the page, SQL-prefiltered by scope and capped at the
 * latest 5 with their evidence tier. Rendered above the opportunity queue or
 * its empty copy whenever at least one learning is serviceable. */
function researchObservations(repositories, tenant) {
  if (!tenant) {
    return '';
  }
  const served = gateForRetrieval(repositories.learnings.listForContext(tenant.id, { tenant: tenant.id }), {
    context: { tenant: tenant.id },
    nowIso: new Date().toISOString(),
  });
  if (served.length === 0) {
    return '';
  }
  const shown = served.slice(-5);
  const items = shown.map((learning) => `<li class="learning-card">
<strong>${escapeHtml(learning.claim)}</strong>
<span>tier ${escapeHtml(EVIDENCE_TYPE_TIERS[learning.evidenceType] ?? 'E')} · confidence ${escapeHtml(learning.confidence.toFixed(2))} · evidence: ${escapeHtml(String(learning.evidenceRefs.length))} · ${escapeHtml(learning.id)}</span>
</li>`).join('');
  const count = shown.length === served.length ? `${served.length}` : `${shown.length} of ${served.length}`;
  return panel({
    title: `Research observations · ${count}`,
    body: `<ul class="learning-list">${items}</ul>`,
    testid: 'research-observations',
  });
}

/** The decision row's evidence refs: payload refs rendered escaped and
 * compactly; rows with none show an em-dash so the column stays aligned. */
function evidenceRefsCell(event) {
  const refs = [
    ...(event.payload.evidence_refs ?? []),
    ...(event.payload.memory_refs ?? []),
  ];
  return `<span class="maturity-label" data-testid="evidence-refs">${refs.length === 0 ? '—' : escapeHtml(refs.join(', '))}</span>`;
}

// The opportunity queue and experiment screens read the repositories, not
// placeholder raw events (opportunity.scored / experiment.started were never
// written by anything). Ranked rows render in repository order — stored score
// desc, id asc — and are never re-sorted in the view.

const COMPONENT_LABELS = [
  ['value_micros', 'value'],
  ['pSuccess', 'success probability'],
  ['fit', 'fit'],
  ['infoValue', 'information value'],
  ['reversibility', 'reversibility'],
  ['cost_micros', 'cost'],
  ['downside', 'downside'],
  ['delay', 'delay'],
];

// The two money components are integer micros and render as money, so a reader
// never has to guess whether 6000000000 is rupees or micros; the other six are
// dimensionless multipliers and stay as plain numbers.
const MONEY_COMPONENTS = new Set(['value_micros', 'cost_micros']);

function opportunityRow(row, currency) {
  const components = COMPONENT_LABELS
    .map(([key, label]) => {
      // An absent component — a record stored before the micros rename, say —
      // keeps the '—' placeholder; the repository projects that as null rather
      // than dropping the key, and both readings land here.
      const raw = row.components[key];
      const shown = raw == null ? '—' : MONEY_COMPONENTS.has(key) ? money(raw, currency) : String(raw);
      return `<span class="score-component" data-component="${key}">${escapeHtml(label)} ${escapeHtml(shown)}</span>`;
    })
    .join('');
  return `<li class="opportunity-row" data-testid="opportunity-row" data-opportunity-id="${escapeHtml(row.opportunity_id)}">
<strong>${escapeHtml(row.name)}</strong>
<span>score <span class="kpi-value" data-testid="opportunity-score">${escapeHtml(String(row.score))}</span></span>
<div class="score-components" data-testid="score-components">${components}</div>
</li>`;
}

function rankedList(rows, emptyCopy, currency) {
  return panel({
    title: `Ranked opportunities · ${rows.length}`,
    body: rows.length === 0
      ? `<p class="empty-copy">${emptyCopy}</p>`
      // The explicit arrow keeps map's index out of the currency slot.
      : `<ul class="opportunity-list">${rows.map((row) => opportunityRow(row, currency)).join('')}</ul>`,
  });
}

function opportunities(state, { repositories, tenant }) {
  if (state === 'loading') {
    return panel({ title: 'Loading opportunity queue', body: skeletonRows(3, 'skeleton-card') });
  }

  if (state === 'error') {
    return errorPanel({
      failed: {
        title: 'Opportunity fetch failed',
        detail: 'The opportunity and experiment store did not respond (source: opportunity store). Drafts and scores are preserved.',
      },
      stillTrue: 'drafted hypotheses and their score components are preserved.',
      retryHref: '/opportunities',
    });
  }

  // Rows always come from the repository in stored-score order, even under
  // the partial shell: only the provisional-scores banner differs.
  const ranked = tenant ? repositories.opportunities.list(tenant.id) : [];

  if (state === 'partial') {
    return `<div class="banner banner-warn" role="status">Some experiment arms await maturity — scores shown are provisional until conversions mature.</div>
${researchObservations(repositories, tenant)}
${rankedList(ranked, 'No opportunities scored yet; the research pass has not produced any provisional bets.', tenantCurrency(tenant))}`;
  }

  if (state === 'empty' || ranked.length === 0) {
    return `${researchObservations(repositories, tenant)}
${emptyState({
      title: 'The opportunity queue is empty',
      message: 'The strategist would investigate first: where recent lead quality dropped by campaign, what upstream search demand is growing for your converting intent, and which channels sit below your current qualified CPL. Running the first research pass populates this queue with ranked, scored bets.',
      action: `<a class="button" href="/opportunities?state=loading">Run the first research pass</a>`,
      testid: 'opportunities-empty',
    })}`;
  }

  return `${researchObservations(repositories, tenant)}
${rankedList(ranked, '', tenantCurrency(tenant))}`;
}

const STATE_BADGES = {
  draft: 'Draft',
  running: 'Running',
  matured: 'Matured',
  stopped: 'Stopped',
  inconclusive: 'Inconclusive',
};

function experimentCard(experiment, currency) {
  const badge = STATE_BADGES[experiment.state] ?? experiment.state;
  const inconclusive = experiment.state === 'inconclusive';
  const stopRules = experiment.record?.stopRules ?? {};
  // An experiment stored with no caps at all renders '—' twice rather than
  // ₹NaN twice: money()'s readability guard is what covers the absent keys.
  const caps = experiment.record?.caps ?? {};
  return `<li class="experiment-card" data-testid="experiment-card" data-experiment-id="${escapeHtml(experiment.experiment_id)}">
<strong>${escapeHtml(experiment.name)}</strong>
<span data-testid="caps">Max spend ${escapeHtml(money(caps.max_spend_micros, currency))} · max downside ${escapeHtml(money(caps.max_downside_micros, currency))}</span>
<div data-testid="stop-rules">stop rules: minimum runtime ${escapeHtml(String(stopRules.min_runtime_hours ?? '—'))}h, minimum sample ${escapeHtml(String(stopRules.min_sample ?? '—'))}, success threshold ${escapeHtml(String(stopRules.success_threshold ?? '—'))}, harm threshold ${escapeHtml(String(stopRules.harm_threshold ?? '—'))}</div>
<span class="maturity-label" data-testid="exp-state">${escapeHtml(badge)}${experiment.evaluation_reason && (inconclusive || experiment.state === 'stopped') ? ` (${escapeHtml(experiment.evaluation_reason)})` : ''}</span>
<span class="maturity-label" data-testid="data-through">data through ${escapeHtml(experiment.data_through ?? '—')}</span>
</li>`;
}

function hypothesisComposer() {
  // The composer is kept mounted on the error shell too (below), so a failed
  // fetch never loses a draft: client.js persists every field to localStorage
  // on input and restores it on load under the opp_exp_draft_ namespace.
  return `<form class="hypothesis-composer" data-testid="hypothesis-composer">
<h3>New hypothesis</h3>
<div class="journal-filter-control">
<label for="composer-title">Title</label>
<input id="composer-title" name="title" data-draft-key="opp_exp_draft_title" placeholder="e.g. Exact-intent search deserves more budget">
</div>
<div class="journal-filter-control">
<label for="composer-thesis">Thesis</label>
<textarea id="composer-thesis" name="thesis" rows="3" data-draft-key="opp_exp_draft_thesis" placeholder="What you expect to happen, and why, with the evidence you have."></textarea>
</div>
<div class="journal-filter-control">
<label for="composer-cap">Suggested cap (micros)</label>
<input id="composer-cap" name="cap" type="number" min="1" data-draft-key="opp_exp_draft_cap" placeholder="500000000">
</div>
</form>`;
}

function experiments(state, { repositories, tenant }) {
  if (state === 'loading') {
    return panel({ title: 'Loading experiments', body: skeletonRows(3, 'skeleton-card') });
  }

  if (state === 'error') {
    // The composer stays mounted beside the error panel: client.js restores
    // the typed draft from localStorage, so a failed fetch loses nothing.
    return `${errorPanel({
      failed: {
        title: 'Experiment fetch failed',
        detail: 'The experiment store could not be read (source: experiment store). In-progress drafts are preserved.',
      },
      stillTrue: 'drafted hypotheses and score components are preserved.',
      retryHref: '/experiments',
    })}
${hypothesisComposer()}`;
  }

  const cards = tenant ? repositories.experiments.list(tenant.id) : [];

  if (state === 'partial') {
    return `<div class="banner banner-warn" role="status">Some arms await maturity — data through the last conversion date is shown per experiment.</div>
${panel({
    title: 'Running experiments',
    body: cards.length === 0
      ? `<p class="empty-copy">No experiments running, so no arms await maturity.</p>`
      : `<ul class="experiment-list">${cards.map((card) => experimentCard(card, tenantCurrency(tenant))).join('')}</ul>`,
  })}
${hypothesisComposer()}`;
  }

  if (state === 'empty' || cards.length === 0) {
    return emptyState({
      title: 'No experiments yet',
      message: 'Experiments settle which bet wins. Each one carries spend caps, stop rules, and a first-class inconclusive state, so a result you cannot trust never masquerades as a winner. Compose the first hypothesis to begin.',
      action: `<a class="button" href="/experiments?state=loading">Compose the first hypothesis</a>`,
      testid: 'experiments-empty',
    }) + hypothesisComposer();
  }

  return panel({
    title: `Running experiments · ${cards.length}`,
    body: `<ul class="experiment-list">${cards.map((card) => experimentCard(card, tenantCurrency(tenant))).join('')}</ul>`,
  }) + hypothesisComposer();
}

const AUTONOMY_POSTURE = [
  ['Budget change', 'approval required', 'spend moves are high downside'],
  ['Campaign status change', 'autonomous under micro-limits', 'reversible, small blast radius'],
  ['Creative refresh', 'shadow', 'creative changes are being evaluated before authority'],
  ['New campaign launch', 'approval required', 'irreversible structure change'],
];

function approvals(state, { repositories, tenant }) {
  if (state === 'loading') {
    return panel({ title: 'Loading approval queue', body: skeletonRows(3, 'skeleton-card') });
  }

  if (state === 'error') {
    return errorPanel({
      failed: {
        title: 'Approval action failed',
        detail: 'The last approval action could not be completed: reconciliation against provider state is still unknown (check: reconciliation).',
      },
      stillTrue: 'the affected item stays pending and nothing was executed.',
      retryHref: '/approvals',
    });
  }

  const pending = eventsOf(repositories, tenant, 'approval.requested')
    .filter((event) => event.payload.status !== 'approved');
  const posture = `<section class="panel">
<h2>Autonomy posture by action class</h2>
<table><thead><tr><th>Action class</th><th>Posture</th><th>Why</th></tr></thead><tbody>
${AUTONOMY_POSTURE.map(([actionClass, posture, why]) => `<tr><td>${escapeHtml(actionClass)}</td><td>${escapeHtml(posture)}</td><td>${escapeHtml(why)}</td></tr>`).join('')}
</tbody></table>
</section>`;

  if (state === 'empty' || (pending.length === 0 && state === 'ideal')) {
    return `${emptyState({
      title: 'No pending approvals',
      message: 'Emptiness here is healthy: it means the system is operating inside the autonomy it has earned, and nothing needs a human yes or no.',
      testid: 'approvals-empty',
    })}
${posture}`;
  }

  if (state === 'partial') {
    return `<div class="banner banner-warn" role="status">Expired approvals are shown as lapsed instead of vanishing.</div>
${panel({
    title: 'Lapsed approvals',
    body: `<p class="empty-copy">One approval expired without a decision and is kept here for the audit trail.</p>
<a class="button" href="/approvals?state=error">Retry the lapsed item</a>`,
  })}
${posture}`;
  }

  const queue = pending.map((event) => `<li class="approval-card">
<strong>${escapeHtml(event.payload.name ?? 'Approval')}</strong>
<span>impact ${escapeHtml(event.payload.impact ?? '—')} · downside ${escapeHtml(event.payload.downside ?? '—')} · expires ${escapeHtml(event.payload.expires ?? '—')}</span>
<form class="approval-actions" data-approval>
<label class="visually-hidden" for="reason-${escapeHtml(event.event_id)}">Reason</label>
<input id="reason-${escapeHtml(event.event_id)}" name="reason" placeholder="Reason">
<button type="button" class="button" data-action="approve">Approve</button>
<button type="button" class="button button-secondary" data-action="reject">Reject</button>
</form>
</li>`).join('');
  return `${panel({
    title: `Pending approvals · ${pending.length}`,
    body: `<ul class="approval-list">${queue}</ul>`,
  })}
${posture}`;
}
