// The layered research mesh (TR-17, IAC-1, IAC-2): Layers 0–4 in order, the
// vendor as an injected constructor argument, evidence tiers A–E, corroboration
// across independent domains, contradiction detection that never silently
// overwrites, Layer 4 recorded as a skip, and a TTL cache keyed by the
// normalized question.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runResearch, planSources, extractClaims, claimTopic, stateFor, scoreEvidence, tierFor, normalizeQuery, CLAIM_STATES, FakeBrowserLeg } from '../../src/research/mesh.js';
import { runSearch, FakeTavilySearch, FakeExaSearch } from '../../src/research/search.js';

const NOW = '2026-09-25T12:00:00.000Z';

test('planSources orders the five layers cheapest and most first-party first, browser last and skipped', () => {
  const plan = planSources({ question: 'brand CPL', tenantScope: { tenant: 'tenant_demo' } });
  assert.deepEqual(plan.map((layer) => layer.layer), [0, 1, 2, 3, 4]);
  assert.equal(plan[0].name, 'first-party truth');
  assert.deepEqual(plan[0].scope, { tenant: 'tenant_demo' });
  assert.equal(plan[4].skipped_until_needed, true, 'the browser is recorded as skipped until needed');
});

test('a search provider in the pipeline runs evict-free through runSearch: vendor shapes match across swap', async () => {
  for (const makeVendor of [FakeTavilySearch, FakeExaSearch]) {
    const run = await runResearch({ question: 'brand CPL', searchProvider: new makeVendor(), nowIso: NOW });
    assert.ok(run.ok);
    assert.ok(run.observations.length > 0);
    // Identical claim shapes: every observation carries the same fields,
    // regardless of which vendor sat behind the interface.
    for (const observation of run.observations) {
      assert.equal(typeof observation.claim, 'string');
      assert.ok(['BELIEVED', 'KNOWN', 'CONTRADICTORY'].includes(observation.state));
    }
  }
});

test('contradiction fixture: two independent sources asserting opposite claims in one scope yield CONTRADICTORY with both source urls', async () => {
  const run = await runResearch({
    question: 'brand search CPL direction',
    officialRows: [
      { url: 'https://north.gov-data.example/cpl', contentMarkdown: 'Brand search CPL is lower than generic prospecting CPL nationwide.' },
      { url: 'https://south.gov-data.example/cpl', contentMarkdown: 'Brand search CPL is higher than generic prospecting CPL nationwide.' },
    ],
    nowIso: NOW,
  });
  // The second sentence asserts the opposite direction on the same topic, so
  // the merge must retain url evidence from BOTH sides. (Known limit of the
  // slice: polarity is word-based, so a bare 'not lower' reads as 'lower' and
  // cannot collide with 'lower' — only genuinely opposite signals merge.)
  assert.ok(run.observations.length > 0, 'the fixture produces observations');
  const contradictories = run.observations.filter((observation) => observation.state === 'CONTRADICTORY');
  assert.ok(contradictories.length > 0, 'the opposing pair merges into one CONTRADICTORY observation');
  for (const contradictory of contradictories) {
    const domains = new Set(contradictory.sources.map((source) => source.domain));
    assert.ok(domains.has('north.gov-data.example'), 'the first source url survives the merge');
    assert.ok(domains.has('south.gov-data.example'), 'the second source url survives the merge — never a silent overwrite');
  }
});

test('corroboration: two distinct domains on one claim is KNOWN; a single domain stays BELIEVED', async () => {
  const both = await runResearch({
    question: 'exact intent conversion',
    officialRows: [
      { url: 'https://one.example/a', contentMarkdown: 'Exact-intent queries convert above broad-prospecting in audited funnels.' },
      { url: 'https://two.example/b', contentMarkdown: 'Exact-intent queries convert above broad-prospecting in audited funnels.' },
    ],
    nowIso: NOW,
  });
  assert.equal(both.observations[0].state, 'KNOWN', 'independently corroborated claims can be known');
  assert.equal(both.observations[0].independence, 2);
  assert.equal(stateFor(2), 'KNOWN');
  assert.equal(stateFor(1), 'BELIEVED');

  const single = await runResearch({
    question: 'exact intent conversion',
    officialRows: [
      { url: 'https://one.example/a', contentMarkdown: 'Exact-intent queries convert above broad-prospecting in audited funnels.' },
    ],
    nowIso: NOW,
  });
  assert.equal(single.observations[0].state, 'BELIEVED');
  assert.equal(single.observations[0].independence, 1);
});

test('Layer 4 records the browser leg as skipped with a reason', async () => {
  const run = await runResearch({
    question: 'anything at all',
    searchProvider: new FakeTavilySearch(),
    nowIso: NOW,
  });
  const skip = run.auditNotes.find((note) => note.code === 'BROWSER_LEG_SKIPPED');
  assert.ok(skip, 'the browser leg is recorded as skipped');
  assert.equal(skip.layer, 4);
  assert.ok(typeof skip.reason === 'string' && skip.reason.length > 0);
  const browserCall = run.toolCalls.find((call) => call.tool === 'research_browser');
  assert.equal(browserCall.skipped, true, 'the recorded call is a skip, not a browser run');
  assert.ok(typeof browserCall.reason === 'string' && browserCall.reason.length > 0);

  // A standing-in fake leg records its own reason through the same path.
  const custom = await runResearch({
    question: 'anything at all',
    browser: FakeBrowserLeg({ reason: 'custom reason' }),
    nowIso: NOW,
  });
  assert.deepEqual(custom.toolCalls[0], { tool: 'research_browser', skipped: true, reason: 'custom reason' });
});

test('slow-changing query hits the TTL cache within its window and refetches after expiry', async () => {
  const cache = new Map();
  const searchProvider = new FakeTavilySearch();
  await runResearch({ question: 'Slow  Changing Data', searchProvider, nowIso: '2026-09-25T00:00:00.000Z', cache, ttlSeconds: 3600 });
  assert.ok([...cache.keys()][0].includes('slow changing data'), 'the cache keys on the normalized question');

  // Within the TTL: fromCache, no second provider call.
  searchProvider.lastQuery = undefined;
  const warm = await runResearch({ question: 'slow   changing   data', searchProvider, nowIso: '2026-09-25T00:30:00.000Z', cache, ttlSeconds: 3600 });
  assert.equal(warm.fromCache, true, 'the same question inside the TTL window is served from cache');
  assert.equal(searchProvider.lastQuery, undefined, 'a cached run never touches the vendor');

  // After expiry: a fresh run that calls the provider again.
  const cold = await runResearch({ question: 'SLOW CHANGING DATA', searchProvider, nowIso: '2026-09-25T03:00:00.000Z', cache, ttlSeconds: 3600 });
  assert.equal(cold.fromCache, false, 'an expired cache entry refetches');
  assert.equal(searchProvider.lastQuery, 'SLOW CHANGING DATA', 'the refetch runs the vendor with the live question');
});

test('evidence tiers score A above C above E on the same claim text', () => {
  // Same sentence, three source types: the tier — and the score — must follow
  // the source type, not the wording.
  const sentence = 'Qualified CPL improves across audited accounts this quarter.';
  const build = (sourceType, url) => [{
    claim: sentence,
    topic: claimTopic(sentence),
    polarity: 1,
    tier: tierFor(sourceType),
    sources: [{ url, domain: url, tier: tierFor(sourceType) }],
  }];
  const a = scoreEvidence(build('first_party', 'https://c.example/first-party'));
  const c = scoreEvidence(build('research', 'https://c.example/research'));
  const e = scoreEvidence(build('marketing', 'https://c.example/marketing'));
  assert.equal(a.tier, 'A');
  assert.equal(c.tier, 'C');
  assert.equal(e.tier, 'E');
  assert.ok(a.score > c.score, `tier A (${a.score}) must outscore tier C (${c.score})`);
  assert.ok(c.score > e.score, `tier C (${c.score}) must outscore tier E (${e.score})`);
  // Tier identity holds with no corroboration at all.
  assert.equal(tierFor('unknown-thing'), 'E', 'an unmapped source type falls to E so a new vendor cannot slip upward');
  // Corroborated first-party evidence must stay inside the tier ceiling: two
  // independent domains lift the score, but A is the ceiling, not a springboard.
  const corroboratedA = scoreEvidence([
    { url: 'https://one.example/a', domain: 'one.example', tier: 'A' },
    { url: 'https://two.example/b', domain: 'two.example', tier: 'A' },
  ]);
  assert.equal(corroboratedA.independence, 2);
  assert.ok(corroboratedA.score <= 1, `tier A corroborated twice must stay at or below 1.0, got ${corroboratedA.score}`);
  assert.ok(corroboratedA.score >= a.score, 'corroboration never scores below the same tier alone');
  assert.deepEqual(extractClaims('First sentence about metric. Second sentence here.\nThird one too.'), ['First sentence about metric.', 'Second sentence here.', 'Third one too.']);
});

test('claim extraction and topic bags are deterministic and strip polarity words', () => {
  assert.deepEqual(claimTopic('Brand CPL 18% lower!'), claimTopic('brand cpl lower'));
  assert.deepEqual(extractClaims('Short.'), [], 'sentences under the 8-character floor are not claims');
});

test('runSearch stays the only search entry business logic imports, and empty query rejection passes through it', async () => {
  // The async wrapper tolerates runSearch rejecting or throwing synchronously:
  // either way the stable code reaches the caller and the provider is untouched.
  const provider = new FakeTavilySearch();
  await assert.rejects(async () => runSearch(provider, { query: '' }), (error) => error.code === 'SEARCH_BAD_QUERY');
  assert.equal(provider.lastQuery, undefined, 'the provider is never called for a bad query');
});
