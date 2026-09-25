import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories, replayRawToDerived } from '../../src/data/repositories.js';
import { validateEvent } from '../../src/domain/events.js';
import { renderPage } from '../../src/web/pages.js';
import { seed } from '../../scripts/seed.js';

const ROUTES = ['/', '/journal', '/opportunities', '/experiments', '/approvals'];

function freshRepos() {
  const dir = mkdtempSync(join(tmpdir(), 'pages-'));
  const db = openDatabase(join(dir, 'app.db'));
  return createRepositories(db);
}

test('a fresh database renders the empty dashboard with the setup checklist', () => {
  const html = renderPage('/', { repositories: freshRepos() });
  assert.match(html, /data-state="empty"/);
  assert.match(html, /No connected ad account yet/);
  assert.match(html, /Connect Meta Ads/);
  assert.match(html, /about 5 minutes/);
  assert.match(html, /about 15 minutes/);
  assert.match(html, /about 1 minute/);
  assert.match(html, /No connected account/, 'header names the missing tenant');
});

test('each page renders its own empty state on a fresh database', () => {
  const repos = freshRepos();
  assert.match(renderPage('/journal', { repositories: repos }), /Start the first replay/);
  assert.match(renderPage('/opportunities', { repositories: repos }), /research pass/);
  assert.match(renderPage('/experiments', { repositories: repos }), /Compose the first hypothesis/);
  assert.match(renderPage('/approvals', { repositories: repos }), /Autonomy posture by action class/);
});

test('every page exposes the loading, partial and error preview shells without touching storage', () => {
  for (const route of ROUTES) {
    const repos = freshRepos();
    const loading = renderPage(route, { repositories: repos, override: 'loading' });
    assert.match(loading, /data-state="loading"/);
    assert.match(loading, /class="skeleton /, `${route} loading shell has skeletons`);

    const partial = renderPage(route, { repositories: repos, override: 'partial' });
    assert.match(partial, /data-state="partial"/);
    assert.match(partial, /aria-live="polite"/);
    assert.ok(/stale|await|Expired|provisional/i.test(partial), `${route} partial shell shows its degraded state`);

    const error = renderPage(route, { repositories: repos, override: 'error' });
    assert.match(error, /data-state="error"/);
    assert.match(error, /data-action="retry"/, `${route} error shell offers retry`);
    assert.match(error, /What is still true/, `${route} error shell names what is still true`);

    assert.equal(repos.rawEvents.count('tenant_demo'), 0, `${route} override never writes`);
  }
});

test('an unknown ?state= value falls back to the derived state', () => {
  const repos = freshRepos();
  const html = renderPage('/', { repositories: repos, override: 'fancy' });
  assert.match(html, /data-state="empty"/);
});

test('after seeding, the header names the demo tenant and the dashboard goes ideal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pages-seeded-'));
  const db = openDatabase(join(dir, 'app.db'));
  const repos = createRepositories(db);
  const html = renderPage('/', { repositories: repos });
  assert.match(html, /data-state="empty"/);

  seed({ dbPath: join(dir, 'app.db') });
  const seededHtml = renderPage('/', { repositories: repos });
  assert.match(seededHtml, /data-state="ideal"/);
  assert.match(seededHtml, /data-testid="tenant-name">Demo Tenant</);
  assert.match(seededHtml, /Qualified CPL/);
  assert.match(seededHtml, /Decision feed · 2 rows/);
});

test('skeleton shells keep a fixed height so data arriving causes no layout shift', () => {
  const repos = freshRepos();
  const loading = renderPage('/', { repositories: repos, override: 'loading' });
  assert.match(loading, /skeleton kpi-card/);
  assert.match(loading, /aria-hidden="true"/);
});
