import { test } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
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

// The h1 hook, without the styling class: a CSS rename must not fail a
// behavioural test, per .sdlc/memory/qa/selectors.md. The class may appear
// anywhere, or not at all; the testid must be on an <h1> whose content is
// plain text.
const H1_HOOK = /<h1[^>]*\bdata-testid="page-title"[^>]*>[^<]*<\/h1>/;

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

test('each error panel heading names its own screen, so the two store-sharing pages cannot be copy-pasted into each other', async () => {
  const repos = freshRepos();
  // Only the panel's own <h2>: /opportunities' detail legitimately names both stores,
  // so asserting on the whole document would fail a correct fix.
  const headingOf = (html) => /panel-error[^]*?<h2>([^<]*)<\/h2>/.exec(html)?.[1];

  const opportunities = await renderPage('/opportunities', { repositories: repos, override: 'error' });
  const experiments = await renderPage('/experiments', { repositories: repos, override: 'error' });

  const opportunityTitle = headingOf(opportunities);
  const experimentTitle = headingOf(experiments);

  assert.equal(opportunityTitle, 'Opportunity fetch failed');
  assert.equal(experimentTitle, 'Experiment fetch failed', 'the sibling panel is unchanged by this fix');
  assert.doesNotMatch(opportunityTitle, /experiment/i, 'the opportunities heading does not name the experiments screen');
  assert.doesNotMatch(experimentTitle, /opportunit/i, 'the experiments heading does not name the opportunities screen');
  assert.ok(!opportunities.includes('Failed to fetch experiments'), 'the old title appears nowhere in the document');

  // The retitle is copy-only; the rest of the panel is what a reader relies on.
  assert.match(opportunities, /<p>The opportunity and experiment store did not respond \(source: opportunity store\)\. Drafts and scores are preserved\.<\/p>/);
  assert.match(experiments, /<p>The experiment store could not be read \(source: experiment store\)\. In-progress drafts are preserved\.<\/p>/);
  assert.match(opportunities, /What is still true: drafted hypotheses and their score components are preserved\./);
  assert.match(opportunities, /data-action="retry" data-retry-href="\/opportunities"/);
});

// Issue #42: every document's heading hierarchy used to begin at panel()'s
// <h2>, so a screen reader's heading navigation had no top level and no page
// named itself. The invariant is per-document, so it is locked across the
// whole route x state matrix rather than on one page.
test('every route renders exactly one h1 that opens the hierarchy, in every state', async () => {
  const STATES = ['ideal', 'empty', 'loading', 'partial', 'error'];
  const EXPECTED = {
    '/': 'Command dashboard',
    '/journal': 'Decision journal',
    '/opportunities': 'Opportunities',
    '/experiments': 'Experiments',
    '/approvals': 'Approvals',
  };
  // Headings in document order, as levels: h1 .. h6.
  const levelsOf = (html) => [...html.matchAll(/<h([1-6])\b[^>]*>/g)].map(([, level]) => Number(level));
  const mainOf = (html) => /<main id="main">([\s\S]*?)<\/main>/.exec(html)?.[1] ?? '';
  const h1TextOf = (html) => /<h1[^>]*>([^<]*)<\/h1>/.exec(html)?.[1];

  for (const route of ROUTES) {
    for (const state of STATES) {
      const where = `${route}?state=${state}`;
      const html = await renderPage(route, { repositories: freshRepos(), override: state });
      const levels = levelsOf(html);

      assert.equal(levels.filter((level) => level === 1).length, 1, `${where}: exactly one h1`);
      assert.equal(levelsOf(mainOf(html))[0], 1, `${where}: the first heading inside main is the h1`);
      assert.ok(levels.every((level) => level <= 3), `${where}: no heading below h3, got [${levels}]`);
      // Start from 0, so the first heading has to be the h1 too, and no step
      // may rise by more than one: h1 -> h3 would fail here.
      let previous = 0;
      for (const level of levels) {
        assert.ok(level <= previous + 1, `${where}: h${previous} is not followed by h${level}`);
        previous = level;
      }
      assert.match(html, H1_HOOK, `${where}: the h1 carries the page-title hook`);
      assert.equal(h1TextOf(html), EXPECTED[route], `${where}: the h1 names its screen`);
    }
  }
});

// The matcher above was relaxed on purpose (issue #46), so it is pinned here
// against both what it must accept and what it must still reject: a relaxation
// that quietly stopped matching anything would pass the 25 shells for the
// wrong reason, and one that stopped rejecting would protect nothing.
test('the h1 hook matcher depends on the testid, not the styling class', () => {
  assert.match('<h1 class="page-title" data-testid="page-title">Command dashboard</h1>', H1_HOOK, 'the shipped markup matches');
  assert.match('<h1 data-testid="page-title">Command dashboard</h1>', H1_HOOK, 'the class may be absent entirely');
  assert.match('<h1 data-testid="page-title" class="page-title">Command dashboard</h1>', H1_HOOK, 'attribute order is not pinned');

  assert.doesNotMatch('<h1 class="page-title">Command dashboard</h1>', H1_HOOK, 'an h1 without the testid is not the hook');
  assert.doesNotMatch('<h1 data-testid="page-title"><span>x</span></h1>', H1_HOOK, 'nested markup is not a plain-text heading');
  assert.doesNotMatch('<h2 data-testid="page-title">Command dashboard</h2>', H1_HOOK, 'the hook only holds on the h1');
});

test('the page h1 never replaces the error panel heading on the two store-sharing screens', async () => {
  const repos = freshRepos();
  // Same regex shape as the #38 test above: the h1 is emitted before the panel
  // rather than inside it, so this still resolves to the panel's own <h2>.
  const headingOf = (html) => /panel-error[^]*?<h2>([^<]*)<\/h2>/.exec(html)?.[1];
  const h1TextOf = (html) => /<h1[^>]*>([^<]*)<\/h1>/.exec(html)?.[1];

  const opportunities = await renderPage('/opportunities', { repositories: repos, override: 'error' });
  const experiments = await renderPage('/experiments', { repositories: repos, override: 'error' });

  assert.equal(headingOf(opportunities), 'Opportunity fetch failed', 'the page h1 sits before the panel, not inside it');
  assert.equal(headingOf(experiments), 'Experiment fetch failed', 'the page h1 sits before the panel, not inside it');
  assert.equal(h1TextOf(opportunities), 'Opportunities', 'the opportunities page still names itself');
  assert.equal(h1TextOf(experiments), 'Experiments', 'the experiments page still names itself');
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
  assert.match(html, /₹4,000\.00/, 'insight spend renders as money');

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
    for (const component of ['value_micros', 'pSuccess', 'fit', 'infoValue', 'reversibility', 'cost_micros', 'downside', 'delay']) {
      assert.match(row, new RegExp(`data-component="${component}"`), `${id} renders its ${component}`);
    }
  }
  assert.match(rowHtml('opp_seed_expensive'), /0\.9208/, 'the stored score renders on the winning row');
});

test('the opportunity row renders money as rupees, never as bare micros', async () => {
  const repos = seededRepos('pages-opp-money-');
  const html = await renderPage('/opportunities', { repositories: repos });
  const row = html.match(/<li class="opportunity-row"[\s\S]*?data-opportunity-id="opp_seed_expensive"[\s\S]*?<\/li>/)[0];

  // 6_000_000_000 micros is 6000 rupees: the two money components go through
  // money(), so a reader never has to know the unit to read the row. Thousands
  // grouping is the repo's canonical formatter, the same one the dashboard's
  // Qualified CPL card already used.
  assert.match(row, /value ₹6,000\.00/);
  assert.match(row, /cost ₹1,900\.00/);
  assert.doesNotMatch(row, /6000000000/, 'the bare micros never render');
  assert.doesNotMatch(row, /1900000000/, 'the bare micros never render');
  assert.doesNotMatch(row, /₹6000\.00|₹1900\.00/, 'the ungrouped rupee string is gone');
  // The six dimensionless components stay plain numbers.
  assert.match(row, /success probability 0\.6/);
  assert.match(row, /downside 2/);
});

test('a component-less or legacy-shaped row renders the placeholder, never ₹NaN', async () => {
  // A record stored before the micros rename carries value/cost, so the
  // repository projects components.value_micros as an explicit null (an
  // undefined key would be dropped by JSON.stringify). The view's null check
  // stands in front of money(), and money() would render '—' for it anyway.
  const repos = freshRepos();
  repos.tenants.create({ id: 'tenant_demo', name: 'Demo Tenant', currency: 'INR' });
  repos.opportunities.create({
    tenant_id: 'tenant_demo',
    opportunity_id: 'opp_legacy',
    record: {
      opportunity_id: 'opp_legacy', tenant_id: 'tenant_demo', name: 'Legacy bet',
      value: 6000, pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost: 1900, downside: 2, delay: 1,
    },
    score: 0.9208,
  });
  // The projection is explicit on the way in, not just on the wire.
  assert.equal(repos.opportunities.get('tenant_demo', 'opp_legacy').components.value_micros, null);
  assert.equal(repos.opportunities.get('tenant_demo', 'opp_legacy').components.cost_micros, null);

  const html = await renderPage('/opportunities', { repositories: repos });
  const row = html.match(/<li class="opportunity-row"[\s\S]*?<\/li>/)[0];
  assert.match(row, /data-component="value_micros">value —</);
  assert.match(row, /data-component="cost_micros">cost —</);
  assert.doesNotMatch(row, /₹NaN/);
  assert.doesNotMatch(row, /value 6000\b/, 'the pre-rename raw-unit number is not silently rendered as money');
  assert.doesNotMatch(row, /cost 1900\b/);
});

test('a row missing a NON-money component renders the placeholder, not a blank or "undefined"', async () => {
  // Coverage, not a regression guard: this passed before the shared rule too,
  // because the view's own `raw == null` check already caught the undefined
  // value. The seven-key defect that motivated this was WIRE-only — a dropped
  // key vanishes in JSON.stringify — and it is pinned in
  // test/api/opportunities.test.js. What this holds is the view's half of the
  // contract: a dimensionless component this build cannot read prints the
  // em-dash, like the money ones, and the row's readable values still render.
  const repos = freshRepos();
  repos.tenants.create({ id: 'tenant_demo', name: 'Demo Tenant', currency: 'INR' });
  const { pSuccess, ...stored } = {
    name: 'No success probability', value_micros: 6_000_000_000, pSuccess: 0.6, fit: 0.9,
    infoValue: 1.2, reversibility: 0.9, cost_micros: 1_900_000_000, downside: 2, delay: 1,
  };
  repos.opportunities.create({ tenant_id: 'tenant_demo', opportunity_id: 'opp_nopsuccess', record: stored, score: 0.9208 });

  const row = (await renderPage('/opportunities', { repositories: repos }))
    .match(/<li class="opportunity-row"[\s\S]*?<\/li>/)[0];
  assert.match(row, /data-component="pSuccess">success probability —</);
  assert.doesNotMatch(row, /undefined/, 'a dropped key never renders as the string "undefined"');
  // The components it CAN read still render, so the em-dash is a statement
  // about the one component and not about the whole row.
  assert.match(row, /data-component="value_micros">value ₹6,000\.00</);
  assert.match(row, /data-component="fit">fit 0\.9</);
});

test('a negative amount renders the em-dash, never a negative number of rupees', async () => {
  // A negative micros IS a safe integer, so the renderer's previous local
  // guard printed '-1.00' for a record the wire projection and the
  // contribution both called unknown. The renderer's guard is the domain's
  // rule now, and the three agree.
  const repos = freshRepos();
  repos.tenants.create({ id: 'tenant_demo', name: 'Demo Tenant', currency: 'INR' });
  repos.opportunities.create({
    tenant_id: 'tenant_demo',
    opportunity_id: 'opp_negative',
    score: 0.4,
    record: {
      name: 'Negative value', value_micros: -1_000_000, pSuccess: 0.6, fit: 0.9,
      infoValue: 1.2, reversibility: 0.9, cost_micros: 1_900_000_000, downside: 2, delay: 1,
    },
  });

  const row = (await renderPage('/opportunities', { repositories: repos }))
    .match(/<li class="opportunity-row"[\s\S]*?<\/li>/)[0];
  assert.match(row, /data-component="value_micros">value —</);
  assert.doesNotMatch(row, /-1\.00|₹-1|value -\d/, 'never as a negative amount');
  assert.match(row, /data-component="cost_micros">cost ₹1,900\.00</, 'and the readable money is unaffected');
});

test('a component stored as a numeric string renders the placeholder, not the string', async () => {
  // '0.5' is not a number this build can stand behind. Rendering it as itself
  // would print a probability the domain never validated, in a row whose
  // contribution is null on the wire.
  const repos = freshRepos();
  repos.tenants.create({ id: 'tenant_demo', name: 'Demo Tenant', currency: 'INR' });
  repos.opportunities.create({
    tenant_id: 'tenant_demo',
    opportunity_id: 'opp_string',
    score: 0.4,
    record: {
      name: 'String probability', value_micros: 6_000_000_000, pSuccess: '0.5', fit: 0.9,
      infoValue: 1.2, reversibility: 0.9, cost_micros: 1_900_000_000, downside: 2, delay: 1,
    },
  });

  const row = (await renderPage('/opportunities', { repositories: repos }))
    .match(/<li class="opportunity-row"[\s\S]*?<\/li>/)[0];
  assert.match(row, /data-component="pSuccess">success probability —</);
  assert.doesNotMatch(row, /success probability 0\.5/, "never as '0.5'");
  assert.doesNotMatch(row, /₹NaN/);
});

test('a component stored out of range renders the em-dash, not the number', async () => {
  // The view half of the read-rule change, on two different keys so the row is
  // not pinned on pSuccess alone. A pSuccess of 1.5 and a downside of -1 are
  // now unreadable, so they project as null and opportunityRow renders the
  // em-dash for any null — the same path a missing component takes. No edit to
  // pages.js is involved; this is what stops the next person concluding that
  // the renderer needs one, and it pins the degradation the browser check in
  // the acceptance criteria walks past.
  for (const [opportunity_id, component, label, value] of [
    ['opp_range_psuccess', 'pSuccess', 'success probability', 1.5],
    ['opp_range_downside', 'downside', 'downside', -1],
  ]) {
    const repos = freshRepos();
    repos.tenants.create({ id: 'tenant_demo', name: 'Demo Tenant', currency: 'INR' });
    repos.opportunities.create({
      tenant_id: 'tenant_demo',
      opportunity_id,
      score: 0.4,
      record: {
        name: 'Out of range', value_micros: 6_000_000_000, pSuccess: 0.6, fit: 0.9,
        infoValue: 1.2, reversibility: 0.9, cost_micros: 1_900_000_000, downside: 2, delay: 1,
        [component]: value,
      },
    });

    const row = (await renderPage('/opportunities', { repositories: repos }))
      .match(/<li class="opportunity-row"[\s\S]*?<\/li>/)[0];
    assert.match(row, new RegExp(`data-component="${component}">${label} —</`), `${component} ${value}: the em-dash`);
    assert.doesNotMatch(row, new RegExp(`${label} ${value}`), `${component} ${value}: never the out-of-range number itself`);
    // The rest of the row still renders, so the em-dash is a statement about
    // that one component and not about the whole record.
    assert.match(row, /data-component="value_micros">value ₹6,000\.00</);
  }
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
  // The caps render exactly once per card: the card used to print them twice
  // (a bare span and an identical div below it), and matching the testid alone
  // passed against either copy.
  const capLines = running.match(/₹500\.00/g) ?? [];
  assert.equal(capLines.length, 1, 'the max spend cap appears exactly once in the card');
  assert.equal((running.match(/₹200\.00/g) ?? []).length, 1, 'the max downside cap appears exactly once');
  assert.equal((card.match(/data-testid="caps"/g) ?? []).length, 1, 'one caps element per card');
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
  // Every composer field carries its own namespaced draft key: the fields
  // client.js persists are exactly the ones the markup declares.
  for (const key of ['opp_exp_draft_title', 'opp_exp_draft_thesis', 'opp_exp_draft_cap']) {
    assert.match(ideal, new RegExp(`data-draft-key="${key}"`), `${key} is persisted`);
  }

  const errorShell = await renderPage('/experiments', { repositories: repos, override: 'error' });
  assert.match(errorShell, /Experiment fetch failed/, 'the error panel still renders');
  assert.match(errorShell, /data-testid="hypothesis-composer"/, 'the composer stays mounted beside the error');
  for (const key of ['opp_exp_draft_title', 'opp_exp_draft_thesis', 'opp_exp_draft_cap']) {
    assert.match(errorShell, new RegExp(`data-draft-key="${key}"`), `${key} survives the error shell`);
  }
});

// A minimal DOM for client.js: the fields the composer markup declares, the
// localStorage behind them, and nothing else the page script touches. Enough
// to drive the draft round trip AC-5 claims — type, reload, still there.
function draftHarness({ fields = {}, stored = {} } = {}) {
  const listeners = new Map();
  const storage = new Map(Object.entries(stored));
  const made = Object.keys(fields).map((key) => ({
    dataset: { draftKey: key },
    value: fields[key],
    addEventListener(type, handler) {
      listeners.set(`${key}:${type}`, handler);
    },
  }));
  globalThis.document = {
    title: 'Experiments · live',
    body: { dataset: { state: 'live' } },
    getElementById: () => null,
    querySelectorAll: (selector) => (selector === '[data-draft-key]' ? made : []),
    querySelector: () => null,
    addEventListener: () => {},
  };
  globalThis.window = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, value),
    },
  };
  return { fields: made, listeners, storage };
}

let clientLoad = 0;
async function loadClient() {
  clientLoad += 1;
  await import(`../../src/web/client.js?draft-run=${clientLoad}`);
}

test('typed composer fields are saved to localStorage and restored on the next load', async () => {
  try {
    const typed = draftHarness({
      fields: { opp_exp_draft_title: '', opp_exp_draft_thesis: '', opp_exp_draft_cap: '' },
    });
    await loadClient();
    const type = (key, value) => {
      typed.fields.find((field) => field.dataset.draftKey === key).value = value;
      typed.listeners.get(`${key}:input`)();
    };
    type('opp_exp_draft_title', 'Exact-intent search deserves more budget');
    type('opp_exp_draft_thesis', 'Qualified CPL should fall because intent is narrower.');
    type('opp_exp_draft_cap', '500000000');
    assert.equal(typed.storage.get('opp_exp_draft_title'), 'Exact-intent search deserves more budget');
    assert.equal(typed.storage.get('opp_exp_draft_thesis'), 'Qualified CPL should fall because intent is narrower.');
    assert.equal(typed.storage.get('opp_exp_draft_cap'), '500000000');

    // The reload: fresh, empty fields, the same storage behind them — what the
    // error shell does to a draft the user is still writing.
    const reloaded = draftHarness({
      fields: { opp_exp_draft_title: '', opp_exp_draft_thesis: '', opp_exp_draft_cap: '' },
      stored: Object.fromEntries(typed.storage),
    });
    await loadClient();
    const restored = Object.fromEntries(reloaded.fields.map((field) => [field.dataset.draftKey, field.value]));
    assert.equal(restored.opp_exp_draft_title, 'Exact-intent search deserves more budget');
    assert.equal(restored.opp_exp_draft_thesis, 'Qualified CPL should fall because intent is narrower.');
    assert.equal(restored.opp_exp_draft_cap, '500000000');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});

test('an empty database still renders the research-prompt empty state', async () => {
  const repos = freshRepos();
  repos.tenants.create({ id: 'tenant_demo', name: 'Demo Tenant', currency: 'INR' });
  const html = await renderPage('/opportunities', { repositories: repos });
  assert.match(html, /data-testid="opportunities-empty"/);
  assert.match(html, /lead quality dropped by campaign/);
  assert.match(html, /search demand is growing for your converting intent/);
  assert.match(html, /below your current qualified CPL/);

  // The copy above is static and also renders on the pre-change page, so it
  // cannot tell the two branches apart. What this change actually moved is the
  // branch condition: the queue is now driven by the repository, so one stored
  // opportunity must replace the empty state with the ranked list.
  repos.opportunities.create({
    tenant_id: 'tenant_demo',
    opportunity_id: 'opp_pages_first',
    record: {
      opportunity_id: 'opp_pages_first', tenant_id: 'tenant_demo', name: 'First bet',
      value_micros: 6_000_000_000, pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost_micros: 1_900_000_000, downside: 2, delay: 1,
    },
    score: 0.9208,
  });
  const ranked = await renderPage('/opportunities', { repositories: repos });
  assert.doesNotMatch(ranked, /data-testid="opportunities-empty"/, 'the empty state yields to the ranked list');
  assert.match(ranked, /data-testid="opportunity-row"/);
  assert.match(ranked, /opp_pages_first/);
  assert.match(ranked, /0\.9208/, 'the stored score renders on the row');
});

test('a non-INR tenant sees its own currency on opportunity value, cost and the Meta tables', async () => {
  // The bug the hardcoded rupee sign had: a USD tenant read 6,000 micros as
  // ₹6,000. Every renderer now goes through the tenant's currency, so the page
  // draws the same amounts the tenant's own account would.
  const repos = freshRepos();
  repos.tenants.create({ id: 'tenant_usd', name: 'US Tenant', currency: 'USD' });
  repos.opportunities.create({
    tenant_id: 'tenant_usd',
    opportunity_id: 'opp_usd_expensive',
    score: 0.9208,
    record: {
      opportunity_id: 'opp_usd_expensive', tenant_id: 'tenant_usd', name: 'US bet',
      value_micros: 6_000_000_000, pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost_micros: 1_900_000_000, downside: 2, delay: 1,
    },
  });

  const row = (await renderPage('/opportunities', { repositories: repos }))
    .match(/<li class="opportunity-row"[\s\S]*?<\/li>/)[0];
  assert.match(row, /value \$6,000\.00/);
  assert.match(row, /cost \$1,900\.00/);
  assert.doesNotMatch(row, /₹/, 'no rupee sign survives anywhere on a USD row');

  const dashboard = await renderPage('/', { repositories: repos, metaProvider: new FakeMetaAdsProvider() });
  assert.match(dashboard, /\$500\.00/, 'the ad-set budget is in the tenant currency');
  assert.match(dashboard, /\$4,000\.00/, 'insight spend is in the tenant currency');
  assert.doesNotMatch(dashboard, /₹500\.00|₹4,000\.00/);
});

// The USD-tenant fixture above has no experiment and no events, so it reaches
// the ideal branch of every page and no partial branch at all. These five sites
// have that shape: dropping the tenant currency at any one of them leaves the
// whole suite green, because nothing renders them under a currency of their
// own. This fixture has an experiment and a qualified lead, and renders every
// page twice — ideal and override:'partial' — so either branch of a shared
// call site is caught. Each assertion is scoped to the site it guards:
//
//   - experimentCard's two money() calls, on the caps line;
//   - both cards.map(experimentCard) sites in experiments(), which the two
//     renders take in turn;
//   - the partial branch of opportunities(), whose rankedList call the
//     existing fixture never reaches;
//   - the partial branch of dashboard(), whose metaRegions call likewise;
//   - the Qualified CPL tile in kpiStrip, the em-dash for a tenant with no
//     events — the spend and the qualified lead below are what make it a
//     number, and the assertion on the resolved volume is what keeps a broken
//     fixture from reading as a currency bug.
//
// No line numbers here on purpose: a coverage claim pinned to line numbers is
// what went stale in the #43 work order. A function or branch name moves with
// the code, and the mutation is what keeps the claim honest.
test('a non-INR tenant sees its own currency on every branch that draws money', async () => {
  const repos = freshRepos();
  repos.tenants.create({ id: 'tenant_usd', name: 'US Tenant', currency: 'USD' });
  repos.opportunities.create({
    tenant_id: 'tenant_usd',
    opportunity_id: 'opp_usd_expensive',
    score: 0.9208,
    record: {
      opportunity_id: 'opp_usd_expensive', tenant_id: 'tenant_usd', name: 'US bet',
      value_micros: 6_000_000_000, pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost_micros: 1_900_000_000, downside: 2, delay: 1,
    },
  });
  repos.experiments.create({
    tenant_id: 'tenant_usd',
    experiment_id: 'exp_usd_running',
    state: 'running',
    record: {
      experiment_id: 'exp_usd_running', tenant_id: 'tenant_usd', name: 'US bet',
      arms: [{ id: 'arm_control', name: 'Control' }, { id: 'arm_exact', name: 'Exact-intent' }],
      caps: { max_spend_micros: 500_000_000, max_downside_micros: 200_000_000 },
      stopRules: { min_runtime_hours: 48, min_sample: 100, success_threshold: 0.1, harm_threshold: 0.2 },
    },
  });

  const occurredAt = '2026-09-25T08:00:00.000Z';
  const envelope = (event_id, event_type, payload) => {
    const validated = validateEvent({
      event_id, event_type, tenant_id: 'tenant_usd', schema_version: '1', occurred_at: occurredAt, payload,
    });
    assert.equal(validated.ok, true, `fixture: ${event_id} must validate`);
    return validated.event;
  };
  for (const event of [
    envelope('evt_usd_spend', 'spend.observed', { campaign: 'us', amount_micros: 3_000_000_000, currency: 'USD' }),
    envelope('evt_usd_qualified', 'lead_qualified', { campaign: 'us', lead_id: 'lead_us', session_id: 'sess_us' }),
  ]) {
    repos.rawEvents.append(event);
  }
  // Before any money assertion: the qualified lead is what stops the CPL tile
  // reading the em-dash. If that has gone, the '$3,000.00' assertion below is
  // measuring the fixture, not the renderer.
  const seeded = repos.rawEvents.listByTypes('tenant_usd', ['spend.observed', 'lead_qualified']);
  assert.equal(
    seeded.filter((event) => event.event_type === 'lead_qualified').length, 1,
    'the CPL tile has a qualified volume to divide by, so it is not the em-dash',
  );

  // Every page is rendered twice: the ideal branch and the partial one, because
  // a mutation at either branch of a shared call site has to be caught and only
  // the pair catches both.
  for (const override of [undefined, 'partial']) {
    const where = override === undefined ? 'the ideal branch' : "the partial branch (override:'partial')";
    const opts = override === undefined ? {} : { override };

    const row = (await renderPage('/opportunities', { repositories: repos, ...opts }))
      .match(/<li class="opportunity-row"[\s\S]*?<\/li>/)[0];
    assert.match(row, /value \$6,000\.00/, `opportunity value in dollars on ${where}`);
    assert.match(row, /cost \$1,900\.00/, `opportunity cost in dollars on ${where}`);
    assert.doesNotMatch(row, /₹/, `no rupee sign on the opportunity row on ${where}`);

    const card = (await renderPage('/experiments', { repositories: repos, ...opts }))
      .match(/data-experiment-id="exp_usd_running"[\s\S]*?<\/li>/)[0];
    assert.match(
      card, /data-testid="caps">Max spend \$500\.00 · max downside \$200\.00/,
      `both caps in dollars on ${where}`,
    );
    assert.doesNotMatch(card, /₹/, `no rupee sign in the experiment card on ${where}`);

    const html = await renderPage('/', { repositories: repos, metaProvider: new FakeMetaAdsProvider(), ...opts });
    const cplTile = html.match(/kpi-card[\s\S]*?Qualified CPL[\s\S]*?<\/div>/)[0];
    const cplText = cplTile.match(/kpi-value">([^<]+)</)[1];
    assert.equal(cplText, '$3,000.00', `Qualified CPL in dollars on ${where}, got ${cplText}`);
    // Scoped to their own sections: the CPL value and the insight spend are
    // both dollar strings, so an unscoped assertion lets one site's regression
    // hide behind another's correct amount.
    const adSets = html.match(/data-testid="meta-adSets"[\s\S]*?<\/section>/)[0];
    const insights = html.match(/data-testid="meta-insights"[\s\S]*?<\/section>/)[0];
    assert.match(adSets, /\$500\.00/, `the ad-set budget in dollars on ${where}`);
    assert.match(insights, /\$4,000\.00/, `the insight spend in dollars on ${where}`);
    assert.doesNotMatch(adSets + insights, /₹/, `no rupee sign in the Meta sections on ${where}`);
  }
});

test('the Meta error shell renders the last-good money cells in the tenant currency too', async () => {
  // The last-good path is the one the ideal page never exercises, so a
  // wrong-currency symbol would hide there: on ?meta_error=quota the tables
  // come from the provider's snapshot, not from a live read.
  const repos = freshRepos();
  repos.tenants.create({ id: 'tenant_usd', name: 'US Tenant', currency: 'USD' });
  const html = await renderPage('/', {
    repositories: repos,
    metaProvider: new FakeMetaAdsProvider({ failureMode: 'quota' }),
    metaError: 'quota',
  });
  assert.match(html, /Meta provider sync failed/);
  assert.match(html, /data-testid="meta-last-good">Meta last good sync /, 'the tables are the last-good snapshot');
  assert.match(html, /\$500\.00/, 'the snapshot ad-set budget is in the tenant currency');
  assert.match(html, /\$4,000\.00/, 'the snapshot insight spend is in the tenant currency');
  assert.doesNotMatch(html, /₹/);
});

test('an unrecognised tenant currency renders as INR instead of throwing', async () => {
  // repositories.tenants.create accepts any string, so an unknown code is bad
  // data, not an exception. A page render must not 500 on it.
  const repos = freshRepos();
  repos.tenants.create({ id: 'tenant_odd', name: 'Odd Tenant', currency: 'ZZZ' });
  repos.opportunities.create({
    tenant_id: 'tenant_odd',
    opportunity_id: 'opp_odd',
    score: 0.4,
    record: {
      opportunity_id: 'opp_odd', tenant_id: 'tenant_odd', name: 'Odd bet',
      value_micros: 1_000_000_000, pSuccess: 0.2, fit: 0.5, infoValue: 0.8, reversibility: 0.5, cost_micros: 100_000_000, downside: 2, delay: 2,
    },
  });

  const row = (await renderPage('/opportunities', { repositories: repos }))
    .match(/<li class="opportunity-row"[\s\S]*?<\/li>/)[0];
  assert.match(row, /value ₹1,000\.00/, 'the fallback is the repo default, not a crash');
  assert.doesNotMatch(row, /ZZZ/);
  assert.match(
    await renderPage('/', { repositories: repos, metaProvider: new FakeMetaAdsProvider() }),
    /₹500\.00/,
    'the dashboard renders too',
  );
});

test('an experiment stored with no caps at all renders two em-dashes, never ₹NaN', async () => {
  // Reachable today: the card defaults caps to {} and renders money() on two
  // absent keys. The safe-integer guard in money() is what changes it.
  const repos = freshRepos();
  repos.tenants.create({ id: 'tenant_demo', name: 'Demo Tenant', currency: 'INR' });
  repos.experiments.create({
    tenant_id: 'tenant_demo',
    experiment_id: 'exp_no_caps',
    state: 'draft',
    record: { experiment_id: 'exp_no_caps', tenant_id: 'tenant_demo', name: 'Uncapped bet', arms: [], stopRules: {} },
  });

  for (const html of [
    await renderPage('/experiments', { repositories: repos }),
    await renderPage('/experiments', { repositories: repos, override: 'partial' }),
  ]) {
    const card = html.match(/data-experiment-id="exp_no_caps"[\s\S]*?<\/li>/)[0];
    assert.match(card, /data-testid="caps">Max spend — · max downside —</);
    assert.doesNotMatch(card, /₹NaN/);
  }
});

test('the experiment caps render through the same helper on both the ideal and the partial branch', async () => {
  // Two cards.map(experimentCard) sites, so two places for the currency to be
  // dropped. Both branches, both caps, exactly once each per card.
  const repos = seededRepos('pages-caps-branches-');
  for (const html of [
    await renderPage('/experiments', { repositories: repos }),
    await renderPage('/experiments', { repositories: repos, override: 'partial' }),
  ]) {
    const card = html.match(/data-experiment-id="exp_seed_running"[\s\S]*?<\/li>/)[0];
    assert.match(card, /Max spend ₹500\.00 · max downside ₹200\.00/);
    assert.equal((card.match(/₹500\.00/g) ?? []).length, 1, 'the max spend cap appears exactly once');
    assert.equal((card.match(/₹200\.00/g) ?? []).length, 1, 'the max downside cap appears exactly once');
    assert.doesNotMatch(card, /₹NaN/);
  }
});

// Issue #51 finding 1: the pinning test at the top of this file exercises
// H1_HOOK itself, so reverting the production call site to the pre-#46
// class-coupled regex leaves the file green. Pin the call site itself.
test('the production h1 assertion goes through H1_HOOK, not an inline regex', () => {
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  // Built from parts so this line cannot match itself. With the needle
  // unsplittable, .find() would return this very line the moment the
  // production call site was deleted, and the test would fail on a secondary
  // assertion instead of the one that names what went missing.
  const needle = 'the h1 carries the page-title' + ' hook';
  const lines = source.split('\n').filter((line) => line.includes(needle));
  const callSite = lines[0];
  assert.ok(callSite, 'the 25-shell h1 assertion is still in this file');
  assert.equal(lines.length, 1, 'the anchor is found exactly once, so it cannot match a second line');
  assert.match(callSite, /assert\.match\(html, H1_HOOK,/, 'the call site uses the pinned constant');
  assert.doesNotMatch(callSite, /class="page-title"/, 'the call site inlines no class-coupled regex');
});

// The class, read off the rendered h1 rather than hard-coded, so the two ends
// of the link are held by one check instead of two literals that happen to
// agree. The pattern is anchored on whitespace on purpose: /\bclass="/ matches
// inside data-class=, which is the false pass this ticket closes, and so does
// the /<h1\s[^>]*\bclass="/ the issue proposed — [^>]* eats the 'data-' and \b
// is a boundary between '-' and 'c'. This form tolerates either attribute
// order, which is what #46 bought and must not be lost here.
function pageTitleClass(html) {
  const h1 = /<h1[^>]*>/.exec(html)?.[0] ?? '';
  assert.match(h1, /data-testid="page-title"/, 'the page h1 is the hook under test');
  return /\sclass="([^"]*)"/.exec(h1)?.[1] ?? '';
}

// Issue #51 finding 2: this is the one place in the suite that asserts on a
// class name, and deliberately so. .sdlc/memory/qa/selectors.md says class
// names are styling hooks and not assertions; the class is the single hook
// that reaches the stylesheet rule, so the exception is declared here instead
// of left accidental. That memory file is owned by the Librarian and does not
// yet record the exception — it could not be edited from a ticket — so an
// agent who reads the memory file and not this comment may take these pins for
// a convention violation, or delete them as redundant. They are not.
test('the shipped page h1 carries the styling class the stylesheet rules on', async () => {
  const html = await renderPage('/', { repositories: freshRepos() });
  const cls = pageTitleClass(html);
  // A class carrying regex metacharacters cannot be escaped into the two
  // lookups below, so fail loudly rather than build a pattern that might
  // match the wrong rule.
  assert.match(cls, /^[A-Za-z_-][A-Za-z0-9_-]*$/, 'the h1 carries one plain class name, with nothing to escape');
  const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');
  assert.ok(
    new RegExp(`\\.${cls}\\s*\\{`).test(css),
    `src/web/styles.css has a rule for .${cls}, the class the page h1 actually carries`,
  );

  assert.equal(
    /\bclass="([^"]*)"/.exec('<h1 data-class="page-title" data-testid="page-title">x</h1>')?.[1],
    'page-title',
    'the word-boundary form this helper replaced matched data-class=, and that was the false pass',
  );
  assert.equal(
    pageTitleClass('<h1 data-class="page-title" data-testid="page-title">x</h1>'),
    '',
    'a data-class attribute is not a class attribute',
  );
  assert.equal(
    pageTitleClass('<h1 data-testid="page-title">x</h1>'),
    '',
    'a missing class attribute yields no class, not a false one',
  );
});

// Issue #51 finding 4: the other end of the same link. Asserting the
// stylesheet's own contents is convention-clean under
// .sdlc/memory/qa/selectors.md and makes AC-2's claim machine-checkable. The
// rule is resolved from the class the h1 carries, so the two ends may move
// together — and the message names which end moved, because a one-sided rename
// is the case where the reader needs telling.
test('the rule the page h1 carries still holds the declarations the page title depends on', async () => {
  const html = await renderPage('/', { repositories: freshRepos() });
  const cls = pageTitleClass(html);
  const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');
  const rule = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(rule, `src/web/styles.css defines a .${cls} rule for the class the page h1 carries`);
  assert.match(rule[1], /margin:\s*0\s*;/, 'the browser default h1 margin is cancelled');
  assert.match(rule[1], /font-size:\s*1\.4rem\s*;/, 'the page title keeps the display size');
  assert.match(rule[1], /line-height:\s*1\.25\s*;/, 'the page title keeps its line height');
});

// ---------------------------------------------------------------------------
// The cascade guard. A declaration is not a rendering: CSS decides what the
// browser applies by cascade, so a rule that outranks the class rule — higher
// specificity, or equal and later, including inside an at-rule — leaves every
// declaration assertion above satisfied and the heading wrong. node:test has no
// DOM and cannot read a computed style, so the helpers below work out which
// rule the browser would apply to <main id="main"><h1 class="cls"> and name the
// ones that beat it. A resolver that guessed at CSS it cannot model would be
// the same false pass again, so it throws on unsupported syntax instead.
// ---------------------------------------------------------------------------

// The three things the page title depends on. Each group lists every shorthand
// and longhand that can set it: a candidate that beats the class rule on any of
// them moves the rendered value. `font` is in the first two groups because it
// sets both at once — reported once per group, which is a correct report rather
// than a duplicate, and cheaper than letting a shorthand through unnoticed.
const PAGE_TITLE_PROPERTIES = [
  { group: 'font-size', properties: ['font-size', 'font'] },
  { group: 'line-height', properties: ['line-height', 'font'] },
  { group: 'margin-top', properties: ['margin', 'margin-top', 'margin-block', 'margin-block-start'] },
];

function unsupportedSelector(selector, reason) {
  return new Error(`the cascade guard cannot read the selector '${selector}': ${reason}`);
}

// Cheap reachability, run before any parsing, so a selector the guard does not
// evaluate (.checklist li:not(.x)) is skipped without being parsed and never
// breaks the suite. Every branch that may reach the h1 is then re-checked
// exactly by parseSelector below — so being generous here can only produce a
// failure or a throw, never a false pass.
function mayReachPageTitle(selector, cls) {
  if (selector === '' || selector.startsWith('@')) return false;
  const compounds = selector.split(/\s*>\s*|\s+/).filter((compound) => compound !== '');
  // Anchored on the start of a compound, not compared for equality. A test for
  // the bare token 'h1' reaches the page h1 only when the whole compound is
  // exactly that, so h1[data-testid], h1:hover, h1:first-child and
  // main > h1[data-testid] were all dropped here, never reached parseSelector,
  // and never reported — h1[data-testid] matching the shipped h1 exactly, at
  // (0,1,1) against the class rule's (0,1,0).
  if (compounds.some((compound) => /^h1(?![\w-])/.test(compound))) return true;
  // On the last compound only, where these reach the h1 at all: '*' matches
  // the element itself, html and body reach it by inheritance, and whether a
  // declaration there can win is parseSelector's call, not this one's.
  const last = compounds[compounds.length - 1] ?? '';
  if (/^(?:\*|html|body)(?![\w-])/.test(last)) return true;
  return last.includes(`.${cls}`);
}

// Supported vocabulary: id, class, attribute, single-colon pseudo-class, type,
// '*', and the descendant and '>' combinators (comma lists are split by the
// caller). A pseudo-element, a '+' or '~', or a functional pseudo-class such as
// :not(…) throws, naming the offending selector. Only branches that may reach
// the h1 are ever parsed, so this cannot fire on unrelated CSS.
function parseSelector(selector, cls) {
  // The two supported combinators, and the only whitespace a selector carries.
  const compounds = selector.split(/\s*>\s*|\s+/).filter((compound) => compound !== '');
  let ids = 0;
  let classes = 0;
  let types = 0;
  let matchesPageTitle = false;

  compounds.forEach((compound, position) => {
    let rest = compound;
    let lastCarriesClass = false;
    let lastIsH1 = false;
    let lastIsUniversal = false;

    while (rest !== '') {
      if (rest.startsWith('::')) throw unsupportedSelector(selector, 'a pseudo-element');
      if (rest.startsWith('+') || rest.startsWith('~')) {
        throw unsupportedSelector(selector, `the '${rest[0]}' combinator`);
      }
      if (rest.startsWith(':')) {
        const pseudo = /^:[A-Za-z-]+/.exec(rest);
        if (!pseudo) throw unsupportedSelector(selector, `the token '${rest}'`);
        if (rest[pseudo[0].length] === '(') {
          throw unsupportedSelector(selector, `the functional pseudo-class '${pseudo[0]}('`);
        }
        classes += 1;
        rest = rest.slice(pseudo[0].length);
        continue;
      }
      const simple = /^(?:#[A-Za-z_][\w-]*|\.[A-Za-z_-][\w-]*|\[[^\]]*\]|\*|[A-Za-z][\w-]*)/.exec(rest);
      if (!simple) throw unsupportedSelector(selector, `the token '${rest}'`);
      const token = simple[0];
      if (token.startsWith('#')) ids += 1;
      else if (token.startsWith('.')) {
        classes += 1;
        lastCarriesClass = token === `.${cls}`;
      } else if (token.startsWith('[')) classes += 1;
      else if (token === '*') lastIsUniversal = true;
      else {
        types += 1;
        lastIsH1 = token === 'h1';
      }
      rest = rest.slice(token.length);
    }

    if (position === compounds.length - 1) {
      // Whether the branch matches the h1 element itself. html and body do not:
      // they reach it by inheritance, and an inherited value applies only where
      // no declaration matches the element — which the class rule always does
      // for these three properties, !important on the ancestor or not. Where it
      // declares none of them, outrankingPageTitleDeclarations reports that
      // directly rather than blaming an override that cannot happen.
      matchesPageTitle = lastCarriesClass || lastIsH1 || lastIsUniversal;
    }
  });

  return { specificity: [ids, classes, types], matchesPageTitle };
}

function specificityOf(selector, cls) {
  return parseSelector(selector, cls).specificity;
}

// Greater specificity wins; equal specificity is decided by source order, so
// the later declaration is the one the browser applies.
function beats(candidate, baseline) {
  for (let rank = 0; rank < 3; rank += 1) {
    if (candidate.specificity[rank] !== baseline.specificity[rank]) {
      return candidate.specificity[rank] > baseline.specificity[rank];
    }
  }
  return candidate.index > baseline.index;
}

// Flatten the stylesheet into rules in document order, lifting @media and
// @supports contents up: a responsive override of the h1's font-size is a real
// override at that width, and the failure message has to name the condition so
// the reader knows when it bites. Keyframes describe an animation rather than a
// rendered element, so they are skipped with their bodies.
function readStylesheet(css) {
  const rules = [];

  const walk = (text, atRules) => {
    let at = 0;
    while (at < text.length) {
      const brace = text.indexOf('{', at);
      if (brace === -1) return;
      // An at-rule statement rather than a block — @import, @charset — has no
      // braces, so step over its semicolon instead of swallowing the next rule.
      const statement = text.indexOf(';', at);
      if (statement !== -1 && statement < brace) {
        at = statement + 1;
        continue;
      }
      const selector = text.slice(at, brace).trim();
      let depth = 1;
      let end = brace + 1;
      while (end < text.length && depth > 0) {
        if (text[end] === '{') depth += 1;
        else if (text[end] === '}') depth -= 1;
        end += 1;
      }
      const body = text.slice(brace + 1, end - 1);

      if (/^@(media|supports)\b/i.test(selector)) walk(body, [...atRules, selector]);
      else if (selector !== '' && !selector.startsWith('@')) {
        rules.push({ selector, body, atRules, index: rules.length });
      }
      at = end;
    }
  };

  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), []);
  return rules;
}

function declarations(body) {
  return body.split(';').map((declaration) => {
    const colon = declaration.indexOf(':');
    if (colon === -1) return null;
    return {
      property: declaration.slice(0, colon).trim().toLowerCase(),
      value: declaration.slice(colon + 1).trim(),
      important: /!\s*important\s*$/i.test(declaration),
    };
  }).filter((declaration) => declaration !== null);
}

function branchesOf(rule) {
  return rule.selector.split(',').map((branch) => branch.trim());
}

// Every declaration that would beat the class rule for one of the three
// properties the page title depends on, with the message the reader needs.
function outrankingPageTitleDeclarations(css, cls) {
  const rules = readStylesheet(css);
  const offenders = [];
  // Every rule carrying the class, in document order. A stylesheet may split
  // one class over several rules — an added !important declaration is the usual
  // reason — and the cascade keeps the last declaration of a property from
  // among them all, not from the last rule alone. Taking only the last rule
  // hid the earlier ones' declarations and made the guard report that the
  // class rule "declares no line-height" about a stylesheet that declares it.
  const classRules = rules.filter((rule) => branchesOf(rule).includes(`.${cls}`));
  const classIndexes = new Set(classRules.map((rule) => rule.index));

  for (const { group, properties } of PAGE_TITLE_PROPERTIES) {
    const subject = `the page h1's ${group}`;
    if (classRules.length === 0) {
      offenders.push({
        selector: `.${cls}`,
        atRules: [],
        group,
        property: group,
        message: `src/web/styles.css has no .${cls} rule, and ${subject} is set entirely by something else`,
      });
      continue;
    }
    const classBranch = `.${cls}`;
    const held = classRules.flatMap((rule) => declarations(rule.body)
      .filter((entry) => properties.includes(entry.property))
      .map((entry) => ({ ...entry, index: rule.index })));
    if (held.length === 0) {
      offenders.push({
        selector: classBranch,
        atRules: classRules[classRules.length - 1].atRules,
        group,
        property: group,
        message: `${classBranch} declares no ${properties.join(' or ')}, so ${subject} is not held by the class rule`,
      });
      continue;
    }
    // The last declaration of this property the cascade keeps is the one to
    // name and the one whose importance decides the comparison — and the rule
    // it came from is the one the class rule is compared with for order.
    const winner = held[held.length - 1];
    const baseline = { specificity: parseSelector(classBranch, cls).specificity, index: winner.index };

    for (const rule of rules) {
      if (classIndexes.has(rule.index)) continue;
      for (const selector of branchesOf(rule)) {
        if (!mayReachPageTitle(selector, cls)) continue;
        const candidate = parseSelector(selector, cls);
        if (!candidate.matchesPageTitle) continue;
        for (const entry of declarations(rule.body).filter((one) => properties.includes(one.property))) {
          // Importance outranks specificity in author origin, and it is
          // asymmetric: an !important declaration beats every normal one, so a
          // plain rule cannot outrank a class rule that is itself !important
          // however much of an id it carries. Of two declarations of equal
          // weight — both normal, or both !important — the cascade decides as
          // it does everywhere else.
          if (entry.important !== winner.important) {
            if (winner.important) continue;
          } else if (!beats({ ...candidate, index: rule.index }, baseline)) continue;
          const inside = rule.atRules.length > 0 ? ` inside ${rule.atRules.join(' then ')}` : '';
          const because = entry.important && !winner.important
            ? 'carries !important, which outranks any normal declaration of the same property'
            : `outranks .${cls} at (${candidate.specificity.join(',')})`;
          // A shorthand is reported under the group it moves, so name what it
          // sets rather than quoting 'font' as though it were a font-size.
          const sets = entry.property === group
            ? `sets ${entry.property}: ${entry.value}`
            : `sets ${entry.property}, which sets the h1's ${group}, to ${entry.value}`;
          const instead = entry.property === group
            ? `${subject} would be ${entry.value}`
            : `${subject} would come from that shorthand`;
          offenders.push({
            selector,
            atRules: rule.atRules,
            group,
            property: entry.property,
            message: `the selector '${selector}'${inside} ${sets} and ${because} — `
              + `${instead} instead of ${winner.property}: ${winner.value}`,
          });
        }
      }
    }
  }

  return offenders;
}

test('nothing outranks the page title rule for the typography the h1 depends on', async () => {
  const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');
  const html = await renderPage('/', { repositories: freshRepos() });
  const cls = pageTitleClass(html);
  const inMedia = `${css}\n@media (max-width: 900px) { #main h1 { font-size: 2.4rem; } }\n`;

  // The shipped stylesheet must be clean, and it is the case that proves the
  // resolver is not simply flagging everything: the '*' reset and the body
  // typography both reach the h1 and both lose to the class rule.
  assert.deepEqual(
    outrankingPageTitleDeclarations(css, cls).map((offender) => offender.message),
    [],
    'nothing in the shipped stylesheet beats the class rule for the h1',
  );

  const override = '#main h1 { font-size: 2.4rem; line-height: 1.6; margin-top: 24px; }';
  const bySelectorAndProperty = (offenders) => offenders.map((one) => `${one.selector} ${one.property}`);

  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(`${css}\n${override}\n`, cls)),
    ['#main h1 font-size', '#main h1 line-height', '#main h1 margin-top'],
    'a later, higher-specificity h1 rule is named once per property — this leaves every declaration above satisfied',
  );
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(inMedia, cls)),
    ['#main h1 font-size'],
    'the same override inside a media query is a real override at that width',
  );
  assert.match(
    outrankingPageTitleDeclarations(inMedia, cls)[0].message,
    /@media \(max-width: 900px\)/,
    'the message names the condition the override bites in',
  );
  assert.deepEqual(
    // Anchored on the resolved class, not the literal, or the insertion would
    // silently no-op under a coordinated rename and this case would pass green.
    bySelectorAndProperty(outrankingPageTitleDeclarations(css.replace(`.${cls} {`, `${override}\n\n.${cls} {`), cls)),
    ['#main h1 font-size', '#main h1 line-height', '#main h1 margin-top'],
    'specificity decides, not source order: the same rule declared above the class rule still fails',
  );

  assert.deepEqual(outrankingPageTitleDeclarations(`${css}\n* { font-size: 2.4rem; }\n`, cls), [],
    "'*' reaches every element but loses to the class rule at (0,1,0), so the heading is unaffected");
  assert.deepEqual(outrankingPageTitleDeclarations(`${css}\nbody { font-size: 2.4rem; }\n`, cls), [],
    'body reaches the h1 by inheritance and still loses at (0,0,1)');
  assert.deepEqual(outrankingPageTitleDeclarations(`${css}\nbody { font-size: 2.4rem !important; }\n`, cls), [],
    'an !important on an ancestor is still only an inherited value, and a declaration matching the h1 beats it at any weight');
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(`${css}\nh1 { font-size: 2.4rem !important; }\n`, cls)),
    ['h1 font-size'],
    '!important beats the class rule on specificity alone, which a guard that ignored it would miss',
  );

  // A bare h1 compound is the easy shape. These carry an extra simple selector
  // and reach the shipped <h1 class="page-title" data-testid="page-title">
  // exactly, so a pre-filter that tested the token for equality dropped them
  // all before the parser could decide and left the suite green on a heading
  // rendering at 38.4px.
  for (const override of [
    'h1[data-testid] { font-size: 2.4rem; }',
    'h1[data-x] { font-size: 2.4rem; }',
    'h1:hover { font-size: 2.4rem; }',
    'h1:first-child { font-size: 2.4rem; }',
    'main > h1[data-testid] { font-size: 2.4rem; }',
    '#main h1[data-testid] { font-size: 2.4rem; }',
  ]) {
    const selector = override.split(' {')[0];
    assert.deepEqual(
      bySelectorAndProperty(outrankingPageTitleDeclarations(`${css}\n${override}\n`, cls)),
      [`${selector} font-size`],
      `'${selector}' matches the shipped page h1, so it is a real override and must be reported`,
    );
  }

  // The font shorthand sets font-size and line-height in one declaration, so a
  // guard keyed on the longhands alone let it past as an ordinary unmatched
  // property. It is reported once per group it moves, which is the truth rather
  // than a duplicate.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(`${css}\n#main h1 { font: 700 2.4rem/1.6 system-ui; }\n`, cls)),
    ['#main h1 font', '#main h1 font'],
    'the font shorthand sets both guarded typographic properties and is outranked in neither',
  );

  // '*' under a descendant combinator still matches the h1, so the pre-filter
  // has to read the last compound rather than the whole branch.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(`${css}\nmain * { font-size: 2.4rem !important; }\n`, cls)),
    ['main * font-size'],
    "a universal selector under a descendant combinator matches the h1, and !important on it wins",
  );

  // Within the class rule the declaration the cascade keeps is the last one
  // setting that property, so that is the value the message names and the
  // importance the comparison weighs — not the first in the group.
  const twoLonghands = css.replace(`${cls} {`, `${cls} {\n  margin-top: 24px;`);
  const shadowed = bySelectorAndProperty(outrankingPageTitleDeclarations(`${twoLonghands}\n#main h1 { margin-top: 3rem; }\n`, cls));
  assert.deepEqual(shadowed, ['#main h1 margin-top'], 'the override is still an override whichever longhand it names');
  assert.match(
    outrankingPageTitleDeclarations(`${twoLonghands}\n#main h1 { margin-top: 3rem; }\n`, cls)[0].message,
    /instead of margin: 0/,
    'and the message names the declaration the class rule actually keeps',
  );

  // Importance is modelled on the class rule's side too: a plain rule of any
  // specificity loses to a class rule whose own declaration is !important. The
  // !important is appended as a second rule for the same class, which is how it
  // gets written, and the earlier rule's other declarations still hold.
  const importantRule = `\n.${cls} { font-size: 1.4rem !important; }\n#main h1 { font-size: 2.4rem; }\n`;
  assert.deepEqual(
    outrankingPageTitleDeclarations(css + importantRule, cls),
    [],
    'an !important class declaration is not outranked by a plain rule at (1,0,1), and the rest of the class rule still holds',
  );
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(`${css}\n.${cls} { font-size: 1.4rem; }\n#main h1 { font-size: 2.4rem; }\n`, cls)),
    ['#main h1 font-size'],
    'the same override is reported once the class rule drops the !important',
  );

  // A coordinated rename of the class is a styling decision both ends may make
  // together; a one-sided one is a loud failure. This is the behaviour #51's
  // work order said it wanted and its delivered literals did not permit. All
  // three are stated against the class the h1 actually carries, so they hold
  // whichever name it carries.
  const renamed = css.replaceAll(`.${cls}`, '.renamed-away');
  assert.deepEqual(outrankingPageTitleDeclarations(renamed, 'renamed-away'), [], 'both ends renamed together is green');
  assert.ok(outrankingPageTitleDeclarations(renamed, cls).length > 0, 'renaming only the stylesheet fails');
  assert.ok(outrankingPageTitleDeclarations(css, 'renamed-away').length > 0, 'renaming only the markup fails');

  assert.deepEqual(outrankingPageTitleDeclarations(`${css}\n.checklist li:not(.x) { font-size: 2rem; }\n`, cls), [],
    'a selector that cannot reach the page h1 is skipped unparsed, so the guard does not throw on CSS it never evaluates');
});

test('the cascade resolver agrees with CSS on specificity', () => {
  const cls = 'page-title';

  assert.deepEqual(specificityOf('*', cls), [0, 0, 0], "'*' is not a type name");
  assert.deepEqual(specificityOf('body', cls), [0, 0, 1], 'a bare type is one c');
  assert.deepEqual(specificityOf('h1', cls), [0, 0, 1], 'the h1 type is one c');
  assert.deepEqual(specificityOf('.page-title', cls), [0, 1, 0], 'a class is one b');
  assert.deepEqual(specificityOf('.a.b', cls), [0, 2, 0], 'a compound of two classes is two b');
  assert.deepEqual(specificityOf('[aria-current="page"]', cls), [0, 1, 0], 'an attribute selector is one b');
  assert.deepEqual(specificityOf('a:hover', cls), [0, 1, 1], 'a single-colon pseudo-class is a b, not a c');
  assert.deepEqual(specificityOf('#main', cls), [1, 0, 0], 'an id is one a');
  assert.deepEqual(specificityOf('#main h1', cls), [1, 0, 1], 'a descendant adds its ancestor to the specificity');
  assert.deepEqual(specificityOf('main > h1', cls), [0, 0, 2], "'>' is a combinator, not a type name");

  const pageTitle = { specificity: specificityOf('.page-title', cls), index: 99 };
  assert.ok(beats({ specificity: specificityOf('#main h1', cls), index: 0 }, pageTitle),
    "'#main h1' beats '.page-title' a hundred rules earlier");
  assert.ok(beats({ specificity: specificityOf('.a.b', cls), index: 0 }, { ...pageTitle, specificity: specificityOf('.a', cls) }),
    "'.a.b' beats '.a'");
  assert.ok(!beats({ specificity: specificityOf('*', cls), index: 99 }, pageTitle), "'*' beats nothing, at any source position");
  assert.ok(beats({ ...pageTitle, index: 5 }, { ...pageTitle, index: 4 }), 'equal specificity is decided by source order');
  assert.ok(!beats({ ...pageTitle, index: 4 }, { ...pageTitle, index: 5 }), 'and not by the reverse');

  assert.ok(parseSelector('*', cls).matchesPageTitle, 'the universal selector matches every element');
  assert.equal(parseSelector('body', cls).matchesPageTitle, false,
    'body reaches the h1 by inheritance, and an inherited value cannot outrank a declaration matching the element');
  assert.ok(parseSelector('h1', cls).matchesPageTitle, 'an h1 type selector reaches the h1');
  assert.ok(parseSelector('h1[data-testid]', cls).matchesPageTitle, 'so does the shipped h1 plus an attribute');
  assert.ok(parseSelector('h1:hover', cls).matchesPageTitle, 'and the same h1 with a pseudo-class');
  assert.ok(parseSelector('main > h1[data-testid]', cls).matchesPageTitle, 'and with a combinator in front of it');
  assert.ok(parseSelector('main .page-title', cls).matchesPageTitle, 'a descendant of the class matches the h1');
  assert.equal(parseSelector('#main', cls).matchesPageTitle, false, 'an ancestor id does not match the h1 itself');
  assert.equal(parseSelector('.panel h2', cls).matchesPageTitle, false, 'a different element does not match the h1');
  assert.equal(parseSelector('.page-title-extra', cls).matchesPageTitle, false, 'a longer class name is not the class');

  // Unsupported syntax throws rather than parsing to a number it invented: a
  // stylesheet the guard cannot model must fail the suite loudly, not pass it
  // for the wrong reason.
  assert.throws(() => specificityOf('.checklist li:not(.x)', cls), /:not\(/, 'a functional pseudo-class throws');
  assert.throws(() => specificityOf('.page-title::after', cls), /pseudo-element/, 'a pseudo-element throws');
  assert.throws(() => specificityOf('h1 + p', cls), /'\+' combinator/, "the '+' combinator throws");
  assert.throws(() => specificityOf('h1 ~ p', cls), /'~' combinator/, "the '~' combinator throws");
});
