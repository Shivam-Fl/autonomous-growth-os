// The shared search interface (TR-17 Layer 2, IAC-1): the vendor swap is a
// constructor argument — the same pipeline call over FakeTavilySearch and
// FakeExaSearch yields identical observation shapes with no business-logic
// edit, and an empty query is rejected with a vendor-stable code before any
// provider is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSearch, SEARCH_ERROR_CODES, FakeTavilySearch, FakeExaSearch, contentHashOf } from '../../src/research/search.js';
import { runResearch } from '../../src/research/mesh.js';

const QUESTION = 'how does brand search CPL compare to generic prospecting';

test('runSearch returns the provider response with providerVersion and every arg echoed', async () => {
  const result = await runSearch(new FakeTavilySearch(), {
    query: 'brand search CPL',
    filters: { intent: 'brand' },
    recency: '2026-08-01T00:00:00.000Z',
    domains: ['research.example.com'],
  });
  assert.equal(result.providerVersion, 'tavily-fake/1');
  assert.equal(result.query, 'brand search CPL');
  assert.deepEqual(result.filters, { intent: 'brand' });
  assert.equal(result.recency, '2026-08-01T00:00:00.000Z', 'the recency filter echoes back untouched');
  assert.deepEqual(result.domains, ['research.example.com']);
});

test('an empty query is rejected with SEARCH_BAD_QUERY and never reaches the provider', async () => {
  for (const bad of [null, undefined, '', '   ', '\n\t', 42]) {
    const provider = new FakeTavilySearch();
    // The async wrapper accepts runSearch rejecting or throwing synchronously.
    await assert.rejects(
      async () => runSearch(provider, { query: bad }),
      (error) => {
        assert.equal(error.code, SEARCH_ERROR_CODES.BAD_QUERY);
        assert.equal(error.code, 'SEARCH_BAD_QUERY', 'the stable code survives spelling changes to the enum');
        return true;
      },
      `query ${JSON.stringify(bad)} must be rejected with SEARCH_BAD_QUERY`,
    );
    assert.equal(provider.lastQuery, undefined, 'the provider is never called for a bad query');
  }

  const exa = new FakeExaSearch();
  await assert.rejects(async () => runSearch(exa, { query: '' }), (error) => error.code === SEARCH_ERROR_CODES.BAD_QUERY);
});

test('both fake vendors answer identical interface surfaces and sort their results by url', async () => {
  for (const makeProvider of [FakeTavilySearch, FakeExaSearch]) {
    const provider = new makeProvider();
    assert.equal(typeof provider.search, 'function');
    assert.equal(typeof provider.providerId, 'string');
    assert.equal(typeof provider.providerVersion, 'string');
    const results = provider.results
      ? provider.results
      : (await provider.search(QUESTION)).results;
    // Deterministic by-url ordering, independent of fixture declaration order.
    const sorted = [...results].sort((a, b) => (a.url < b.url ? -1 : 1));
    assert.deepEqual(results, sorted, `${provider.providerId} results come back sorted by url`);
    assert.match(results[0].url, /^https:\/\//);
    for (const result of results) {
      assert.equal(typeof result.title, 'string');
      assert.equal(typeof result.snippet, 'string');
      assert.equal(typeof result.contentHash, 'string');
      assert.match(result.contentHash, /^[0-9a-f]{16}$/, 'contentHash is 16 hex chars');
      assert.match(result.publishedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(result.sourceType, 'research');
    }
  }
});

test('the same result text always hashes to the same contentHash', () => {
  const text = 'identical payload';
  assert.equal(contentHashOf(text), contentHashOf(`${text}`));
  assert.notEqual(contentHashOf(text), contentHashOf('different payload'));
});

/** Run the pipeline once per vendor, no fetcher (Layer 3 unexpired: Layer 2
 * rows flow straight in), and return the comparable observation shape. */
async function observationsFor(searchProvider) {
  const run = await runResearch({ question: QUESTION, searchProvider, nowIso: '2026-09-25T12:00:00.000Z' });
  return run.observations.map((observation) => ({
    state: observation.state,
    tier: observation.tier,
    score: observation.score,
    independence: observation.independence,
    sourceCount: observation.sources.length,
  }));
}

test('vendor swap: building the pipeline with each adapter yields identical observation shapes', async () => {
  const tavily = await observationsFor(new FakeTavilySearch());
  const exa = await observationsFor(new FakeExaSearch());
  assert.ok(tavily.length > 0, 'fixture: each vendor serves claims');
  assert.deepEqual(
    tavily,
    exa,
    'swapping the search adapter changes no claim shape — vendor identity lives behind the interface',
  );
});
