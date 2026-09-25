import { test } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories, replayRawToDerived } from '../../src/data/repositories.js';
import { validateEvent } from '../../src/domain/events.js';
import { computeFunnel } from '../../src/domain/measurement.js';
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

const FIXTURE_OCCURRED_AT = '2026-09-25T08:00:00.000Z';

/** A validated envelope for a named tenant. The assertion names the event
 * that broke, so a malformed fixture never surfaces as a rendering bug. */
function validatedEnvelope(tenantId, event_id, event_type, payload) {
  const validated = validateEvent({
    event_id, event_type, tenant_id: tenantId, schema_version: '1', occurred_at: FIXTURE_OCCURRED_AT, payload,
  });
  assert.equal(validated.ok, true, `fixture: ${event_id} must validate`);
  return validated.event;
}

/** A USD tenant with one opportunity, whose value and cost are the amounts the
 * currency assertions read. No events and no experiment: the fixtures that
 * need those append them on top of the repos this returns. */
function usdRepos() {
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
  return repos;
}

/** usdRepos() with the tenant's stored currency code spelled the way a row
 * this app did not write might spell it. tenants.create accepts any string —
 * the contract the ZZZ test below pins — so this builds a mis-cased row
 * without a migration, and reaches the same state the QA repro makes with a
 * raw SQL UPDATE. The amounts match usdRepos() so a render is comparable. */
function usdCasingRepos(storedCurrency) {
  const repos = freshRepos();
  repos.tenants.create({ id: 'tenant_usd', name: 'US Tenant', currency: storedCurrency });
  repos.opportunities.create({
    tenant_id: 'tenant_usd',
    opportunity_id: 'opp_usd_casing',
    score: 0.9208,
    record: {
      opportunity_id: 'opp_usd_casing', tenant_id: 'tenant_usd', name: 'US bet',
      value_micros: 6_000_000_000, pSuccess: 0.6, fit: 0.9, infoValue: 1.2, reversibility: 0.9, cost_micros: 1_900_000_000, downside: 2, delay: 1,
    },
  });
  return repos;
}

/** Every formatted amount on the first opportunity row, in render order, so
 * one render's money can be compared against another's directly instead of by
 * eye. The em-dash is a legitimate value here — that is the case a genuine
 * foreign-surrency spend produces. */
function opportunityRowMoney(html) {
  const row = html.match(/<li class="opportunity-row"[\s\S]*?<\/li>/)[0];
  return [...row.matchAll(/[$₹€£][\d,]+\.\d{2}/g)].map((match) => match[0]);
}

/** The Qualified CPL tile's rendered value, the way the kpiStrip assertions
 * read it. */
function qualifiedCplValue(html) {
  const tile = html.match(/kpi-card[\s\S]*?Qualified CPL[\s\S]*?<\/div>/)[0];
  return tile.match(/kpi-value">([^<]+)</)[1];
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
  const mainOf = (html) => /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? '';
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

// Issue #52: following a same-document fragment link moves focus only if its
// target is focusable, and <main> is not by default. The landmark therefore
// carries tabindex="-1" — programmatically focusable, still out of the tab
// sequence — or activating the skip link scrolls to #main and leaves focus on
// <body>, putting the keyboard user back in the header it promises to skip.
const skipLinkFocusesMain = (html) => {
  const mainAttrs = /<main\b([^>]*)>/.exec(html)?.[1] ?? '';
  // Find the link by its target rather than by position, so the brand and the
  // nav are not depended on to sort before it.
  const skipAttrs = [...html.matchAll(/<a\b([^>]*)>/g)]
    .map(([, attrs]) => attrs)
    .find((attrs) => /\bhref="#main"/.test(attrs));
  return Boolean(
    /\bid="main"/.test(mainAttrs) &&
    /\btabindex="-1"/.test(mainAttrs) &&
    skipAttrs !== undefined &&
    /\bclass="[^"]*\bskip-link\b[^"]*"/.test(skipAttrs)
  );
};

test('the skip link targets a focusable main landmark on every route and state', async () => {
  const STATES = ['ideal', 'empty', 'loading', 'partial', 'error'];

  for (const route of ROUTES) {
    for (const state of STATES) {
      const where = `${route}?state=${state}`;
      const html = await renderPage(route, { repositories: freshRepos(), override: state });
      assert.ok(skipLinkFocusesMain(html), `${where}: the skip link points at a focusable main landmark`);
    }
  }

  // Both attributes are matched against the tag's captured attribute string, so
  // the property is asked of markup nobody emits rather than asserted about
  // once. Asserting <main id="main"[^>]*tabindex="-1"/> instead would read as
  // order-independent and would fail the same valid page, reordered.
  assert.ok(
    skipLinkFocusesMain('<a href="#main" class="skip-link">Skip to content</a><main tabindex="-1" id="main"></main>'),
    'attribute order is not pinned on either tag'
  );
  assert.ok(
    skipLinkFocusesMain('<a class="skip-link" href="#main" lang="en">Skip to content</a><main id="main" lang="en" tabindex="-1"></main>'),
    'a third attribute on either tag is tolerated'
  );

  // What the lock protects, one failure mode at a time.
  assert.ok(
    !skipLinkFocusesMain('<a class="skip-link" href="#main">Skip to content</a><main id="main"></main>'),
    'a main without tabindex is not focusable, so the link only scrolls'
  );
  assert.ok(
    !skipLinkFocusesMain('<a class="skip-link" href="#content">Skip to content</a><main id="main" tabindex="-1"></main>'),
    'the skip link has to target main'
  );
  assert.ok(
    !skipLinkFocusesMain('<a href="#main">Skip to content</a><main id="main" tabindex="-1"></main>'),
    'a link to #main that is not the skip link is not the bypass'
  );
});

// The other end of the same link: the one line that stops the skip link's focus
// from painting the global accent ring around all 1100px of main can be deleted
// with a green suite unless something here asserts it. Same currency as the
// .page-title rule test further down, applied to the stylesheet.
test('the #main focus suppression still carries the declaration the skip target depends on', () => {
  const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');
  const rule = /#main:focus\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'src/web/styles.css defines a #main:focus rule');
  assert.match(rule[1], /outline:\s*none\s*;/, 'the focused landmark paints no ring');
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
  // Ingest would 400 the USD row against the INR tenant (CURRENCY_MISMATCH),
  // so the only way a live database holds both is the repository route:
  // a pre-fix legacy batch appended straight into the append-only table.
  const legacy = [
    validatedEnvelope('tenant_demo', 'evt_ac_inr_spend', 'spend.observed', { campaign: 'legacy', amount_micros: 3_000_000_000, currency: 'INR' }),
    validatedEnvelope('tenant_demo', 'evt_ac_usd_spend', 'spend.observed', { campaign: 'legacy', amount_micros: 3_000_000_000, currency: 'USD' }),
    validatedEnvelope('tenant_demo', 'evt_ac_qualified', 'lead_qualified', { campaign: 'legacy', lead_id: 'lead_ac', session_id: 'sess_ac' }),
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
  const legacy = [
    validatedEnvelope('tenant_demo', 'evt_legacy_inr_spend', 'spend.observed', { campaign: 'legacy', amount_micros: 3_000_000_000, currency: 'INR' }),
    validatedEnvelope('tenant_demo', 'evt_legacy_usd_spend', 'spend.observed', { campaign: 'legacy', amount_micros: 3_000_000_000, currency: 'USD' }),
    validatedEnvelope('tenant_demo', 'evt_legacy_qualified', 'lead_qualified', { campaign: 'legacy', lead_id: 'lead_legacy', session_id: 'sess_legacy' }),
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
  const repos = usdRepos();

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
  const repos = usdRepos();
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

  for (const event of [
    validatedEnvelope('tenant_usd', 'evt_usd_spend', 'spend.observed', { campaign: 'us', amount_micros: 3_000_000_000, currency: 'USD' }),
    validatedEnvelope('tenant_usd', 'evt_usd_qualified', 'lead_qualified', { campaign: 'us', lead_id: 'lead_us', session_id: 'sess_us' }),
  ]) {
    repos.rawEvents.append(event);
  }
  // Before any money assertion, the fixture's own arithmetic is checked, so a
  // broken fixture fails HERE rather than surfacing at the money assertion as
  // 'got —', which reads as a currency regression. Both halves of the CPL
  // need guarding: the qualified lead is the denominator, and the spend row is
  // the numerator. Guarding only the denominator lets a fixture that stopped
  // carrying its amount pass this guard and then fail as a currency bug —
  // which is exactly what the guard's own comment claims to prevent.
  const seeded = repos.rawEvents.listByTypes('tenant_usd', ['spend.observed', 'lead_qualified']);
  assert.equal(
    seeded.filter((event) => event.event_type === 'lead_qualified').length, 1,
    'the CPL tile has a qualified volume to divide by, so it is not the em-dash',
  );
  assert.equal(
    seeded.find((event) => event.event_type === 'spend.observed')?.payload?.amount_micros, 3_000_000_000,
    'the fixture still carries the spend the $3,000.00 CPL is 3_000_000_000 divided by',
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

// A stored currency code is an arbitrary string: the QA repro sets the column
// with a raw SQL UPDATE, which never reaches tenants.create, so 'usd', 'Usd'
// and ' USD ' all arrive in the read path. These name the SAME unit of account
// as 'USD', and every test here fails against the exact-match membership test
// this replaces — a 'usd' tenant drew all six of its dashboard amounts as
// rupees and its own spend as foreign.
test('a tenant stored as lowercase usd renders its own currency on the opportunity row', async () => {
  const repos = usdCasingRepos('usd');
  const row = (await renderPage('/opportunities', { repositories: repos }))
    .match(/<li class="opportunity-row"[\s\S]*?<\/li>/)[0];
  assert.match(row, /value \$6,000\.00/, 'the stored row names the same currency as USD');
  assert.match(row, /cost \$1,900\.00/);
  assert.doesNotMatch(row, /₹/, 'no rupee sign survives anywhere on a usd row');
});

test('usd, Usd and a padded USD render byte-identical money, so case is not a currency', async () => {
  // Compared against each other rather than eyeballed: three renders that
  // each happen to look right is a weaker claim than three that are equal,
  // and the baseline is pinned too so the comparison cannot pass vacuously
  // on three empty lists.
  const renders = [];
  for (const stored of ['usd', 'Usd', ' USD ']) {
    renders.push(opportunityRowMoney(await renderPage('/opportunities', { repositories: usdCasingRepos(stored) })));
  }
  assert.deepEqual(renders[0], ['$6,000.00', '$1,900.00'], 'the usd row draws its own unit, in render order');
  assert.deepEqual(renders[1], renders[0], 'Usd draws exactly what usd draws');
  assert.deepEqual(renders[2], renders[0], 'a padded code draws exactly what usd draws');
});

test('a usd tenant with its own USD spend gets a number for Qualified CPL, not the em-dash', async () => {
  // The exclusion in computeFunnel used to see the tenant row's 'usd' and the
  // spend row's 'USD' as two currencies, so the tenant's own spend was dropped
  // and the tile read '—'. The figure is this fixture's own: one qualified
  // lead and no seed rows, so 3_000_000_000 / 1. The seeded database behind
  // the browser criterion divides the same amount by three.
  const repos = usdCasingRepos('usd');
  for (const event of [
    validatedEnvelope('tenant_usd', 'evt_casing_spend', 'spend.observed', { campaign: 'us', amount_micros: 3_000_000_000, currency: 'USD' }),
    validatedEnvelope('tenant_usd', 'evt_casing_qualified', 'lead_qualified', { campaign: 'us', lead_id: 'lead_casing', session_id: 'sess_casing' }),
  ]) {
    repos.rawEvents.append(event);
  }
  const cplText = qualifiedCplValue(await renderPage('/', { repositories: repos }));
  assert.equal(cplText, '$3,000.00', `a usd tenant's own USD spend must reach the CPL, got ${cplText}`);
});

test("a usd tenant whose only spend row is a different currency still reads the em-dash", async () => {
  // The case an earlier reading of this ticket mistook for the defect. It is
  // not: computeFunnel excludes spend denominated in a currency other than
  // the tenant's, and a tenant whose only spend is genuinely foreign really
  // does have no CPL to show. Ingest would 400 this INR row against the usd
  // tenant, so — as in the mixed-currency legacy tests above — the only way a
  // database holds both is the append-only repository route.
  //
  // Pinned so the em-dash cannot later be "fixed" by summing foreign-currency
  // spend, which would put a real number in front of a reader denominated in
  // the wrong unit. An em-dash that means "we do not know" is the honest one.
  const repos = usdCasingRepos('usd');
  for (const event of [
    validatedEnvelope('tenant_usd', 'evt_foreign_spend', 'spend.observed', { campaign: 'us', amount_micros: 3_000_000_000, currency: 'INR' }),
    validatedEnvelope('tenant_usd', 'evt_foreign_qualified', 'lead_qualified', { campaign: 'us', lead_id: 'lead_foreign', session_id: 'sess_foreign' }),
  ]) {
    repos.rawEvents.append(event);
  }
  const rows = repos.rawEvents.listByTypes('tenant_usd', ['spend.observed', 'lead_qualified']);
  assert.equal(computeFunnel(rows, 'USD').spend_micros, 0, 'the foreign row never enters the sum');
  assert.equal(computeFunnel(rows, 'USD').qualified_volume, 1, 'the qualified lead still counts');
  const cplText = qualifiedCplValue(await renderPage('/', { repositories: repos }));
  assert.equal(cplText, '—', 'no CPL is knowable, so the tile says so rather than inventing one');
});

test("a usd tenant's dashboard Meta tables render dollars", async () => {
  const repos = usdCasingRepos('usd');
  const html = await renderPage('/', { repositories: repos, metaProvider: new FakeMetaAdsProvider() });
  const adSets = html.match(/data-testid="meta-adSets"[\s\S]*?<\/section>/)[0];
  const insights = html.match(/data-testid="meta-insights"[\s\S]*?<\/section>/)[0];
  assert.match(adSets, /\$500\.00/, 'the ad-set budget is in the tenant currency');
  assert.match(insights, /\$4,000\.00/, 'the insight spend is in the tenant currency');
  assert.doesNotMatch(adSets + insights, /₹/, 'no rupee amount in the Meta sections');
});

test('a usd tenant still renders the last-good Meta snapshot in dollars on the error path', async () => {
  // The last-good path reads the same tenant currency as the ideal one, from a
  // snapshot rather than a live read, so it is a separate code path to the one
  // the ideal-page test exercises.
  const repos = usdCasingRepos('usd');
  const html = await renderPage('/', {
    repositories: repos,
    metaProvider: new FakeMetaAdsProvider({ failureMode: 'quota' }),
    metaError: 'quota',
  });
  assert.match(html, /data-testid="meta-last-good">Meta last good sync /, 'the tables are the last-good snapshot');
  assert.match(html, /\$500\.00/, 'the snapshot ad-set budget is in the tenant currency');
  assert.match(html, /\$4,000\.00/, 'the snapshot insight spend is in the tenant currency');
  assert.doesNotMatch(html, /₹/);
});

test('an unrecognised tenant currency is still resolved to the INR fallback, never leaked', async () => {
  // Case and whitespace are not currency errors, so canonicalCurrency resolves
  // them. A code that names no ISO currency is genuine bad data, and the
  // documented fallback is unchanged: it renders, and it does not 500 or print
  // the raw code at a reader.
  const repos = usdCasingRepos('ZZZ');
  const row = (await renderPage('/opportunities', { repositories: repos }))
    .match(/<li class="opportunity-row"[\s\S]*?<\/li>/)[0];
  assert.match(row, /value ₹6,000\.00/, 'an unknown code still falls back to the repo default');
  const html = await renderPage('/', { repositories: repos, metaProvider: new FakeMetaAdsProvider() });
  assert.doesNotMatch(html, /ZZZ/, 'the raw code never reaches a reader');
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
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const callSite = source.split('\n').find((line) => line.includes('the h1 carries the page-title hook'));
  assert.ok(callSite, 'the 25-shell h1 assertion is still in this file');
  assert.match(callSite, /assert\.match\(html, H1_HOOK,/, 'the call site uses the pinned constant');
  assert.doesNotMatch(callSite, /class="page-title"/, 'the call site inlines no class-coupled regex');
});

// Issue #51 finding 2: this is the one place in the suite that asserts on a
// class name, and deliberately so. The class is a styling hook, not a hook a
// behavioural test may depend on, but it is the only thing that reaches the
// .page-title rule — so the coupling is declared here instead of accidental.
test('the shipped page h1 carries the styling class the stylesheet rules on', async () => {
  const html = await renderPage('/', { repositories: freshRepos() });
  const h1 = /<h1[^>]*>/.exec(html)?.[0] ?? '';
  assert.match(h1, /data-testid="page-title"/, 'the page h1 is the hook under test');
  assert.equal(/\bclass="([^"]*)"/.exec(h1)?.[1], 'page-title', 'the emitted h1 still carries the styling class');
});

// Issue #51 finding 4: the other end of the same link. Asserting the
// stylesheet's own contents is convention-clean under
// .sdlc/memory/qa/selectors.md and makes AC-2's claim machine-checkable.
test('the .page-title rule still carries the declarations the page title depends on', () => {
  const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');
  const rule = /\.page-title\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'src/web/styles.css defines a .page-title rule');
  assert.match(rule[1], /margin:\s*0\s*;/, 'the browser default h1 margin is cancelled');
  assert.match(rule[1], /font-size:\s*1\.4rem\s*;/, 'the page title keeps the display size');
  assert.match(rule[1], /line-height:\s*1\.25\s*;/, 'the page title keeps its line height');
});

// Issue #48: the narrow-viewport overflow is a layout constraint rather than a
// styling choice, and a stylesheet is not observable from a rendered page — so
// these two declarations are pinned here for the same reason the #main:focus
// and .page-title rules above are. Delete either one and every page overflows
// sideways again below ~1100px, with a green browser run to prove it.
test('the narrow layout still carries the two declarations it depends on', () => {
  const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');

  const itemRule = /#main\s*>\s*\*\s*\{([^}]*)\}/.exec(css);
  assert.ok(itemRule, 'src/web/styles.css lifts the floor on the #main grid items');
  assert.match(itemRule[1], /min-width:\s*0\s*;/, 'a grid item may shrink below its min-content width');

  const regionRule = /\.table-scroll\s*\{([^}]*)\}/.exec(css);
  assert.ok(regionRule, 'src/web/styles.css defines a .table-scroll rule');
  assert.match(regionRule[1], /overflow-x:\s*auto\s*;/, 'a table wider than its column scrolls in its own region');
});

// The other half of the same fix. Lifting the floor stops one wide table from
// sizing the column for every sibling, but the table itself is still wider than
// the column, so it scrolls in a region of its own. The tabindex and the name
// are not decoration: a scroll container that cannot take focus cannot be
// scrolled by keyboard outside Chromium, which would trade a sideways-scrolling
// page for a table whose last columns cannot be read at all.
//
// Like the .page-title test above, this couples to a class name on purpose and
// says so: the wrapper is the only handle there is on the region, and asserting
// it on a rendered page is what makes the keyboard contract checkable.
test('every table the five routes render is wrapped in a keyboard-reachable, named region', async () => {
  const repos = seededRepos('pages-table-scroll-');
  const shells = [
    ['/', { metaProvider: new FakeMetaAdsProvider() }],
    ['/journal', {}],
    // The error shell keeps the journal table (it is the record the failure
    // preserved), so the region it scrolls in has to be there too.
    ['/journal', { override: 'error' }],
    ['/opportunities', {}],
    ['/experiments', {}],
    ['/approvals', {}],
  ];
  const labels = {};

  for (const [route, options] of shells) {
    const where = `${route}${options.override ? `?state=${options.override}` : ''}`;
    const html = await renderPage(route, { repositories: repos, ...options });
    const tables = html.match(/<table[\s>]/g) ?? [];
    const wrappers = html.match(/<div class="table-scroll"[^>]*>/g) ?? [];
    assert.equal(wrappers.length, tables.length, `${where}: every table has a region, and nothing else does`);

    labels[where] = wrappers.map((tag) => /\baria-label="([^"]*)"/.exec(tag)[1]);
    for (const [tag, label] of wrappers.map((w, i) => [w, labels[where][i]])) {
      assert.match(tag, /\btabindex="0"/, `${where}: ${label} takes focus, or its last columns are unreachable by keyboard`);
      assert.match(tag, /\brole="region"/, `${where}: ${label} is announced as a region`);
      assert.notEqual(label, '', `${where}: the region has a non-empty accessible name`);
    }
  }

  assert.ok(labels['/'].includes('Meta insights table'), 'the Meta panels name their table');
  assert.ok(labels['/journal'].includes('Decision journal table'), 'the journal names its table');
  assert.ok(labels['/journal?state=error'].includes('Decision journal table'), 'the preserved journal table is named too');
  assert.ok(
    labels['/approvals'].includes('Autonomy posture by action class table'),
    'the approvals posture table names itself'
  );
});

test('a page that renders no table renders no region, so the count above is not vacuous', async () => {
  const empty = await renderPage('/', { repositories: freshRepos() });
  assert.doesNotMatch(empty, /<table[\s>]/, 'the empty dashboard renders no table');
  assert.doesNotMatch(empty, /table-scroll/, 'so it renders no region to put one in');

  for (const route of ['/opportunities', '/experiments']) {
    const html = await renderPage(route, { repositories: seededRepos(`pages-tablescroll-${route.slice(1)}-`) });
    assert.doesNotMatch(html, /<table[\s>]/, `${route}: no table`);
    assert.doesNotMatch(html, /table-scroll/, `${route}: no region`);
  }
});
