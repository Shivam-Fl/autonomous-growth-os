import { before, test } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// The skip link's target, as a heading-hierarchy matcher. Hoisted beside
// H1_HOOK for the same reason and with the same rule: the id is load-bearing,
// because the assertion below is only about the landmark the skip link points
// at, and issue #46 relaxed it past the requirement #52 relied on. Issue #61
// restores it and pins both the acceptances and the rejections, so a second
// relaxation cannot pass the 25 shells for the wrong reason again.
//
// The attribute is asked for with \s, not \b. \b asserts a word boundary and
// '-' is not a word character, so \bid="main" also matched the tail of
// data-id="main" — a landmark the skip link does not target, on a page whose
// href="#main" resolved to nothing, with the whole suite green. Every matcher
// in this file's guard family asks for its attribute the same way.
const mainOf = (html) => /<main\b[^>]*\sid="main"[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? '';

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
 * need those append them on top of the repos this returns.
 *
 * The optional argument is how the tenant's stored currency code is spelled the
 * way a row this app did not write might spell it. tenants.create accepts any
 * string — the contract the ZZZ test below pins — so this builds a mis-cased
 * row without a migration, and reaches the same state the QA repro makes with a
 * raw SQL UPDATE. The amounts are the same either way, so renders are
 * comparable. */
function usdRepos(storedCurrency = 'USD') {
  const repos = freshRepos();
  repos.tenants.create({ id: 'tenant_usd', name: 'US Tenant', currency: storedCurrency });
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

/** A seeded database with one pending approval in the queue. Nothing in the
 * product writes approval.requested — grep finds exactly one hit, the read at
 * src/web/pages.js:924 — so the card that .approval-actions and .approval-card
 * describe is reached here through the repository layer. Before this, no test
 * rendered an approval card at all, so both selectors were pinned against a
 * page that had never shown one. */
function pendingApprovalRepos(prefix) {
  const repos = seededRepos(prefix);
  repos.rawEvents.append(validatedEnvelope('tenant_demo', 'evt_pages_approval_1', 'approval.requested', {
    name: 'Raise budget', status: 'pending', impact: 'high', downside: 'low', expires: '2026-10-25T08:00:00.000Z',
  }));
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
//
// Each attribute is asked for with \s rather than \b, and the reason is the
// same as in mainOf above: '-' is a non-word character, so \bid="main" also
// matched data-id="main", \btabindex="-1" matched data-tabindex="-1", and the
// class and href clauses matched data-class and data-href. Every capture here
// begins immediately after the tag name, so a real attribute always has
// whitespace before it and a data-* spelling never does.
const skipLinkFocusesMain = (html) => {
  const main = /<main\b([^>]*)>/.exec(html);
  const mainAttrs = main?.[1] ?? '';
  // Find the link by its target rather than by position, so the brand and the
  // nav are not depended on to sort before it.
  const skip = [...html.matchAll(/<a\b([^>]*)>/g)]
    .find(([, attrs]) => /\shref="#main"/.test(attrs));
  return Boolean(
    /\sid="main"/.test(mainAttrs) &&
    /\stabindex="-1"/.test(mainAttrs) &&
    skip !== undefined &&
    /\sclass="[^"]*\bskip-link\b[^"]*"/.test(skip[1]) &&
    // Every clause above is asked of a tag in isolation, so a link sitting
    // BELOW </main> satisfies all of them and the bypass is destroyed. The
    // bypass is document order, so compare the two offsets. Last in the chain,
    // so main.index is never read on a null match.
    skip.index < main.index
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
  // The order pin below is deliberately on the link-before-main relation and
  // not on the link being the document's first element, so the brand and the
  // nav may still sort ahead of it.
  assert.ok(
    skipLinkFocusesMain('<header>brand nav</header><a class="skip-link" href="#main">Skip to content</a><main id="main" tabindex="-1"></main>'),
    'brand and nav may sort before the skip link'
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
  // The defect issue #61 exists for: every clause above holds for a link that
  // sits BELOW </main>, because each one is asked of the tag in isolation. The
  // bypass is the document order, and nothing above compares the two offsets.
  assert.ok(
    !skipLinkFocusesMain('<main id="main" tabindex="-1"></main><a class="skip-link" href="#main">Skip to content</a>'),
    'a skip link after </main> is not a bypass, however well-formed it is'
  );

  // Issue #61 BUG-2: a required attribute that appears only inside a data-*
  // attribute is not the attribute. \b asserts a word boundary and '-' is not a
  // word character, so each of these used to satisfy the guard that was written
  // to require it. A <main data-id="main"> is not the skip link's target — the
  // served page had getElementById('main') === null and Enter on the link left
  // focus on the link itself — while the suite stayed green.
  assert.ok(
    !skipLinkFocusesMain('<a class="skip-link" href="#main">Skip to content</a><main data-id="main" tabindex="-1"></main>'),
    'data-id="main" is not id="main", so the landmark is not the skip link target'
  );
  assert.ok(
    !skipLinkFocusesMain('<a class="skip-link" href="#main">Skip to content</a><main id="main" data-tabindex="-1"></main>'),
    'data-tabindex="-1" is not tabindex="-1", so the landmark is not focusable'
  );
  assert.ok(
    !skipLinkFocusesMain('<a data-class="skip-link" href="#main">Skip to content</a><main id="main" tabindex="-1"></main>'),
    'data-class="skip-link" is not the styling class, so this is not the bypass'
  );
  assert.ok(
    !skipLinkFocusesMain('<a class="skip-link" data-href="#main">Skip to content</a><main id="main" tabindex="-1"></main>'),
    'data-href="#main" is not href="#main", so the link targets nothing'
  );

  // The order clause reads main.index, so a document with no <main> or no <a>
  // has to answer false rather than throw.
  assert.equal(
    skipLinkFocusesMain('<a class="skip-link" href="#main">S</a>'), false, 'no main landmark is not a bypass'
  );
  assert.equal(
    skipLinkFocusesMain('<main id="main" tabindex="-1"></main>'), false, 'no link at all is not a bypass'
  );
  assert.equal(skipLinkFocusesMain(''), false, 'an empty document is not a bypass');
});

// BUG-12. Every page load used to log one console error, on all five routes:
// with no icon declared the browser asks for /favicon.ico, nothing serves it,
// and the 404 is reported as "Failed to load resource". Declaring the icon in
// the head is what removes the REQUEST — serving something at /favicon.ico
// would only remove the 404 and leave the implicit request in place — and the
// declaration has to resolve, so both halves are asserted here: the link in the
// served document, and the route answering it. A data: URL would satisfy the
// first and leave the icon unverified, which is why the asset is a file.
test('BUG-12: every served page declares an icon that the asset route answers', async () => {
  const STATES = ['ideal', 'empty', 'loading', 'partial', 'error'];

  for (const route of ROUTES) {
    for (const state of STATES) {
      const where = `${route}?state=${state}`;
      const html = await renderPage(route, { repositories: freshRepos(), override: state });
      // Two attributes, each matched on its own rather than as one literal
      // start tag: attribute order in a tag is not significant, so pinning the
      // whole tag would go red on a reorder that breaks nothing — the same
      // shape this ticket exists to close, in its own new test. The PATH is
      // still pinned, because a renamed asset is a real change and a
      // declaration that does not resolve is the defect.
      assert.match(
        html,
        /<link\b[^>]*\brel="icon"/,
        `${where}: the head declares the icon, or the browser asks for /favicon.ico and logs the 404`,
      );
      assert.match(
        html,
        /<link\b[^>]*\bhref="\/assets\/favicon\.svg"/,
        `${where}: ...and it points at the asset the route below serves`,
      );
    }
  }

  const app = buildApp({ repositories: freshRepos() });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const icon = await fetch(`http://127.0.0.1:${port}/assets/favicon.svg`);
    assert.equal(icon.status, 200, 'the declared icon resolves — a link to a 404 is the same defect under another path');
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml', 'and is served as the type the link declares');
    assert.match(await icon.text(), /<svg[^>]*>/, 'the body is the icon rather than an empty response');
  } finally {
    server.close();
    await once(server, 'close');
  }
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

// The other end of that same rule, in the mode that strips author colours:
// Chromium honours `outline: none` under forced-colors and substitutes no
// system colour of its own, while every other focusable element keeps its
// ring. Without the carve-out, <main> would be the one focusable thing on the
// page with no indicator, at the exact moment a forced-colors user needs to
// know the bypass ran. The default-mode suppression above is not the thing
// under test; this asserts only that the mode gets one back.
test('the #main focus suppression is restored inside forced-colors so the landmark is not the one focusable thing with no indicator', () => {
  const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');
  const carveOut = /@media\s*\(forced-colors:\s*active\)\s*\{[^@]*?#main:focus\s*\{([^}]*)\}/.exec(css);
  assert.ok(carveOut, 'src/web/styles.css restores the focus ring inside @media (forced-colors: active)');
  assert.match(
    carveOut[1], /outline:\s*2px\s+solid\s+CanvasText\s*;/,
    'the carve-out paints a system colour, so it survives the mode'
  );

  // Source order is the whole mechanism, and nothing else in the suite names
  // it: both selectors are 1,1,0, so the carve-out wins ONLY by coming after
  // the bare rule. Moved above it, the landmark goes back to painting no
  // indicator. The test above goes red under that reordering, but at a
  // property it is not about, so the ordering is named here directly.
  const bareRuleAt = css.search(/#main:focus\s*\{/);
  assert.ok(bareRuleAt !== -1, 'src/web/styles.css defines the bare #main:focus rule');
  assert.ok(
    carveOut.index > bareRuleAt,
    'the forced-colors carve-out is declared AFTER the bare #main:focus rule, at equal specificity'
  );
});

// mainOf decides which landmark the heading-hierarchy assertion above reads,
// so its id requirement is load-bearing: relaxed, the assertion would be
// satisfied by some other <main> and the 25 shells would still pass. Issue
// #61 restores it and pins both the acceptances and the rejections, so a
// second relaxation cannot go unnoticed again.
test('the main matcher still requires id="main" on the landmark it captures', () => {
  assert.equal(mainOf('<main id="main"><h1>Command dashboard</h1></main>'), '<h1>Command dashboard</h1>', 'the shipped markup matches');
  assert.equal(mainOf('<main id="main" tabindex="-1"><h1>X</h1></main>'), '<h1>X</h1>', 'the tabindex #52 added still matches');
  assert.equal(mainOf('<main tabindex="-1" id="main"><h1>X</h1></main>'), '<h1>X</h1>', 'attribute order is not pinned');
  assert.equal(mainOf('<main tabindex="-1" id="main" lang="en"><h1>X</h1></main>'), '<h1>X</h1>', 'a fourth attribute is tolerated');

  assert.equal(mainOf('<main><h1>X</h1></main>'), '', 'a main with no id is not the skip link target');
  assert.equal(mainOf('<main id="other"><h1>X</h1></main>'), '', 'another id is not the skip link target');
  assert.equal(
    mainOf('<main data-id="main"><h1>X</h1></main>'), '',
    'data-id="main" is not id="main" (issue #61: \b matched the tail of the data-* spelling)'
  );
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
  const cplText = qualifiedCplValue(html);
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

// The other direction of the same rule, and the one a half-applied fix gets
// wrong: a stored code that names NO currency matches no spend row, so the same
// exclusion has to move the tile and the API together. Read rupees here while
// the API read null would be the same disagreement, inverted.
test('a tenant row naming no currency reads the em-dash on the dashboard and null from the API', async () => {
  const repos = freshRepos();
  // The row is held at 'ZZZ' first, and the INR spend behind it is appended
  // through the repository rather than posted: ingest 400s a rupee against
  // this row, which is the point. A live database only reaches this state the
  // same way a pre-fix batch did.
  assert.equal(repos.tenants.create({ id: 'tenant_demo', name: 'Demo Tenant', currency: 'ZZZ' }).currency, 'ZZZ');
  const legacy = [
    validatedEnvelope('tenant_demo', 'evt_zzz_read_spend', 'spend.observed', { campaign: 'legacy', amount_micros: 7_200_000_000, currency: 'INR' }),
    ...[1, 2, 3].map((n) => validatedEnvelope('tenant_demo', `evt_zzz_read_qualified_${n}`, 'lead_qualified', { campaign: 'legacy', lead_id: `lead_zzz_${n}`, session_id: 'sess_zzz' })),
  ];
  for (const event of legacy) {
    assert.equal(repos.rawEvents.append(event).appended, true, `fixture: ${event.event_id} must append`);
  }

  const html = await renderPage('/', { repositories: repos, metaProvider: new FakeMetaAdsProvider() });
  const cplText = qualifiedCplValue(html);
  assert.equal(cplText, '—', `a code naming no currency draws the em-dash, got ${cplText}`);
  assert.doesNotMatch(html, /2,400\.00/, 'the rupee figure the old read drew is gone');
  assert.doesNotMatch(html, /ZZZ/, 'and the raw code never reaches a reader');

  const app = buildApp({ repositories: repos });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const metrics = await (await fetch(`http://127.0.0.1:${port}/v1/metrics`)).json();
    assert.equal(metrics.spend_micros, 0, 'the API excludes what the tile stopped drawing');
    assert.equal(metrics.qualified_cpl_micros, null, 'API CPL is null on the same row the tile draws — for');
    assert.equal(metrics.qualified_volume, 3, 'and the volume survives a currency its spend side cannot name');
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
  const cplText = qualifiedCplValue(html);
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

// A minimal DOM for the error shell, for the claim issue #61 exists to lock:
// nothing holds keyboard focus before the user has pressed a key (AC-5). It
// records focus() calls rather than faking document.activeElement, because the
// property under test is the side effect on the document, not a value read
// back out of a stub. The panel, its own <h2> and the retry inside it are the
// whole shell; the retry is also what the ?state= strip is driven from.
function errorShellHarness({ panel = true, heading = 'Replay evaluation failed for scenario replay-tracking-outage', retryHref = '/journal', href = 'http://localhost:3000/journal?state=error' } = {}) {
  const focused = [];
  const navigated = [];
  const listeners = new Map();
  const liveRegion = { textContent: '' };
  const retry = {
    dataset: { action: 'retry', retryHref },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    focus() {
      focused.push('BUTTON[data-action=retry]');
    },
  };
  const errorPanel = {
    querySelector: (selector) => (selector === 'h2' && heading ? { textContent: heading } : null),
  };
  globalThis.document = {
    title: 'Decision journal · Autonomous Growth OS',
    body: { dataset: { state: 'error' } },
    getElementById: (id) => (id === 'live-region' ? liveRegion : null),
    querySelectorAll: (selector) => (selector === '[data-action="retry"]' && panel ? [retry] : []),
    // Agnostic about how the panel is addressed, and that is the whole point.
    // A real querySelector searches the whole tree, so the descendant selector
    // '.panel-error [data-action="retry"]' resolves to the retry INSIDE the
    // panel. A stub that answers only the exact string '.panel-error' returns
    // null for that selector — and the pre-fix client.js, which asked only that
    // descendant question, then records no focus call at all, so the test below
    // passes green against the very defect it was written for.
    querySelector: (selector) => {
      if (!panel || !selector.includes('.panel-error')) {
        return null;
      }
      return selector.includes('[data-action="retry"]') ? retry : errorPanel;
    },
    addEventListener: () => {},
  };
  globalThis.window = {
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { origin: 'http://localhost:3000', href, replace: (to) => navigated.push(to) },
  };
  return {
    focused,
    liveRegion,
    navigated,
    click: () => listeners.get('click')(),
  };
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

// Issue #61 BUG-1, the runtime half of a guarantee the rest of this file only
// checks as document order. client.js used to focus the failing panel's retry
// action on load, so on every error shell document.activeElement was already
// BUTTON[data-action=retry] before the user pressed anything and the first Tab
// continued from there — the skip link was never the first stop. Nothing else
// here could see it: every other guard in this file reads an HTML string, and
// this is a script side effect. Asserted on the error shell AND on a shell
// with no panel at all, so the claim is "nothing takes focus", not "the panel
// takes less of it".
test('a fresh load focuses nothing on the error shell, so the first Tab reaches the skip link', async () => {
  try {
    const errorShell = errorShellHarness();
    await loadClient();
    assert.deepEqual(errorShell.focused, [], 'no focus is taken before the user presses a key');

    const noPanel = errorShellHarness({ panel: false });
    await loadClient();
    assert.deepEqual(noPanel.focused, [], 'and a shell with no error panel takes no focus either');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});

// What the load-time focus was standing in for. On a region-level failure
// (?meta_error=quota) body data-state is still 'ideal', so the page-state
// announcement names nothing that failed and the failure was announced
// nowhere. Locked as a contract of its own: without it, deleting the focus
// would have left a failed page that says nothing. Both halves — what failed
// and what to do about it — and the copy is the panel's own <h2>, which
// docs/ui.md already requires the panel to state, so it cannot drift.
test('an error panel is announced through the live region, by name and with a next action', async () => {
  try {
    const errorShell = errorShellHarness();
    await loadClient();
    assert.match(
      errorShell.liveRegion.textContent,
      /Replay evaluation failed for scenario replay-tracking-outage/,
      'the live region names the failure the panel itself names'
    );
    assert.match(
      errorShell.liveRegion.textContent,
      /Use Retry to try again\./,
      'and points at the Retry action'
    );

    // The defensive half of the new branch: a panel that ever stops rendering
    // an <h2> degrades to a generic sentence rather than throwing on load.
    const headingless = errorShellHarness({ heading: null });
    await loadClient();
    assert.equal(
      headingless.liveRegion.textContent,
      'This page failed to load Use Retry to try again.',
      'a panel with no heading still announces, and does not throw'
    );
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});

// The behaviour the autofocus displaced, minus the focus steal: the retry is
// still wired, still announces, and still reloads the route with the ?state=
// preview override stripped so the user lands on the real page. Both sources of
// the target are exercised, because the button carries data-retry-href and a
// shell that does not falls back to the current location.
test('the wired retry still announces and still reloads the route with the preview override stripped', async () => {
  try {
    const fromHref = errorShellHarness();
    await loadClient();
    fromHref.click();
    assert.deepEqual(fromHref.navigated, ['/journal']);
    assert.equal(fromHref.liveRegion.textContent, 'Retrying…');

    const fromLocation = errorShellHarness({ retryHref: '' });
    await loadClient();
    fromLocation.click();
    assert.deepEqual(
      fromLocation.navigated, ['/journal'],
      'with no data-retry-href the current location is used and ?state= is stripped'
    );
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
    const cplText = qualifiedCplValue(html);
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
  const repos = usdRepos('usd');
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
    renders.push(opportunityRowMoney(await renderPage('/opportunities', { repositories: usdRepos(stored) })));
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
  const repos = usdRepos('usd');
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
  const repos = usdRepos('usd');
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
  const repos = usdRepos('usd');
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
  const repos = usdRepos('usd');
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
  const repos = usdRepos('ZZZ');
  const row = (await renderPage('/opportunities', { repositories: repos }))
    .match(/<li class="opportunity-row"[\s\S]*?<\/li>/)[0];
  assert.match(row, /value ₹6,000\.00/, 'an unknown code still falls back to the repo default');
  const html = await renderPage('/', { repositories: repos, metaProvider: new FakeMetaAdsProvider() });
  assert.doesNotMatch(html, /ZZZ/, 'the raw code never reaches a reader');
});

test('a bad code still renders a symbol on every money() surface, and no raw micros anywhere', async () => {
  // The seven non-funnel call sites the currency seam change deliberately does
  // not move. They must look exactly as they did: an unknown code relabels to
  // the repo default, which is money()'s guard, and the funnel is the only
  // consumer that COMPARES codes. A sweep is the only thing that catches a
  // call site the change moved that nobody enumerated, so it asserts the
  // property rather than the amounts: a symbol, or no amount at all.
  const repos = usdRepos('ZZZ');
  for (const route of ['/', '/opportunities', '/experiments']) {
    const html = await renderPage(route, { repositories: repos, metaProvider: new FakeMetaAdsProvider() });
    assert.doesNotMatch(html, /ZZZ/, `${route} never prints the raw code`);
    assert.doesNotMatch(html, /NaN|undefined/, `${route} renders no failed-format sentinel`);
    // Text content only: the composer's cap input carries a micros placeholder
    // in an attribute, and a raw integer in a placeholder is a form default,
    // not a rendered amount. Seven digits is above every non-money count these
    // pages print — the largest is the insights table's 6-digit impressions.
    const text = html.replace(/<[^>]*>/g, ' ');
    assert.doesNotMatch(text, /\d{7,}/, `${route} renders no bare micros integer`);
  }
  // And the one surface that definitely does draw money still draws it, in the
  // repo default, rather than quietly drawing nothing.
  const opportunities = await renderPage('/opportunities', { repositories: repos });
  assert.deepEqual(opportunityRowMoney(opportunities), ['₹6,000.00', '₹1,900.00'], 'the opportunity amounts still render, relabelled');
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
  // Matched on the attribute rather than on the shipped class name: what this
  // decides is that the call site inlines no class-coupled regex AT ALL, and a
  // pin on one spelling would still pass if the regex came back written against
  // the old one. It would be the pin to a literal, going quietly stale, that
  // #55 is about.
  assert.doesNotMatch(callSite, /class="/, 'the call site inlines no class-coupled regex');
  // The same treatment for the other assertion that had no pin. 25 shells render
  // 25 times, and 'exactly one h1' is the assertion that says each of them has
  // a page heading at all; deleting it cost nothing and the suite stayed green,
  // so the suite could not tell a page with no h1 from one with the right
  // class on it. It is a second anchor and neither protects the other: this one
  // finds the assertion by its own text, and the one above finds the hook.
  // Anchored on the assertion's own text rather than on its message, so the
  // prose in this file and the test's own name above cannot match it.
  const counted = 'levels.filter((level) => level === 1)' + '.length, 1,';
  const countLines = source.split('\n').filter((line) => line.includes(counted));
  assert.equal(countLines.length, 1, 'the counting assertion is found exactly once, so it cannot match a second line');
  assert.match(
    countLines[0],
    /assert\.equal\(levels\.filter\(\(level\) => level === 1\)\.length, 1,/,
    'the 25-shell test still counts the h1s of every shell — the assertion itself, not a line that merely mentions one',
  );
});

// The class, read off the rendered h1 rather than hard-coded, so the two ends
// of the link are held by one check instead of two literals that happen to
// agree. It is read off the resolved ELEMENT now, not off a regex over the tag:
// the cascade guard below needs the h1 as an element with a chain behind it
// (pageTitleElement), and two readers of the same markup would be two things
// to keep in step. The old form was anchored on whitespace for a reason —
// /\bclass="/ matches inside data-class=, which is the false pass this ticket
// closes, and so does the /<h1\s[^>]*\bclass="/ the issue proposed — but
// attribute PARSING is what rules data-class= out, and a parser gets that for
// free. Either attribute order still works, which is what #46 bought and must
// not be lost here.

// Void elements never open a scope, so the ancestor stack is walked with them
// skipped: an <img> in the header must not make every later element a child of
// it. Comments go before the walk — a '<' inside one is text, not a tag — which
// is the same order readStylesheet strips them in.
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

function parseAttributes(source) {
  const attrs = {};
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

// The page h1 as an element, with the chain of elements it sits inside, root
// first. The hook is data-testid — the one .sdlc/memory/qa/selectors.md calls
// stable — so the guard's notion of "the page h1" stops depending on the
// styling class, and the class is read off what comes back (pageTitleClass) so
// the two ends of the class-to-rule link still move together under a
// coordinated rename.
function pageTitleElement(html) {
  const open = [];
  let found = null;
  const tags = /<(\/?)([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;
  let tag;

  // A raw-text element holds text, not markup, so a '<' inside one is text the
  // way a '<' inside a comment is — and a string carrying
  // data-testid="page-title" in an inline script would otherwise hijack the
  // resolution. The hijack is silent: the guard would then reason about the
  // wrong element, and because the h1's real rule is scoped to the h1's own
  // class the wrong element makes it report nothing at all. Emptied before the
  // walk, the same way comments are, and the elements themselves still open and
  // close so the ancestor stack is unchanged.
  const scannable = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|textarea|title)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi, '<$1$2></$1>');

  while ((tag = tags.exec(scannable)) !== null) {
    const [, closing, name, source, selfClosing] = tag;
    const element = { tag: name.toLowerCase(), attrs: parseAttributes(source) };
    element.classes = (element.attrs.class ?? '').split(/\s+/).filter((value) => value !== '');

    if (closing === '/') {
      // A close tag for an element that is not open is stepped over rather than
      // unwinding the stack: the guard reasons about one heading, and a
      // mis-nested sibling elsewhere in the document is not its problem. It
      // cannot be reached from the shipped shell, which is well formed.
      if (open.length > 0 && open[open.length - 1].tag === element.tag) open.pop();
      continue;
    }
    if (element.attrs['data-testid'] === 'page-title') {
      found = { element, chain: [...open, element] };
    }
    if (selfClosing !== '/' && !VOID_ELEMENTS.has(element.tag)) open.push(element);
  }

  assert.ok(found, 'the rendered page carries an element with data-testid="page-title"');
  // A resolution that is not an h1 is a proof the scan went wrong — a hijack
  // rather than a page to reason about — and it is loud rather than silent.
  assert.equal(found.element.tag, 'h1', 'and it is the h1, not some other element carrying the same hook');
  // The chain is root-first, so the root is known exactly rather than guessed
  // at — which is what lets ':root' be decided instead of stripped below.
  found.chain[0].isRoot = true;
  return found;
}
function pageTitleClass(html) {
  return pageTitleElement(html).element.classes.join(' ');
}

// The class is written out as a LITERAL in exactly two tables in this file,
// and these are them. Both are about what a class SELECTOR is worth rather
// than about the class the page h1 carries: one is a table of weights, the
// other a table of names that are provably not the class. Neither follows a
// coordinated rename, because neither is trying to name the shipped rule.
//
// They are NAMED constants rather than an enumeration of the lines they sit
// on, and the audit at the end of the class-link tests below is the reason. A
// per-line allow-list of literals is the same defect the audit exists to
// close — a decision pinned to where a thing is rather than to what it is —
// and a fifth table would be a fifth line in it. The audit names THESE two and
// finds them by their declaration, so a vocabulary table that grows a row is
// still allowed and a literal written anywhere else is not.
const CLASS_VOCABULARY = {
  // A class selector is one b...
  plain: '.page-title',
  // ...and ':is()' is scored by its heaviest argument, which an id outranks.
  isWithId: ':is(#a, h1.page-title)',
};

// A name that merely STARTS with the class is not the class, and a
// pseudo-element styles a generated box rather than the element. Both are
// PROVABLE non-matches, and that each is one is the whole of the claim each
// case is about; which class they name is not part of it.
const REACH_VOCABULARY = {
  longerName: '.page-title-extra',
  pseudoElement: '.page-title::after',
};

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

  // The same three values again, as the table the cascade guard compares the
  // stylesheet's RESOLVED value against. The literals above stay so a reader
  // can see what the values are; this is what stops a stylesheet that declares
  // the class rule a second time from satisfying both while the cascade keeps
  // the second rule's 2.4rem (BUG-2), which is a false pass this file was
  // filed for. The two are read from one table so they cannot drift apart.
  for (const [group, held] of Object.entries(PAGE_TITLE_HELD)) {
    assert.ok(
      held.some((text) => new RegExp(`${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*;`).test(rule[1])),
      `the class rule declares one of ${held.join(', ')}, the value the page h1's ${group} is held at`,
    );
  }
});

// BUG-9. The cascade contract below builds every class-coupled fixture through
// `cls`, the class read off the rendered h1, and four of them spelled the class
// out instead. One of the four went RED under a coordinated rename, on a
// stylesheet that was correct. The other three were worse than red, and that is
// why this is a test: a selector that matches nothing is silent, so a fixture
// pinned to the old name keeps passing while testing nothing at all — the
// pseudo-element case stops being about a pseudo-element and becomes a selector
// for a class no element carries, and the suite cannot tell the two apart.
// Nothing about that is observable from the outside, so it is checked here, in
// the idiom of the pinning test at the top of this file: this file reads its
// own source.
//
// The allow-list is the two named vocabulary tables and nothing else. A class
// literal is fine inside CLASS_VOCABULARY or REACH_VOCABULARY, because the case
// there is about what a class selector is worth rather than about the shipped
// one, and fine in prose, which is why a failure message may quote one. It is
// not fine anywhere else — and "anywhere else" is DECIDED rather than listed,
// by what the text around the literal reads as. A comment is prose and is left
// in, so the reasoning above may name the class as freely as the messages do.
//
// It is a test and not a convention on purpose: the same report has been filed
// twice against this file, once for the 25-shell count assertion and once for
// those four fixtures, and a convention is not what a fifth fixture is going to
// read first.
test('every class-coupled fixture in this file follows the class the element carries', async () => {
  const resolved = pageTitleClass(await renderPage('/', { repositories: freshRepos() }));
  assert.notEqual(resolved, '', 'the shipped h1 does carry a class, so the audit below has a literal to look for');
  const escaped = resolved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const literal = new RegExp(`\\.${escaped}\\b`, 'g');
  // Block comments are five JSDoc headers at the top of this file and hold no
  // class, so they are blanked rather than parsed — blanked in place, so the
  // line numbers the failure names are the ones a reader opens the file at.
  const lines = readFileSync(new URL(import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n');

  const covers = (name) => {
    const from = lines.findIndex((line) => line.startsWith(`const ${name} = {`));
    assert.notEqual(from, -1, `${name} is still declared in this file, and the audit reads that declaration rather than a list of lines`);
    const to = lines.findIndex((line, at) => at > from && line === '};');
    assert.notEqual(to, -1, `${name} is still a block declaration, so the lines it spans can be found`);
    return (at) => at >= from && at <= to;
  };
  const allowed = [covers('CLASS_VOCABULARY'), covers('REACH_VOCABULARY')];

  // The text of the string a literal sits in, or null if it sits in none. The
  // quote state has to be WALKED rather than guessed at from either side: an
  // assertion message quotes a selector in single quotes inside a double-quoted
  // string, and cutting at the inner quote would read the tail of a sentence
  // as a bare selector. Walking it makes the first quote the string opens and
  // the first quote of THAT character the one that closes it.
  const stringAt = (line, at) => {
    const isQuote = (cursor) => "'\"`".includes(line[cursor]) && line[cursor - 1] !== '\\';
    let start = -1;
    for (let cursor = 0; cursor < at; cursor += 1) {
      if (!isQuote(cursor)) continue;
      if (start === -1) { start = cursor; continue; }
      for (cursor += 1; cursor < line.length && !isQuote(cursor); cursor += 1);
    }
    if (start === -1) return null;
    const closing = line.indexOf(line[start], start + 1);
    return line.slice(start, closing === -1 ? line.length : closing + 1);
  };

  const pinned = [];
  lines.forEach((line, at) => {
    literal.lastIndex = 0;
    const found = literal.exec(line);
    if (found === null) return;
    if (allowed.some((span) => span(at))) return;
    if (/^\s*\/\//.test(line)) return;
    const quoted = stringAt(line, found.index);
    // A block is a stylesheet whatever the words around it are: '@layer base {
    // .page-title { … }' has two perfectly good English words in it and is a
    // fixture, not a sentence.
    if (quoted === null || /[{}]/.test(quoted)) {
      pinned.push(`line ${at + 1}: ${line.trim()}`);
      return;
    }
    // Otherwise it has to READ as a sentence. Three lowercase words of three
    // letters or more, counted with the literal itself taken out first — so
    // '.page-title-extra' is left with one word and is a selector, and a
    // message quoting the same thing is left with a dozen and is prose. It is
    // a floor and not a grammar, and the failure it can let through is a
    // selector spelled entirely in long lowercase words.
    const words = quoted.replace(new RegExp(literal.source, 'g'), '').split(/[^A-Za-z]+/).filter((word) => /^[a-z]{3,}$/.test(word));
    if (words.length >= 3) return;
    pinned.push(`line ${at + 1}: ${line.trim()}`);
  });
  assert.deepEqual(pinned, [],
    'every class literal in this file is inside CLASS_VOCABULARY, inside REACH_VOCABULARY, or prose in a message — '
    + 'a fixture spelled out instead of interpolated goes red on a correct stylesheet, or, when the selector matches nothing, keeps passing while testing nothing');
});

// ---------------------------------------------------------------------------
// The cascade guard. A declaration is not a rendering: CSS decides what the
// browser applies by cascade, so a rule that outranks the class rule — higher
// specificity, or equal and later, including inside an at-rule — leaves every
// declaration assertion above satisfied and the heading wrong. node:test has no
// DOM and cannot read a computed style, so the helpers below work out which
// rule the browser would apply to <main id="main"><h1 class="cls"> and name the
// ones that beat it.
//
// The contract, stated once because the tests, the criteria and the failure
// message must not disagree about it:
//
//   A rule is REPORTED when either ground holds.
//     (a) it MAY match the page h1 and outranks the class rule on one of the
//         three guarded properties — higher specificity, or equal and later,
//         with !important outranking specificity asymmetrically; or
//     (b) it MAY match the DOCUMENT ROOT, chain[0], and declares font-size or
//         the font shorthand, because the class rule's own values are in rem
//         and every rem in the sheet is measured against the root's font-size.
//   It is SILENT when it provably cannot match the h1, when it does match the
//         h1 but loses the cascade, and when it declares none of the three
//         guarded properties.
//
// Two properties of that contract carry the whole weight:
//
//   Reachability is FALSE ONLY ON A PROOF. A whitelist of recognised spellings
//   under-approximates — '[data-testid="page-title"]' matches the shipped h1
//   exactly and a list of spellings had never heard of it (BUG-1) — and a
//   last-compound test over-approximates, claiming the page h1 of any branch
//   ending in h1 (BUG-3). One rule, made once, wrong in opposite directions.
//   Here the question is asked of the ELEMENT and answered one way: nothing the
//   vocabulary cannot decide is ever a proof. The cost is false failures, and
//   the risk section names that as the direction to be wrong in.
//
//   The ground (b) reach test is about the ROOT, not about the h1. These are
//   different questions and answering them the same way round is how '[lang]'
//   got filed as a provable no-match: the h1 carries no lang attribute, which
//   is a ground (a) fact, but the document root is <html lang="en"> and the
//   rule matches it, so it is a ground (b) report. The counter-example is the
//   mirror image: 'h1[data-testid="page title"]' names a value the h1 does not
//   carry and is a proof of non-match under ground (a), while the root, having
//   no data-testid at all, is a proof of non-match under ground (b).
//
// One limit of that claim is stated rather than claimed away. The block
// at-rules are read rather than skipped whole — BUG-5 was exactly that skip,
// and it made appending '@layer base { html { font-size: 20px } }' to the
// shipped sheet a GREEN suite on a heading the browser renders at 28px — but
// each is decided by a rule of its own, and the table with it is at readStylesheet
// below. An at-rule the reader has never heard of is read, not skipped, because
// a rule it cannot place is a rule it cannot report, and that is the silent
// pass rather than the false alarm. The limits that remain are inside those
// rules and are named where they are made.
//
// It also compares the VALUE the browser settles on, not only the declaration
// that wins. The declaration test above asserts the class rule contains three
// strings; the cascade test takes the class rule's winning declaration for each
// guarded group and compares it to the same three. A stylesheet that declares
// .page-title twice satisfies both while the h1 renders at 38.4px (BUG-2).
//
// That comparison is on the declaration TEXT, not on the resolved value, and
// that is a decision rather than an accident: 'margin: 0px', 'font-size: 1.40rem'
// and 'line-height: 1.250' all render the h1 exactly as the shipped sheet does
// and are all reported, because telling those apart from the held spelling means
// resolving every length against the root's font-size — the very coupling to the
// root that ground (b) exists to police. The noise is in the direction the
// contract accepts, and a restatement that changes the RENDERING is caught by
// either reading.
// ---------------------------------------------------------------------------

// The three things the page title depends on. Each group lists every shorthand
// and longhand that can set it: a candidate that beats the class rule on any of
// them moves the rendered value. `font` is in the first two groups because it
// sets both at once — reported once per group, which is a correct report rather
// than a duplicate, and cheaper than letting a shorthand through unnoticed.
// `all` is in all three, because it sets all three: 'h1[data-testid="page-title"]
// { all: unset }' is an ordinary-looking reset that Chromium settles at 16px
// with a default line-height and the browser's own top margin, and a guard that
// listed only the three longhands certified every one of them wrong.
const PAGE_TITLE_PROPERTIES = [
  { group: 'font-size', properties: ['font-size', 'font', 'all'] },
  { group: 'line-height', properties: ['line-height', 'font', 'all'] },
  { group: 'margin-top', properties: ['margin', 'margin-top', 'margin-block', 'margin-block-start', 'all'] },
];

// The declaration each guarded group must finally be settled by, as the
// declaration text the browser reads — 'margin: 0' for the margin-top group,
// because a margin: 0 after a margin-top: 24px in the same rule is the
// declaration the cascade keeps and the one the browser applies. Both the
// declaration test and the cascade test read this one table; a change to a
// value the page title is held at is a change both ends see, and it is the
// same contract AC-2 already imposes on the class rule's own values.
//
// Each group is a LIST of equivalent texts rather than one. The guard reports
// a rule that would CHANGE the value the page title is held at, and
// '#main h1 { margin-top: 0 }' changes nothing: margin-top and margin-block-
// start are the same property as the margin the class rule writes, so they are
// restatements of it. Reading one spelling per group reported all three
// (measured: 22.4px / 28px / 0px for every one), and the message it wrote was
// self-refuting — "the page h1's font-size would be font-size: 1.4rem instead
// of font-size: 1.4rem" (AC-18). The list is the group, and the first entry is
// the spelling the messages name.
const PAGE_TITLE_HELD = {
  'font-size': ['font-size: 1.4rem'],
  'line-height': ['line-height: 1.25'],
  'margin-top': ['margin: 0', 'margin-top: 0', 'margin-block-start: 0'],
};

// A shorthand is a declaration that sets MORE than the group it is filed
// under, so it is never a restatement no matter what it is written as.
// '#main h1 { font: 700 1.4rem system-ui }' restates the held font-size
// exactly and still has to be reported: the shorthand's size component is read
// as 'inherit' against the line-height, which is why Chromium settles that
// heading at 22.4px with lineHeight 'normal' rather than 28px. '#main h1 { all:
// unset }' takes it to 16px/24px/0px. Silencing either would be a false pass,
// and the safe way to widen what is silent is not to widen it.
const GROUP_SHORTHANDS = {
  'font-size': ['font', 'all'],
  'line-height': ['font', 'all'],
  'margin-top': ['all'],
};

// The root-side question, asked in one place rather than in the two that ask
// it. A declaration on the document root is a report only if it can set that
// root's font-size, because that is what the class rule's rem is measured
// against. `font` is in the list because the shorthand sets it, and `all`
// because it sets every property including that one — the same argument that
// puts 'all' in PAGE_TITLE_PROPERTIES, and the reason an ordinary-looking
// reset moves every rem in the sheet.
const ROOT_FONT_PROPERTIES = ['font-size', 'font', 'all'];

// The declaration as the browser reads it, with the importance stripped:
// 'font-size: 1.4rem' and 'font-size: 1.4rem !important' are the same value,
// and which one was written is not a difference the page can render.
const declarationText = (entry) => `${entry.property}: ${entry.value.replace(/!\s*important\s*$/i, '').trim()}`;

// Does this declaration put the group at a value the page title already is at?
// The value filter, asked of the declaration the cascade KEEPS rather than of
// any declaration in the rule, and asked of that one alone: '#main h1 { margin:
// 0; margin-top: 24px }' keeps the longhand and is still reported.
//
// A shorthand is never a restatement, whatever its value reads as. 'all: revert'
// and 'all: unset' are the same three words with opposite effects, and the only
// honest answer for a shorthand the guard cannot expand is to report it — the
// false alarm, which the contract permits, in place of a false pass.
function restates(declaration, group) {
  if (declaration === null) return false;
  if (GROUP_SHORTHANDS[group].includes(declaration.property)) return false;
  return PAGE_TITLE_HELD[group].includes(declarationText(declaration));
}

// 'revert' is a REMOVAL and not a set, and it is a WORD rather than a
// property. The previous version of this guard exempted one spelling of it —
// `carried.property === 'all' && declarationText(carried) === 'all: revert'` —
// and reported the other three, one of them with a message asserting as fact
// that the page h1's font-size 'moves with it' while the declared value was the
// word 'revert' and the browser read 22.4px. A guard that exempts one spelling
// of a concept reports the next spelling, and this one had already reported
// three of them.
//
// Exactly 'revert', though. 'revert-layer', 'unset', 'initial' and 'inherit'
// are NOT removals: 'unset' sets every longhand, and what it sets a root to is
// a renderer this file does not have. They stay reported — the loud direction,
// which the contract accepts — and the case that says so is what keeps the
// word from quietly becoming the rule.
function isRemoval(declaration) {
  if (declaration === null) return false;
  return declaration.value.replace(/!\s*important\s*$/i, '').trim().toLowerCase() === 'revert';
}

// THE value decision, in one function, called by every place that answers the
// question "would this put the page title somewhere it is not already". The
// guard has two push points and the shipped-sheet probe has two more, and until
// this was pulled out the four did not answer it the same way: the guard
// composed two inline tests, and the probe asked neither. Two answers to one
// question is how a rule the guard had already decided was a no-op reached the
// probe as a violation, in a message that named a selector and said nothing
// about a value.
//
// `subject` is a parameter rather than an implicit difference between callers
// because the revert exemption is true for one subject and false for the
// other, and the reason is a fact about where the declaration applies:
//
//   on the ROOT, a removal can only carry the font-size back toward the
//   user-agent default the class rule's rem is already measured against — the
//   shipped root reads 16px — so it moves nothing. (measured: root 16px and
//   h1 22.4px either way)
//   on the H1, a removal drops the class rule's OWN declaration and hands the
//   element to the user-agent's 'h1 { font-size: 2em }', which is 32px on a
//   16px root. '#main h1 { all: revert }' genuinely moves the heading, so it
//   stays reported, and generalising the exemption to reach it would be a
//   FALSE PASS on a heading at 32px.
//
// Everything else is one rule: false for a declaration that is not there,
// false for a removal on the root, false for a group the page title is already
// held at, true otherwise. The shorthand rule stays inside restates, where it
// was already correct — moving it would be churn, and churn is how the second
// answer appeared in the first place.
function movesTheHeldValue(declaration, group, subject) {
  if (declaration === null) return false;
  if (subject === 'root' && isRemoval(declaration)) return false;
  return !restates(declaration, group);
}

// A shorthand is reported under the group it moves, so a message names what the
// declaration sets rather than quoting the shorthand as though it were the
// longhand: 'font: 700 2.4rem system-ui' does not say the h1's font-size is
// '700 2.4rem system-ui', it says the font shorthand is what the font-size
// would come from.
const setsProperty = (entry, group) => (entry.property === group
  ? `sets ${entry.property}: ${entry.value}`
  : `sets ${entry.property}, which sets the h1's ${group}, to ${entry.value}`);

const declaredValue = (entry, group) => (entry.property === group
  ? entry.value
  : `whatever the ${entry.property} shorthand sets`);

// The tier a declaration competes in: the two things decided before any weight
// is read, and '@starting-style' is decided FIRST. A starting style is ranked
// below every other declaration in its origin, importance included — measured:
// '@starting-style { h1 { font-size: 2.4rem !important } }' leaves the h1 at
// 22.4px, because the class rule's own plain 1.4rem is what the browser keeps.
// Importance is the second question, in author origin: an !important declaration
// beats every normal one whatever the rest of its weight.
const tier = (entry) => {
  if (entry.startingStyle) return entry.important ? 0 : -1;
  return entry.important ? 2 : 1;
};

// The declaration the cascade keeps among `entries` — all written under
// `branch` at `index`, unless each entry already carries its own, which is what
// the whole-sheet pool below does: its entries come from different rules, so
// there is no single branch to write on them. Narrowed to the heaviest tier,
// then by layer rank, then specificity, then source order, which is the order
// the browser settles them in. It is the same question for the class rule's own
// pool and for the sheet's, so it is asked by one function: a restatement is
// only a restatement if the declaration the browser would keep is the held one,
// which is not the same as any declaration in the rule being it.
function cascadingWinner(entries, branch, index) {
  const top = Math.max(...entries.map(tier));
  let winner = null;
  let winnerAt = -1;
  for (const [at, entry] of entries.entries()) {
    if (tier(entry) !== top) continue;
    const offered = entry.branch === undefined ? { ...entry, branch, index } : entry;
    if (winner === null || keptInPool(offered, at, winner, winnerAt)) {
      winner = offered;
      winnerAt = at;
    }
  }
  return winner;
}

// ONE scanner for the whole guard, and every cut of a selector runs on it —
// the matcher and the specificity function must not tokenise a selector two
// ways, and a selector must not be cut two ways either. A selector shape that
// tokenised one way for matching and another for the cascade would mis-order
// the two against each other, and the fix for that is one function, not two
// that agree today.
//
// Quote- and bracket-aware, because a space inside a quoted value is not a
// compound boundary: 'h1[data-x="a b"]' is ONE compound, and the plain
// whitespace regex this replaces cut it in half and threw on the token
// '[data-x="a' (BUG-4) — a build break on ordinary CSS the guard's own
// comment claimed to support. A newline is whitespace too, because the
// shipped sheet breaks a comma list across one.
//
// The same state decides where the comma BETWEEN two selectors is, which is
// why both cuts come from here rather than from a second copy of the walk: a
// ',' inside a quoted value or inside a functional pseudo-class belongs to the
// selector it is written in, and cutting there hands the matcher half a
// selector that was never in the stylesheet — BUG-4's failure one character
// over, and the guard would report the half it invented.
//
// The escape case is the same disagreement one character earlier. A backslash
// was not a character any of this could read, so it was consumed as an unknown
// token and the fragment after it was re-read as a type selector of its own —
// 'ain' in '#\6d ain h1' became a type that no ancestor satisfies, which is a
// confident FALSE, and a proof fabricated out of a decode failure (BUG-8). The
// fix is not a second place to special-case a backslash: the splitter and the
// tokenizer have to agree about where one ends, so both run escapeLength, and
// the raw characters are carried through for the tokenizer to decode.
function splitOutside(text, isBoundary) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;
  let at = 0;

  while (at < text.length) {
    const character = text[at];
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '\\') {
      // One unit of text, and the whitespace that terminates a hex escape
      // belongs to the escape rather than to the boundary scan below. That is
      // the whole asymmetry of BUG-8: in '#mai\6e h1' the escape eats the
      // space, so there is nothing to split on and the selector is the single
      // id '#mainh1'.
      const length = escapeLength(text, at);
      current += text.slice(at, at + length);
      at += length;
      continue;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '[' || character === '(') depth += 1;
    else if (character === ']' || character === ')') depth -= 1;
    else if (depth === 0 && isBoundary(character)) {
      parts.push({ text: current, boundary: character });
      current = '';
      at += 1;
      continue;
    }
    current += character;
    at += 1;
  }
  parts.push({ text: current, boundary: null });
  return parts;
}

// ONE reader for every backslash in a selector, and the reason there is only
// one is the contract above rather than tidiness: a rule the guard cannot
// decode has to come back UNDECIDED, and it can only come back undecided if
// every place that walks selector text agrees on where an escape ends. Where
// they disagreed, the disagreement was silent — the splitter stopped at the
// space, the tokenizer read what came after the backslash as a type selector,
// and the browser moved the heading while the suite said it could not.
//
// CSS gives an escape two shapes. A backslash and one to six hex digits is
// that code point, and ONE following whitespace terminates it and is CONSUMED.
// A backslash and any other character is that character. Both the splitter
// (splitOutside) and the tokenizer (splitSimple) run this, and so does the
// attribute-body walk, so the terminator is not a boundary anywhere.
function escapeLength(text, index) {
  if (text[index] !== '\\') return 0;
  let at = index + 1;
  let digits = 0;
  while (digits < 6 && at < text.length && /[0-9a-fA-F]/.test(text[at])) {
    at += 1;
    digits += 1;
  }
  if (digits > 0) {
    // The terminator is one whitespace character and it belongs to the escape.
    if (at < text.length && /\s/.test(text[at])) at += 1;
    return at - index;
  }
  return at < text.length ? 2 : 1;
}

function decodeEscape(text, index) {
  let at = index + 1;
  let digits = '';
  while (digits.length < 6 && at < text.length && /[0-9a-fA-F]/.test(text[at])) {
    digits += text[at];
    at += 1;
  }
  // '\' and then anything that is not a hex digit stands for that character.
  if (digits === '') return at < text.length ? text[at] : '';
  // CSS maps a code point outside the Unicode range — and zero — to the
  // replacement character, and String.fromCodePoint throws on the first, so
  // this is the one place a malformed escape could have become a build break.
  const code = Number.parseInt(digits, 16);
  return code === 0 || code > 0x10ffff ? '�' : String.fromCodePoint(code);
}

// An identifier at `start`, escapes decoded rather than guessed at. Null when
// there is no name there, which every caller answers with an 'unknown' token
// — the answer the guard has to give for text it cannot read, and never a
// proof. A name may not begin with a digit, which is what keeps '1.4rem' out
// of a type selector; a type selector may not begin with '-' or '_' either, so
// the id/class and type reads ask for different opening sets.
const NAME_START = /[A-Za-z_\-\u0080-\uffff]/;
const NAME_REST = /[A-Za-z0-9_\-\u0080-\uffff]/;
const TYPE_START = /[A-Za-z\u0080-\uffff]/;

function readName(text, start, opener = NAME_START) {
  let at = start;
  let name = '';
  while (at < text.length) {
    const escaped = escapeLength(text, at);
    if (escaped > 0) {
      name += decodeEscape(text, at);
      at += escaped;
      continue;
    }
    if (!(at === start ? opener : NAME_REST).test(text[at])) break;
    name += text[at];
    at += 1;
  }
  return at === start ? null : { name, length: at - start };
}

const isCombinator = (character) => character === '>' || character === '+' || character === '~';

// Each compound carries the combinator joining it to the one BEFORE it, and
// the spaces either side of a '>' emit no empty compound: 'main > h1' is two
// compounds, not three, and the empty middle one silently broke the match.
//
// The combinator is read off the boundary that ENDS a compound, which is the
// whole reason a combinator written with spaces round it must survive: in
// 'main > h1' the boundary after 'main' is the space and the one that ends the
// empty middle is the '>', so a scanner that took the first boundary and moved
// on read 'h1 + p' and 'h1+p' as different selectors — and dropping the '+'
// there let a sibling selector be answered by the descendant rule, which can
// return false and so manufactured a proof the guard is only allowed to have.
function splitCompounds(branch) {
  const compounds = [];
  let combinator = '';
  for (const part of splitOutside(branch, (character) => isCombinator(character) || /\s/.test(character))) {
    const compound = part.text.trim();
    if (compound !== '') {
      compounds.push({ compound, combinator });
      combinator = '';
    }
    // The boundary that ENDS a compound joins it to the one AFTER it, so it
    // is held until there is one. In 'main > h1' that is the '>' ending the
    // empty part between the spaces, and holding it across the empty part is
    // what keeps the spaced spelling of a combinator from being dropped.
    if (isCombinator(part.boundary)) combinator = part.boundary;
  }
  return compounds;
}

// A rule's selector list, cut on top-level commas only: 'html, body' is two
// branches, and so is the shipped sheet's own list broken across a newline.
function splitTopLevelCommas(selector) {
  return splitOutside(selector, (character) => character === ',')
    .map((part) => part.text.trim())
    .filter((part) => part !== '');
}

// The text of an attribute selector's body — everything up to the ']' — found
// by tracking the quote rather than by the first bracket, since a quoted value
// may hold both a space and a bracket. Returns null when the ']' never comes,
// which the caller reports as an unreadable token rather than guessing. The
// escape scanner runs here too: an escaped ']' is a character in the value,
// and stopping at it would cut a selector the stylesheet does not contain.
function readAttributeBody(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += escapeLength(text, index) - 1;
    } else if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ']') return text.slice(0, index);
  }
  return null;
}

const ATTRIBUTE_SOURCE = /^\s*(~=|\^=|\$=|\*=|\|=|=)?\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]*))\s*$/;

// An attribute selector's body, with its NAME read by the same scanner as
// every other name rather than by a character class. 'h1[data\2d testid]' is
// 'h1[data-testid]' — the hex escape consumes the space that terminates it —
// and that is the same decode the id and class reads now do, which is why the
// escaped attribute name moved the heading in Chromium (38.4px, measured) and
// was previously invisible to the guard entirely. A name the scanner cannot
// read is null here, and the caller makes an 'unknown' token of it: undecided,
// never a proof.
function parseAttribute(text) {
  const leading = text.length - text.replace(/^\s+/, '').length;
  const name = readName(text, leading);
  if (name === null) return null;
  const parsed = ATTRIBUTE_SOURCE.exec(text.slice(leading + name.length));
  if (parsed === null) return null;
  return {
    attribute: name.name.toLowerCase(),
    op: parsed[1] ?? null,
    value: parsed[2] ?? parsed[3] ?? parsed[4] ?? null,
  };
}

// One compound's simple selectors, read left to right, each carrying its own
// source text so a token can be dropped (stripNarrowing) without re-rendering
// it. A token the vocabulary does not cover is returned as {kind: 'unknown'}
// rather than throwing: the guard's contract is that reachability is decided,
// never guessed, and a token it cannot read is exactly the case it must not
// claim a proof about. The previous version threw, which turned a selector the
// parser had not met into a build break — the guard narrowing its own contract
// to fit its parser, which is how BUG-4 became a failure at all.
function splitSimple(compound) {
  const tokens = [];
  let rest = compound;

  const take = (kind, name, length, extra = {}) => {
    const source = rest.slice(0, length);
    rest = rest.slice(length);
    tokens.push({ kind, source, name, ...extra });
  };
  // A token the vocabulary cannot read is 'unknown', and its answer is null —
  // undecided — in simpleMatches below. What must never happen is an
  // UNDECODED FRAGMENT coming back as something readable, so the whole run of
  // unreadable text is consumed here rather than re-read one character at a
  // time. That is the difference between this and the version before it: a
  // backslash used to be consumed as an unknown token and the 'ain' after it
  // was then handed to the type branch, which no ancestor satisfies, which is
  // a confident false. A decode failure had become a proof.
  const unreadable = (length) => take('unknown', rest.slice(0, length), length);

  while (rest !== '') {
    if (rest.startsWith('::')) {
      const name = readName(rest, 2);
      if (name === null || name.name === '') unreadable(2);
      else take('pseudo-element', `::${name.name}`, name.length + 2);
    } else if (rest.startsWith(':')) {
      const name = readName(rest, 1);
      if (name === null || name.name === '') unreadable(1);
      // A functional pseudo-class takes its argument, which may itself hold
      // brackets, quotes and escapes: ':not([data-x="a b"])' is one token.
      else if (rest[name.length + 1] === '(') {
        const end = functionalEnd(rest, name.length + 1);
        take('pseudo', rest.slice(0, end), end);
      } else take('pseudo', `:${name.name}`, name.length + 1);
    } else if (rest.startsWith('#') || rest.startsWith('.')) {
      const name = readName(rest, 1);
      if (name === null || name.name === '') unreadable(1);
      else take(rest[0] === '#' ? 'id' : 'class', rest[0] + name.name, name.length + 1);
    } else if (rest.startsWith('[')) {
      const body = readAttributeBody(rest.slice(1));
      const parsed = body === null ? null : parseAttribute(body);
      if (parsed === null) {
        // Consume the whole malformed selector rather than one character, so
        // an unreadable token cannot be re-read as a readable one.
        unreadable(body === null ? rest.length : body.length + 2);
      } else {
        take('attribute', rest.slice(0, body.length + 2), body.length + 2, parsed);
      }
    } else if (rest.startsWith('*')) {
      take('universal', '*', 1);
    } else {
      const name = readName(rest, 0, TYPE_START);
      if (name === null || name.name === '') unreadable(1);
      else take('type', name.name, name.length);
    }
  }

  return tokens;
}

// Where a functional pseudo-class's argument ends, and the whole of its name.
function functionalEnd(text, open) {
  let depth = 0;
  let quote = null;
  for (let end = open; end < text.length; end += 1) {
    const character = text[end];
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    // An escaped ')' is a character in the argument, not the end of it, so
    // the same scanner decides here.
    else if (character === '\\') end += escapeLength(text, end) - 1;
    else if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return end + 1;
    }
  }
  return text.length;
}

// Pseudo-classes are DECIDED here, not deleted.
//
// The previous version of this function removed every pseudo-class token AND
// ITS ARGUMENT and asked about whatever was left, on the theory that a
// pseudo-class only ever narrows. That theory is right about the answer and
// wrong about how to get it: ':where(h1)' has no base left at all, so the
// compound became the empty string, and an empty compound matches anything —
// the exact hazard the comment above it named for ':root' and left open. Every
// report it produced asserted as fact a change Chromium does not make
// (measured: 22.4px throughout), so this was a guaranteed false alarm on every
// functional pseudo-class in the sheet (BUG-7).
//
// So the compound is asked about the element, one token at a time, and the
// answer depends on which pseudo-class it is:
//
//   :root                 NAMES the root rather than qualifying it, and the
//                         chain knows the root exactly, so it is decided.
//   :not(sel)             the compound is false when any argument matches, and
//                         true when every argument provably fails.
//   :is(sel), :where(sel) the mirror image: true when any argument matches,
//                         false when every one provably fails.
//   :has(sel)             needs descendants an ancestor chain does not carry.
//   :hover, :nth-child(2) undecidable from static markup.
//
// The last two are "may match", which is the reported direction and the one
// the contract says to be wrong in: 'h1:hover' is reported at rest even though
// this page does not move.
//
// The invariant that replaces the old comment is a shape, not a string: a
// compound is a list of tokens and is never reduced to text at all, so there
// is no empty compound for the matcher to answer vacuously true about. The one
// way to get there would be to answer true for a compound nothing was decided
// about, and the only answer a compound made entirely of undecidable tokens
// gets is null. Both halves are asserted in the test below.
function stripNarrowing(compound, chain, target) {
  let undecided = false;
  for (const token of splitSimple(compound)) {
    const answer = simpleMatches(token, chain[target], chain, target);
    if (answer === false) return false;
    if (answer === null) undecided = true;
  }
  return undecided ? null : true;
}

// The decision for one functional pseudo-class, by the same rules. ':not()'
// negates its argument and ':is()' and ':where()' do not, so the two are one
// loop read either way round: any argument that matches settles it, and the
// compound is only decided when every argument was decided.
function pseudoMatches(token, element, chain, target) {
  if (token.name === ':root') return element.isRoot === true;
  const argument = pseudoArgument(token.name);
  // Not functional at all: ':hover', ':focus-visible', ':first-child'. A
  // pseudo-class is a state the served markup says nothing about.
  if (argument === null) return null;
  // ':has()' asks about descendants, and the chain stops at the h1.
  if (token.name.startsWith(':has(')) return null;
  let matched = false;
  let undecided = false;
  for (const selector of argument) {
    const reached = branchReaches(selector, chain, target);
    if (reached === true) matched = true;
    else if (reached === null) undecided = true;
  }
  if (token.name.startsWith(':not(')) {
    if (matched) return false;
    return undecided ? null : true;
  }
  if (matched) return true;
  return undecided ? null : false;
}

// Does an attribute selector hold for this element? A real VALUE comparison,
// not a presence test, and that is the whole of it: the shipped h1 carries
// data-testid="page-title", so 'h1[data-testid]' matches and
// 'h1[data-testid="page title"]' does not — the attribute is present with a
// different value, which is a proof and not a maybe. A presence-only test would
// have made the second one a false failure on a rule that changes nothing
// (measured: the browser leaves the h1 at 22.4px).
function attributeHolds(token, element) {
  const actual = element.attrs[token.attribute];
  if (actual === undefined) return false;
  if (token.op === null) return true;
  const expected = token.value ?? '';
  if (token.op === '=') return actual === expected;
  if (token.op === '~=') return actual.split(/\s+/).includes(expected);
  if (token.op === '^=') return actual.startsWith(expected);
  if (token.op === '$=') return actual.endsWith(expected);
  if (token.op === '*=') return actual.includes(expected);
  if (token.op === '|=') return actual === expected || actual.startsWith(`${expected}-`);
  return true;
}

// One simple selector against one element. Tri-state on purpose, and only
// `false` may silence anything: false is a PROOF of non-match, true is a match,
// and null is everything static markup cannot decide (a token the vocabulary
// does not read). That asymmetry is the guard.
function simpleMatches(token, element, chain, target) {
  if (token.kind === 'universal') return true;
  if (token.kind === 'type') return token.name.toLowerCase() === element.tag;
  if (token.kind === 'id') return element.attrs.id === token.name.slice(1);
  if (token.kind === 'class') return element.classes.includes(token.name.slice(1));
  if (token.kind === 'attribute') return attributeHolds(token, element);
  // A pseudo-element styles a generated box, never the element itself, so a
  // compound carrying one cannot match the element.
  if (token.kind === 'pseudo-element') return false;
  if (token.kind === 'pseudo') return pseudoMatches(token, element, chain, target);
  // 'unknown': text the tokenizer could not decode. Null, and that is the
  // whole point — it may not be false, because a false here is a proof the
  // guard would then be standing on, and it is a proof out of a DECODE
  // FAILURE rather than out of anything about the element.
  return null;
}

// The empty compound, asked anyway, is UNDECIDED and never a match. Nothing in
// the guard produces one — the tokenizer keeps tokens and the matcher never
// deletes them, which is what BUG-7 was — but 'the empty string matches
// anything' is the hazard this whole function is built around, so the one input
// that would prove the hazard is answered the only way the contract allows:
// undecided, which reports rather than passes.
function compoundMatches(compound, chain, target) {
  if (compound.trim() === '') return null;
  return stripNarrowing(compound, chain, target);
}

// THE one-directional answer, and the only place the guard decides whether a
// selector can reach an element. False is returned on a proof and on nothing
// else; every shape the vocabulary cannot decide is true, which reports the
// rule rather than guessing at it. `target` is an index into `chain`: the page
// h1 at the end for ground (a), chain[0] for ground (b).
function branchReaches(branch, chain, target) {
  if (branch === '' || branch.startsWith('@')) return false;
  // A pseudo-element styles a generated box. No declaration in such a branch
  // is a declaration on the element, at any specificity.
  if (branch.includes('::')) return false;

  const parts = splitCompounds(branch);
  if (parts.length === 0) return false;

  // The rightmost compound is the part of the question the chain can answer
  // with no tree at all, so it decides first: 'h1 + p' is out because the page
  // h1 is not a p, which is a proof and needs no sibling information.
  if (compoundMatches(parts[parts.length - 1].compound, chain, target) === false) return false;

  // '+' and '~' need siblings, which one ancestor chain does not carry.
  // Whatever got past the rightmost compound cannot be proved out on sibling
  // grounds, so the honest answer is "may match" — never a silent pass.
  let position = target;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const join = parts[index + 1].combinator;
    if (join === '+' || join === '~') return true;
    if (join === '>') {
      // The element immediately to the left. This is what closes BUG-3: '.page-title h1'
      // is not 'the h1 with the class on an ancestor', it needs an ancestor that
      // actually carries the class, and the chain is html < body < main#main < h1.
      position -= 1;
      if (position < 0) return false;
      if (compoundMatches(parts[index].compound, chain, position) === false) return false;
    } else {
      // A descendant may be any element to the left, so the proof is that
      // EVERY element to the left is excluded. `position` deliberately does not
      // move: keeping the widest set of ancestors for the compounds further
      // left can only turn a proof into "may match", which is the safe way to
      // be wrong.
      const excluded = chain
        .slice(0, position)
        .every((element, at) => compoundMatches(parts[index].compound, chain, at) === false);
      if (excluded) return false;
    }
  }
  return true;
}

// (ids, classes, types), on the same splitter the matcher uses. A universal
// selector counts as nothing and a plain pseudo-class counts as a b, exactly as
// CSS says; a pseudo-element and a token the vocabulary cannot read yield null
// rather than a number, because the guard has no proof about such a shape and
// "undecidable" must never be read downstream as "loses the cascade".
function specificityOf(selector) {
  const counts = [0, 0, 0];
  for (const { compound } of splitCompounds(selector)) {
    const part = compoundSpecificity(compound);
    if (part === null) return null;
    for (let rank = 0; rank < 3; rank += 1) counts[rank] += part[rank];
  }
  return counts;
}

// A functional pseudo-class is NOT one b. CSS gives ':is()', ':not()' and
// ':has()' the specificity of their most specific ARGUMENT and gives ':where()'
// none at all, and scoring every pseudo-class as one b put ':is(#a, h1)' at
// (0,0,1) — below the class rule — so a rule that really does outrank the page
// title fell on the SILENT side, which is the one direction the contract says
// cannot happen. The arguments are read with the same scanner that cuts the
// selector, so a comma inside one, or a quoted value holding a space, is an
// argument rather than a boundary.
const heavier = (one, other) => one[0] !== other[0]
  ? one[0] > other[0]
  : one[1] !== other[1] ? one[1] > other[1] : one[2] > other[2];

// Which of two declarations the class rule wrote the cascade keeps: layer rank
// first, then the more specific branch, and among equals the later one. 'at'
// is the position in the pool, and the pool is built in document order across
// the class rules and in body order inside each, so a pair written in ONE rule
// is settled the way the browser settles it — 'margin-top: 24px' then
// 'margin: 0' keeps the shorthand, which is the declaration PAGE_TITLE_HELD
// names.
//
// A specificity the vocabulary cannot compute is not a proof that the
// declaration loses, so it is KEPT rather than passed over. That is the same
// one-directional answer the reachability half gives for the same shape, and it
// costs a report on a selector the guard cannot read, which is the direction
// the contract accepts.
function keptInPool(entry, at, keep, keepAt) {
  if (layerOutranks(entry, keep)) return true;
  if (layerOutranks(keep, entry)) return false;
  const one = specificityOf(entry.branch);
  const other = specificityOf(keep.branch);
  if (one === null) return true;
  if (other === null) return false;
  if (one[0] !== other[0] || one[1] !== other[1] || one[2] !== other[2]) return heavier(one, other);
  return at > keepAt;
}

function compoundSpecificity(compound) {
  const counts = [0, 0, 0];
  for (const token of splitSimple(compound)) {
    if (token.kind === 'id') counts[0] += 1;
    else if (token.kind === 'class' || token.kind === 'attribute') counts[1] += 1;
    else if (token.kind === 'type') counts[2] += 1;
    else if (token.kind === 'pseudo') {
      const argument = pseudoArgument(token.name);
      // ':where()' exists precisely to contribute nothing.
      if (argument === null) counts[1] += 1;
      // ':has()' takes a RELATIVE selector list — 'h1:has(> span)' — and the
      // guard has no tree to anchor one against. Reading the 'span' in it as a
      // type selector of its own is the same fragment-re-read that made
      // '#\6d ain' a proof, so the whole compound is unreadable instead. The
      // caller reports an unreadable specificity rather than passing over it,
      // which is why 'h1:has(> span)' is a report: the guard cannot decide it,
      // and may-not-decide is the direction it is allowed to be wrong in.
      else if (token.name.startsWith(':has(')) return null;
      else if (!token.name.startsWith(':where(')) {
        const heaviest = argument.reduce((top, part) => {
          const one = compoundSpecificity(part);
          return one === null ? null : (heavier(one, top) ? one : top);
        }, [0, 0, 0]);
        // An argument the vocabulary cannot read is an argument whose weight is
        // unknown, and an unknown weight may be anything — so the whole
        // compound is unreadable, which the caller reports rather than passes.
        if (heaviest === null) return null;
        for (let rank = 0; rank < 3; rank += 1) counts[rank] += heaviest[rank];
      }
    } else if (token.kind !== 'universal') return null;
  }
  return counts;
}

// The comma-separated arguments of a functional pseudo-class, or null when the
// name is not functional at all — ':hover' and ':focus-visible' are a b each.
function pseudoArgument(name) {
  const open = name.indexOf('(');
  return open === -1 ? null : splitTopLevelCommas(name.slice(open + 1, name.length - 1));
}

// LAYER RANK joins the cascade, and it is the first comparison within an
// origin. It is easy to get half right and each half fails in a direction the
// other half does not, so all three parts are stated here rather than left to
// the reader of the caller:
//
//   among NORMAL declarations  an UNLAYERED one beats every layer, whatever
//                             its specificity — '@layer base { #main h1 { … } }'
//                             at (1,0,1) loses to the unlayered class rule at
//                             (0,1,0). That is layer order, not a specificity
//                             error. (measured: 22.4px)
//   among !IMPORTANT ones      a LAYERED declaration beats every unlayered one
//                             — '@layer base { h1 { … !important } }' beats an
//                             unlayered 'h1 { … !important }'. (measured:
//                             22.4px)
//   among layers               NORMAL is settled by the LATER-declared layer;
//                             !IMPORTANT REVERSES THAT, so the EARLIER-declared
//                             layer wins. (measured: '@layer base { 1.4rem
//                             !important } @layer top { 2.4rem !important }'
//                             reads 22.4px, and the same two rules in the other
//                             order read 38.4px)
//
// The third part is the one a half-implementation gets backwards in exactly
// the direction this guard is not allowed to be wrong in, so the test pins it
// both ways round.
function layerOutranks(one, other, important = one.important === true) {
  // A starting style is beaten by any normal declaration for the same
  // property, important or not, so it can never outrank the class rule. The
  // rules are read rather than skipped, and the rank is what makes them lose.
  if (one.startingStyle !== other.startingStyle) return !one.startingStyle;
  if (one.layer === other.layer) return false;
  if (one.layer === null) return !important;
  if (other.layer === null) return important;
  return important ? one.layer < other.layer : one.layer > other.layer;
}

// A declaration that is in no layer and carries no @starting-style: the state
// the whole shipped sheet is in, and the one the existing callers that pass a
// bare {specificity, index} mean.
const UNLAYERED = { layer: null, startingStyle: false, important: false };

// Greater layer rank wins, then greater specificity, then source order — so the
// later declaration is the one the browser applies among equals.
function beats(candidate, baseline) {
  const one = { ...UNLAYERED, ...candidate };
  const other = { ...UNLAYERED, ...baseline };
  if (layerOutranks(one, other)) return true;
  if (layerOutranks(other, one)) return false;
  for (let rank = 0; rank < 3; rank += 1) {
    if (one.specificity[rank] !== other.specificity[rank]) {
      return one.specificity[rank] > other.specificity[rank];
    }
  }
  return one.index > other.index;
}

// Block at-rules whose body describes something other than a rendered element:
// an animation, a font, a page box, a registration. Nothing inside them is a
// declaration on the page h1, so their bodies are stepped over whole. @keyframes
// already was; the rest join it rather than each being rediscovered.
const AT_RULES_WITHOUT_ELEMENTS = new Set([
  'keyframes', 'font-face', 'page', 'property', 'counter-style', 'charset', 'import',
]);

// Flatten the stylesheet into rules in document order. A block at-rule is
// walked to any depth, and every rule it produces carries the block it came
// out of, because the previous reader recursed on /^@(media|supports)\b/ and
// consumed every OTHER block whole: a rule inside '@layer base { … }' was never
// produced, so it could be neither reported nor proved out, and a rule the
// browser applies — '@layer base { html { font-size: 20px } }' moves the h1 to
// 28px, measured — passed with the suite green. A reader that cannot read is a
// SILENT PASS, which is the one direction the contract does not permit.
//
// Each at-rule is DECIDED rather than skipped, and each decision carries its
// reason because a table read only on the reporting side is how the last three
// bugs happened:
//
//   @media           descend. The MEDIUM is the only part of the condition that
//                    can be decided here: a query naming 'print' or 'speech'
//                    cannot match the page the guard is about, which is a page
//                    rendered on screen. Every other condition — 'all',
//                    'screen', a feature query, an empty one — is undecidable,
//                    so the rules are read and the condition is named, which is
//                    the existing behaviour for max-width and reduced-motion
//                    and must not change. (AC-14 records the cost: a print-only
//                    override of the page title is no longer reported.)
//   @supports        descend, undecidable, condition named. Unchanged.
//   @layer           descend, carrying the layer on every rule it produces.
//                    This is the false pass above, and it also joins the
//                    cascade — see layerOutranks.
//   @starting-style  descend, but ranked below every normal declaration. A
//                    starting style is beaten by any normal declaration for the
//                    same property, important or not, so it can never outrank
//                    the class rule: the rules are read and the rank is what
//                    makes them lose. (measured: 22.4px even with !important)
//   @container       descend, but silent unless the sheet DECLARES a container
//                    anywhere. With none there is nothing for a query to match,
//                    which is a proof; with one, the rules are read and the
//                    query is named. (measured: 22.4px)
//   @scope           descend, with the PRELUDE decided by the same reachability
//                    function the matcher uses, against the same chain. A
//                    prelude no element in the chain can match is a proof that
//                    the block has no scoping root on this page; anything else,
//                    including an absent prelude, is undecidable and read with
//                    the scope named. (measured: '@scope (main)' moves the h1
//                    to 38.4px because the h1 IS inside main; '@scope (.nope)'
//                    reads 22.4px)
//
// Every row is pinned on BOTH sides in the tests, because a rule that is only
// ever exercised on the silent side is a list of silences.
function readStylesheet(css, chain) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // A container query needs a container to match, and a container comes from a
  // declaration. The check is over the SHEET rather than over the query,
  // because that is where the container has to come from — so the assumption is
  // verified at run time rather than trusted. (risks: a container created at
  // runtime by script rather than by CSS would make this wrong in the
  // false-alarm direction. The app has no such script today.)
  const hasContainer = /(?:^|[;{])[\s\S]{0,80}?\b(?:container|container-type|container-name)\s*:/.test(source);
  // The layer list, declared once, in document order, as the reader meets it.
  // A block with no name is the ANONYMOUS layer, and it is ordered here like
  // any other — so it lands after every named layer declared before it.
  const layers = [];
  const rules = [];

  const walk = (text, context) => {
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
      at = end;

      if (!selector.startsWith('@')) {
        if (selector !== '') rules.push({ selector, body, index: rules.length, ...context });
        continue;
      }
      const name = /^@([a-z-]+)/i.exec(selector)?.[1].toLowerCase() ?? '';
      if (AT_RULES_WITHOUT_ELEMENTS.has(name)) continue;
      const prelude = selector.slice(name.length + 1).trim();
      const inside = { ...context, atRules: [...context.atRules, selector] };

      if (name === 'media') {
        // Every query, not just the first: '@media print, screen' still applies
        // to the page the guard is about, and treating the whole block as
        // printed would be a silent pass — the direction the contract forbids.
        const queries = splitTopLevelCommas(prelude);
        if (queries.length > 0 && queries.every((query) => /\b(?:print|speech)\b/.test(query))) continue;
        walk(body, inside);
      } else if (name === 'supports') {
        walk(body, inside);
      } else if (name === 'layer') {
        walk(body, { ...inside, layer: layers.push(prelude) - 1 });
      } else if (name === 'starting-style') {
        walk(body, { ...inside, startingStyle: true });
      } else if (name === 'container') {
        if (hasContainer) walk(body, inside);
      } else if (name === 'scope') {
        // A scope root is the first element of the chain its prelude matches,
        // and the block can only reach the page h1 when that element is the h1
        // itself or one of its ancestors — so the question is whether the
        // chain PROVES the prelude misses everywhere. Anything it cannot
        // decide, including an absent prelude, is read.
        const root = prelude.replace(/^\(([\s\S]*)\)$/, '$1').trim();
        if (root !== '' && chain.every((element, at2) => branchReaches(root, chain, at2) === false)) continue;
        walk(body, inside);
      } else {
        // An at-rule this reader has never heard of. Its body is read rather
        // than skipped, because a rule the reader cannot place is a rule it
        // cannot report — and that is the silent pass, not a false alarm.
        walk(body, inside);
      }
    }
  };

  walk(source, { atRules: [], layer: null, startingStyle: false });
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
  return splitTopLevelCommas(rule.selector);
}

// Is this branch the rule that gives the page h1 its typography? Tested on the
// branch rather than compared to the string `.${cls}`, because a selector names
// the element it matches and the class rule may be written several ways:
// 'h1.page-title' and 'main > .page-title' are the same rule as '.page-title'
// and outrank it, and reading only the plain spelling made the guard report
// "the stylesheet has no .page-title rule" about a stylesheet that plainly has
// it — one file, two readings of the same question, opposite answers, while the
// sibling declaration test matched inside 'h1.page-title {' and passed green.
//
// The class has to be on the RIGHTMOST compound, because that is the compound
// the branch matches the h1 BY: '.page-title h1' is a rule about a descendant
// and is not this one. And the branch has to REACH the h1, exactly as any
// other predicate about an element does — the one reachability function, with
// no bypass beside it.
//
// It used to answer true for any single-compound branch carrying the class
// token, with no reachability question asked at all, which put two shapes on
// the wrong side of everything downstream (BUG-6). '.page-title::after' was
// taken to BE the class rule although a pseudo-element styles a generated box
// and never the element, and '.page-title[data-x]' although the h1 carries no
// data-x. Their declarations were pooled as the BASELINE and cross-checked
// against the held value, so the value cross-check reported an override of a
// rule the stylesheet does not have — on a build where nothing moves (measured:
// 22.4px throughout). The same predicate reached from the other side is worse:
// ground (a) skips a branch isClassBranch claims, so a real competitor sharing
// a rule with one of them was invisible.
//
// The shortcut is deleted rather than amended. The multi-compound case is now
// the same question, which is what AC-3's coordinated rename depends on: the
// class rule has to stay findable when it is written 'h1.page-title' or
// 'main > .page-title'.
function isClassBranch(branch, cls, chain) {
  const parts = splitCompounds(branch);
  if (parts.length === 0) return false;
  const target = parts[parts.length - 1].compound;
  if (!splitSimple(target).some((token) => token.kind === 'class' && token.name === `.${cls}`)) return false;
  return branchReaches(branch, chain, chain.length - 1);
}

const classBranchesOf = (rule, cls, chain) => branchesOf(rule).filter((branch) => isClassBranch(branch, cls, chain));

// Every declaration that would move one of the three properties the page title
// depends on, with the message the reader needs. `chain` is the resolved page
// h1 and its ancestors; `cls` the class it carries, which is the baseline the
// class-to-rule link names on both ends.
function outrankingPageTitleDeclarations(css, cls, chain) {
  const rules = readStylesheet(css, chain);
  const offenders = [];
  const pageTitle = chain.length - 1;
  // Every rule that gives the page h1 its typography, in document order. The
  // branch is carried on each declaration below rather than rebuilt as a
  // literal, so the specificity the cascade is compared against is the one the
  // selector in the file actually has — 'h1.page-title' is (0,1,1), and
  // scoring a competitor against a made-up (0,1,0) would have it win by
  // default. A stylesheet may also split the class over several rules — an
  // added !important declaration is the usual reason — and the cascade keeps
  // the winning declaration of a property from among them all, not from the
  // last rule alone. Taking only the last rule hid the earlier ones'
  // declarations and made the guard report that the class rule "declares no
  // line-height" about a stylesheet that declares it.
  const classRules = rules.filter((rule) => classBranchesOf(rule, cls, chain).length > 0);
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
    // The branch to NAME is needed whether or not the pool below turns out to
    // be empty, so it is read here. Reading it from the winner instead put a
    // stylesheet whose class rule omits one of the three guarded properties —
    // the single most likely edit to that rule — into a ReferenceError on a
    // `const` declared twenty lines further down, rather than the report this
    // branch was written to make.
    const namedBranch = classBranchesOf(classRules[classRules.length - 1], cls, chain)[0];
    const held = classRules.flatMap((rule) => declarations(rule.body)
      .filter((entry) => properties.includes(entry.property))
      .map((entry) => ({
        ...entry,
        index: rule.index,
        atRules: rule.atRules,
        branch: classBranchesOf(rule, cls, chain)[0],
        layer: rule.layer,
        startingStyle: rule.startingStyle,
      })));
    if (held.length === 0) {
      offenders.push({
        selector: namedBranch,
        atRules: classRules[classRules.length - 1].atRules,
        group,
        property: group,
        message: `${namedBranch} declares no ${properties.join(' or ')}, so ${subject} is not held by the class rule`,
      });
      continue;
    }
    // The declaration the cascade keeps is the one to name, and the one whose
    // importance decides the comparison. In author origin an !important
    // declaration beats every normal one whatever the order, so "the last one in
    // the document" is the winner only among declarations of EQUAL weight:
    // taking the last one regardless of importance let two .page-title rules
    // carrying the same 1.4rem flip the guard's answer on nothing but their
    // order, and reported an override the browser does not apply. So the pool is
    // narrowed to the heaviest declarations first, and then by layer rank, then
    // by specificity, then by position — cascadingWinner asks that question
    // once for this pool and once for every competitor below, so a restatement
    // is judged by the same cascade on both sides.
    //
    // Layer rank is in there because the class rule's own winner is chosen by
    // the same function as its competitors. Without it,
    // '@layer base { .page-title { font-size: 2.4rem } }' made the cross-check
    // report a 2.4rem the browser has already discarded: the unlayered shipped
    // rule outranks a layered NORMAL declaration at any specificity, and the
    // heading stays at 22.4px (measured).
    let winner = null;
    let winnerAt = -1;
    for (const [at, entry] of held.entries()) {
      if (winner === null || keptInPool(entry, at, winner, winnerAt)) {
        winner = entry;
        winnerAt = at;
      }
    }
    // The cascade is a property of the SHEET, not of one rule measured against
    // another. Every declaration in this group that the browser would weigh for
    // the page h1 goes into one pool, in document order, and the pool is asked
    // once. Asking rule against rule instead reported overrides the browser does
    // not apply: '#main h1 { font-size: 2.4rem }' outranks '.page-title' at
    // (1,0,1) and so was reported, on a stylesheet where the class rule carries
    // '.page-title { font-size: 1.4rem !important }' after it and the heading
    // renders at 22.4px (measured). The one declaration the browser keeps is
    // the one the report names, whichever rule wrote it.
    const offers = [];
    for (const rule of rules) {
      for (const selector of branchesOf(rule)) {
        // The class rule's own declarations are in the pool alongside everyone
        // else's, in document order, because they decide the same question and
        // the answer may not depend on which side of the comparison a rule
        // happened to sit. A selector list may pair '.page-title' with a real
        // competitor, and both branches of it are read: '#main h1, .page-title
        // { font-size: 2.4rem }' is an override the browser applies at (1,0,1).
        if (!branchReaches(selector, chain, pageTitle)) continue;
        // A shorthand is in the pool under every group it sets, so 'font' and
        // 'all' are weighed against the same longhands they would set.
        for (const entry of declarations(rule.body)) {
          if (!properties.includes(entry.property)) continue;
          offers.push({
            ...entry,
            branch: selector,
            index: rule.index,
            atRules: rule.atRules,
            layer: rule.layer,
            startingStyle: rule.startingStyle,
            baseline: classIndexes.has(rule.index) && isClassBranch(selector, cls, chain),
          });
        }
      }
    }
    const decided = cascadingWinner(offers);
    if (decided === null) continue;

    // The VALUE, not only the declaration that wins (BUG-2). The declaration
    // test above asserts the class rule contains the three strings; a sheet
    // that declares the class rule a second time satisfies that while the
    // cascade keeps the later rule's 2.4rem and the h1 renders at 38.4px.
    // Importance is ignored here: what the page title depends on is the value,
    // and 'font-size: 1.4rem !important' settles at the same 1.4rem. So is the
    // spelling: '#main h1 { font-size: 1.4rem }' restates the held value and
    // moves nothing, and the message the guard used to write about it refuted
    // itself ('would be font-size: 1.4rem instead of font-size: 1.4rem').
    //
    // It is movesTheHeldValue that decides, and not an inline test, because
    // this is one of four places that answer the question and the other three
    // are the probe's two filters and the root side below. The subject is 'h1',
    // which is what makes the revert exemption FALSE here and true on the root:
    // 'all: revert' on the h1 drops the class rule's own declaration and hands
    // the element to the user-agent's 2em, so it is reported, and the reason
    // is written next to the exemption rather than left to the reader.
    if (!movesTheHeldValue(decided, group, 'h1')) continue;
    const inside = decided.atRules.length > 0 ? ` inside ${decided.atRules.join(' then ')}` : '';
    // Two reports from one declaration. The class rule's own is the value
    // cross-check: the rule that holds the page title's typography no longer
    // holds the value, and it says so about the rule. A competitor's is
    // ground (a), and it says what outranks what — importance, or specificity
    // read off the selector in the file.
    if (decided.baseline === true) {
      offenders.push({
        selector: decided.branch,
        atRules: decided.atRules,
        group,
        property: decided.property,
        message: `the selector '${decided.branch}'${inside} declares ${declarationText(decided)} and the cascade keeps it — `
          + `${subject} would be ${declaredValue(decided, group)} instead of ${PAGE_TITLE_HELD[group][0]}`,
      });
      continue;
    }
    const decidedSpecificity = specificityOf(decided.branch);
    const because = decided.important && !winner.important
      ? 'carries !important, which outranks any normal declaration of the same property'
      : `outranks .${cls} at (${decidedSpecificity === null ? 'unreadable' : decidedSpecificity.join(',')})`;
    // A specificity the vocabulary cannot compute is not a proof that the rule
    // loses, so it is reported rather than passed: a class rule written
    // 'h1::first-line.page-title' has a pseudo-element in it, and comparing
    // against it unguarded threw.
    offenders.push({
      selector: decided.branch,
      atRules: decided.atRules,
      group,
      property: decided.property,
      message: `the selector '${decided.branch}'${inside} ${setsProperty(decided, group)} and ${because} — `
        + `${subject} would be ${declaredValue(decided, group)} instead of ${PAGE_TITLE_HELD[group][0]}`,
    });
  }

  // Ground (b), the root. The class rule's own font-size is in rem, and every
  // rem in the sheet is measured against the ROOT element's font-size, so a
  // font-size on the root moves the page h1 even though the class rule wins the
  // cascade on the element outright — '* { font-size: 2.4rem }' loses at
  // (0,0,0) and still renders the heading at 53.76px. The reach test is
  // against chain[0], NOT against the h1, and that is the whole difference:
  // '[lang]' names an attribute the h1 does not carry and one the root does.
  //
  // Only the font-size group is reported, and the guard's own measurements say
  // so: in every one of these cases Chromium reads lineHeight 67.2px, which is
  // 1.25 x 53.76px — the h1's line-height is untouched, because
  // 'line-height: 1.25' is unitless and the class rule declares it on the
  // element. Reporting the line-height here would be a false failure asserting
  // a change that does not happen, which is the failure mode this rewrite
  // exists to remove.
  for (const rule of rules) {
    const carriesClass = classIndexes.has(rule.index);
    for (const selector of branchesOf(rule)) {
      // As above: the class branch of a rule is the baseline, and any other
      // branch in the same list is still judged on its own. '.page-title, html
      // { font-size: 20px }' moves the h1 through the root just as much as the
      // plain 'html' rule does.
      if (carriesClass && isClassBranch(selector, cls, chain)) continue;
      if (!branchReaches(selector, chain, 0)) continue;
      // 'all' is here for the same reason it is in PAGE_TITLE_PROPERTIES: it
      // sets the root's font-size like any reset does, and the same argument
      // that a guard listing only the longhands certified a wrong rendering
      // applies to the root as much as to the h1. '* { all: unset }' and
      // ':root { all: revert }' are ordinary-looking rules that move every rem
      // in the sheet.
      const offered = declarations(rule.body).filter((one) => ROOT_FONT_PROPERTIES.includes(one.property));
      const carried = cascadingWinner(offered, selector, rule.index);
      // The value decision again, with the root as the subject. 'revert' is a
      // REMOVAL and not a set, and on the root it is the one exemption there
      // is: it declares nothing, so it cannot set the root's font-size, and it
      // removes author declarations, which can only carry the root back toward
      // the user-agent default the class rule's rem is already measured
      // against. Measured: root 16px and h1 22.4px either way. On the h1 the
      // same word is a REPORT, and movesTheHeldValue is where that asymmetry
      // lives rather than being a comparison written out again here.
      //
      // 'revert-layer' and 'unset' are not removals and are not in the
      // exemption: 'unset' sets every longhand, and whether the root happens
      // to already be at the default on this page is a fact about the shipped
      // sheet that a stylesheet may change, which is why the guard cannot take
      // it. As with the class rule above, it is the declaration the cascade
      // KEEPS that decides: a rule that reverts the root and then sets its
      // font-size still moves the heading.
      if (!movesTheHeldValue(carried, 'font-size', 'root')) continue;
      for (const entry of offered) {
        const inside = rule.atRules.length > 0 ? ` inside ${rule.atRules.join(' then ')}` : '';
        const sets = entry.property === 'font'
          ? `the font shorthand, which sets the root's font-size too (${entry.value})`
          : entry.property === 'all'
            ? `all: ${entry.value}, which resets the root's font-size too`
            : `font-size: ${entry.value}`;
        offenders.push({
          selector,
          atRules: rule.atRules,
          group: 'font-size',
          property: entry.property,
          message: `the selector '${selector}'${inside} sets ${sets} on the document root — `
            + `the class rule's font-size is written in rem and is measured against the root's font-size, `
            + `so the page h1's font-size moves with it, away from ${PAGE_TITLE_HELD['font-size'][0]}, `
            + `even though .${cls} wins the cascade on the element`,
        });
      }
    }
  }

  return offenders;
}

// THE SHIPPED-SHEET PROBE, as a function of any sheet rather than of the one it
// is written beside, so the guard and the probe can be asked the SAME question
// about the SAME rule and the two answers compared. Reading the whole sheet by
// hand is the claim that makes the guard's verdict on it worth anything: a
// guard that quietly stopped asking about half the sheet would return the same
// [] the clean tree produces, and this is the assertion that would notice.
//
// It asked the question the other way for a while, which is how BUG-10
// happened. It filtered on 'this rule declares a guarded property SOMEWHERE'
// and stopped there, so it never picked a winner and had no declaration to ask
// anything of: '#main h1 { line-height: 1.25 }' restates the value the page
// title is already held at, the guard was silent about it, and the probe named
// the selector as an override of nothing. It is now asked the way the guard
// asks — which declaration the cascade KEEPS for each group, and whether that
// puts the h1 somewhere it is not already — so the two answer one question and
// the agreement table below can hold them to it.
//
// A sheet carrying no class rule is not this function's report to make. The
// guard reports that once per guarded group, and the probe's claim is about
// what the class rule outranks, which is not a question without one.
function probeStylesheet(sheet, cls, chain) {
  const classRule = sheet.find((rule) => classBranchesOf(rule, cls, chain).length > 0);
  if (classRule === undefined) return { outranking: [], rootReports: [] };
  const baseline = {
    specificity: specificityOf(classBranchesOf(classRule, cls, chain)[0]),
    index: classRule.index,
    layer: classRule.layer,
    startingStyle: classRule.startingStyle,
  };

  // Ground (a). Every rule carrying the class is the baseline rather than a
  // competitor: a second class rule is reported by the value cross-check,
  // which is the claim that actually decides, and calling it an outranking rule
  // here too would be the same override reported twice. The class rule is found
  // the way the guard finds it — by the branch, not by the string '.${cls}' —
  // so this probe cannot disagree with the guard about what the baseline is.
  //
  // Note what this does NOT claim: that only the class rule can reach the h1. A
  // rule that reaches the h1 and LOSES the cascade is silent and correct — '*'
  // is the standing example, and appending '* { line-height: 2 }' is an
  // expected-green case. The claim is the one that decides: of the rules that
  // may reach the h1, the class rule is the only one that may also outrank it
  // and put a group at a value the h1 is not already at.
  const outranking = sheet
    .filter((rule) => classBranchesOf(rule, cls, chain).length === 0)
    .flatMap((rule) => branchesOf(rule).map((branch) => ({ branch, rule })))
    .filter(({ branch }) => branchReaches(branch, chain, chain.length - 1))
    .filter(({ branch, rule }) => beats(
      {
        specificity: specificityOf(branch),
        index: sheet.length,
        layer: rule.layer,
        startingStyle: rule.startingStyle,
      },
      baseline,
    ))
    // The winner, per group, is what makes the restatement exemption decidable
    // here at all: '#main h1 { margin: 0; margin-top: 24px }' keeps the
    // longhand and is reported, while '#main h1 { margin: 0 }' restates the
    // held value and is not — and the guard reaches the same verdict for the
    // same reason rather than by a different route.
    .flatMap(({ branch, rule }) => PAGE_TITLE_PROPERTIES
      .map(({ group, properties }) => (movesTheHeldValue(
        cascadingWinner(
          declarations(rule.body).filter((entry) => properties.includes(entry.property)),
          branch,
          rule.index,
        ),
        group,
        'h1',
      ) ? `${branch} ${group}` : null))
      .filter((one) => one !== null));

  // Ground (b) over the WHOLE sheet rather than the guarded subset, and the
  // claim is the narrow one: reaching the root is not itself a report — '*'
  // reaches it and declares box-sizing — a font-size there is. Distinct
  // branches, because a stylesheet may declare '*' twice and the question is
  // which SELECTORS can match the root, not how many times one is written. The
  // winner and the value decision are the guard's, with the root as the
  // subject, so ':root { all: revert }' and ':root { font: revert }' are silent
  // on BOTH sides instead of on the guard's side only.
  const rootReports = [...new Set(sheet.flatMap((rule) => branchesOf(rule)
    .filter((branch) => !isClassBranch(branch, cls, chain) && branchReaches(branch, chain, 0))
    .filter((branch) => movesTheHeldValue(
      cascadingWinner(
        declarations(rule.body).filter((one) => ROOT_FONT_PROPERTIES.includes(one.property)),
        branch,
        rule.index,
      ),
      'font-size',
      'root',
    ))
    .map((branch) => `${branch} font-size`)))];

  return { outranking, rootReports };
}

// The cascade contract is seven tests rather than one. `node --test` reports a
// single pass or fail for a whole body, so a red build used to hand the reader
// an assertion message and nothing about which of thirty independent scenarios
// produced it — while every other long test in this file scopes itself to one
// concern, which is the convention here. They are cut at the comment
// boundaries already in the contract, so each assertion keeps the reasoning
// written above it, and they share one resolved page h1 and one stylesheet, so
// what differs between them is the case and nothing else.
let css;
let chain;
let cls;
let html;
let sheetWith;
let bySelectorAndProperty;

before(async () => {
  css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');
  html = await renderPage('/', { repositories: freshRepos() });
  chain = pageTitleElement(html).chain;
  cls = pageTitleClass(html);
  // A stylesheet carrying the class rule and nothing else, for every case
  // below that asserts what the guard REPORTS. Those cases are about the
  // guard, and pinning them to the shipped file ties them to a property of
  // that file their verdict must not depend on: append
  // '.page-title { font-size: 1.4rem !important; }' and the browser still
  // renders 22.4px, so a plain competitor is correctly no longer reported —
  // and a case that insisted on the report would then be red on a correct
  // stylesheet, which is the false alarm this guard exists to remove. The
  // class is interpolated, so the fixture follows a coordinated rename like
  // every other case here. The shipped sheet stays the input to the
  // clean-tree probes and to the cases that are about the file itself: the
  // two-longhand winner, the appended !important class rule, and the renames.
  sheetWith = (extra) => `.${cls} { font-size: 1.4rem; line-height: 1.25; margin: 0; }\n${extra}\n`;
  bySelectorAndProperty = (offenders) => offenders.map((one) => `${one.selector} ${one.property}`);
});

test('nothing in the shipped stylesheet beats the class rule for the page h1', async () => {
  const inMedia = sheetWith('@media (max-width: 900px) { #main h1 { font-size: 2.4rem; } }');
  const override = '#main h1 { font-size: 2.4rem; line-height: 1.6; margin-top: 24px; }';

  // The shipped stylesheet must be clean, and it is the case that proves the
  // resolver is not simply flagging everything: the '*' reset and the body
  // typography both reach the h1 and both lose to the class rule.
  assert.deepEqual(
    outrankingPageTitleDeclarations(css, cls, chain).map((offender) => offender.message),
    [],
    'nothing in the shipped stylesheet beats the class rule for the h1',
  );

  // ...which is only a claim worth reading if the sheet is probed rather than
  // trusted. Every rule of it, and every one that reaches the h1 or the root. A
  // guard that quietly stopped asking about half the sheet would return []
  // above just as happily, and this is the assertion that would notice.
  const sheet = readStylesheet(css, chain);
  const probe = probeStylesheet(sheet, cls, chain);
  // The h1-side claim is the one that decides, and it is the guard's: reaching
  // the h1 and LOSING the cascade is silent and correct — '*' is the standing
  // example, and appending '* { line-height: 2 }' is an expected-green case —
  // so what the probe rules out is a rule that reaches the h1 AND outranks it
  // AND puts a group somewhere the h1 is not already. All three, and the third
  // is the one the old probe could not ask about: it filtered on whether a rule
  // declared a guarded property somewhere, so it reported '#main h1
  // { line-height: 1.25 }' as an override of a value the heading is already
  // held at (BUG-10).
  assert.deepEqual(probe.outranking, [],
    'of the rules in the shipped sheet, no rule but the class rule may reach the h1, outrank it, and put a group at a value the h1 is not already at');
  // Ground (b) over the WHOLE sheet rather than the guarded subset, and the
  // claim is the narrow one: reaching the root is not itself a report — '*'
  // reaches it and declares box-sizing — a font-size there is. ':root'
  // and '*' are the two that are provably about the root; ':focus-visible' is
  // here because a pseudo-class is undecidable from static markup, so it MAY
  // match anything, which is the noisy direction the contract deliberately
  // takes. None of the three declares a font-size at a value that could set
  // one, which is what keeps an ordinary type-scale reset from turning the
  // build red.
  const rootReaching = [...new Set(sheet.flatMap((rule) => branchesOf(rule).filter((branch) => branchReaches(branch, chain, 0))))];
  assert.deepEqual(rootReaching, [':root', '*', ':focus-visible'],
    'the rules in the shipped sheet that may match the document root — the last because an undecidable pseudo-class may');
  assert.deepEqual(probe.rootReports, [],
    'and not one of them declares font-size, the font shorthand or the all shorthand at a value that could set the root\'s font-size, so ground (b) fires on nothing in the shipped sheet');

  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(override), cls, chain)),
    ['#main h1 font-size', '#main h1 line-height', '#main h1 margin-top'],
    'a later, higher-specificity h1 rule is named once per property — this leaves every declaration above satisfied',
  );
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(inMedia, cls, chain)),
    ['#main h1 font-size'],
    'the same override inside a media query is a real override at that width',
  );
  assert.match(
    outrankingPageTitleDeclarations(inMedia, cls, chain)[0].message,
    /@media \(max-width: 900px\)/,
    'the message names the condition the override bites in',
  );
  assert.deepEqual(
    // The override above the class rule rather than below it, in the fixture
    // rather than in the shipped sheet, so the only thing that differs from
    // the case above is the order. Anchored on the resolved class, not the
    // literal, or the substitution would silently no-op under a coordinated
    // rename and this case would pass green.
    bySelectorAndProperty(outrankingPageTitleDeclarations(
      `${override}\n.${cls} { font-size: 1.4rem; line-height: 1.25; margin: 0; }\n`, cls, chain)),
    ['#main h1 font-size', '#main h1 line-height', '#main h1 margin-top'],
    'specificity decides, not source order: the same rule declared above the class rule still fails',
  );

});

// THE TWO SIDES, and the comparison between them, at module scope beside the
// table they are compared in — so a rule is written down once and compared
// once. Two copies is how the last two attempts each wrote the same rule down
// twice and enforced it once.
//
// The comparison is NOT a union, and the reason is the direction it fails in. A
// union is satisfied whenever EITHER implementation matches the row, and every
// row's expected value is what the guard returns on its own, so the probe's
// contribution to all sixteen rows was nil and a probe that had stopped
// reporting could not fail any of them (BUG-11). Merging also swallows a
// spurious extra finding into the same list, so the only way the union could
// ever go red was over-reporting, and the direction that matters here is
// under-reporting. So each side is read on its own, each is held to the row's
// own expected value, and a disagreement names the side that drifted.
function guardVerdictOf(sheetText) {
  return [...new Set(
    outrankingPageTitleDeclarations(sheetText, cls, chain).map((one) => `${one.selector} ${one.group}`),
  )].sort();
}

function probeVerdictOf(sheetText) {
  const probe = probeStylesheet(readStylesheet(sheetText, chain), cls, chain);
  return [...new Set([...probe.outranking, ...probe.rootReports])].sort();
}

// The sides that do not match the row, and [] only when both of them do. The
// guard is now held to the row's expected value as well as the probe, which it
// never was: a row may no longer carry an expected value only one of the two
// can produce.
//
// A side's held value is the row's own `expected` unless the row names a
// different one for that side, which is how the ONE case the two
// implementations are built to answer differently is carried as an expectation
// rather than reported as drift — see the !important row below.
function disagreementsIn({ extra, expected, guard, probe, guardExpected = expected, probeExpected = expected }) {
  const against = (side, actual, held) => (JSON.stringify(actual) === JSON.stringify(held)
    ? null
    : { side, extra, actual, expected: held });
  return [
    against('the guard', guard, guardExpected),
    against('the probe', probe, probeExpected),
  ].filter((one) => one !== null);
}

// Data rather than a sentence, because two assertion sites below both have to
// read this and one of them has to COMPARE it: a message carrying the row's own
// text makes the BUG-11 test a second copy of the table, and respacing a row
// then turns it red for a reason that has nothing to do with the probe. The
// sentence is formatted here instead, at the two sites that want to read it.
const asSentence = (one) => `${one.side} disagrees about '${one.extra}' — it returns ${JSON.stringify(one.actual)} where it is held at ${JSON.stringify(one.expected)}`;

// What one side of a row is held at — the row's `expected`, or the verdict that
// row names for that side.
const heldAt = (row, side) => row[3]?.[side] ?? row[1];

// BUG-10, the half a green case cannot buy on its own. Every case below that
// went green with the fix was a case the PROBE went red on, and a fix that
// answered it by deleting the probe would have gone green identically — the
// probe's whole claim is exhaustive, so nothing in the guard's verdict would
// have said anything was missing. So the two are held to each other, for the
// same appended rule: the verdict the guard must return AND the verdict the
// probe must return, and the two have to agree — silent together or reporting
// together.
//
// ON THE FIXTURE, not on the shipped sheet, and the reason is the same one every
// other case in this file that asserts what the guard REPORTS is asserted on
// (see the `sheetWith` comment in the hook above): what a row's verdict is
// depends on the row's rule and nothing else. Pinned to src/web/styles.css it
// also depended on the REST of that file, and AC-21's own how_to_verify — append
// '#main h1 { font-size: 1.4rem !important; }' and the suite must stay green —
// then turned two rows red. The !important is a real competitor for the sibling
// red row: the guard correctly stops reporting the plain override that loses to
// it, the probe has no importance term and still reports, and the old union hid
// it because the probe alone satisfied the row. The shipped stylesheet is held
// clean by the test above, which is the one place that reads the live file, and
// a row cannot go stale when a file nobody here edits changes.
//
// The fourteen no-op spellings are the ones the report names, and each of them
// is a rule the browser leaves the heading at 22.4px / 28px / 0px on. Between
// them and the two real overrides sits the one row the two sides are MEANT to
// differ on. The last two are real overrides, which is what stops the table
// from being satisfied by a probe that had stopped asking about the h1 at all:
// agreeing on nothing is agreement too, and only the rows a silent probe cannot
// satisfy distinguish it from agreement.
const BUG_10_ROWS = [
  // The no-op spellings. A restatement of a value the h1 is already held at
  // moves nothing, in one of the spellings the group is written in, and the
  // h1 reads 22.4px / 28px / 0px for every one of them in the browser.
  ['h1[data-testid] { font-size: 1.4rem; }', [], 'it restates the held font-size at (0,1,1) and later in the file'],
  ['h1[data-testid] { margin: 0; }', [], 'the margin shorthand is one of the spellings the margin-top group is held at'],
  ['#main h1 { font-size: 1.4rem; }', [], 'the same restatement at (1,0,1), which outranks the class rule outright'],
  ['#main h1 { line-height: 1.25; }', [], 'and the one the old probe reported on its own, with nothing saying why'],
  ['#main h1 { margin: 0; }', [], 'the margin spelling, where the group is held at a list rather than one value'],
  ['#main h1 { margin-top: 0; }', [], 'a longhand of the same property, so the same no-op'],
  ['#main h1 { margin-block-start: 0; }', [], 'and the logical spelling of it, which is the same property and was reported as though it were not'],
  // The two rows importance does NOT decide, and their silence is the point
  // they need to be read for. The guard ranks !important above every normal
  // declaration, so the declaration it keeps here is the one appended; the probe
  // has no importance term at all. Both are silent, but for different reasons —
  // the guard's is the cascade, the probe's is the value — and the reason the
  // row is green is that the value settles the same either way, not that the
  // comparison ignores importance. It does not, and the next row says so.
  ['#main h1 { font-size: 1.4rem !important; }', [], 'importance decides which declaration the guard keeps, and neither side reports — because the one it keeps restates the value the h1 is already held at'],
  ['#main h1 { line-height: 1.25 !important; }', [], 'and the same in the other group, the second of the two rows where importance changes nothing'],
  // ...and the row where it changes everything, which is the one case the two
  // implementations answer differently ON PURPOSE and no single `expected` can
  // hold. `beats()` compares layer, specificity and index and never reads
  // importance, so a probe cannot know that the !important below wins; the
  // guard ranks it and correctly stops reporting an override the browser does
  // not apply (measured: the h1 still reads 22.4px on this sheet). So the row
  // carries each side's own verdict and the divergence is an expectation. It
  // is here because the shape could not express it, which is the same gap: a
  // table that reports a known, intended difference as drift teaches the next
  // person to "fix" one of the two implementations.
  ['#main h1 { font-size: 1.4rem !important; }\n#main h1 { font-size: 2.4rem; }', ['#main h1 font-size'], 'an !important restatement outranks a real override, so the guard is silent and the probe reports — held as the divergence it is, not as drift', { guard: [] }],
  // The removals on the root, in every property they can be written in and
  // every shape they can be wrapped in. A removal cannot set the root's
  // font-size, and the shipped root is already at the user-agent default the
  // class rule's rem is measured against: root 16px and h1 22.4px either way.
  [':root { all: revert; }', [], 'the one spelling the previous guard exempted, and it is still silent'],
  [':root { font: revert; }', [], 'the same removal in the font shorthand, which the previous guard REPORTED with a message claiming the h1 moves'],
  [':root { font-size: revert; }', [], 'and in the longhand, which it also reported'],
  ['* { all: revert; }', [], 'a universal selector reaches the root, and the same removal is a removal there'],
  ['@layer base { :root { all: revert; } }', [], 'inside a layer, where the cascade keeps the layered declaration and the word is still a word'],
  // ...and the two real overrides. Chromium reads 38.4px and 44.8px.
  ['#main h1 { font-size: 2.4rem; }', ['#main h1 font-size'], 'a real override, so the two must agree on REPORTING it and name the selector'],
  ['#main h1 { line-height: 2; }', ['#main h1 line-height'], 'and a second one in another group, for the same reason'],
];

test('BUG-10: the guard and the shipped-sheet probe answer the same question about the same rule', () => {
  for (const row of BUG_10_ROWS) {
    const [extra, expected, claim] = row;
    const sheetText = sheetWith(extra);
    const disagreements = disagreementsIn({
      extra,
      expected,
      guardExpected: heldAt(row, 'guard'),
      probeExpected: heldAt(row, 'probe'),
      guard: guardVerdictOf(sheetText),
      probe: probeVerdictOf(sheetText),
    });
    assert.deepEqual(
      disagreements,
      [],
      `the guard and the probe EACH return this row's own verdict for '${extra}' — ${claim}. `
      + (disagreements.length ? disagreements.map(asSentence).join('; ') : 'No side disagreed.')
      + ' A disagreement here is the drift this table exists to catch, whichever of the two is wrong, and it names the side: '
      + 'a merged list would be satisfied whenever either one is right, so a probe that had stopped asking about the h1 at all '
      + 'would be absorbed into the guard\'s correct answer rather than named',
    );
  }
});

// BUG-11. The green rows above are green because both sides are silent on them,
// and nothing in them can tell a silent probe from an honest one. The rows were
// already the rows that catch it; what did not exist was a comparison required
// to FAIL, so the fix here is not more cases in the list — the list is not what
// failed — it is handing the comparison a broken input and watching it notice.
// It is the same instinct as the pinning test above, which reads this
// file's own source to catch a deleted call site, applied to a predicate rather
// than to a string: a neutered predicate is a failing assertion here, where a
// deleted call site is an absence nobody notices.
//
// The EXPECTED side below is read out of the table rather than derived from the
// probe and rather than written down again, so a stub updated carelessly shows
// up as a changed expectation instead of as silence — and so respacing a row's
// text does not turn this test red for a reason that has nothing to do with the
// probe. It is the rows the table holds the probe at reporting something for,
// which is three now that the table carries the importance divergence, and each
// one is named with the side that failed to say it.
//
// The COUNT is pinned alongside, and it is the half that keeps the third door
// shut. An expectation read out of the table moves with the table, so deleting a
// row would otherwise delete the demand along with it and leave this green — the
// neutered probe and the missing red rows together are the wrong fix AC-21
// forbids, and each of them alone is caught. Only a number stated here is
// independent of the table, and it is three because the two real overrides and
// the divergence are the rows a silent probe cannot satisfy.
test('BUG-11: the agreement table is a comparison that can fail', () => {
  const mustReport = BUG_10_ROWS.filter((row) => heldAt(row, 'probe').length > 0);
  const named = BUG_10_ROWS.flatMap((row) => disagreementsIn({
    extra: row[0],
    expected: row[1],
    guardExpected: heldAt(row, 'guard'),
    probeExpected: heldAt(row, 'probe'),
    guard: guardVerdictOf(sheetWith(row[0])),
    probe: [], // a probe that reports nothing, ever — the mutation AC-23 names
  }));

  assert.equal(
    mustReport.length,
    3,
    'the table still holds the probe at reporting something for exactly three rows — the two real overrides and the importance '
    + 'divergence. Delete one and the assertion below it is satisfied by a table with no red half left, which is the wrong fix '
    + 'AC-21 forbids; add one legitimately and this number is what moves',
  );
  assert.deepEqual(
    // The side, what it returned and what it is held at — the row's own TEXT is
    // left out of the comparison and carried in the message instead, so editing
    // a rule's spacing cannot turn this red while editing what it means can.
    named.map(({ side, actual, expected: held }) => ({ side, actual, expected: held })),
    mustReport.map((row) => ({ side: 'the probe', actual: [], expected: heldAt(row, 'probe') })),
    'a probe that reports nothing is named on exactly the rows the table holds it at reporting something for, and on no other — so '
    + 'the green rows are green because BOTH sides are silent rather than because one side is, and the green half cannot be bought '
    + 'by deleting the probe. Collapsing this comparison back into a union, or neutering probeStylesheet, turns this test red. '
    + (named.length ? `Named: ${named.map(asSentence).join('; ')}` : 'Nothing was named.'),
  );
});


test('a rule that reaches the h1 and the root: the two grounds on single rules', async () => {
  // '*' was one case in the previous version of this file, and its message said
  // the heading was unaffected because '*' loses to the class rule at (0,1,0).
  // That sentence was false and it is worth saying why: the cascade on the
  // ELEMENT is only half of what the browser does, because the class rule's own
  // font-size is 1.4rem and every rem is measured against the root — and '*'
  // matches the root. Chromium reads 53.76px. So the case splits in two: the
  // same selector is REPORTED for a font-size (ground (b)) and silent for a
  // declaration that does not move the root (ground (a), where it reaches the
  // h1 and loses).
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith('* { font-size: 2.4rem; }'), cls, chain)),
    ['* font-size'],
    "'*' declaring font-size is reported under ground (b) — it matches the root, and the h1 renders at 53.76px",
  );
  assert.deepEqual(
    outrankingPageTitleDeclarations(sheetWith('* { line-height: 2; }\n* { margin: 24px 0 0; }'), cls, chain),
    [],
    "'*' declaring anything else on a guarded property reaches the h1 and loses at (0,0,0), and touches no root font-size — silent at 22.4px",
  );
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith('* { font: 700 2.4rem system-ui; }'), cls, chain)),
    ['* font'],
    'the font shorthand sets the root font-size too, so it is the same ground-(b) report',
  );
  // The body is not the root. rem is measured against the root, so a font-size
  // on the body leaves the page h1 at 22.4px even though the body is an ancestor
  // of it — and a declaration matching the element beats an inherited one at
  // any weight, !important included.
  assert.deepEqual(outrankingPageTitleDeclarations(sheetWith('body { font-size: 2.4rem; }'), cls, chain), [],
    'body reaches the h1 by inheritance and still loses at (0,0,1)');
  assert.deepEqual(outrankingPageTitleDeclarations(sheetWith('body { font-size: 2.4rem !important; }'), cls, chain), [],
    'an !important on an ancestor is still only an inherited value, and a declaration matching the h1 beats it at any weight');
  for (const rule of ['main { font-size: 20px; }', '#main { font-size: 20px; }']) {
    assert.deepEqual(outrankingPageTitleDeclarations(sheetWith(rule), cls, chain), [],
      `'${rule.split(' {')[0]}' is not the root either — rem is measured against the root, and the h1 stays at 22.4px`);
  }
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith('h1 { font-size: 2.4rem !important; }'), cls, chain)),
    ['h1 font-size'],
    '!important beats the class rule on specificity alone, which a guard that ignored it would miss',
  );

  // A bare h1 compound is the easy shape. These carry an extra simple selector
  // and reach the shipped <h1 class="page-title" data-testid="page-title">
  // exactly, so a pre-filter that tested the token for equality dropped them
  // all before the parser could decide and left the suite green on a heading
  // rendering at 38.4px. 'h1:first-child' is in the list because a pseudo-class
  // is undecidable from static markup and the base matches, so the rule MAY
  // apply — 'h1:hover' for the same reason, and it is reported at rest.
  for (const override of [
    'h1[data-testid] { font-size: 2.4rem; }',
    'h1:hover { font-size: 2.4rem; }',
    'h1:first-child { font-size: 2.4rem; }',
    'main > h1[data-testid] { font-size: 2.4rem; }',
    '#main h1[data-testid] { font-size: 2.4rem; }',
    'h1[data-testid="page-title"] { font-size: 2.4rem; }',
  ]) {
    const selector = override.split(' {')[0];
    assert.deepEqual(
      bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(override), cls, chain)),
      [`${selector} font-size`],
      `'${selector}' matches the shipped page h1, so it is a real override and must be reported`,
    );
  }

  // BUG-1, verbatim: the spelling .sdlc/memory/qa/selectors.md steers a
  // developer towards, and the one the old pre-filter could not see at all.
  // It carries no h1 token and no dot, so mayReachPageTitle returned false and
  // the suite stayed green on a heading Chromium renders at 38.4px. The class
  // is interpolated rather than written out, so these move with a coordinated
  // rename like every other case in this test.
  for (const selector of ['[data-testid="page-title"]', `[class~="${cls}"]`]) {
    assert.deepEqual(
      bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(`${selector} { font-size: 2.4rem; }`), cls, chain)),
      [`${selector} font-size`],
      `'${selector}' matches the shipped page h1 at (0,1,0) and later in the file, so it is a real override`,
    );
  }

  // The font shorthand sets font-size and line-height in one declaration, so a
  // guard keyed on the longhands alone let it past as an ordinary unmatched
  // property. It is reported once per group it moves, which is the truth rather
  // than a duplicate.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith('#main h1 { font: 700 2.4rem/1.6 system-ui; }'), cls, chain)),
    ['#main h1 font', '#main h1 font'],
    'the font shorthand sets both guarded typographic properties and is outranked in neither',
  );

  // 'all' is the shorthand of all three guarded properties, and the table of
  // guarded properties is what decides whether a declaration is read at all —
  // so a sheet could reset the page title's font-size, line-height and top
  // margin with one ordinary-looking declaration and leave the suite green.
  // Chromium settles 'h1[data-testid="page-title"] { all: unset }' at 16px
  // with the browser's own line-height, against the 22.4px the page title is
  // held at: all three wrong, nothing reported. It is reported once per group
  // it moves, the same treatment the 'font' shorthand gets above.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith('h1[data-testid="page-title"] { all: unset; }'), cls, chain)),
    ['h1[data-testid="page-title"] all', 'h1[data-testid="page-title"] all', 'h1[data-testid="page-title"] all'],
    "'all' sets all three guarded properties at once, so a matching rule that outranks the class rule is reported once per group it moves",
  );
  assert.deepEqual(
    outrankingPageTitleDeclarations(sheetWith('h1 { all: unset; }'), cls, chain),
    [],
    "the same reset through a bare 'h1' reaches the h1 and loses at (0,0,1), so the cascade still leaves the heading at 22.4px and the guard is quiet",
  );
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(`.${cls} { all: unset; }`), cls, chain)),
    [`.${cls} all`, `.${cls} all`, `.${cls} all`],
    'and in the class rule itself the value cross-check catches it: the declaration the cascade keeps is no longer the one the page title depends on',
  );

  // '*' under a descendant combinator still matches the h1, so the pre-filter
  // has to read the last compound rather than the whole branch.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith('main * { font-size: 2.4rem !important; }'), cls, chain)),
    ['main * font-size'],
    "a universal selector under a descendant combinator matches the h1, and !important on it wins",
  );

});

test("the class rule's own declarations: which one the cascade keeps", async () => {
  // Within the class rule the declaration the cascade keeps is the last one
  // setting that property, so that is the value the message names and the
  // importance the comparison weighs — not the first in the group.
  const twoLonghands = css.replace(`${cls} {`, `${cls} {\n  margin-top: 24px;`);
  const shadowed = bySelectorAndProperty(outrankingPageTitleDeclarations(`${twoLonghands}\n#main h1 { margin-top: 3rem; }\n`, cls, chain));
  assert.deepEqual(shadowed, ['#main h1 margin-top'], 'the override is still an override whichever longhand it names');
  assert.match(
    outrankingPageTitleDeclarations(`${twoLonghands}\n#main h1 { margin-top: 3rem; }\n`, cls, chain)[0].message,
    /instead of margin: 0/,
    'and the message names the declaration the class rule actually keeps',
  );

  // Importance is modelled on the class rule's side too: a plain rule of any
  // specificity loses to a class rule whose own declaration is !important. The
  // !important is appended as a second rule for the same class, which is how it
  // gets written, and the earlier rule's other declarations still hold.
  const importantRule = `\n.${cls} { font-size: 1.4rem !important; }\n#main h1 { font-size: 2.4rem; }\n`;
  assert.deepEqual(
    outrankingPageTitleDeclarations(css + importantRule, cls, chain),
    [],
    'an !important class declaration is not outranked by a plain rule at (1,0,1), and the rest of the class rule still holds',
  );
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(`.${cls} { font-size: 1.4rem; }\n#main h1 { font-size: 2.4rem; }`), cls, chain)),
    ['#main h1 font-size'],
    'the same override is reported once the class rule drops the !important',
  );
  // ...and the winner is the one the cascade keeps, not merely the last one
  // written. Among declarations of EQUAL weight that is the last, but an
  // !important declaration outranks a later normal one however it is written, so
  // a pool holding both must be narrowed before the last is taken. These three
  // are the same two class rules in different orders: the guard gave opposite
  // answers on stylesheets the browser renders identically at 22.4px.
  for (const [restatement, reported, claim] of [
    [
      `.${cls} { font-size: 1.4rem !important; }\n.${cls} { font-size: 1.4rem; }`,
      [],
      'an !important first and a plain restatement after it still settle at 1.4rem, so nothing is reported and the h1 stays at 22.4px',
    ],
    [
      `.${cls} { font-size: 1.4rem; }\n.${cls} { font-size: 1.4rem !important; }`,
      [],
      'and the same two declarations in the other order are equally green — the answer may not depend on which was written first',
    ],
    [
      `.${cls} { font-size: 1.4rem !important; }\n.${cls} { font-size: 2.4rem; }`,
      [],
      "a later 2.4rem does not overtake the !important 1.4rem, so the value cross-check must not report a 38.4px heading the browser never renders",
    ],
  ]) {
    assert.deepEqual(
      bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(`\n#main h1 { font-size: 2.4rem; }\n${restatement}\n`), cls, chain)),
      reported,
      claim,
    );
  }

});

test('the class name is a styling decision both ends may move together', async () => {
  // A coordinated rename of the class is a styling decision both ends may make
  // together; a one-sided one is a loud failure. This is the behaviour #51's
  // work order said it wanted and its delivered literals did not permit. All
  // three are stated against the class the h1 actually carries, so they hold
  // whichever name it carries.
  const renamed = css.replaceAll(`.${cls}`, '.renamed-away');
  // BOTH ends move, so the markup is renamed with the stylesheet and the chain
  // is re-read from the page that carries the new name. A chain still holding
  // the old class decides '.renamed-away' out of reach on the h1, which is the
  // one-sided case's answer and not this one's — and with isClassBranch no
  // longer admitting a single compound on sight (BUG-6), the chain is the only
  // thing that can answer it.
  const renamedChain = pageTitleElement(html.replaceAll(`class="${cls}"`, 'class="renamed-away"')).chain;
  assert.deepEqual(outrankingPageTitleDeclarations(renamed, 'renamed-away', renamedChain), [], 'both ends renamed together is green');
  assert.ok(outrankingPageTitleDeclarations(renamed, cls, chain).length > 0, 'renaming only the stylesheet fails');
  assert.ok(outrankingPageTitleDeclarations(css, 'renamed-away', chain).length > 0, 'renaming only the markup fails');

  assert.deepEqual(outrankingPageTitleDeclarations(sheetWith('.checklist li:not(.x) { font-size: 2rem; }'), cls, chain), [],
    'a selector that cannot reach the page h1 is skipped unparsed, so the guard does not throw on CSS it never evaluates');

  // The class rule may be WRITTEN several ways, and the guard has to find the
  // one in the file rather than insist on one spelling. Read as the string
  // '.page-title', a class rule written 'h1.page-title' was invisible to it and
  // the guard reported "the stylesheet has no .page-title rule" about a
  // stylesheet that plainly has it — while the sibling declaration test, which
  // matches inside 'h1.page-title {', passed green on the same file.
  for (const spelling of [`h1.${cls}`, `main > .${cls}`, `body .${cls}`]) {
    assert.deepEqual(
      outrankingPageTitleDeclarations(sheetWith(`${spelling} { font-size: 1.4rem; line-height: 1.25; margin: 0; }`), cls, chain),
      [],
      `'${spelling}' is the class rule written another way, so it is the baseline and the h1 keeps 22.4px`,
    );
  }
  // ...and the baseline is the selector that is in the file, not the plain
  // spelling: 'h1.page-title' is (0,1,1) and outranks '.page-title' at (0,1,0),
  // so a competitor that loses to the plain spelling wins against this one.
  //
  // This used to expect a report, and the report was false. It assumed the class
  // rule 'carries' the 2.4rem because that is the last declaration written,
  // which is not what the cascade keeps: 'h1.page-title' is (0,1,1) and the
  // h1 is an h1 carrying the class, so the 1.4rem wins at any position in the
  // file. Chromium reads 22.4px for this sheet, and the assertion was turning
  // the build red over a stylesheet the browser renders exactly as the page
  // title is held. The pair is BOTH ways round below, because the claim worth
  // pinning is that the answer follows the specificity and not the order.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(
      sheetWith(`h1.${cls} { font-size: 1.4rem; line-height: 1.25; margin: 0; }\n.${cls} { font-size: 2.4rem; }`), cls, chain)),
    [],
    "the later plain-spelled rule loses to 'h1.page-title' on specificity, so the declaration the cascade keeps is the 1.4rem and the h1 stays at 22.4px",
  );
  // The same two rules the other way round is the false pass this guard was
  // filed to close, and it is invisible to an assertion that only reads the
  // last declaration written: the specific rule is written FIRST here, so
  // 'winner = the last one in the document' picked the plain 1.4rem, found it
  // equal to the held value, and passed on a heading Chromium renders at
  // 38.4px. Specificity is settled before source order, and both orders have
  // to be green for the right reason and red for the right reason.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(
      sheetWith(`h1.${cls} { font-size: 2.4rem; }\n.${cls} { font-size: 1.4rem; line-height: 1.25; margin: 0; }`), cls, chain)),
    [`h1.${cls} font-size`],
    "and with the specific rule written FIRST the 2.4rem is the declaration the cascade keeps, so it is reported rather than passed over (38.4px)",
  );
  assert.match(
    outrankingPageTitleDeclarations(sheetWith(`h1.${cls} { font-size: 2.4rem; }\n.${cls} { font-size: 1.4rem; line-height: 1.25; margin: 0; }`), cls, chain)[0].message,
    new RegExp(`the selector 'h1\\.${cls}' declares font-size: 2\\.4rem and the cascade keeps it`),
    'and the message names the winning selector, not merely the property',
  );
  // A competitor that shares a selector LIST with the class rule is still a
  // competitor. The whole rule is the baseline when a class branch is in it,
  // and skipping the whole rule put the other half of the list out of reach of
  // both grounds: '#main h1' at (1,0,1) is a real override the browser applies,
  // and the guard was reading only the '.page-title' half of the same rule.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(
      sheetWith(`#main h1, .${cls} { font-size: 2.4rem; }\n.${cls} { font-size: 1.4rem; line-height: 1.25; margin: 0; }`), cls, chain)),
    ['#main h1 font-size'],
    "the '#main h1' half of a list that also carries the class is a real override at (1,0,1), and 38.4px is what the browser renders",
  );
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(
      sheetWith(`.${cls}, html { font-size: 20px; }`), cls, chain)),
    [`.${cls} font-size`, 'html font-size'],
    "and the same on the other ground: a list pairing the class with a root selector moves the h1 twice over — the class rule's own value becomes 20px, and the root's font-size moves with it. Chromium reads 20px",
  );
  // A rule that gives the h1 the class on the ANCESTOR is a different rule
  // about a descendant, and the shipped chain has no such ancestor — so it is
  // not the baseline and it is not an override either.
  assert.deepEqual(
    outrankingPageTitleDeclarations(sheetWith(`.${cls} > .${cls} { font-size: 2.4rem; }`), cls, chain),
    [],
    "'.page-title > .page-title' needs a page title inside a page title, and there is none, so it is a no-op at (0,2,0)",
  );

});

// BUG-9, in the other direction from the test above. That one is the rename
// applied to the STYLESHEET and the chain; this one is the same rename applied
// to the FIXTURES — the class-coupled cases, which today read the class through
// `cls` and, before the fix, four of them spelled it out instead.
//
// Both halves have to be here and they fail in OPPOSITE directions, which is
// the whole reason neither alone is enough. A fixture pinned to the old name
// names a class no element carries, which matches nothing, which is silent:
//   the RED half — 'h1:is(.page-title)' expects a report and gets none, so the
//   suite goes red on a stylesheet that is correct;
//   the VACUOUS half — '.page-title::after' expects silence and gets it, and
//   the suite cannot tell silence-because-a-pseudo-element-styles-a-generated-
//   box from silence-because-the-selector-matches-nothing. It keeps passing
//   while testing nothing at all, and it is silent by construction rather than
//   by accident.
test('BUG-9: the class-coupled fixtures follow the class, under a coordinated rename', async () => {
  const RENAMED = 'renamed-away';
  const renamedChain = pageTitleElement(html.replaceAll(`class="${cls}"`, `class="${RENAMED}"`)).chain;
  // The sheet is the class rule and the fixture, and NOT the shipped stylesheet
  // underneath them. What this case is about is whether the FIXTURE names the
  // class, and a case built on the whole sheet is also about whatever else the
  // sheet happens to contain: append '#main h1 { font-size: 1.4rem; }' — a
  // rule that restates the held value and that the guard reports nobody — and
  // the assertion below went red, because that rule outranks 'h1:is(…)' at
  // (1,0,1) and takes the winner off it. The decision had been pinned to the
  // sheet rather than to the fixture, which is the defect this ticket is about
  // in a place nobody had looked. The shipped sheet is not weakened by being
  // left out of it: the other cases here, and every case above, read it.
  const caseSheet = (name, extra) => `.${name} { font-size: 1.4rem; line-height: 1.25; margin: 0; }\n${extra}\n`;

  // The RED half. A fixture pinned to the old name matches nothing, the guard
  // proves it out, and the case that demands a report is given none.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(caseSheet(RENAMED, `h1:is(.${RENAMED}) { font-size: 2.4rem; }`), RENAMED, renamedChain)),
    [`h1:is(.${RENAMED}) font-size`],
    "under a coordinated rename 'h1:is(.page-title)' is still REPORTED, because the argument is the class the renamed h1 carries and 38.4px is what the browser renders. A fixture spelled with the old name matches nothing and this goes red",
  );
  // The VACUOUS half, and the reason it is silent stated twice: once as the
  // verdict, and once as the question the matcher actually asked.
  assert.equal(isClassBranch(`.${RENAMED}`, RENAMED, renamedChain), true,
    'the renamed class rule is still found on the renamed chain, so a selector naming that class is not vacuous here');
  assert.deepEqual(
    outrankingPageTitleDeclarations(caseSheet(RENAMED, `.${RENAMED}::after { font-size: 2.4rem; }`), RENAMED, renamedChain),
    [],
    "and '.page-title::after' is still SILENT, because a pseudo-element styles a generated box rather than the h1 — which is the reason the case is about, and not the reason a selector matching nothing is silent",
  );
  assert.equal(branchReaches(`.${RENAMED}::after`, renamedChain, renamedChain.length - 1), false,
    'and that is decided on the pseudo-element: the class beside it is one the renamed h1 does carry');
  // The same pair on the shipped class, off the same two rules rather than the
  // renamed ones, so the two are the same two cases rather than something the
  // rename introduced.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(caseSheet(cls, `h1:is(.${cls}) { font-size: 2.4rem; }`), cls, chain)),
    [`h1:is(.${cls}) font-size`],
    'and the same case on the shipped class, where the two verdicts are identical to the renamed ones',
  );
});

test('the value cross-check: the declaration the cascade keeps against the held value', async () => {
  // BUG-2, verbatim. The class rule declared twice with different values
  // satisfied BOTH tests in the previous version — the declaration test read
  // the first rule with .exec and the cascade test took the last declaration of
  // the property — while the browser applied the second rule's 2.4rem and
  // rendered the h1 at 38.4px. Both tests now read PAGE_TITLE_HELD, and the
  // cascade test compares the class rule's WINNING declaration against it, so a
  // second rule can no longer leave the two disagreeing.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(`.${cls} { font-size: 2.4rem; }`), cls, chain)),
    [`.${cls} font-size`],
    "a second .page-title rule is reported by the VALUE cross-check, not by ground (a) — it IS the baseline rule",
  );
  assert.match(
    outrankingPageTitleDeclarations(sheetWith(`.${cls} { font-size: 2.4rem; }`), cls, chain)[0].message,
    /font-size: 2\.4rem.*instead of font-size: 1\.4rem/,
    'the message names the winning value and the one the page title depends on, not merely the selector',
  );
  for (const [group, property, rule] of [
    ['line-height', 'line-height', `.${cls} { line-height: 1.6; }`],
    ['margin-top', 'margin', `.${cls} { margin: 24px 0 0; }`],
  ]) {
    assert.deepEqual(
      bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(rule), cls, chain)),
      [`.${cls} ${property}`],
      `the value cross-check covers the ${group} group too, not only font-size`,
    );
  }
  // An equivalent restatement is not a change of value, so it is not a report.
  // 'font-size: 1.4rem !important' settles at the same 1.4rem the h1 depends
  // on, and the comparison ignores importance on purpose.
  assert.deepEqual(
    outrankingPageTitleDeclarations(sheetWith(`.${cls} { font-size: 1.4rem !important; }`), cls, chain),
    [],
    'a restatement of the held value is green, even carrying !important',
  );
  // Importance is the one thing the comparison ignores, because '1.4rem' and
  // '1.4rem !important' are the same value. SPELLING is not ignored, and that
  // is the ordered design rather than an oversight: the comparison is on the
  // declaration text, so a rule that renders identically is still reported. All
  // three of these settle the h1 at 22.4px / 1.25 / 0px in Chromium, and the
  // build goes red on them anyway — the false-failure direction the risk section
  // names as the one to be wrong in. Resolving them would mean resolving every
  // length against the root's font-size, which is the coupling ground (b)
  // polices; it is pinned here so the next reader does not read the loudness as
  // a bug.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(`.${cls} { margin: 0px; }`), cls, chain)),
    [`.${cls} margin`],
    "a value that renders identically but is spelled differently is REPORTED: the comparison is textual, and that is on the record rather than accidental",
  );

  // A class rule that declares none of a group's properties is the most likely
  // edit anyone makes to that rule, and the branch written to REPORT it — "the
  // class rule declares no line-height or font" — read a `const` declared
  // twenty lines further down the same function. So the guard threw a
  // ReferenceError instead of making the report, on the one shape where it has
  // nothing to compare and everything to say. No case covered the path, which is
  // how the crash reached a branch whose suite is green.
  const incomplete = outrankingPageTitleDeclarations(`.${cls} { color: red; }`, cls, chain);
  assert.deepEqual(
    incomplete.map((one) => one.group),
    ['font-size', 'line-height', 'margin-top'],
    'a class rule that declares none of the guarded properties is reported once per group, not thrown on',
  );
  for (const group of ['font-size', 'line-height', 'margin-top']) {
    assert.match(
      incomplete.find((one) => one.group === group).message,
      new RegExp(`^\\.${cls} declares no .*${group === 'margin-top' ? 'margin' : group}.*, `
        + `so the page h1's ${group} is not held by the class rule$`),
      `and the '${group}' report names the class rule and says the group is no longer held`,
    );
  }
  // The same path is reachable from a selector list rather than a hand-edited
  // class rule: the list is read as the class rule, its body carries one of the
  // three groups, and the other two are unheld. Both routes run the same code,
  // and this is the one that made the crash look like a crash on ordinary CSS.
  assert.deepEqual(
    outrankingPageTitleDeclarations(`#main h1, .${cls} { font-size: 2.4rem; }`, cls, chain)
      .filter((one) => one.message.includes('is not held by the class rule'))
      .map((one) => one.group),
    ['line-height', 'margin-top'],
    "a list pairing the class with a competitor leaves the other two groups unheld, and that is reported rather than thrown on",
  );

});

test('BUG-3 and BUG-4: the shapes to prove out, and the spellings to read whole', async () => {
  // BUG-3, verbatim. The old guard reported this one, in a message asserting as
  // fact a change that does not happen: '.page-title h1' needs an ancestor
  // carrying the class, and the chain is html < body < main#main < h1 — the page
  // title carries the class itself rather than sitting inside one. Chromium
  // reads 22.4px, so a red build here is a false alarm.
  for (const selector of [`.${cls} h1`, `.${cls} h2`, '.panel h1']) {
    assert.deepEqual(outrankingPageTitleDeclarations(sheetWith(`${selector} { font-size: 2.4rem; }`), cls, chain), [],
      `'${selector}' provably cannot reach the page h1, so it is a no-op at any specificity — the h1 stays at 22.4px`);
  }
  // The ancestor requirement holds in the other direction too: the class on the
  // h1 itself matches, at (0,2,0) with the type.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(`h1.${cls} { font-size: 2.4rem; }`), cls, chain)),
    [`h1.${cls} font-size`],
    'the class on the h1 itself is a match, not a missing ancestor',
  );
  // And a sibling combinator, which needs information the chain does not carry.
  // The h1 is main#main's first child, so no '.kpi + h1' matches it today and
  // Chromium reads 22.4px — but the two spellings below differ only by the
  // spaces round the '+', and the spaced one used to lose its combinator and
  // be answered by the DESCENDANT rule, which can return false. That is a
  // proof the guard is only allowed to have when it has one, so the spaced
  // spelling is reported: undecidable, may match, the noisy direction.
  for (const selector of [`.kpi + h1.${cls}`, `.kpi~h1.${cls}`, `h1 + .${cls}`]) {
    assert.deepEqual(
      bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(`${selector} { font-size: 2.4rem; }`), cls, chain)),
      [`${selector} font-size`],
      `'${selector}' cannot be proved out — the rightmost compound matches the h1 and the sibling is undecidable from an ancestor chain, so it may match`,
    );
  }
  assert.equal(branchReaches(`.kpi + h1.${cls}`, chain, chain.length - 1),
    branchReaches(`.kpi~h1.${cls}`, chain, chain.length - 1),
    'a combinator written with spaces round it is the same selector as one written without, and reaches the same answer');

  // BUG-4, verbatim, and the pair that pins why. The space is inside a quoted
  // value, so the selector is one compound; the shipped h1 carries no data-x,
  // so the rule cannot reach it. The naive whitespace split this replaces threw
  // "the cascade guard cannot read the selector 'h1[data-x="a b"]': the token
  // '[data-x="a'" — a build break on ordinary CSS.
  assert.deepEqual(
    outrankingPageTitleDeclarations(sheetWith('h1[data-x="a b"] { font-size: 2.4rem; }'), cls, chain),
    [],
    'a space inside a quoted value is not a compound boundary, and a guard that threw here was a build break on valid CSS',
  );
  // The same shape with a value the h1 does NOT carry: the attribute is
  // present with a different value, which is a proof of non-match, so it is
  // silent — the browser leaves the h1 at 22.4px. Read the attribute's value,
  // not its presence, or this is a false failure on a rule that changes
  // nothing. Its companion below differs only in the hyphen and IS reported.
  assert.deepEqual(
    outrankingPageTitleDeclarations(sheetWith('h1[data-testid="page title"] { font-size: 2.4rem; }'), cls, chain),
    [],
    'the h1 carries data-testid="page-title" with a hyphen, so this names a value it does not have — a proof of non-match',
  );
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith('h1[data-testid="page-title"] { font-size: 2.4rem; }'), cls, chain)),
    ['h1[data-testid="page-title"] font-size'],
    'the same selector with the value the h1 really carries is a real override at (0,1,1)',
  );
  // BUG-4's sibling: the same quoted value, cut on a comma instead of a space.
  // A rule's selector list is cut on TOP-LEVEL commas only, and the walk that
  // decides that is the one that decides where a compound ends — a bare
  // ',', split turned 'h1[data-x="a,b"]' into the half-selector 'h1[data-x="a',
  // which the matcher cannot read: the message named a selector that is not in
  // the stylesheet, the specificity came back unreadable, and a rule that
  // changes nothing at all was reported. Chromium reads 22.4px for it, because
  // the shipped h1 carries no data-x.
  assert.deepEqual(
    outrankingPageTitleDeclarations(sheetWith('h1[data-x="a,b"] { font-size: 2.4rem; }'), cls, chain),
    [],
    'a comma inside a quoted value is not a selector boundary, and cutting it there reported a half-selector the stylesheet does not contain',
  );
  // The functional pseudo-class carries a comma in its argument, so it is the
  // same cut one syntax level in. What matters is that it is read as ONE
  // selector, with a specificity the cascade can be ordered by; before the fix
  // the message read "the selector 'h1:is(.a' … at (unreadable)".
  //
  // ':is()' is decided, not stripped: the argument is a selector list, evaluated
  // un-negated, so one of these two is a match and the compound matches. What
  // the cut would have thrown away is the comma AND the specificity of the
  // argument, which is the part that has to be scored.
  const functional = outrankingPageTitleDeclarations(sheetWith(`h1:is(.a, .${cls}) { font-size: 2.4rem; }`), cls, chain);
  assert.deepEqual(bySelectorAndProperty(functional), [`h1:is(.a, .${cls}) font-size`],
    'a comma inside a pseudo-class argument is not a selector boundary either: the whole selector is named, and it is reported because one of its arguments matches the h1');
  assert.match(functional[0].message, new RegExp(`outranks \\.${cls} at \\(0,1,1\\)`),
    'and its specificity is the one the whole selector has, rather than the unreadable value a cut selector leaves behind');
  // The same list with no argument the h1 can match is a PROOF of non-match,
  // and BUG-7 was a report about exactly this shape: the old stripNarrowing
  // removed ':is(.a, .b)' whole, left 'h1', matched, and reported a 38.4px
  // heading Chromium renders at 22.4px.
  assert.deepEqual(
    outrankingPageTitleDeclarations(sheetWith('h1:is(.a, .b) { font-size: 2.4rem; }'), cls, chain),
    [],
    "':is(.a, .b)' decides on its arguments, and neither is a class the h1 carries, so the rule provably cannot reach it",
  );
  // The same vocabulary, scored wrongly, is a SILENT pass: ':is(#a, h1)' is
  // (1,0,0) in CSS because of the id in its argument, so it outranks the class
  // rule at (0,1,0) at any position in the file. Scored as a flat b it read
  // (0,0,1), lost, and nothing was reported while the heading rendered at the
  // rule's line-height. These are the end of that hole, through the guard
  // rather than through specificityOf.
  for (const selector of [':is(#a, h1)', ':not(#a)']) {
    assert.deepEqual(
      bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(`${selector} { line-height: 2; }`), cls, chain)),
      [`${selector} line-height`],
      `the id in '${selector}' is a real (1,0,0), so the rule outranks the class rule wherever it is written and the h1 renders at that line-height`,
    );
  }
  assert.deepEqual(
    outrankingPageTitleDeclarations(sheetWith(':where(#a) { line-height: 2; }'), cls, chain),
    [],
    "':where(#a)' contributes no specificity at all, so it reaches the h1 and loses at (0,0,0) — and the browser keeps the class rule's 1.25",
  );

});

test('BUG-5: the block at-rules and the layer rank, decided rather than skipped', async () => {
  // BUG-5, verbatim. readStylesheet consumed every block at-rule whole, so a
  // rule inside one was invisible to BOTH grounds: appending this to the shipped
  // sheet left the suite green while the browser rendered the heading at 28px on
  // a root of 20px. The append is to the shipped file rather than to the
  // fixture, because the case that matters is the one a developer would write.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(`${css}\n@layer base { html { font-size: 20px; } }\n`, cls, chain)),
    ['html font-size'],
    "appending '@layer base { html { font-size: 20px; } }' to the shipped sheet is reported — the browser reads the h1 at 28px and the root at 20px",
  );
  // The same through the shorthand, which is the other half of the same rule.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(`${css}\n@layer reset { html { font: 700 2.4rem system-ui; } }\n`, cls, chain)),
    ['html font'],
    "and the 'font' shorthand spelling, which moves the same root to 53.76px",
  );

  // Layer rank is not 'later wins', and the table that gets it wrong is worse
  // than no table. The measured rule, in both directions and for both weights:
  //
  //   among NORMAL declarations  an UNLAYERED one beats every layer, whatever
  //                             its specificity — so a layered 2.4rem loses and
  //                             the h1 stays at 22.4px
  //   among !IMPORTANT ones      a LAYERED declaration beats every unlayered
  //                             one, and among layers the EARLIER one wins, so
  //                             the pair below settles at 22.4px in EITHER order
  //                             (measured: the reversed spelling reads 38.4px)
  for (const [extra, claim] of [
    ['@layer base { h1 { font-size: 2.4rem; } }', 'a layered NORMAL declaration loses to the unlayered class rule whatever its specificity, so a red build here would be a false alarm'],
    ['@layer base { #main h1 { font-size: 2.4rem; } }', 'and an id in a layer does not buy it back — the layer is settled before the specificity is'],
    [`@layer base { .${cls} { font-size: 2.4rem; } }`, `the value cross-check reads the same cascade, so a layered '.${cls}' does not make the class rule's own winner 2.4rem`],
    ['@layer base { h1 { font-size: 1.4rem !important; } } @layer top { h1 { font-size: 2.4rem !important; } }', 'among two layers the EARLIER one wins an !important declaration, so this restates the held value'],
    ['@layer top { h1 { font-size: 1.4rem !important; } } @layer base { h1 { font-size: 2.4rem !important; } }', 'and the same two layers in the other order settle at the same 1.4rem, because base is still the earlier one'],
    ['@layer base { h1 { font-size: 1.4rem !important; } } h1 { font-size: 3rem !important; }', 'a layered !important beats an unlayered !important, so the unlayered 3rem is discarded'],
  ]) {
    assert.deepEqual(
      outrankingPageTitleDeclarations(sheetWith(extra), cls, chain),
      [],
      claim,
    );
  }
  for (const [extra, selector] of [
    ['@layer base { h1 { font-size: 2.4rem !important; } }', 'h1'],
    ['@layer base { #main h1 { font-size: 2.4rem !important; } }', '#main h1'],
  ]) {
    assert.deepEqual(
      bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(extra), cls, chain)),
      [`${selector} font-size`],
      `'${extra}' reverses layer order, so a layered !important beats the unlayered class rule and the h1 renders at 38.4px`,
    );
  }

  // The other block at-rules are DECIDED, not skipped, and each is pinned on
  // both sides — a table only ever exercised where it is silent is a list of
  // silences. Silent is a PROOF here and reported is a MAY: a rule inside a
  // block nothing can match cannot reach the h1, and a rule inside a block that
  // may does.
  for (const [extra, claim] of [
    ['@starting-style { h1 { font-size: 2.4rem !important; } }', 'a starting style gives way to any normal declaration in the same origin, even an !important one (browser: 22.4px)'],
    ['@container c { h1 { font-size: 2.4rem !important; } }', 'a container query needs a container, and this sheet declares none, so there is nothing for it to match (browser: 22.4px)'],
    ['@scope (.nope) { h1 { font-size: 2.4rem !important; } }', "a scope root nothing in the chain can match leaves the block with no scoping root on this page (browser: 22.4px)"],
    ['@media print { #main h1 { font-size: 2.4rem; } }', 'a printed page is not the page under test (browser: 22.4px)'],
    ['@media speech { h1 { font-size: 2.4rem; } }', 'and neither is a spoken one (browser: 22.4px)'],
  ]) {
    assert.deepEqual(
      outrankingPageTitleDeclarations(sheetWith(extra), cls, chain),
      [],
      `'${extra.split(' {')[0]}' is proved out on this page, so it is silent: ${claim}`,
    );
  }
  // ...and reported, each naming the condition it bites in, so the report is
  // actionable rather than a bare selector.
  for (const [extra, selector, named] of [
    ['@scope (main) { h1 { font-size: 2.4rem !important; } }', 'h1', '@scope (main)'],
    ['@supports (display:grid) { h1 { font-size: 2.4rem !important; } }', 'h1', '@supports (display:grid)'],
    ['@media (max-width: 900px) { h1 { font-size: 2.4rem !important; } }', 'h1', '@media (max-width: 900px)'],
    ['@media (prefers-reduced-motion: reduce) { h1 { font-size: 2.4rem !important; } }', 'h1', '@media (prefers-reduced-motion: reduce)'],
  ]) {
    const reported = outrankingPageTitleDeclarations(sheetWith(extra), cls, chain);
    assert.deepEqual(
      bySelectorAndProperty(reported.filter((one) => one.property === 'font-size')),
      [`${selector} font-size`],
      `'${extra.split(' {')[0]}' may be true, so the rule inside it is read and reported`,
    );
    assert.match(reported[0].message, new RegExp(named.replace(/[()]/g, '\\$&')),
      `and the message names the condition — '${named}' — rather than a bare selector`);
  }
  // Nested blocks, which is the shape a real layer-plus-query sheet has and the
  // one a walk that only descends once would still miss.
  const nested = outrankingPageTitleDeclarations(
    sheetWith('@layer base { @media (max-width: 900px) { h1 { font-size: 2.4rem !important; } } }'), cls, chain);
  assert.deepEqual(bySelectorAndProperty(nested), ['h1 font-size'],
    'a rule nested in a layer inside a media query is found, not stepped over');
  assert.match(nested[0].message, /@layer base then @media \(max-width: 900px\)/,
    'and the message names both the layer and the condition, in the order they nest');

  // The container exemption is about the SHEET and not about the query: a
  // container is a declaration, so the question is whether one exists anywhere
  // in the sheet being read. This is the false-alarm direction — a container
  // created at runtime by script would make it wrong — and the app has no such
  // script today.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(
      sheetWith('main { container-type: inline-size; }\n@container c { h1 { font-size: 2.4rem !important; } }'), cls, chain)),
    ['h1 font-size'],
    "with 'container-type' declared anywhere in the sheet, the container query is read and its rule reported rather than proved out",
  );
  assert.match(
    outrankingPageTitleDeclarations(
      sheetWith('main { container-type: inline-size; }\n@container c { h1 { font-size: 2.4rem !important; } }'), cls, chain)[0].message,
    /@container c/,
    'and the message names the container query it was found in',
  );
  // '@media print, screen' applies to the page under test, so treating the
  // whole block as printed would be a silent pass — the direction the contract
  // forbids. EVERY query in the list has to be one the page is not rendered in.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith('@media print, screen { #main h1 { font-size: 2.4rem; } }'), cls, chain)),
    ['#main h1 font-size'],
    "'print, screen' includes the screen, so the block is read and the override inside it is reported",
  );
  assert.deepEqual(
    outrankingPageTitleDeclarations(sheetWith('@media print, speech { #main h1 { font-size: 2.4rem; } }'), cls, chain),
    [],
    "and a list of media the page is NOT rendered in is still silent, which is the whole point of asking about every query rather than the first",
  );
});

test('BUG-6: the class rule is the branch that reaches the h1, not the rule that mentions it', async () => {
  // BUG-6, verbatim, and the sibling from the same predicate. isClassBranch
  // returned true for any single compound carrying the class token, without
  // asking whether that branch matches the h1 — so a rule about a generated box
  // or about an attribute the h1 does not carry was taken for the baseline.
  // Both leave the h1 at 22.4px, so both are silent.
  for (const extra of [
    `.${cls}::after { font-size: 2.4rem; }`,
    `.${cls}[data-x] { font-size: 2.4rem; }`,
  ]) {
    assert.deepEqual(
      outrankingPageTitleDeclarations(sheetWith(extra), cls, chain),
      [],
      `'${extra.split(' {')[0]}' is not the class rule — it does not match the h1 — and its declaration is not the baseline, so there is nothing to report`,
    );
  }
  // The predicate itself, because the report above is now decided by one pool
  // and this bug would no longer show up in it. isClassBranch used to answer
  // true for any single compound carrying the class token, without asking
  // whether the branch matches the h1; asserting the two answers that shortcut
  // got wrong is what keeps it gone rather than merely unused today.
  assert.equal(isClassBranch(`.${cls}::after`, cls, chain), false,
    "'.page-title::after' styles a generated box, so the branch is not the class rule at any count of compounds");
  assert.equal(isClassBranch(`.${cls}[data-x]`, cls, chain), false,
    "and neither is '.page-title[data-x]', which the h1 does not carry");
  assert.equal(isClassBranch(`h1.${cls}`, cls, chain), true,
    "while a class rule that does reach the h1 is still found, which is what AC-3 and the coordinated rename depend on");
  // The shortcut is gone rather than amended: the branch is held to the same
  // reachability question as any other, and a class rule that really does
  // reach the h1 is still found.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(`h1.${cls} { font-size: 2.4rem; }`), cls, chain)),
    [`h1.${cls} font-size`],
    "and 'h1.page-title' is still found as the class rule AND as an override, so the shortcut's removal did not take the finding with it",
  );
  // ...including through a multi-compound branch, which is the case AC-3 and the
  // coordinated rename both depend on.
  for (const spelling of [`h1.${cls}`, `main > .${cls}`, `body .${cls}`]) {
    assert.deepEqual(
      outrankingPageTitleDeclarations(sheetWith(`${spelling} { font-size: 1.4rem; line-height: 1.25; margin: 0; }`), cls, chain),
      [],
      `'${spelling}' reaches the h1 and holds it, so it is the baseline and the guard is quiet`,
    );
  }
});

test('BUG-7: a pseudo-class is decided, not stripped', async () => {
  // BUG-7, verbatim. stripNarrowing deleted a pseudo-class together with its
  // ARGUMENT, so ':where(h1)' became the empty compound, and an empty compound
  // matching anything is the hazard the comment above that function names and
  // leaves open. Each of these is a proof of non-match and the browser reads
  // 22.4px for all of them.
  for (const extra of [
    ':where(h1) { font-size: 2.4rem; }',
    ':where(h1[data-testid]) { font-size: 2.4rem; }',
    ':root:not(html) { font-size: 20px; }',
    'h1:not([data-testid]) { font-size: 2.4rem; }',
  ]) {
    assert.deepEqual(
      outrankingPageTitleDeclarations(sheetWith(extra), cls, chain),
      [],
      `'${extra.split(' {')[0]}' is decided rather than stripped, and it is a proof of non-match`,
    );
  }
  // ':where(h1)' is silent for a second reason as well: ':where()' contributes
  // NO specificity, so it reaches the h1 at (0,0,0) and loses the cascade there.
  // The restatement below is the same fact read as a value.
  assert.deepEqual(
    outrankingPageTitleDeclarations(sheetWith(':where(h1) { font-size: 1.4rem; }'), cls, chain),
    [],
    "':where(h1)' restates the held value at zero specificity, so it is silent twice over",
  );
  // ':is()' and ':not()' contribute their most specific argument, which is what
  // a 'h1' alone would not: ':is(#a, h1)' is (1,0,0) and outranks the class rule
  // wherever it is written. Scored as a flat 'h1' it read (0,0,1), lost, and
  // nothing was reported while the heading rendered at the rule's line-height.
  for (const selector of [':is(#a, h1)', ':not(#a)']) {
    assert.deepEqual(
      bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(`${selector} { line-height: 2; }`), cls, chain)),
      [`${selector} line-height`],
      `the id in '${selector}' is a real (1,0,0), so the rule outranks the class rule wherever it is written`,
    );
  }
  // The undecidable ones stay on the REPORTED side, so a fix that simply
  // ignored pseudo-classes — the shape of the bug being closed — fails here.
  // The first two are false alarms on this page; the third is not.
  for (const [extra, claim] of [
    ['h1:has(> span) { font-size: 2.4rem; }', "':has()' needs descendants an ancestor chain does not carry, so it may match and is reported (this page does not move: 22.4px)"],
    ['h1:hover { font-size: 2.4rem; }', "a state the served markup says nothing about, so it may match and is reported (this page does not move: 22.4px)"],
    [`h1:is(.${cls}) { font-size: 2.4rem; }`, "and ':is()' whose argument the h1 DOES carry is a real override: 38.4px"],
  ]) {
    assert.deepEqual(
      bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(extra), cls, chain)),
      [`${extra.split(' {')[0]} font-size`],
      claim,
    );
  }
  // The invariant that closes it for good, rather than one case at a time: a
  // compound is a list of tokens and is never reduced to text, so there is no
  // empty compound for the matcher to answer vacuously true about. Every form
  // that used to produce one is a counter-example.
  const empties = [':where(h1)', ':where(h1) span', 'h1:not([data-testid])', ':root:not(html)', ':is(h1)', ':has(> span)'];
  for (const compound of empties) {
    const parts = splitCompounds(compound);
    assert.ok(parts.length > 0 && parts.every((part) => part.compound !== ''),
      `'${compound}' is cut into compounds and none of them is empty`);
    assert.ok(splitSimple(parts[parts.length - 1].compound).length > 0,
      `'${compound}' tokenises into at least one token, so nothing was stripped away`);
  }
  assert.equal(compoundMatches('', chain, chain.length - 1), null,
    'and an empty compound, asked anyway, is UNDECIDED rather than vacuously true — that is the whole of the fix');
  // A token the vocabulary cannot read is undecided too, never false: false is
  // a proof, and a proof the guard would then be standing on.
  for (const compound of ['h1\\', 'h1[', 'h1#', 'h1:not(']) {
    assert.notEqual(compoundMatches(compound, chain, chain.length - 1), false,
      `'${compound}' is not answered with a confident false`);
  }
});

test('BUG-8: a backslash is a thing the scanner decodes, not one it guesses at', async () => {
  // BUG-8, verbatim. An escape was not a character the tokenizer could read, so
  // it was consumed as an unknown token and the fragment after it was re-read as
  // a TYPE selector of its own: in '#\6d ain h1' the 'ain' became a type no
  // ancestor satisfies, which is a confident FALSE. A proof fabricated out of a
  // decode failure is the one thing this guard's contract forbids.
  const escapedId = outrankingPageTitleDeclarations(sheetWith('#\\6d ain h1 { font-size: 2.4rem; }'), cls, chain);
  assert.deepEqual(bySelectorAndProperty(escapedId), ['#\\6d ain h1 font-size'],
    "'#\\6d ain h1' is '#main h1' at (1,0,1), so it reaches the h1 and is a real override (browser: 38.4px)");
  assert.deepEqual(readName('#\\6d ain h1', 1), { name: 'main', length: 7 },
    "and the scanner reads the escape out of it rather than taking the fragment after it for a type selector of its own: "
    + "the hex escape takes the space that ends it, so 'ain' continues the SAME name and the id is '#main'");
  // The report names the selector AS WRITTEN, which is what a developer greps
  // the stylesheet for; the decoding is asserted on readName above rather than
  // by rewriting the selector in a message.
  // The escaped ATTRIBUTE NAME, red today by accident through the value
  // cross-check. It has to stay red through reachability, which is a different
  // question and the one that was broken.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith('h1[data\\2d testid="page-title"] { font-size: 2.4rem; }'), cls, chain)),
    ['h1[data\\2d testid="page-title"] font-size'],
    "'h1[data\\2d testid=\"page-title\"]' decodes to 'h1[data-testid=\"page-title\"]', which the h1 carries, so it stays red — through reachability, which is the question that was broken",
  );
  assert.equal(readName('data\\2d testid', 0).name, 'data-testid',
    'and the attribute NAME decodes through the same reader, so the rule is matched rather than merely not crashing');
  // The case that says the scanner decodes rather than merely stops crashing.
  // This one looks like a false pass and is not: a hex escape consumes the
  // whitespace that terminates it, so this is the single id '#mainh1' and it
  // matches nothing at all.
  assert.deepEqual(
    outrankingPageTitleDeclarations(sheetWith('#mai\\6e h1 { font-size: 2.4rem; }'), cls, chain),
    [],
    "'#mai\\6e h1' is the id '#mainh1' — the escape eats the space that follows it — so it matches nothing and the browser leaves the h1 at 22.4px",
  );
  assert.equal(decodeEscape('\\6d ', 0), 'm', 'a hex escape decodes to the character it names');
  assert.equal(escapeLength('#mai\\6e h1', 4), 4, 'and it consumes the terminating space with it, which is why the id above is one token');
  assert.equal(escapeLength('h1\\:not', 2), 2, "an escaped non-hex character is the character itself, and the backslash ends there");
  assert.equal(decodeEscape('\\:not', 0), ':', 'so it decodes to a colon, which is a character in a name rather than a pseudo-class');
});

test('AC-18: a rule that restates the held value moves nothing, and is silent', async () => {
  // T-14, and the report this closes. A rule that outranks the class rule and
  // restates the value the class rule already holds is not an override of
  // anything, and the message the guard used to write about it refuted itself
  // ('would be font-size: 1.4rem instead of font-size: 1.4rem'). Each of these
  // measures 22.4px / 28px / 0px.
  for (const extra of [
    'h1[data-testid] { font-size: 1.4rem; }',
    '#main h1 { font-size: 1.4rem; }',
    '#main h1 { line-height: 1.25; }',
    '#main h1 { margin: 0; }',
    '#main h1 { margin-top: 0; }',
    '#main h1 { margin-block-start: 0; }',
  ]) {
    assert.deepEqual(
      outrankingPageTitleDeclarations(sheetWith(extra), cls, chain),
      [],
      `'${extra.split(' {')[0]}' restates a value the page title is already held at, in one of the spellings the group is written in, so it changes nothing`,
    );
  }
  // The rule must not reach a shorthand, or the filter becomes a false pass.
  // 'font: 700 1.4rem system-ui' leaves the font-size at 22.4px and drops the
  // line-height to 'normal' (measured), and 'all: unset' takes the h1 to
  // 16px / 24px / 0px (measured). Neither is a restatement, and a guard that
  // compared the shorthand's own text would have read the first as a match.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith('#main h1 { font: 700 1.4rem system-ui; }'), cls, chain)),
    ['#main h1 font', '#main h1 font'],
    "the font shorthand restates nothing the page title can see, and the line-height it sets is 'normal', not the held 1.25",
  );
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith('#main h1 { all: unset; }'), cls, chain)),
    ['#main h1 all', '#main h1 all', '#main h1 all'],
    "and 'all' is reported once per group it moves, because it moves all three (measured: 16px / 24px / 0px)",
  );
  // 'revert' is a REMOVAL and not a set, so on the root it is not a font-size
  // and moves nothing: measured 22.4px. 'unset' and 'revert-layer' are reported
  // beside it, and both are FALSE ALARMS on this page today — measured 22.4px
  // for each — because nothing the guard can see gives either of them anything
  // to act on. They are reported because the alternative is resolving what
  // 'unset' unsets to, which is a renderer. That is the direction the contract
  // permits being wrong in, and it is pinned here so the next reader does not
  // read the pair as a contradiction.
  assert.deepEqual(
    outrankingPageTitleDeclarations(sheetWith(':root { all: revert; }'), cls, chain),
    [],
    "':root { all: revert }' removes what the cascade had put there rather than setting a font-size, so the root is 16px and the h1 is 22.4px (measured)",
  );
  for (const value of ['unset', 'revert-layer']) {
    assert.deepEqual(
      bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(`:root { all: ${value}; }`), cls, chain)),
      [`:root all`],
      `':root { all: ${value} }' is reported as a root declaration that could set a font-size — a known false alarm on this page, and the loud direction is the safe one`,
    );
  }
});

// AC-22, and the edge of this change. 'revert' is a REMOVAL, and the previous
// version of the guard wrote that as a comparison on one spelling of it —
// `property === 'all' && declarationText === 'all: revert'` — so the concept
// was reported three times out of four: ':root { all: revert }' was silent
// while ':root { font: revert }' and ':root { font-size: revert }' were
// reported, each with a message asserting as fact that the page h1's font-size
// 'moves with it, away from font-size: 1.4rem' while the declared value was the
// word 'revert' and the browser read 22.4px. A guard that exempts one spelling
// of a concept reports the next spelling.
//
// The exemption is a fact about WHERE THE DECLARATION APPLIES, not about the
// word, and both sides are pinned here because getting it wrong in the
// permissive direction is a FALSE PASS and getting it wrong in the loud
// direction is only the false alarm this guard already accepts.
//
//   on the ROOT   a removal carries the font-size back toward the user-agent
//                 default the class rule's rem is already measured against, and
//                 the shipped root is already there: documentElement 16px and
//                 h1 22.4px before and after (measured).
//   on the H1     a removal drops the class rule's OWN declaration and hands
//                 the element to the user-agent's 'h1 { font-size: 2em }', which
//                 is 32px on a 16px root (measured). It genuinely moves the
//                 heading, so it stays reported — and generalising the
//                 exemption to silence it would be a false pass on 32px.
test('AC-22: revert is a removal wherever it is written, and only on the document root', async () => {
  for (const extra of [':root { font: revert; }', ':root { font-size: revert; }']) {
    const reported = outrankingPageTitleDeclarations(sheetWith(extra), cls, chain);
    assert.deepEqual(reported, [],
      `'${extra}' is the same removal in another property, and no message claims the page h1's font-size moves with it — `
      + 'the declared value is the word revert and the browser reads 22.4px');
    assert.equal(reported.filter((one) => /moves with it/.test(one.message)).length, 0,
      'and in particular there is no message of that shape, which is the self-refuting one this closes');
  }
  // The h1 side, from all three directions, because silencing either of them is
  // a false pass rather than a false alarm.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith('#main h1 { all: revert; }'), cls, chain)),
    ['#main h1 all', '#main h1 all', '#main h1 all'],
    "the same word on the h1 is REPORTED: it drops the class rule's own declaration and hands the element to the user-agent's "
    + "'h1 { font-size: 2em }', which is 32px on a 16px root (measured) against 22.4px on the clean tree. The exemption is a fact about the subject, not about the word",
  );
  // ...and the exemption is spelled exactly 'revert', so the neighbouring words
  // stay on the reported side. 'unset' sets every longhand, 'initial' and
  // 'inherit' set every longhand to something specific, and 'revert-layer' rolls
  // back to the previous layer rather than removing anything. What each settles
  // the root to is a renderer this file does not have, and the loud direction is
  // the one the contract accepts being wrong in.
  for (const value of ['revert-layer', 'unset', 'initial', 'inherit']) {
    assert.deepEqual(
      bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(`:root { all: ${value}; }`), cls, chain)),
      [`:root all`],
      `':root { all: ${value} }' is NOT a removal and stays reported, so the exemption does not become the word 'revert' standing in for a family of words`,
    );
  }
  // isRemoval is the rule rather than a spelling, said out loud.
  for (const value of ['revert', 'REVERT', ' revert ', 'revert !important']) {
    assert.equal(isRemoval({ property: 'font-size', value, important: value.includes('important') }), true,
      `'${value.trim()}' is the word revert, with the case, the surrounding space and the importance all stripped off it`);
  }
  for (const value of ['revert-layer', 'unset', 'initial', 'inherit', '1.4rem', 'revert 0']) {
    assert.equal(isRemoval({ property: 'all', value, important: false }), false,
      `'${value}' is not the word revert, whatever property it is written under`);
  }
});

test('ground (b): a font-size on the document root moves the page h1', async () => {
  // Ground (b), reported. These lose the cascade on the element and still move
  // the heading, because the class rule's font-size is in rem. Chromium reads
  // 53.76px for the 2.4rem forms and 28px for the 20px ones.
  for (const [selector, named] of [
    ['*', '*'],
    ['html', 'html'],
    // A comma list is split into branches and each is judged on its own: 'body'
    // is not the root, so the branch that does the damage is the one named.
    ['html, body', 'html'],
    ['[lang]', '[lang]'],
  ]) {
    const offenders = outrankingPageTitleDeclarations(sheetWith(`${selector} { font-size: 2.4rem; }`), cls, chain);
    assert.deepEqual(bySelectorAndProperty(offenders), [`${named} font-size`],
      `'${selector}' may match the document root and declares font-size, so it moves the h1 whatever the cascade says on the element`);
    assert.match(offenders[0].message, /document root/,
      "and the message says the root's font-size is what moved");
  }
  // '[lang]' is the case a ground-(a) reading gets wrong. The h1 carries no
  // lang attribute, which is true and irrelevant here: the document root is
  // <html lang="en"> and the rule matches THAT. Filing it with the
  // provable-no-match cases is what an earlier revision of this work order
  // did, and it would have certified a 53.76px page title. It is stated here
  // so the next reader does not re-derive it and move it back.
  assert.equal(branchReaches('[lang]', chain, chain.length - 1), false,
    "under ground (a) '[lang]' is a proof of non-match: the h1 carries no lang attribute");
  assert.equal(branchReaches('[lang]', chain, 0), true,
    "under ground (b) it is a report: the root is <html lang=\"en\"> and the rule matches it");
  for (const selector of ['html', ':root']) {
    assert.deepEqual(
      bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(`${selector} { font-size: 20px; }`), cls, chain)),
      [`${selector} font-size`],
      `'${selector} { font-size: 20px }' renders the h1 at 28px and is reported`,
    );
  }
  // The same ground, reached through the 'all' shorthand. A reset of the root
  // moves every rem in the sheet, so the page title's 1.4rem is measured against
  // a root this rule has just changed — the identical report, one declaration
  // shorter, and the table of guarded properties says exactly that about 'all'.
  for (const selector of ['*', ':root']) {
    assert.deepEqual(
      bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith(`${selector} { all: unset; }`), cls, chain)),
      [`${selector} all`],
      `'${selector} { all: unset }' moves the root's font-size, so the rem the page title is sized in moves with it`,
    );
  }
  // Inside an at-rule is the same report with the condition named, like any
  // other override the reader has to be told the width of.
  assert.deepEqual(
    bySelectorAndProperty(outrankingPageTitleDeclarations(sheetWith('@media (max-width: 900px) { html { font-size: 20px; } }'), cls, chain)),
    ['html font-size'],
    'a root font-size inside a media query is a real override at that width',
  );
  assert.match(
    outrankingPageTitleDeclarations(sheetWith('@media (max-width: 900px) { html { font-size: 20px; } }'), cls, chain)[0].message,
    /@media \(max-width: 900px\)/,
    'and its message names the condition',
  );
});

test('the cascade resolver agrees with CSS on specificity', async () => {
  const { chain } = pageTitleElement(await renderPage('/', { repositories: freshRepos() }));
  const cls = pageTitleClass(await renderPage('/', { repositories: freshRepos() }));
  const pageTitle = chain.length - 1;
  const reaches = (selector, target = pageTitle) => branchReaches(selector, chain, target);

  assert.deepEqual(specificityOf('*'), [0, 0, 0], "'*' is not a type name");
  assert.deepEqual(specificityOf('body'), [0, 0, 1], 'a bare type is one c');
  assert.deepEqual(specificityOf('h1'), [0, 0, 1], 'the h1 type is one c');
  assert.deepEqual(specificityOf(CLASS_VOCABULARY.plain), [0, 1, 0], 'a class is one b');
  assert.deepEqual(specificityOf('.a.b'), [0, 2, 0], 'a compound of two classes is two b');
  assert.deepEqual(specificityOf('[aria-current="page"]'), [0, 1, 0], 'an attribute selector is one b');
  assert.deepEqual(specificityOf('a:hover'), [0, 1, 1], 'a single-colon pseudo-class is a b, not a c');
  assert.deepEqual(specificityOf('#main'), [1, 0, 0], 'an id is one a');
  assert.deepEqual(specificityOf('#main h1'), [1, 0, 1], 'a descendant adds its ancestor to the specificity');
  assert.deepEqual(specificityOf('main > h1'), [0, 0, 2], "'>' is a combinator, not a type name");
  // The one splitter serves both, and the shapes that used to throw are the
  // ones that must be counted rather than refused: a functional pseudo-class is
  // a b, and ':not(.x)' contributes its argument.
  assert.deepEqual(specificityOf('h1[data-x="a b"]'), [0, 1, 1], 'a space inside a quoted value is not a second compound');
  assert.deepEqual(specificityOf('main > h1[data-testid]'), [0, 1, 2], "spaces either side of a '>' are not an empty compound");
  assert.deepEqual(specificityOf('.checklist li:not(.x)'), [0, 2, 1], "a functional pseudo-class contributes its argument's specificity, so ':not(.x)' is a b");
  assert.deepEqual(specificityOf('.a\n.b'), [0, 2, 0], 'a newline is whitespace — the shipped sheet breaks a comma list across one');
  // A functional pseudo-class is scored by its most specific argument, and
  // ':where()' by nothing at all. Both were a flat b, which put ':is(#a, h1)' at
  // (0,0,1) — under the class rule — so a rule that really does outrank the page
  // title landed on the SILENT side, the one direction the contract says cannot
  // happen. The reachability half was right about these shapes all along; it was
  // the arithmetic after it that dropped them.
  assert.deepEqual(specificityOf('h1:is(.a, .b)'), [0, 1, 1], "':is()' takes its most specific argument, here one b");
  assert.deepEqual(specificityOf(':is(#a, h1)'), [1, 0, 0], "and the id in the argument lifts the whole selector to (1,0,0)");
  assert.deepEqual(specificityOf(CLASS_VOCABULARY.isWithId), [1, 0, 0], 'the heaviest ARGUMENT is taken, not all of them added: the id outranks the class and the type');
  assert.deepEqual(specificityOf(':not(#a)'), [1, 0, 0], "':not()' takes its argument's specificity");
  assert.deepEqual(specificityOf(':where(#a)'), [0, 0, 0], "':where()' contributes nothing, which is the point of it");
  assert.deepEqual(specificityOf('h1:where(.a)'), [0, 0, 1], 'so the type beside it is all that is left');
  assert.deepEqual(specificityOf('h1:is([data-x="a b"], .c)'), [0, 1, 1], 'a quoted value holding a space is one argument, not two');
  assert.deepEqual(specificityOf('h1:is(:not(#a))'), [1, 0, 1], 'and a nested functional pseudo-class is scored through');

  const pageTitleBaseline = { specificity: specificityOf(`.${cls}`), index: 99 };
  assert.ok(beats({ specificity: specificityOf('#main h1'), index: 0 }, pageTitleBaseline),
    "'#main h1' beats '.page-title' a hundred rules earlier");
  assert.ok(beats({ specificity: specificityOf('.a.b'), index: 0 }, { ...pageTitleBaseline, specificity: specificityOf('.a') }),
    "'.a.b' beats '.a'");
  assert.ok(!beats({ specificity: specificityOf('*'), index: 99 }, pageTitleBaseline), "'*' beats nothing, at any source position");
  assert.ok(beats({ ...pageTitleBaseline, index: 5 }, { ...pageTitleBaseline, index: 4 }), 'equal specificity is decided by source order');
  assert.ok(!beats({ ...pageTitleBaseline, index: 4 }, { ...pageTitleBaseline, index: 5 }), 'and not by the reverse');

  // The one-directional guarantee, in the three directions it can answer, each
  // against the real chain read off the real markup. This is the assertion the
  // four assert.throws cases used to make, re-expressed against a guard that
  // does not throw: a stylesheet the guard cannot model must not fail the suite
  // by being unparseable, and it must never pass it for the wrong reason
  // either. False is a proof; true is everything else.
  //
  // REACH-AND-REPORT — may reach the h1 and outrank the class rule at (0,1,0).
  for (const [selector, specificity] of [
    ['#main h1', '(1,0,1)'],
    ['#main h1[data-testid]', '(1,1,1)'],
    ['main > h1[data-testid]', '(0,1,2)'],
    ['h1[data-testid]', '(0,1,1)'],
    ['h1[data-testid="page-title"]', '(0,1,1)'],
    ['h1:hover', '(0,1,1)'],
    ['[data-testid="page-title"]', '(0,1,0)'],
    [`[class~="${cls}"]`, '(0,1,0)'],
  ]) {
    assert.equal(reaches(selector), true, `'${selector}' ${specificity} reaches the page h1`);
  }
  // REACH-BUT-LOSE — matches the h1, loses the cascade, so ground (a) is silent.
  for (const [selector, specificity] of [
    ['*', '(0,0,0)'],
    ['h1', '(0,0,1)'],
    ['main *', '(0,0,1)'],
    ['main h1', '(0,0,2)'],
    ['html body main h1', '(0,0,4)'],
  ]) {
    assert.equal(reaches(selector), true, `'${selector}' ${specificity} matches the h1 even though it loses the cascade`);
  }
  // PROVABLY NO-MATCH — false, on a proof, and never a throw.
  for (const selector of [
    '.checklist li:not(.x)', 'h1 + p', 'h1 ~ p', '.panel h2', '.app-header h1',
    REACH_VOCABULARY.longerName, '[data-testid="nope"]', 'h1::after', REACH_VOCABULARY.pseudoElement,
    'h1[data-x="a b"]', 'h1[data-testid="page title"]', 'main > h1[data-x]', 'h1#main',
  ]) {
    assert.equal(reaches(selector), false, `'${selector}' provably cannot match the shipped page h1`);
  }
  // The same list against the ROOT, where the answers are different — because
  // the ground (b) test asks about a different element, and reading one as the
  // other is how '[lang]' ended up filed as a proof of non-match.
  assert.equal(reaches('body'), false, 'the body is not the page h1: it reaches it by inheritance, and a declaration on the element wins');
  assert.equal(reaches('#main'), false, 'an ancestor id does not match the h1 itself');
  assert.equal(reaches('.panel h2'), false, 'a different element does not match the h1');
  assert.equal(reaches(REACH_VOCABULARY.longerName), false, 'a longer class name is not the class');
  for (const selector of ['*', 'html', ':root', '[lang]']) {
    assert.equal(reaches(selector, 0), true, `'${selector}' may match the document root`);
  }
  assert.equal(reaches('body', 0), false, 'and the body is not the root either — rem is measured against the root, not against it');
  assert.equal(reaches('main', 0), false, 'nor is main');
  assert.equal(reaches('#main', 0), false, 'nor #main');
  assert.equal(reaches('[data-testid="page-title"]', 0), false, 'the root carries no data-testid, which is the mirror of the [lang] case above');
});

// The guard's world-model, asserted directly. Every question it asks is about
// the page h1 as an ELEMENT, so what that element is — and what sits around it
// — is the guard's premise, and a premise that drifted silently is how a
// matcher ends up reasoning about a page it has never seen. It is read from the
// rendered markup, not assumed, and the hook it reads is data-testid: the
// styling class may be renamed at either end, and this one may not.
test('the cascade guard resolves the page h1 and its chain from the markup', async () => {
  const { element, chain } = pageTitleElement(await renderPage('/', { repositories: freshRepos() }));

  assert.equal(element.tag, 'h1', 'the hook is on the h1');
  assert.equal(element.attrs['data-testid'], 'page-title', 'and it is the stable hook, not the styling class');
  assert.deepEqual(
    chain.map((one) => (one.attrs.id === undefined ? one.tag : `${one.tag}#${one.attrs.id}`)),
    ['html', 'body', 'main#main', 'h1'],
    'the chain is root-first and ends at the h1, with no wrapper between body and main — which is what makes ".page-title h1" a no-op and the root the element ground (b) asks about',
  );
  assert.equal(chain[0].attrs.lang, 'en', 'the document root carries lang, so [lang] reaches it and is a ground (b) report');
  assert.equal(chain.at(-1).attrs['data-testid'], 'page-title', 'the last element in the chain is the one the guard targets');

  // A void element in the header does not become the parent of everything after
  // it: the ancestor stack is walked with them skipped, or main#main would come
  // out as a child of the skip link.
  assert.ok(
    !chain.some((one) => one.tag === 'a' || one.tag === 'header'),
    'nothing between body and main#main is treated as an ancestor of the h1',
  );

  // The styling class, read off a real render rather than written out: every
  // claim below is about the class the shipped h1 carries, and the two ends of
  // that link may move together.
  const shippedClass = pageTitleClass(await renderPage('/', { repositories: freshRepos() }));
  assert.notEqual(shippedClass, '', 'the shipped h1 does carry a class, so the strip below is not a no-op');

  // A raw-text element holds text, not markup. A string inside one carrying the
  // hook is a hijack, and it is silent: the guard would resolve the page h1 to
  // the string's element, the real h1 would no longer be the target, and every
  // question asked of it would come back with nothing to say. The class is read
  // off the shipped h1 rather than written out, so the claim holds under a
  // coordinated rename — written out, it went RED on a correct rename, which is
  // the same defect the cascade contract's four fixtures had.
  const hijacked = pageTitleElement(
    `<html lang="en"><body><main id="main"><h1 class="${shippedClass}" data-testid="page-title">Real</h1></main>`
    + "<script>var t = '<h1 data-testid=\"page-title\">fake</h1>';</script></body></html>",
  );
  assert.deepEqual(hijacked.chain.map((one) => one.tag), ['html', 'body', 'main', 'h1'],
    "a hook inside a <script> is text and not an element, so the chain still ends at the h1 the page renders");
  assert.equal(hijacked.element.classes.includes(shippedClass), true,
    'and it is the REAL h1, carrying the class the stylesheet rules on — not the one the script string names');

  // With the class gone the guard must rebuild its world rather than keep the
  // old one: the same markup with the styling class dropped resolves to a chain
  // whose h1 simply carries no class, and the class-to-rule link is then the
  // one-sided failure the class tests report. The class is read off the element
  // rather than written out, so this holds under a coordinated rename.
  const withoutClass = (await renderPage('/', { repositories: freshRepos() })).replace(` class="${shippedClass}"`, '');
  const stripped = pageTitleElement(withoutClass);
  assert.deepEqual(stripped.element.classes, [], 'the h1 carries no class once the stylesheet hook is dropped');
  assert.equal(stripped.chain.length, chain.length, 'and the chain is rebuilt to the same depth, so nothing downstream silently changed shape');
  assert.equal(branchReaches(`.${shippedClass}`, stripped.chain, stripped.chain.length - 1), false,
    'and the class rule can now PROVE it cannot reach the h1, because the h1 demonstrably carries no such class — '
    + 'a proof, not a guess, which is the one direction the guard is allowed to be quiet in');
  assert.equal(branchReaches('[lang]', stripped.chain, 0), true,
    'while ground (b) is unchanged, because dropping a class says nothing about what reaches the root');
});

// Issue #48: the narrow-viewport overflow is a layout constraint rather than a
// styling choice, and a stylesheet is not observable from a rendered page — so
// these two declarations are pinned here for the same reason the #main:focus
// and .page-title rules above are. Delete either one and every page overflows
// sideways again below ~1100px, with a green browser run to prove it.
//
// Every matching rule, not the first. The first-match form could not see a
// later rule re-declaring either property to something else, which is exactly
// how this fix gets silently undone: append `#main > * { min-width: auto }` or
// `.table-scroll { overflow-x: visible }` to the end of the stylesheet and the
// old assertion still passed, with the declarations it names both overridden.
test('the narrow layout still carries the two declarations it depends on', () => {
  const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');

  const itemRules = [...css.matchAll(/#main\s*>\s*\*\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(itemRules.length > 0, 'src/web/styles.css lifts the floor on the #main grid items');
  itemRules.forEach((body, i) => {
    const values = [...body.matchAll(/min-width\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.deepEqual(values, ['0'],
      `#main > * rule ${i + 1} must declare min-width: 0 and nothing else, or a later rule re-breaks the layout; it declared ${JSON.stringify(values)}`);
  });

  const regionRules = [...css.matchAll(/\.table-scroll\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(regionRules.length > 0, 'src/web/styles.css defines a .table-scroll rule');
  regionRules.forEach((body, i) => {
    const values = [...body.matchAll(/overflow-x\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.deepEqual(values, ['auto'],
      `.table-scroll rule ${i + 1} must declare overflow-x: auto and nothing else, or a later rule re-breaks the layout; it declared ${JSON.stringify(values)}`);
  });
});

// Issue #67: the other half of the same constraint, pinned in the same
// deliberate style and for the same reason — a stylesheet is not observable
// from a rendered page, and the browser check that would catch this is not in
// CI. `overflow-wrap: anywhere` on the four card lists is what keeps a long
// unbreakable name inside its own card instead of scrolling the page sideways.
//
// #71 findings 2, 3 and 5. The pin this replaces asserted on a substring of
// the rule's raw text, so a class renamed to .opportunity-roww satisfied it,
// and counted every overflow-wrap rule in the file, so a .page-footer rule
// that cannot override the card rule failed it. Three changes: exact compound
// match instead of substring, comments stripped before parsing (a comment has
// no braces, so prose naming a class was being swallowed into the selector),
// and the "no later override" check scoped to rules that touch a card class
// instead of counted across the file.
//
// #71 finding 2, other end: the class list is checked against the markup the
// server actually renders. The stylesheet half of this test cannot tell a
// selector that matches a rendered element from one that matches nothing, so
// each class is also required in the HTML of the route that renders it.
test('the card lists still carry the wrap that keeps an unbreakable name inside its own card', async () => {
  const CARD_CLASSES = ['.experiment-card', '.opportunity-row', '.approval-card', '.learning-card'];
  const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');
  // Comments carry no braces, so a class named only in prose would otherwise be
  // swallowed into the selector group and satisfy the assertion below.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const rules = [...stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .map((match, index) => ({ selector: match[1].trim(), body: match[2], index }))
    .filter((rule) => /overflow-wrap\s*:/.test(rule.body));

  const card = rules.find((rule) => rule.selector.split(',').some((part) => CARD_CLASSES.includes(part.trim())));
  assert.ok(card, 'src/web/styles.css declares overflow-wrap on the card lists');

  // Exact compound match, not a substring: '.opportunity-roww' and '.opportunity-row-old'
  // both contain '.opportunity-row', and a `*` descendant states nothing the bare
  // class does not, because overflow-wrap is inherited.
  assert.deepEqual(card.selector.split(',').map((part) => part.trim()).sort(), [...CARD_CLASSES].sort(),
    `the wrap rule covers exactly these four classes as bare selectors — a renamed or dropped class matches nothing in the page: ${JSON.stringify(CARD_CLASSES)}`);

  const values = [...card.body.matchAll(/overflow-wrap\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(values, ['anywhere'],
    'the wrap is anywhere and not break-word: break-word creates the break opportunity but leaves the intrinsic min-content width alone, so a grid track floored at min-content still sizes to the whole string');

  // Scoped to the card classes, so a rule that cannot override them does not turn
  // the suite red — appending `.page-footer { overflow-wrap: anywhere; }` must pass.
  for (const later of rules.filter((rule) => rule.index > card.index)) {
    const touched = later.selector.split(',').map((part) => part.trim()).filter((part) => CARD_CLASSES.includes(part));
    assert.deepEqual(touched, [],
      `a later rule re-declares overflow-wrap on ${touched.join(', ')}, which overrides the card rule it is meant to protect`);
  }

  // #71 finding 2, closed: a selector that matches nothing in a real page is the
  // one mistake the stylesheet half cannot see. Each class is required in the HTML
  // of the route that renders it, so renaming a class on the page fails here even
  // though the stylesheet and CARD_CLASSES would both still say the old name.
  const seeded = seededRepos('pages-card-wrap-');
  const markup = {
    '.experiment-card': await renderPage('/experiments', { repositories: seeded }),
    '.opportunity-row': await renderPage('/opportunities', { repositories: seeded }),
    '.learning-card': await renderPage('/opportunities', { repositories: seeded }),
    '.approval-card': await renderPage('/approvals', { repositories: pendingApprovalRepos('pages-card-wrap-approvals-') }),
  };
  for (const cls of CARD_CLASSES) {
    // The markup carries the class name without the dot, and split on
    // whitespace so a renamed class (learning-item, learning-cardw) is a
    // different token rather than a substring of this one.
    const tokens = new Set([...markup[cls].matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)));
    assert.ok(tokens.has(cls.slice(1)),
      `the page still renders ${cls} as its own class, so the wrap rule's selector has something to match`);
  }
});

// #71 finding 1: the wrap rule fixes the name but not the card. .approval-actions
// was a nowrap flex row holding an <input> at its ~234px intrinsic width, so the
// row floored the card at ~389px and .approval-card is a grid item, so the page
// overflowed anyway — with a short name. overflow-wrap cannot reach either, so
// the two declarations it takes are pinned here for the same reason as the ones
// above, and the render proves both selectors have a card to match.
//
// #71 BUG-1: the first version of this pin required min-width: 0, which is the
// declaration that broke the field. flex: 1 is basis 0%, so with the automatic
// minimum removed the input is the row's only shrinkable item and took the whole
// deficit: 59px at a 414px viewport, six characters, against 232px on the base
// commit. The pin below states the property that is actually wanted — a readable
// floor — rather than the one that happened to fix the overflow.
test('the approval action row can shrink, and the selectors below have something to match', async () => {
  const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');

  const rows = [...css.matchAll(/\.approval-actions\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(rows.length > 0, 'src/web/styles.css defines a .approval-actions rule');
  rows.forEach((body, i) => {
    const values = [...body.matchAll(/flex-wrap\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.deepEqual(values, ['wrap'], `.approval-actions rule ${i + 1} must declare flex-wrap: wrap and nothing else, or the reason input and the two buttons cannot share a narrow card; it declared ${JSON.stringify(values)}`);
  });

  const inputs = [...css.matchAll(/\.approval-actions input\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(inputs.length > 0, 'src/web/styles.css styles the approval reason input');
  inputs.forEach((body, i) => {
    const widths = [...body.matchAll(/min-width\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.deepEqual(widths.length, 1, `the reason input rule ${i + 1} declares exactly one min-width, or which one wins is a matter of order; it declared ${JSON.stringify(widths)}`);
    const floor = /^(\d+(?:\.\d+)?)(ch|rem|px)$/.exec(widths[0]);
    assert.ok(floor, `the reason input rule ${i + 1} floors the field at a readable width in ch, rem or px, not at a keyword or a percentage it cannot be measured against; it declared ${JSON.stringify(widths[0])}`);
    assert.ok(Number(floor[1]) >= 12, `the reason input rule ${i + 1} floors the field at 12 characters or more, or it collapses to six characters of what a human is typing: at a 414px viewport min-width: 0 measured 59px against this rule's 16ch; it declared ${JSON.stringify(widths[0])}`);
  });

  // The render is what makes the two pins facts about the page rather than
  // about the file: until this, no test had ever rendered an approval card.
  const html = await renderPage('/approvals', { repositories: pendingApprovalRepos('pages-approval-actions-') });
  assert.match(html, /<li class="approval-card"[^>]*>/, 'a pending approval renders the card the pins above are about');
  const row = /<form class="approval-actions"[\s\S]*?<\/form>/.exec(html)?.[0];
  assert.ok(row, 'and the action row inside it');
  assert.equal((row.match(/<button /g) ?? []).length, 2, 'the row holds the Approve and Reject buttons the flex-wrap pin is about');
  assert.match(row, /<input id="reason-/, 'and the reason input the min-width pin is about');
});

// #71 BUG-2: the same free-text class of defect on a fifth surface. The wrap
// rule is scoped to four server-rendered card lists, and the journal decision
// drawer renders the same stored free text — evidence_refs, memory_refs,
// policy_decision_id, worst_reasonable_case — by a different route, client.js
// filling #journal-drawer-body from GET /v1/decisions/:id. Nothing rendered it
// in any test, so nothing measured it: with 120-character unbreakable values
// the body laid out 1229px inside 271px at a 320px viewport, and the page only
// stayed the right width because #journal-drawer is position: fixed and so is
// left out of document scroll width. The text was reachable by scrolling the
// drawer sideways, which its overflow-y: auto makes overflow-x: auto.
//
// Unlike the card rule this one cannot be cross-checked against rendered
// markup: the drawer body is empty in the server's HTML by design, so there is
// no render in which the selector is known to match. That gap is the reason
// the pin is a declaration pin and is worth stating rather than hiding.
test('the journal decision drawer wraps the stored free text it is filled with', () => {
  const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');
  const bodies = [...css.matchAll(/\.journal-drawer-body\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(bodies.length > 0, 'src/web/styles.css defines a .journal-drawer-body rule');
  bodies.forEach((body, i) => {
    const values = [...body.matchAll(/overflow-wrap\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.deepEqual(values, ['anywhere'],
      `.journal-drawer-body rule ${i + 1} declares overflow-wrap: anywhere and nothing else, or a decision's stored refs scroll the drawer sideways instead of wrapping inside it: with 120-character unbreakable values the body measured 1229px of scrollWidth against 271px of clientWidth at a 320px viewport; it declared ${JSON.stringify(values)}`);
  });
});

// #71 finding 6: the header shows tenants.list()[0].name, and src/api/routes.js
// auto-creates an unknown tenant with name = the request's tenant_id, so that
// name is the request's free text verbatim. .header-status is a flex row and the
// span's automatic minimum floored the header at the whole token — 1495px of
// scrollWidth at every width from 320 to 414. Not decoration, and the render
// below is what makes the selector a fact about the page.
test('the header wraps a tenant name as long as the id that created it', async () => {
  const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');
  const names = [...css.matchAll(/\.tenant-name\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(names.length > 0, 'src/web/styles.css defines a .tenant-name rule');
  names.forEach((body, i) => {
    const values = [...body.matchAll(/overflow-wrap\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.deepEqual(values, ['anywhere'], `.tenant-name rule ${i + 1} must declare overflow-wrap: anywhere and nothing else; it declared ${JSON.stringify(values)}`);
  });

  const long = `tenant_${'a'.repeat(130)}`;
  const repos = freshRepos();
  repos.tenants.create({ id: long, name: long, currency: 'INR' });
  const html = await renderPage('/', { repositories: repos });
  const shown = /data-testid="tenant-name">([^<]*)</.exec(html)?.[1];
  assert.equal(shown, long, 'the header renders the whole tenant name; it wraps, it is not truncated');
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
    // Cardinality is not the claim. An equal count is satisfied just as well by
    // an empty region sitting beside a bare table — and a bare table that
    // nothing can scroll to is exactly what the keyboard contract below is
    // about — so containment is asserted directly.
    const wrapped = html.match(/<div class="table-scroll"[^>]*>\s*<table[\s>]/g) ?? [];
    assert.equal(wrappers.length, tables.length, `${where}: every table has a region, and nothing else does`);
    assert.equal(wrapped.length, tables.length,
      `${where}: every table opens inside a region — an equal count of the two is satisfied just as well by an empty region beside a bare table, and a bare table is exactly what the keyboard contract below is about`);

    labels[where] = [];
    for (const [i, tag] of wrappers.entries()) {
      const named = /\baria-label="([^"]*)"/.exec(tag);
      assert.ok(named, `${where}: region ${i + 1} of ${wrappers.length} carries an aria-label, so it has an accessible name`);
      const label = named[1];
      labels[where].push(label);
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
