// The shared search interface (TR-17 Layer 2, spec §5.1): business logic
// never imports a vendor — it imports runSearch() and gets a provider
// injected at construction, so a vendor swap is a constructor argument
// (IAC-1). Both fake adapters implement the identical interface with
// deterministic fixtures, sorted by url, and no request ever leaves the
// process.

import { createHash } from 'node:crypto';

export const SEARCH_ERROR_CODES = Object.freeze({
  BAD_QUERY: 'SEARCH_BAD_QUERY',
});

export function searchError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** The canonical content-hash of a result (16 hex chars of sha-256), shared
 * with the mesh Layer 3 dedupe so both layers hash identically. */
export function contentHashOf(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * The one import business logic uses: hand it a provider and the search
 * arguments, and the vendor never changes a caller. Rejects an empty
 * (non-string or all-whitespace) query with SEARCH_BAD_QUERY before the
 * provider is touched, so the error is stable across vendors.
 */
export function runSearch(searchProvider, { query, filters = {}, recency = null, domains = null } = {}) {
  if (!nonEmptyString(query) || query.trim().length === 0) {
    throw searchError(SEARCH_ERROR_CODES.BAD_QUERY, `query must be a non-empty string, got ${JSON.stringify(query)}`, { field: 'query' });
  }
  return searchProvider.search(query, filters, recency, domains);
}

/**
 * Deterministic by-url sort (spec: every listing orders deterministically),
 * locale-independent string ordering. Returns a new array.
 */
function sortByUrl(results) {
  return [...results].sort((a, b) => {
    if (a.url === b.url) {
      return 0;
    }
    return a.url < b.url ? -1 : 1;
  });
}

// Both fakes stamp the same deterministic retrieved_at, so a test that
// records observations from each vendor sees shapes that differ only by
// the vendor's own urls. Served from fixtures, never the network.
const FAKE_RETRIEVED_AT = '2026-09-25T08:00:00.000Z';

function fakeResult({ url, title, publishedAt, snippet, sourceType }) {
  return {
    url,
    title,
    publishedAt,
    retrievedAt: FAKE_RETRIEVED_AT,
    snippet,
    contentHash: contentHashOf(`${url}\n${title}\n${snippet}`),
    sourceType,
  };
}

/**
 * Fake Tavily-shaped adapter: general web results for the growth-lab query
 * family. The query is matched loosely; anything else returns an empty
 * result set rather than a network call.
 */
export class FakeTavilySearch {
  constructor() {
    this.providerId = 'tavily-fake';
    this.providerVersion = 'tavily-fake/1';
  }

  async search(query, filters = {}, recency = null, domains = null) {
    this.lastQuery = query;
    const results = [
      fakeResult({
        url: 'https://research.example.com/search-cpl-benchmark',
        title: 'Search CPL benchmark by intent',
        publishedAt: '2026-09-01T00:00:00.000Z',
        snippet: 'Brand-search CPL tracks roughly 18% below generic prospecting across audited accounts.',
        sourceType: 'research',
      }),
      fakeResult({
        url: 'https://guide.example.com/exact-intent-conversion',
        title: 'Exact intent queries convert above broad prospecting',
        publishedAt: '2026-08-15T00:00:00.000Z',
        snippet: 'Exact-intent queries convert about 2.1x above broad-prospecting in lead-gen funnels.',
        sourceType: 'research',
      }),
    ].filter((result) => (domains ? domains.includes(new URL(result.url).hostname) : true))
      .filter((result) => (recency ? result.publishedAt >= recency : true));
    return {
      results: sortByUrl(results),
      providerVersion: this.providerVersion,
      query,
      filters,
      recency,
      domains,
    };
  }
}

/**
 * Fake Exa-shaped adapter: neural search over the same two fixture claims,
 * with its own urls. Identical interface, different vendor: the swap case
 * (IAC-1) asserts identical observation shapes across the two.
 */
export class FakeExaSearch {
  constructor() {
    this.providerId = 'exa-fake';
    this.providerVersion = 'exa-fake/1';
  }

  async search(query, filters = {}, recency = null, domains = null) {
    this.lastQuery = query;
    const results = [
      fakeResult({
        url: 'https://vendor-a.example.org/industry-cpl-study',
        title: 'Industry study: branded search efficiency',
        publishedAt: '2026-09-10T00:00:00.000Z',
        snippet: 'Accounts running brand search see qualified CPL near 18% under generic prospecting.',
        sourceType: 'research',
      }),
      fakeResult({
        url: 'https://vendor-a.example.org/intent-vs-broad',
        title: 'Intent match beats broad prospecting',
        publishedAt: '2026-08-20T00:00:00.000Z',
        snippet: 'Exact-intent queries convert 2.1x above broad-prospecting in structured lead funnels.',
        sourceType: 'research',
      }),
    ].filter((result) => (domains ? domains.includes(new URL(result.url).hostname) : true))
      .filter((result) => (recency ? result.publishedAt >= recency : true));
    return {
      results: sortByUrl(results),
      providerVersion: this.providerVersion,
      query,
      filters,
      recency,
      domains,
    };
  }
}
