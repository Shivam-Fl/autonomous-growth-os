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
