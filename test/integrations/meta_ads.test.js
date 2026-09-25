// Adapter contract suite (TR-13, AC-2/AC-4): the identical read sequence runs
// against the fake provider and the live provider over an injected stub
// transport serving canned v26.0 Graph-shaped JSON. One runner drives both
// legs with zero business-logic changes between runs, and no request ever
// leaves the process: the real global fetch is replaced with a tripwire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  GRAPH_API_VERSION,
  META_ERROR_CODES,
  READ_METHODS,
  sortById,
  validateAd,
  validateAdSet,
  validateCampaign,
  validateInsight,
} from '../../src/integrations/meta_ads/index.js';
import { FIXTURE_SYNCED_AT, FakeMetaAdsProvider, implementsReadInterface } from '../../src/integrations/meta_ads/fake.js';
import { LiveMetaAdsProvider } from '../../src/integrations/meta_ads/live.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(HERE, '..', '..', 'src', 'integrations', 'meta_ads');
const ACCOUNT = '1234567890';
const GRAPH_HOST = 'https://graph.facebook.com';
const TEST_TOKEN = 'test-access-token-not-a-secret-but-treated-like-one';

// Canned v26.0 Graph-shaped responses. Arrays are deliberately not id-ordered:
// both providers must sort on the way out for the contract to hold. The live
// campaign leg spans two pages so pagination is first-class (ADR-0004).
const CAMPAIGN_PAGE_ONE = {
  data: [
    { id: 'campaign_002', name: 'Generic prospecting — search', status: 'ACTIVE', objective: 'OUTCOME_LEADS' },
    { id: 'campaign_001', name: 'Search — brand defence', status: 'ACTIVE', objective: 'OUTCOME_LEADS' },
  ],
  paging: {
    cursors: { before: 'before-cursor', after: 'after-cursor' },
    next: `${GRAPH_HOST}/${GRAPH_API_VERSION}/act_${ACCOUNT}/campaigns?fields=id%2Cname%2Cstatus%2Cobjective&limit=100&after=after-cursor`,
  },
};
const CAMPAIGN_PAGE_TWO = {
  data: [
    { id: 'campaign_003', name: 'Retargeting — funnel revisit', status: 'PAUSED', objective: 'OUTCOME_TRAFFIC' },
  ],
};
const AD_SET_PAGE = {
  data: [
    { id: 'adset_002', campaign_id: 'campaign_002', name: 'Prospecting · broad', status: 'ACTIVE', daily_budget: '100000' },
    { id: 'adset_001', campaign_id: 'campaign_001', name: 'Search · exact', status: 'ACTIVE', daily_budget: '50000' },
    { id: 'adset_003', campaign_id: 'campaign_003', name: 'Retargeting · 30 days', status: 'PAUSED', daily_budget: '25000' },
  ],
};
const AD_PAGE = {
  data: [
    { id: 'ad_002', adset_id: 'adset_002', name: 'Prospecting — RSA A', status: 'ACTIVE' },
    { id: 'ad_001', adset_id: 'adset_001', name: 'Brand — RSA A', status: 'ACTIVE' },
    { id: 'ad_003', adset_id: 'adset_003', name: 'Retargeting — static A', status: 'PAUSED' },
  ],
};
const INSIGHT_PAGE = {
  data: [
    { campaign_id: 'campaign_002', spend: '8750.00', impressions: '210000', clicks: '2100', date_start: '2026-08-28', date_stop: '2026-09-24' },
    { campaign_id: 'campaign_001', spend: '4000.00', impressions: '90000', clicks: '1200', date_start: '2026-08-28', date_stop: '2026-09-24' },
    { campaign_id: 'campaign_003', spend: '1250.00', impressions: '30000', clicks: '300', date_start: '2026-08-28', date_stop: '2026-09-24' },
  ],
};

const GRAPH_ROUTES = [
  [(parsed) => parsed.pathname === `/${GRAPH_API_VERSION}/act_${ACCOUNT}/campaigns` && !parsed.searchParams.has('after'), () => jsonResponse(200, CAMPAIGN_PAGE_ONE)],
  [(parsed) => parsed.pathname === `/${GRAPH_API_VERSION}/act_${ACCOUNT}/campaigns`, () => jsonResponse(200, CAMPAIGN_PAGE_TWO)],
  [(parsed) => parsed.pathname === `/${GRAPH_API_VERSION}/act_${ACCOUNT}/adsets`, () => jsonResponse(200, AD_SET_PAGE)],
  [(parsed) => parsed.pathname === `/${GRAPH_API_VERSION}/act_${ACCOUNT}/ads`, () => jsonResponse(200, AD_PAGE)],
  [(parsed) => parsed.pathname === `/${GRAPH_API_VERSION}/act_${ACCOUNT}/insights`, () => jsonResponse(200, INSIGHT_PAGE)],
];

const GRAPH_ERROR_BODY = {
  error: {
    message: '(#613) Calls to this API have exceeded the rate limit.',
    code: 613,
    error_subcode: 2446078,
  },
};

function jsonResponse(status, body) {
  return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

function graphStub(routes, recorded) {
  return async (url, init) => {
    recorded.urls.push(url);
    recorded.headers.push(init?.headers ?? {});
    const parsed = new URL(url);
    if (parsed.origin !== GRAPH_HOST) {
      throw new Error(`stub only serves the Graph host, got ${url}`);
    }
    const route = routes.find(([matches]) => matches(parsed));
    if (!route) {
      throw new Error(`stub has no canned response for ${url}`);
    }
    return route[1](parsed);
  };
}

function singleStatusStub(status, body) {
  return graphStub([[(parsed) => true, () => jsonResponse(status, body)]], { urls: [], headers: [] });
}

function liveProvider(fetchImpl) {
  return new LiveMetaAdsProvider({ token: TEST_TOKEN, adAccountId: ACCOUNT, fetchImpl });
}

// The shared contract: identical for the fake leg and the live leg, which is
// what "zero business-logic changes between runs" means here.
const CONTRACT = [
  ['campaigns', 'listCampaigns', validateCampaign],
  ['adSets', 'listAdSets', validateAdSet],
  ['ads', 'listAds', validateAd],
  ['insights', 'getInsights', validateInsight],
];

async function runContract(provider, label) {
  const rowsByCollection = {};
  for (const [collection, method, validate] of CONTRACT) {
    assert.equal(typeof provider[method], 'function', `${label} implements ${method}`);
    const result = await provider[method]();
    assert.ok(result.ok, `${label}: ${method} succeeds (${result.error?.message ?? ''})`);
    assert.equal(result.data.length, 3, `${label}: ${method} returns the three fixture rows`);
    for (const row of result.data) {
      const checked = validate(row);
      assert.ok(checked.ok, `${label}: ${method} row satisfies the typed shape (${checked.error?.message ?? ''})`);
    }
    const ids = result.data.map((row) => row.id);
    assert.deepEqual(ids, [...ids].sort(), `${label}: ${method} rows are deterministically id-sorted`);
    rowsByCollection[collection] = result.data;
  }
  return rowsByCollection;
}

test('GRAPH_API_VERSION is the ADR-0004 pin, asserted by value, and defined exactly once', () => {
  assert.equal(GRAPH_API_VERSION, 'v26.0');
  const sources = ['index.js', 'fake.js', 'live.js'].map((name) => readFileSync(join(SOURCE_DIR, name), 'utf8'));
  const occurrences = sources.map((source) => [...source.matchAll(/v26\.0/g)].length);
  assert.equal(occurrences[0], 1, 'the version lives in the contract module');
  assert.deepEqual(occurrences.slice(1), [0, 0], 'no provider file hardcodes the version');
});

test('both providers implement every method of the typed read interface', () => {
  assert.deepEqual([...READ_METHODS], ['listCampaigns', 'listAdSets', 'listAds', 'getInsights']);
  const fake = new FakeMetaAdsProvider();
  const live = new LiveMetaAdsProvider({ token: TEST_TOKEN, adAccountId: ACCOUNT, fetchImpl: async () => jsonResponse(200, { data: [] }) });
  assert.ok(implementsReadInterface(fake), 'the fake implements the full interface');
  assert.ok(implementsReadInterface(live), 'the live implements the full interface');
  for (const method of READ_METHODS) {
    assert.equal(typeof fake[method], 'function', `fake implements ${method}`);
    assert.equal(typeof live[method], 'function', `live implements ${method}`);
  }
});

test('the contract reads run identically against the fake and the stubbed-transport live provider', async () => {
  const fakeRows = await runContract(new FakeMetaAdsProvider(), 'fake');

  const recorded = { urls: [], headers: [] };
  const liveRows = await runContract(liveProvider(graphStub(GRAPH_ROUTES, recorded)), 'live');

  for (const [collection] of CONTRACT) {
    assert.deepEqual(
      liveRows[collection],
      fakeRows[collection],
      `${collection}: the live provider maps the Graph payload to exactly the rows the fake emits`,
    );
  }
});

test('the live leg touches nothing but the injected transport: zero network leaves the process', async () => {
  const realFetch = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = async () => {
    globalCalls += 1;
    throw new Error('the real network is off limits in tests');
  };
  try {
    const recorded = { urls: [], headers: [] };
    const rows = await runContract(liveProvider(graphStub(GRAPH_ROUTES, recorded)), 'live');
    assert.ok(Object.keys(rows).length > 0, 'fixture: the contract produced rows');
    assert.equal(globalCalls, 0, 'the real global fetch was never called');
    assert.ok(recorded.urls.length >= 5, 'fixture: the stub transport served every request');
    for (const url of recorded.urls) {
      assert.equal(new URL(url).origin, GRAPH_HOST, 'no request pointed anywhere but the pinned Graph host');
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('every live request URL carries the pinned version as a path segment', async () => {
  const recorded = { urls: [], headers: [] };
  await runContract(liveProvider(graphStub(GRAPH_ROUTES, recorded)), 'live');
  for (const url of recorded.urls) {
    assert.ok(url.includes(`/${GRAPH_API_VERSION}/`), `every request interpolates the pinned version: ${url}`);
  }
});

test('quota exhaustion and revoked permission surface as named typed errors on both providers', async () => {
  const cases = [
    ['quota', META_ERROR_CODES.QUOTA, true, 429],
    ['revoked', META_ERROR_CODES.PERMISSION, false, 403],
  ];
  for (const [mode, code, retryable, httpStatus] of cases) {
    const fake = await new FakeMetaAdsProvider({ failureMode: mode }).listCampaigns();
    assert.equal(fake.ok, false, `fake ${mode}: the read fails`);
    assert.equal(fake.error.code, code);
    assert.equal(fake.error.retryable, retryable);
    assert.deepEqual(Object.keys(fake.error).sort(), ['code', 'details', 'message', 'retryable'], 'the error is the typed envelope');

    const live = await liveProvider(singleStatusStub(httpStatus, GRAPH_ERROR_BODY)).listCampaigns();
    assert.equal(live.ok, false, `live ${mode}: the read fails`);
    assert.equal(live.error.code, code);
    assert.equal(live.error.retryable, retryable);
    assert.equal(live.error.details.status, httpStatus);
    assert.equal(live.error.details.graph_message, GRAPH_ERROR_BODY.error.message, 'the provider message is carried, not thrown');
    assert.deepEqual(Object.keys(live.error).sort(), ['code', 'details', 'message', 'retryable'], 'the error is the typed envelope');
  }
});

test('the live provider without META_ADS_ACCESS_TOKEN returns META_NOT_CONFIGURED and never calls the transport', async () => {
  const previous = {
    token: process.env.META_ADS_ACCESS_TOKEN,
    account: process.env.META_AD_ACCOUNT_ID,
  };
  delete process.env.META_ADS_ACCESS_TOKEN;
  delete process.env.META_AD_ACCOUNT_ID;
  try {
    let transportCalls = 0;
    const tripwire = async () => {
      transportCalls += 1;
      throw new Error('the unconfigured provider must not reach the transport');
    };
    const live = new LiveMetaAdsProvider({ fetchImpl: tripwire });
    for (const method of READ_METHODS) {
      const result = await live[method]();
      assert.equal(result.ok, false, `${method} refuses without credentials`);
      assert.equal(result.error.code, META_ERROR_CODES.NOT_CONFIGURED);
      assert.equal(result.error.details.credential, 'META_ADS_ACCESS_TOKEN');
      assert.equal(result.error.retryable, false);
    }
    assert.equal(transportCalls, 0, 'the transport was never touched');
  } finally {
    if (previous.token !== undefined) {
      process.env.META_ADS_ACCESS_TOKEN = previous.token;
    }
    if (previous.account !== undefined) {
      process.env.META_AD_ACCOUNT_ID = previous.account;
    }
  }
});

test('a token without an ad account is also refused as META_NOT_CONFIGURED', async () => {
  const live = new LiveMetaAdsProvider({ token: TEST_TOKEN, fetchImpl: async () => { throw new Error('must not be called'); } });
  const result = await live.listCampaigns();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, META_ERROR_CODES.NOT_CONFIGURED);
  assert.equal(result.error.details.credential, 'META_AD_ACCOUNT_ID');
});

test('credentials resolve from the injected environment when not passed explicitly', async () => {
  const recorded = { urls: [], headers: [] };
  const live = new LiveMetaAdsProvider({
    env: { META_ADS_ACCESS_TOKEN: TEST_TOKEN, META_AD_ACCOUNT_ID: ACCOUNT },
    fetchImpl: graphStub([[() => true, () => jsonResponse(200, CAMPAIGN_PAGE_TWO)]], recorded),
  });
  const result = await live.listCampaigns();
  assert.ok(result.ok, `env-configured credentials are honoured (${result.error?.message ?? ''})`);
  assert.equal(result.data.length, 1);
});

test('provider payloads are boundary-validated by parsing, never cast into rows', async () => {
  const cases = [
    // A 200 whose body is not JSON is a transport violation: retrying may help.
    ['a non-JSON body', 'listCampaigns', '<html>oops</html>', 'not JSON', true],
    ['JSON that is not an object', 'listCampaigns', '"just a string"', 'non-array data field', false],
    ['a data field that is not an array', 'listCampaigns', { data: { id: 'campaign_001' } }, 'non-array data field', false],
    ['a row with a wrong-typed field', 'listCampaigns', { data: [{ id: 7, name: 'Search', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }] }, 'id is missing or has the wrong type', false],
    ['a row missing a field', 'listCampaigns', { data: [{ id: 'campaign_001', name: 'Search', status: 'ACTIVE' }] }, 'objective is missing or has the wrong type', false],
    ['an unparseable money field', 'getInsights', { data: [{ campaign_id: 'campaign_001', spend: '4,000.00', impressions: '900', clicks: '12' }] }, 'spend is not a parseable value', false],
  ];
  for (const [label, method, body, expectedFragment, retryable] of cases) {
    const result = await liveProvider(singleStatusStub(200, body))[method]();
    assert.equal(result.ok, false, `${label}: the read fails`);
    assert.equal(result.error.code, META_ERROR_CODES.NETWORK, `${label}: the failure is a typed network error`);
    assert.equal(result.error.retryable, retryable, `${label}: retryable flag`);
    assert.ok(
      result.error.message.includes(expectedFragment) || JSON.stringify(result.error.details).includes(expectedFragment),
      `${label}: the error names what was rejected (${result.error.message})`,
    );
  }
});

test('pagination follows Graph next links within the pinned version and a bounded page count', async () => {
  // The main contract leg already spans two campaign pages; assert the paging
  // URL and the bounded-cap path explicitly.
  const recorded = { urls: [], headers: [] };
  await runContract(liveProvider(graphStub(GRAPH_ROUTES, recorded)), 'live');
  const pagedUrls = recorded.urls.filter((url) => url.includes('after='));
  assert.equal(pagedUrls.length, 1, 'fixture: exactly one request followed the Graph next link');
  assert.ok(pagedUrls[0].includes(`/${GRAPH_API_VERSION}/`), 'the followed page keeps the pinned version');

  let runawayRequests = 0;
  const runaway = graphStub([[(parsed) => parsed.pathname.endsWith('/campaigns'), () => {
    runawayRequests += 1;
    return jsonResponse(200, { data: [{ id: `campaign_${runawayRequests}`, name: 'Endless', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }], paging: { next: `${GRAPH_HOST}/${GRAPH_API_VERSION}/act_${ACCOUNT}/campaigns?after=${runawayRequests}` } });
  }]], { urls: [], headers: [] });
  const capped = await liveProvider(runaway).listCampaigns();
  assert.equal(capped.ok, false, 'unbounded pagination is refused');
  assert.equal(capped.error.code, META_ERROR_CODES.NETWORK);
  assert.ok(capped.error.message.includes('pagination exceeded'), 'the cap is named');
  assert.ok(runawayRequests <= 21, 'the cap bounds the request count');
});

test('a paging.next off the Graph host is refused, never followed', async () => {
  const recorded = { urls: [], headers: [] };
  const routes = [[
    () => true,
    () => jsonResponse(200, {
      data: [{ id: 'campaign_001', name: 'Search', status: 'ACTIVE', objective: 'OUTCOME_LEADS' }],
      paging: { next: 'https://evil.example.com/v26.0/campaigns?after=x' },
    }),
  ]];
  const result = await liveProvider(graphStub(routes, recorded)).listCampaigns();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, META_ERROR_CODES.NETWORK);
  assert.ok(result.error.message.includes('off the Graph host'));
  assert.ok(!recorded.urls.some((url) => url.includes('evil.example.com')), 'the foreign link was never requested');
});

test('secrets never leak: the token travels only in the Authorization header', async () => {
  const token = 'EAAsuper-secret-test-token';
  const recorded = { urls: [], headers: [] };
  const live = new LiveMetaAdsProvider({ token, adAccountId: ACCOUNT, fetchImpl: graphStub(GRAPH_ROUTES, recorded) });
  await runContract(live, 'live');
  assert.ok(recorded.headers.length > 0, 'fixture: requests were recorded');
  for (const headers of recorded.headers) {
    assert.equal(headers.Authorization, `Bearer ${token}`, 'the token authenticates every request');
  }
  for (const url of recorded.urls) {
    assert.ok(!url.includes(token), 'no URL ever carries the token');
  }

  const denied = await liveProvider(singleStatusStub(403, GRAPH_ERROR_BODY)).listAdSets();
  assert.equal(denied.ok, false);
  assert.ok(!JSON.stringify(denied.error).includes(token), 'error envelopes never carry the token');
  const broken = await liveProvider(async () => { throw new TypeError('fetch failed'); }).getInsights();
  assert.equal(broken.ok, false);
  assert.ok(!JSON.stringify(broken.error).includes(token), 'transport failures never carry the token');
});

test('the fake provider sorts idempotently and exposes the last-good snapshot', async () => {
  const provider = new FakeMetaAdsProvider();
  const first = await provider.listAdSets();
  const second = await provider.listAdSets();
  assert.deepEqual(first, second, 'reads are deterministic');
  assert.deepEqual(first.data.map((row) => row.id), [...first.data.map((row) => row.id)].sort(), 'output is id-sorted');

  const snapshot = provider.lastGood();
  assert.equal(snapshot.synced_at, FIXTURE_SYNCED_AT);
  assert.match(snapshot.synced_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'the sync timestamp is UTC ISO-8601');
  for (const collection of ['campaigns', 'adSets', 'ads', 'insights']) {
    const ids = snapshot[collection].map((row) => row.id);
    assert.deepEqual(ids, [...ids].sort(), `the snapshot's ${collection} are id-sorted`);
  }
});

test('the fake provider rejects an unknown failure mode', () => {
  assert.throws(() => new FakeMetaAdsProvider({ failureMode: 'banana' }), /unknown Meta fake failure mode/);
});

test('sortById returns a new id-ordered array and never reorders its input', () => {
  const input = [{ id: 'campaign_002' }, { id: 'campaign_001' }, { id: 'campaign_003' }];
  const sorted = sortById(input);
  assert.deepEqual(sorted.map((row) => row.id), ['campaign_001', 'campaign_002', 'campaign_003']);
  assert.deepEqual(input.map((row) => row.id), ['campaign_002', 'campaign_001', 'campaign_003'], 'the input array is untouched');
  assert.notEqual(sorted, input, 'a new array is returned');
});

test('row validators reject non-objects and wrong types without casting', () => {
  assert.equal(validateCampaign('campaign_001').ok, false);
  assert.equal(validateCampaign(null).ok, false);
  assert.equal(validateCampaign({ id: 'c1', name: 'n', status: 'ACTIVE', objective: 'OUTCOME_LEADS', extra: 'ignored' }).ok, true, 'extra fields are ignored, not rejected');
  assert.equal(validateAdSet({ id: 'a1', campaign_id: 'c1', name: 'n', status: 'ACTIVE', daily_budget_micros: 1.5 }).ok, false, 'floats never pass as money');
  assert.equal(validateAdSet({ id: 'a1', campaign_id: 'c1', name: 'n', status: 'ACTIVE', daily_budget_micros: -1 }).ok, false, 'negative money is rejected');
  assert.equal(validateAd({ id: 'd1', ad_set_id: 'a1', name: 'n', status: 'ACTIVE' }).ok, true);
  assert.equal(validateInsight({ id: 'i1', campaign_id: 'c1', spend_micros: 4_000_000_000, impressions: 90_000, clicks: 1_200 }).ok, true);
  assert.equal(validateInsight({ id: 'i1', campaign_id: 'c1', spend_micros: '4000', impressions: 90_000, clicks: 1_200 }).ok, false, 'money arrives as an integer or not at all');
});
