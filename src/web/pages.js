// Server-rendered pages: layout plus the five screens (TR-21), each with
// ideal, empty, loading, partial and error variants selected from store
// state. The ?state= preview override (empty|ideal|loading|partial|error)
// renders a shell for QA to drive on a fresh database; it never writes.
// The dashboard additionally reads the Meta provider passed in at render
// (per request, from routes) and renders its campaign regions from the typed
// read envelopes; ?meta_error=quota|revoked simulates a provider failure.

import { META_ERROR_CODES } from '../integrations/meta_ads/index.js';

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
<main id="main">
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

export async function renderPage(route, { repositories, override = null, metaProvider = null, metaError = null } = {}) {
  if (!ROUTES.includes(route)) {
    throw new Error(`unknown page route ${route}`);
  }
  const state = resolveState(route, override, repositories);
  const tenant = firstTenant(repositories);
  const content = await PAGES[route](state, { repositories, tenant, metaProvider, metaError });
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

function spentMicros(repositories, tenant) {
  if (!tenant) {
    return 0;
  }
  const spend = repositories.derived.list(tenant.id)
    .filter((row) => row.metric === 'spend_micros');
  return spend.reduce((total, row) => total + row.value_micros, 0);
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
  adSets: (row) => [row.id, row.campaign_id, row.name, row.status, money(row.daily_budget_micros)],
  ads: (row) => [row.id, row.ad_set_id, row.name, row.status],
  insights: (row) => [row.id, row.campaign_id, money(row.spend_micros), String(row.impressions), String(row.clicks)],
};

function money(micros) {
  return `₹${(micros / 1_000_000).toFixed(2)}`;
}

function metaTable(collection, title, headers, rows) {
  const cells = META_CELLS[collection];
  const body = rows.length === 0
    ? `<p class="empty-copy">No ${escapeHtml(title.toLowerCase())} in the last good sync.</p>`
    : `<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>
${rows.map((row) => `<tr>${cells(row).map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}
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

async function metaRegions({ metaProvider, metaError }) {
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
${META_TABLES.map(([collection, title, headers]) => metaTable(collection, title, headers, reads[collection].data)).join('')}`;
  }

  const check = failed ? META_CHECKS[failed.error.code] ?? 'provider-sync' : META_SIMULATION_CHECKS[simulation];
  const snapshot = metaProvider.lastGood?.() ?? null;
  const syncedAt = snapshot?.synced_at ?? 'unknown';
  const tables = META_TABLES
    .map(([collection, title, headers]) => {
      const rows = snapshot ? snapshot[collection] : reads[collection].ok ? reads[collection].data : null;
      return rows ? metaTable(collection, title, headers, rows) : null;
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
    const lastGood = tenant
      ? eventsOf(repositories, tenant, 'spend.observed').at(-1)?.occurred_at ?? 'unknown'
      : 'unknown';
    return `<div class="banner banner-warn" role="status">Provider data is stale — last good sync ${escapeHtml(lastGood)}</div>
${kpiStrip(state, { repositories, tenant, stale: true })}
${await metaRegions({ metaProvider, metaError })}
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
${await metaRegions({ metaProvider, metaError })}
${decisionFeed(state, { repositories, tenant })}
${experimentsPanel(state, { repositories, tenant })}
${guardianPanel(state)}`;
}

function kpiStrip(state, { repositories, tenant }) {
  const spend = spentMicros(repositories, tenant);
  const qualified = eventsOf(repositories, tenant, 'lead.qualified').length;
  const cpl = qualified > 0 ? Math.round(spend / qualified) : null;
  const cards = [
    ['Qualified CPL', cpl === null ? '—' : `₹${(cpl / 1_000_000).toFixed(2)}`],
    ['Qualified volume', String(qualified)],
    ['Maturity coverage', '0.00'],
  ].map(([label, value]) => `<div class="kpi-card"><span class="kpi-label">${escapeHtml(label)}</span><span class="kpi-value">${escapeHtml(value)}</span></div>`);

  return `<section class="kpi-strip" aria-label="KPIs">
${cards.join('')}
</section>`;
}

function decisionFeed(state, { repositories, tenant }) {
  const decisions = eventsOf(repositories, tenant, 'decision.recorded');
  const rows = decisions.map((event) => `<tr>
<td>${escapeHtml(event.occurred_at)}</td>
<td>${escapeHtml(event.payload.class ?? 'unknown')}</td>
<td>${escapeHtml(event.payload.expected ?? '—')}</td>
<td>${escapeHtml(event.payload.status ?? 'shadow')}</td>
</tr>`).join('');
  return panel({
    title: `Decision feed · ${decisions.length} row${decisions.length === 1 ? '' : 's'}`,
    body: decisions.length === 0
      ? `<p class="empty-copy">No decisions recorded yet. Decisions appear here once shadow mode starts.</p>`
      : `<table><thead><tr><th>When</th><th>Action class</th><th>Expected</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`,
  });
}

function experimentsPanel(state, { repositories, tenant }) {
  const experiments = eventsOf(repositories, tenant, 'experiment.started');
  const cards = experiments.map((event) => `<li class="experiment-card">
<strong>${escapeHtml(event.payload.name ?? 'Experiment')}</strong>
<span>State: ${escapeHtml(event.payload.state ?? 'running')} · arms: ${escapeHtml(String(event.payload.arms ?? 2))}</span>
</li>`).join('');
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

function journal(state, { repositories, tenant }) {
  if (state === 'loading') {
    return `${panel({ title: 'Loading decisions', body: skeletonRows(4) })}
${panel({ title: 'Calibration', body: `<p class="empty-copy">Cached last run — refreshing…</p>` })}`;
  }

  if (state === 'error') {
    return errorPanel({
      failed: {
        title: 'Replay evaluation failed',
        detail: 'Scenario replay-2026-09-25 could not be evaluated: derived metrics unavailable (check: replay-runner).',
      },
      stillTrue: 'every prior journal entry is preserved and untouched.',
      retryHref: '/journal',
    });
  }

  if (state === 'partial') {
    const decisions = eventsOf(repositories, tenant, 'decision.recorded');
    return `${panel({
      title: 'Awaiting maturity',
      body: decisions.length === 0
        ? `<p class="empty-copy">No recent decisions awaiting maturity. Once shadow mode runs, unevaluated decisions appear here with their expected evaluation dates.</p>`
        : `<table><thead><tr><th>When</th><th>Action class</th><th>Expected</th><th>Status</th></tr></thead><tbody>
${decisions.map((event) => `<tr>
<td>${escapeHtml(event.occurred_at)}</td>
<td>${escapeHtml(event.payload.class ?? 'unknown')}</td>
<td>${escapeHtml(event.payload.expected ?? '—')}</td>
<td>awaiting maturity · expected evaluation ${escapeHtml(event.payload.expected_evaluation ?? '2026-10-02')}</td>
</tr>`).join('')}
</tbody></table>`,
    })}`;
  }

  const decisions = eventsOf(repositories, tenant, 'decision.recorded');
  if (state === 'empty' || decisions.length === 0) {
    return emptyState({
      title: 'Shadow mode has not started',
      message: 'Before shadow mode starts this journal is empty. Once it starts, every decision the system considers appears here: the alternatives it weighed (including do-nothing), the expected effect, and how the matured outcome compared.',
      action: `<a class="button" href="/journal?state=partial">Start the first replay</a>`,
      testid: 'journal-empty',
    });
  }

  return panel({
    title: `Decision journal · ${decisions.length} rows`,
    body: `<table><thead><tr><th>When</th><th>Action class</th><th>Expected</th><th>Matured</th><th>Status</th></tr></thead><tbody>
${decisions.map((event) => `<tr>
<td>${escapeHtml(event.occurred_at)}</td>
<td>${escapeHtml(event.payload.class ?? 'unknown')}</td>
<td>${escapeHtml(event.payload.expected ?? '—')}</td>
<td>${escapeHtml(event.payload.matured ?? 'pending')}</td>
<td>${escapeHtml(event.payload.status ?? 'shadow')}</td>
</tr>`).join('')}
</tbody></table>`,
  });
}

function opportunities(state, { repositories, tenant }) {
  if (state === 'loading') {
    return panel({ title: 'Loading opportunity queue', body: skeletonRows(3, 'skeleton-card') });
  }

  if (state === 'error') {
    return errorPanel({
      failed: {
        title: 'Failed to fetch experiments',
        detail: 'The opportunity and experiment store did not respond (source: derived_metrics store). Drafts and scores are preserved.',
      },
      stillTrue: 'drafted hypotheses and their score components are preserved.',
      retryHref: '/opportunities',
    });
  }

  if (state === 'partial') {
    const queue = eventsOf(repositories, tenant, 'opportunity.scored');
    return `<div class="banner banner-warn" role="status">Some experiment arms await maturity — scores shown are provisional until conversions mature.</div>
${panel({
    title: 'Ranked opportunities',
    body: queue.length === 0
      ? `<p class="empty-copy">No opportunities scored yet; the research pass has not produced any provisional bets.</p>`
      : `<ul>${queue.map((event) => `<li>
<strong>${escapeHtml(event.payload.name ?? 'Opportunity')}</strong>
— value ${escapeHtml(event.payload.value ?? '—')} · success probability ${escapeHtml(event.payload.probability ?? '—')}
<span class="maturity-label">data through ${escapeHtml(event.payload.data_through ?? '—')}</span>
</li>`).join('')}</ul>`,
  })}`;
  }

  const queue = eventsOf(repositories, tenant, 'opportunity.scored');
  if (state === 'empty' || queue.length === 0) {
    return emptyState({
      title: 'The opportunity queue is empty',
      message: 'The strategist would investigate first: where recent lead quality dropped by campaign, what upstream search demand is growing for your converting intent, and which channels sit below your current qualified CPL. Running the first research pass populates this queue with ranked, scored bets.',
      action: `<a class="button" href="/opportunities?state=loading">Run the first research pass</a>`,
      testid: 'opportunities-empty',
    });
  }

  return panel({
    title: `Ranked opportunities · ${queue.length}`,
    body: `<ul>${queue.map((event) => `<li>
<strong>${escapeHtml(event.payload.name ?? 'Opportunity')}</strong>
— value ${escapeHtml(event.payload.value ?? '—')} · success probability ${escapeHtml(event.payload.probability ?? '—')}
</li>`).join('')}</ul>`,
  });
}

function experiments(state, { repositories, tenant }) {
  if (state === 'loading') {
    return panel({ title: 'Loading experiments', body: skeletonRows(3, 'skeleton-card') });
  }

  if (state === 'error') {
    return errorPanel({
      failed: {
        title: 'Experiment fetch failed',
        detail: 'The experiment store could not be read (source: experiment store). In-progress drafts are preserved.',
      },
      stillTrue: 'drafted hypotheses and score components are preserved.',
      retryHref: '/experiments',
    });
  }

  if (state === 'partial') {
    const experimentsList = eventsOf(repositories, tenant, 'experiment.started');
    return `<div class="banner banner-warn" role="status">Some arms await maturity — data through the last conversion date is shown per experiment.</div>
${panel({
    title: 'Running experiments',
    body: experimentsList.length === 0
      ? `<p class="empty-copy">No experiments running, so no arms await maturity.</p>`
      : `<ul class="experiment-list">${experimentsList.map((event) => `<li class="experiment-card">
<strong>${escapeHtml(event.payload.name ?? 'Experiment')}</strong>
<span>State: ${escapeHtml(event.payload.state ?? 'running')} · arms: ${escapeHtml(String(event.payload.arms ?? 2))}</span>
<span class="maturity-label">data through ${escapeHtml(event.payload.data_through ?? '—')}</span>
</li>`).join('')}</ul>`,
  })}`;
  }

  const experimentsList = eventsOf(repositories, tenant, 'experiment.started');
  if (state === 'empty' || experimentsList.length === 0) {
    return emptyState({
      title: 'No experiments yet',
      message: 'Experiments settle which bet wins. Each one carries spend caps, stop rules, and a first-class inconclusive state, so a result you cannot trust never masquerades as a winner. Compose the first hypothesis to begin.',
      action: `<a class="button" href="/experiments?state=loading">Compose the first hypothesis</a>`,
      testid: 'experiments-empty',
    });
  }

  return panel({
    title: `Running experiments · ${experimentsList.length}`,
    body: `<ul class="experiment-list">${experimentsList.map((event) => `<li class="experiment-card">
<strong>${escapeHtml(event.payload.name ?? 'Experiment')}</strong>
<span>State: ${escapeHtml(event.payload.state ?? 'running')} · arms: ${escapeHtml(String(event.payload.arms ?? 2))}</span>
</li>`).join('')}</ul>`,
  });
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
