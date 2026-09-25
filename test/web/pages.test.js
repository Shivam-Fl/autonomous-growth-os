import { test } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories, replayRawToDerived } from '../../src/data/repositories.js';
import { validateEvent } from '../../src/domain/events.js';
import { renderPage } from '../../src/web/pages.js';
import { buildApp } from '../../src/api/routes.js';
import { seed } from '../../scripts/seed.js';
import { FakeMetaAdsProvider } from '../../src/integrations/meta_ads/fake.js';

const ROUTES = ['/', '/journal', '/opportunities', '/experiments', '/approvals'];

function freshRepos() {
  const dir = mkdtempSync(join(tmpdir(), 'pages-'));
  const db = openDatabase(join(dir, 'app.db'));
  return createRepositories(db);
}

function seededRepos(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  seed({ dbPath: join(dir, 'app.db') });
  return createRepositories(openDatabase(join(dir, 'app.db')));
}

test('a fresh database renders the empty dashboard with the setup checklist', async () => {
  const html = await renderPage('/', { repositories: freshRepos() });
  assert.match(html, /data-state="empty"/);
  assert.match(html, /No connected ad account yet/);
  assert.match(html, /Connect Meta Ads/);
  assert.match(html, /about 5 minutes/);
  assert.match(html, /about 15 minutes/);
  assert.match(html, /about 1 minute/);
  assert.match(html, /No connected account/, 'header names the missing tenant');
});

test('each page renders its own empty state on a fresh database', async () => {
  const repos = freshRepos();
  assert.match(await renderPage('/journal', { repositories: repos }), /Start the first replay/);
  assert.match(await renderPage('/opportunities', { repositories: repos }), /research pass/);
  assert.match(await renderPage('/experiments', { repositories: repos }), /Compose the first hypothesis/);
  assert.match(await renderPage('/approvals', { repositories: repos }), /Autonomy posture by action class/);
});

test('every page exposes the loading, partial and error preview shells without touching storage', async () => {
  for (const route of ROUTES) {
    const repos = freshRepos();
    const loading = await renderPage(route, { repositories: repos, override: 'loading' });
    assert.match(loading, /data-state="loading"/);
    assert.match(loading, /class="skeleton /, `${route} loading shell has skeletons`);

    const partial = await renderPage(route, { repositories: repos, override: 'partial' });
    assert.match(partial, /data-state="partial"/);
    assert.match(partial, /aria-live="polite"/);
    assert.ok(/stale|await|Expired|provisional/i.test(partial), `${route} partial shell shows its degraded state`);

    const error = await renderPage(route, { repositories: repos, override: 'error' });
    assert.match(error, /data-state="error"/);
    assert.match(error, /data-action="retry"/, `${route} error shell offers retry`);
    assert.match(error, /What is still true/, `${route} error shell names what is still true`);

    assert.equal(repos.rawEvents.count('tenant_demo'), 0, `${route} override never writes`);
  }
});

test('an unknown ?state= value falls back to the derived state', async () => {
  const repos = freshRepos();
  const html = await renderPage('/', { repositories: repos, override: 'fancy' });
  assert.match(html, /data-state="empty"/);
});

test('after seeding, the header names the demo tenant and the dashboard goes ideal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pages-seeded-'));
  const db = openDatabase(join(dir, 'app.db'));
  const repos = createRepositories(db);
  const html = await renderPage('/', { repositories: repos });
  assert.match(html, /data-state="empty"/);

  seed({ dbPath: join(dir, 'app.db') });
  const seededHtml = await renderPage('/', { repositories: repos });
  assert.match(seededHtml, /data-state="ideal"/);
  assert.match(seededHtml, /data-testid="tenant-name">Demo Tenant</);
  assert.match(seededHtml, /Qualified CPL/);
  assert.match(seededHtml, /Decision feed · 2 rows/);
});

test('?state=empty on a seeded database shows the empty body AND the empty header, on every route', async () => {
  const repos = seededRepos('pages-override-');
  assert.ok(repos.tenants.list().length > 0, 'fixture: the database is seeded');

  for (const route of ROUTES) {
    const html = await renderPage(route, { repositories: repos, override: 'empty' });
    assert.match(html, /data-state="empty"/, `${route} body follows the override`);
    assert.match(html, /data-testid="tenant-name">No connected account</, `${route} header agrees with the empty body`);
    assert.doesNotMatch(html, />Demo Tenant</, `${route} header never names the tenant under ?state=empty`);
  }
});

test('without an override the header still follows the store, exactly as before', async () => {
  const repos = seededRepos('pages-store-');

  const ideal = await renderPage('/journal', { repositories: repos });
  assert.match(ideal, /data-state="ideal"/);
  assert.match(ideal, /data-testid="tenant-name">Demo Tenant</);

  const fresh = createRepositories(openDatabase(join(mkdtempSync(join(tmpdir(), 'pages-store-')), 'app.db')));
  const empty = await renderPage('/journal', { repositories: fresh });
  assert.match(empty, /data-state="empty"/);
  assert.match(empty, /data-testid="tenant-name">No connected account</);
});

// Mixed-currency legacy rows (QA BUG-2 on the dashboard side): raw_events is
// append-only, so a pre-fix INR tenant can still hold a USD spend row that
// ingest today would 400 as CURRENCY_MISMATCH. kpiStrip must exclude it the
// same way GET /v1/metrics does, or the two surfaces disagree on CPL.
test('a legacy mixed-currency batch on an otherwise empty tenant reads ₹3,000.00 on the card and the API agrees', async () => {
  const repos = freshRepos();
  repos.tenants.create({ id: 'tenant_demo', name: 'Demo Tenant', currency: 'INR' });
  const occurredAt = '2026-09-25T08:00:00.000Z';
  const envelope = (event_id, event_type, payload) => {
    const validated = validateEvent({
      event_id, event_type, tenant_id: 'tenant_demo', schema_version: '1', occurred_at: occurredAt, payload,
    });
    assert.equal(validated.ok, true, `fixture: ${event_id} must validate`);
    return validated.event;
  };
  // Ingest would 400 the USD row against the INR tenant (CURRENCY_MISMATCH),
  // so the only way a live database holds both is the repository route:
  // a pre-fix legacy batch appended straight into the append-only table.
  const legacy = [
    envelope('evt_ac_inr_spend', 'spend.observed', { campaign: 'legacy', amount_micros: 3_000_000_000, currency: 'INR' }),
    envelope('evt_ac_usd_spend', 'spend.observed', { campaign: 'legacy', amount_micros: 3_000_000_000, currency: 'USD' }),
    envelope('evt_ac_qualified', 'lead_qualified', { campaign: 'legacy', lead_id: 'lead_ac', session_id: 'sess_ac' }),
  ];
  for (const event of legacy) {
    repos.rawEvents.append(event);
  }

  const html = await renderPage('/', { repositories: repos });
  const cplCard = html.match(/kpi-card[\s\S]*?Qualified CPL[\s\S]*?<\/div>/)[0];
  const cplText = cplCard.match(/kpi-value">([^<]+)</)[1];
  assert.equal(cplText, '₹3,000.00', `dashboard CPL must exclude the USD row, got ${cplText}`);

  const app = buildApp({ repositories: repos });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const metrics = await (await fetch(`http://127.0.0.1:${port}/v1/metrics`)).json();
    assert.equal(metrics.qualified_cpl_micros, 3_000_000_000, 'API CPL excludes the USD row too');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('the dashboard KPI strip excludes foreign-currency legacy spend like the metrics API does', async () => {
  const repos = seededRepos('pages-mixed-currency-');
  // The demo tenant is INR with one 7_200_000_000 INR spend and 3 qualified
  // leads after the seed, so the legacy batch adds: an INR spend of exactly
  // 3_000_000_000 (matching the AC's amount), a USD spend of 3_000_000_000
  // that must never enter either surface's sum, and one more qualified lead.
  const occurredAt = '2026-09-25T08:00:00.000Z';
  const envelope = (event_id, event_type, payload) => {
    const validated = validateEvent({
      event_id, event_type, tenant_id: 'tenant_demo', schema_version: '1', occurred_at: occurredAt, payload,
    });
    assert.equal(validated.ok, true, `fixture: ${event_id} must validate`);
    return validated.event;
  };
  const legacy = [
    envelope('evt_legacy_inr_spend', 'spend.observed', { campaign: 'legacy', amount_micros: 3_000_000_000, currency: 'INR' }),
    envelope('evt_legacy_usd_spend', 'spend.observed', { campaign: 'legacy', amount_micros: 3_000_000_000, currency: 'USD' }),
    envelope('evt_legacy_qualified', 'lead_qualified', { campaign: 'legacy', lead_id: 'lead_legacy', session_id: 'sess_legacy' }),
  ];
  // Directly through rawEvents.append: ingest would 400 the USD row today,
  // so the repository layer is the only way a pre-fix database looks like this.
  const bar = [];
  for (const event of legacy) {
    const { appended } = repos.rawEvents.append(event);
    bar.push(appended);
  }
  assert.deepEqual(bar, [true, true, true], 'fixture: all three legacy rows appended');

  const html = await renderPage('/', { repositories: repos });
  const cplCard = html.match(/kpi-card[\s\S]*?Qualified CPL[\s\S]*?<\/div>/)[0];
  const cplText = cplCard.match(/kpi-value">([^<]+)</)[1];
  // Only the INR rows enter the sum: (7_200 + 3_000) / 4 = 2_550_000_000 = ₹2,550.00.
  assert.equal(cplText, '₹2,550.00', `dashboard CPL must exclude the USD row, got ${cplText}`);

  // The API computes the same tenant from the same rows and must agree.
  const app = buildApp({ repositories: repos });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const metrics = await (await fetch(`http://127.0.0.1:${port}/v1/metrics`)).json();
    assert.equal(metrics.qualified_cpl_micros, 2_550_000_000, 'API CPL excludes the USD row too');
    assert.equal(metrics.spend_micros, 10_200_000_000, 'API spend is the INR rows only');
    assert.equal(metrics.qualified_volume, 4);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('skeleton shells keep a fixed height so data arriving causes no layout shift', async () => {
  const repos = freshRepos();
  const loading = await renderPage('/', { repositories: repos, override: 'loading' });
  assert.match(loading, /skeleton kpi-card/);
  assert.match(loading, /aria-hidden="true"/);
});

test('the ideal dashboard renders the four Meta tables with row counts, id-sorted rows and the last-good sync', async () => {
  const repos = seededRepos('pages-meta-ideal-');
  const html = await renderPage('/', { repositories: repos, metaProvider: new FakeMetaAdsProvider() });

  assert.match(html, /data-testid="meta-last-good">Meta last good sync 2026-09-25T08:00:00\.000Z</);
  assert.match(html, /Meta campaigns · 3 rows/);
  assert.match(html, /Meta ad sets · 3 rows/);
  assert.match(html, /Meta ads · 3 rows/);
  assert.match(html, /Meta insights · 3 rows/);
  assert.match(html, /<th>Id<\/th><th>Name<\/th><th>Status<\/th><th>Objective<\/th>/, 'tables expose headers');
  assert.match(html, /₹500\.00/, 'ad-set budgets render as money');
  assert.match(html, /₹4000\.00/, 'insight spend renders as money');

  const campaignsTable = html.match(/data-testid="meta-campaigns"[\s\S]*?<\/table>/)[0];
  const order = ['campaign_001', 'campaign_002', 'campaign_003'].map((id) => campaignsTable.indexOf(id));
  assert.ok(order.every((index) => index >= 0), 'every campaign row is present');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'campaign rows appear in id order');
});

test('the dashboard error panel names the failing check, keeps the last-good sync and the prior rows', async () => {
  const repos = seededRepos('pages-meta-error-');
  const cases = [
    ['quota', 'provider-sync/quota', /META_QUOTA_EXHAUSTED|quota/],
    ['revoked', 'provider-sync/permission', /META_PERMISSION_REVOKED|revoked/],
  ];
  for (const [simulation, check, message] of cases) {
    const html = await renderPage('/', {
      repositories: repos,
      metaProvider: new FakeMetaAdsProvider({ failureMode: simulation }),
      metaError: simulation,
    });
    assert.match(html, /Meta provider sync failed/);
    assert.match(html, new RegExp(`check: ${check.replaceAll('/', '\\/')}`), `${simulation}: the failing check is named`);
    assert.match(html, message, `${simulation}: the typed envelope's message is shown`);
    assert.match(html, /data-testid="meta-last-good">Meta last good sync 2026-09-25T08:00:00\.000Z</);
    assert.match(html, /data-action="retry"/, `${simulation}: retry is offered`);
    assert.match(html, /campaign_001/, `${simulation}: prior campaign rows are preserved`);
    assert.match(html, /Meta campaigns · 3 rows/, `${simulation}: the preserved table keeps its row count`);
    assert.match(html, /data-state="ideal"/, 'the page state is still ideal; the failure is the region’s');
  }
});

test('a failing provider read drives the error panel even without the ?meta_error hint', async () => {
  const repos = seededRepos('pages-meta-envelope-');
  const html = await renderPage('/', {
    repositories: repos,
    metaProvider: new FakeMetaAdsProvider({ failureMode: 'quota' }),
  });
  assert.match(html, /check: provider-sync\/quota/);
  assert.match(html, /data-action="retry"/);
  assert.match(html, /campaign_001/, 'prior rows come from the last-good snapshot');
});

test('an unknown ?meta_error= value is ignored like an unknown ?state=', async () => {
  const repos = seededRepos('pages-meta-unknown-');
  const html = await renderPage('/', {
    repositories: repos,
    metaProvider: new FakeMetaAdsProvider({ failureMode: 'ok' }),
    metaError: 'banana',
  });
  assert.match(html, /data-state="ideal"/);
  assert.doesNotMatch(html, /Meta provider sync failed/);
  assert.match(html, /Meta campaigns · 3 rows/);
});

test('without a meta provider the dashboard says Meta data is not connected', async () => {
  const repos = seededRepos('pages-meta-absent-');
  const html = await renderPage('/', { repositories: repos });
  assert.match(html, /data-testid="meta-unavailable"/);
  assert.match(html, /Meta data is not connected yet/);
  assert.doesNotMatch(html, /Meta campaigns · \d+ rows/, 'no table claims rows without a provider');
});

test('the dashboard loading shell skeletons the Meta campaign region too', async () => {
  const repos = freshRepos();
  const html = await renderPage('/', { repositories: repos, override: 'loading', metaProvider: new FakeMetaAdsProvider() });
  assert.match(html, /Loading KPIs/);
  assert.match(html, /Loading Meta campaigns/);
  assert.match(html, /class="skeleton skeleton-row"/);
  assert.doesNotMatch(html, /Meta campaigns · \d+ rows/, 'no table is rendered while loading');
});

test('the partial dashboard keeps the stale banner and renders the Meta tables from the provider', async () => {
  const repos = seededRepos('pages-meta-partial-');
  const html = await renderPage('/', {
    repositories: repos,
    override: 'partial',
    metaProvider: new FakeMetaAdsProvider(),
  });
  assert.match(html, /data-state="partial"/);
  assert.match(html, /Provider data is stale — last good sync/);
  assert.match(html, /Meta campaigns · 3 rows/);
});

test('the dashboard route wires ?meta_error through to the provider and the error panel', async () => {
  const repos = seededRepos('pages-meta-route-');
  const app = buildApp({ repositories: repos });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const url = (path) => `http://127.0.0.1:${port}${path}`;
  try {
    const quota = await (await fetch(url('/?meta_error=quota'))).text();
    assert.match(quota, /check: provider-sync\/quota/);
    assert.match(quota, /data-action="retry"/);
    assert.match(quota, /campaign_001/, 'the browser route preserves prior rows');

    const revoked = await (await fetch(url('/?meta_error=revoked'))).text();
    assert.match(revoked, /check: provider-sync\/permission/);

    const unknown = await (await fetch(url('/?meta_error=banana'))).text();
    assert.doesNotMatch(unknown, /Meta provider sync failed/);
    assert.match(unknown, /Meta campaigns · 3 rows/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

// Decision journal (TR-15, issue #19): the page reads the decisions
// repository — filters, drawer fields and the LIVE calibration summary.
// The frozen replay's 0.70/0.33 aggregate is CI-only and never appears here.
test('the ideal journal renders filters, drawer fields and the LIVE calibration after seeding', async () => {
  const repos = seededRepos('pages-journal-');
  const html = await renderPage('/journal', { repositories: repos });
  assert.match(html, /data-testid="journal-filters"/);
  assert.match(html, /<select id="journal-filter-class"/);
  assert.match(html, /<select id="journal-filter-status"/);
  assert.match(html, /data-testid="journal-drawer"/);
  assert.match(html, /data-action="open-decision"/, 'rows carry the drawer opener');
  // Live seeded truth: evaluated 2 (both correct), one intervention, 1 awaiting.
  assert.match(html, /data-testid="journal-precision">Precision 1\.00 over 2 matured decisions</);
  assert.match(html, /data-testid="journal-false-intervention">False-intervention rate 0\.00 over 1 interventions</);
  assert.match(html, /data-testid="journal-awaiting">1 awaiting maturity</);
  assert.doesNotMatch(html, /0\.70/, 'the frozen replay aggregate is CI-only and never renders');
});

test('the journal table filters by class and status through the repository', async () => {
  const repos = seededRepos('pages-jfilter-');
  const byClass = await renderPage('/journal', { repositories: repos, filters: { class: 'campaign-status', status: null } });
  assert.match(byClass, /campaign status/);
  assert.doesNotMatch(byClass, /raise search brand budget 10pct/, 'the budget-change row is filtered out');
  const byStatus = await renderPage('/journal', { repositories: repos, filters: { class: null, status: 'awaiting-maturity' } });
  assert.match(byStatus, /shift budget to retargeting/);
  assert.doesNotMatch(byStatus, /dec_seed_matured_1/, 'matured rows are filtered out');
  const unknown = await renderPage('/journal', { repositories: repos, filters: { class: 'nonsense', status: 'nonsense' } });
  assert.match(unknown, /data-state="ideal"/, 'unknown filter values degrade to unfiltered');
  assert.match(unknown, /dec_seed_matured_1/);
});

test('the journal partial shell shows the awaiting-maturity row with its expected evaluation date', async () => {
  const repos = seededRepos('pages-jpartial-');
  const html = await renderPage('/journal', { repositories: repos, override: 'partial' });
  assert.match(html, /Awaiting maturity — expected evaluation \d+ \w+ \d{4}/);
  assert.match(html, /dec_seed_awaiting_1/);
  assert.match(html, /data-testid="journal-precision">Precision 1\.00 over 2 matured decisions</);
});

test('the journal error shell names the scenario, preserves prior entries and offers per-scenario retry', async () => {
  const repos = seededRepos('pages-jerror-');
  const html = await renderPage('/journal', { repositories: repos, override: 'error' });
  assert.match(html, /Replay evaluation failed for scenario replay-tracking-outage/);
  assert.match(html, /What is still true: every prior journal entry is preserved and untouched\./);
  assert.match(html, /dec_seed_matured_1/, 'prior entries stay on screen');
  assert.match(html, /Retry replay evaluation for replay-cpl-hold/);
  assert.match(html, /Retry replay evaluation for replay-tracking-outage/);
});

test('a decision drawer carries the TR-6 fields the drawer renders', async () => {
  const repos = seededRepos('pages-jdrawer-');
  const row = repos.decisions.get('tenant_demo', 'dec_seed_matured_1');
  assert.ok(row, 'fixture: the seeded decision exists');
  assert.equal(row.alternatives.filter((entry) => entry.action === 'do_nothing').length, 1);
  assert.ok(row.alternatives.find((entry) => entry.action === 'do_nothing').reason.length > 0);
  assert.deepEqual(Object.keys(row.alternatives[0].expected_outcomes).sort(), ['mean', 'p10', 'p90']);
  assert.ok(Number.isSafeInteger(row.risk.expected_downside_micros));
  assert.ok(row.risk.worst_reasonable_case.length > 0);
  assert.ok(Array.isArray(row.evidence_refs) && row.evidence_refs.length > 0);
  assert.ok(Array.isArray(row.memory_refs) && row.memory_refs.length > 0);
  assert.ok(row.critic_result.length > 0);
  assert.ok(row.policy_decision_id.length > 0);
});

// Opportunity queue + experiments (issue #22): the pages read the new
// repositories, never placeholder raw events, so the seeded fixtures decide
// everything below.

test('ranked rows render stored score plus all eight score components in repository order', async () => {
  const repos = seededRepos('pages-opp-rank-');
  const html = await renderPage('/opportunities', { repositories: repos });

  const order = ['opp_seed_expensive', 'opp_seed_cheap', 'opp_seed_low'].map((id) => html.indexOf(id));
  assert.ok(order.every((index) => index >= 0), 'all three seeded opportunities render');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '0.9208 expensive first, 0.40 cheap, 0.01 low');

  const rowHtml = (id) => html.match(new RegExp(`<li class="opportunity-row"[\\s\\S]*?data-opportunity-id="${id}"[\\s\\S]*?</li>`))[0];
  for (const id of ['opp_seed_expensive', 'opp_seed_cheap', 'opp_seed_low']) {
    const row = rowHtml(id);
    assert.match(row, /data-testid="opportunity-row"/);
    assert.match(row, /data-testid="score-components"/);
    for (const component of ['value', 'pSuccess', 'fit', 'infoValue', 'reversibility', 'cost', 'downside', 'delay']) {
      assert.match(row, new RegExp(`data-component="${component}"`), `${id} renders its ${component}`);
    }
  }
  assert.match(rowHtml('opp_seed_expensive'), /0\.9208/, 'the stored score renders on the winning row');
});

test('the seeded underpowered experiment renders the Inconclusive badge, never Win or Loss', async () => {
  const repos = seededRepos('pages-exp-badge-');
  const html = await renderPage('/experiments', { repositories: repos });
  const card = html.match(/data-experiment-id="exp_seed_underpowered"[\s\S]*?<\/li>/)[0];
  assert.match(card, /data-testid="exp-state">Inconclusive \(underpowered\)</);
  assert.match(card, /data-testid="caps"/);
  assert.match(card, /data-testid="stop-rules"/);
  assert.match(card, /data-testid="data-through">data through /);
  assert.doesNotMatch(card, /Win|Loss/, 'an inconclusive experiment never renders a win or loss badge');

  const running = html.match(/data-experiment-id="exp_seed_running"[\s\S]*?<\/li>/)[0];
  assert.match(running, /data-testid="exp-state">Running</);
  assert.match(html, /₹500\.00/, 'the max spend cap formats as money');
});

test('the dashboard experiments panel reads the experiment repository, not the dead raw-event stream', async () => {
  const repos = seededRepos('pages-dashboard-exp-');
  const html = await renderPage('/', { repositories: repos });
  assert.match(html, /Open experiments · 2/, 'both seeded experiments reach the dashboard');
  assert.match(html, /data-experiment-id="exp_seed_running"/);
  assert.match(html, /data-experiment-id="exp_seed_underpowered"/);
  assert.match(html, /Exact-intent search budget test/, 'the running experiment renders its name');
  assert.match(html, /State: Running · arms: 2/);
  assert.match(html, /State: Inconclusive · arms: 2/, 'the persisted inconclusive state renders on the dashboard too');
});

test('re-seeding after an evaluation does not clobber the experiment state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pages-reseed-'));
  const dbPath = join(dir, 'app.db');
  seed({ dbPath });
  const repos = createRepositories(openDatabase(dbPath));
  // An evaluation between the two seed runs: exactly the write a re-seed
  // must never revert or re-date (updateState is the same surface the
  // evaluate route uses).
  repos.experiments.updateState('tenant_demo', 'exp_seed_underpowered', {
    state: 'matured', evaluation_result: 'win', evaluation_reason: null,
    evaluated_at: '2026-09-25T12:00:00.000Z', data_through: '2026-09-25T11:00:00.000Z',
  });

  const second = seed({ dbPath });
  assert.equal(second.alreadySeeded, true, 'a repeat seed reports alreadySeeded');

  const after = repos.experiments.get('tenant_demo', 'exp_seed_underpowered');
  assert.equal(after.state, 'matured', 'a later evaluation is not reverted by a re-seed');
  assert.equal(after.evaluation_result, 'win');
  assert.equal(after.evaluated_at, '2026-09-25T12:00:00.000Z', 'evaluated_at is not rewritten');
  assert.equal(after.data_through, '2026-09-25T11:00:00.000Z', 'data_through is not rewritten');
});

test('the composer is mounted on the error shell and on the ideal page', async () => {
  const repos = seededRepos('pages-composer-');
  const ideal = await renderPage('/experiments', { repositories: repos });
  assert.match(ideal, /data-testid="hypothesis-composer"/);
  assert.match(ideal, /<label for="composer-title">Title</);
  assert.match(ideal, /data-draft-key="opp_exp_draft_title"/);

  const errorShell = await renderPage('/experiments', { repositories: repos, override: 'error' });
  assert.match(errorShell, /Experiment fetch failed/, 'the error panel still renders');
  assert.match(errorShell, /data-testid="hypothesis-composer"/, 'the composer stays mounted beside the error');
});

test('an empty database still renders the research-prompt empty state', async () => {
  const repos = freshRepos();
  repos.tenants.create({ id: 'tenant_demo', name: 'Demo Tenant', currency: 'INR' });
  const html = await renderPage('/opportunities', { repositories: repos });
  assert.match(html, /data-testid="opportunities-empty"/);
  assert.match(html, /lead quality dropped by campaign/);
  assert.match(html, /search demand is growing for your converting intent/);
  assert.match(html, /below your current qualified CPL/);
});
