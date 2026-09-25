// Live Meta provider (TR-13, ADR-0004): the same typed read interface as the
// fake, over direct HTTPS against the pinned Graph version. The transport is
// injectable so the contract suite runs with zero network; provider specifics
// (field mapping, pagination, status mapping) stay in this file. Secrets are
// never logged and never placed in a URL — the access token travels only in
// the Authorization header, and error envelopes carry status and provider
// message, never credentials.

import {
  GRAPH_API_VERSION,
  META_ERROR_CODES,
  credentialGate,
  insightRowId,
  metaError,
  readError,
  readOk,
  sortById,
  validateAd,
  validateAdSet,
  validateCampaign,
  validateInsight,
} from './index.js';

const GRAPH_BASE_URL = 'https://graph.facebook.com';
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

// Graph paths address the ad account as act_<id>; accept the id with or
// without the prefix so either configuration convention works.
function accountPath(adAccountId) {
  return `act_${String(adAccountId).replace(/^act_/, '')}`;
}

/**
 * Graph encodes spend as a decimal string in the account currency's major
 * units ("4000.00"). Integer math only: money never passes through a float.
 * Returns micros, or null when the value is not a parseable amount.
 */
function parseMajorUnitMicros(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) {
    return null;
  }
  const micros = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}

// Graph encodes daily_budget in the account currency's minor unit. For the
// hundredth-based currencies this slice targets (INR, USD) one minor unit is
// 10^4 micros; currencies without minor units need a per-account exponent
// before any live read.
const MINOR_UNITS_PER_MICRO = 10_000n;

function parseMinorUnitMicros(value) {
  const digits = typeof value === 'string' && /^\d+$/.test(value)
    ? value
    : Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (digits === null) {
    return null;
  }
  const micros = BigInt(digits) * MINOR_UNITS_PER_MICRO;
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}

function parseCount(value) {
  if (Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function boundaryError(field) {
  return metaError(
    META_ERROR_CODES.NETWORK,
    `provider payload rejected: ${field} is not a parseable value`,
    { details: { field }, retryable: false },
  );
}

// Graph field -> typed row. Each mapper picks the documented fields and runs
// the checked parses; anything unexpected is rejected by the shared row
// validators in index.js rather than passed through as a half-formed row.
function mapCampaign(raw) {
  return readOk({
    id: raw?.id,
    name: raw?.name,
    status: raw?.status,
    objective: raw?.objective,
  });
}

function mapAdSet(raw) {
  const dailyBudgetMicros = parseMinorUnitMicros(raw?.daily_budget);
  if (dailyBudgetMicros === null) {
    return readError(boundaryError('daily_budget'));
  }
  return readOk({
    id: raw?.id,
    campaign_id: raw?.campaign_id,
    name: raw?.name,
    status: raw?.status,
    daily_budget_micros: dailyBudgetMicros,
  });
}

// Graph spells the ad's parent ad set `adset_id`; the typed row shape is
// `ad_set_id`, matching `campaign_id` in the other rows.
function mapAd(raw) {
  return readOk({
    id: raw?.id,
    ad_set_id: raw?.adset_id,
    name: raw?.name,
    status: raw?.status,
  });
}

function mapInsight(raw) {
  const spendMicros = parseMajorUnitMicros(raw?.spend);
  if (spendMicros === null) {
    return readError(boundaryError('spend'));
  }
  const impressions = parseCount(raw?.impressions);
  if (impressions === null) {
    return readError(boundaryError('impressions'));
  }
  const clicks = parseCount(raw?.clicks);
  if (clicks === null) {
    return readError(boundaryError('clicks'));
  }
  return readOk({
    id: insightRowId(raw?.campaign_id),
    campaign_id: raw?.campaign_id,
    spend_micros: spendMicros,
    impressions,
    clicks,
  });
}

const ENDPOINTS = {
  listCampaigns: {
    collection: 'campaigns',
    path: 'campaigns',
    fields: 'id,name,status,objective',
    map: mapCampaign,
    validate: validateCampaign,
  },
  listAdSets: {
    collection: 'adSets',
    path: 'adsets',
    fields: 'id,name,campaign_id,status,daily_budget',
    map: mapAdSet,
    validate: validateAdSet,
  },
  listAds: {
    collection: 'ads',
    path: 'ads',
    fields: 'id,adset_id,name,status',
    map: mapAd,
    validate: validateAd,
  },
  getInsights: {
    collection: 'insights',
    path: 'insights',
    fields: 'campaign_id,spend,impressions,clicks',
    params: { level: 'campaign', date_preset: 'last_28d' },
    map: mapInsight,
    validate: validateInsight,
  },
};

function graphErrorMessage(bodyText) {
  try {
    const message = JSON.parse(bodyText)?.error?.message;
    return typeof message === 'string' ? message : null;
  } catch {
    return null;
  }
}

function statusError(status, bodyText, url) {
  const graphMessage = graphErrorMessage(bodyText);
  const details = { status, graph_message: graphMessage, url };
  if (status === 429) {
    return metaError(META_ERROR_CODES.QUOTA, 'Meta Ads read quota is exhausted (HTTP 429)', { details, retryable: true });
  }
  if (status === 403) {
    return metaError(META_ERROR_CODES.PERMISSION, 'Meta Ads read access was refused for this account (HTTP 403)', { details, retryable: false });
  }
  return metaError(
    META_ERROR_CODES.NETWORK,
    `Meta request failed with HTTP ${status}`,
    { details, retryable: status >= 500 },
  );
}

async function requestJson(transport, url, token) {
  let response;
  try {
    response = await transport(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch (error) {
    return readError(metaError(
      META_ERROR_CODES.NETWORK,
      `Meta request failed before a response arrived (${error?.name ?? 'Error'})`,
      { details: { url, transport_error: error?.message ?? null }, retryable: true },
    ));
  }

  const status = response?.status;
  if (!Number.isInteger(status)) {
    return readError(metaError(
      META_ERROR_CODES.NETWORK,
      'Meta transport returned no HTTP status',
      { details: { url }, retryable: true },
    ));
  }

  let bodyText;
  try {
    bodyText = await response.text();
  } catch (error) {
    return readError(metaError(
      META_ERROR_CODES.NETWORK,
      `Meta response body could not be read (${error?.name ?? 'Error'})`,
      { details: { url, transport_error: error?.message ?? null }, retryable: true },
    ));
  }

  if (status < 200 || status >= 300) {
    return readError(statusError(status, bodyText, url));
  }

  // Boundary validation starts here: the body is parsed, never cast, and a
  // non-JSON body is a typed failure instead of a thrown SyntaxError.
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return readError(metaError(
      META_ERROR_CODES.NETWORK,
      'Meta response body is not JSON',
      { details: { url }, retryable: true },
    ));
  }
  return readOk(parsed);
}

// Graph paginates with an absolute next URL. Only same-host links are
// followed: a provider response cannot point the bearer token at another
// host, and pagination is bounded so a hostile or broken link cannot spin.
function followPaging(paging) {
  const next = paging?.next;
  if (next === undefined || next === null) {
    return readOk(null);
  }
  if (typeof next !== 'string') {
    return readError(metaError(
      META_ERROR_CODES.NETWORK,
      'provider returned a non-string paging.next',
      { details: { field: 'paging.next' }, retryable: false },
    ));
  }
  try {
    if (new URL(next).origin !== GRAPH_BASE_URL) {
      return readError(metaError(
        META_ERROR_CODES.NETWORK,
        'refusing to follow a paging.next off the Graph host',
        { details: { field: 'paging.next' }, retryable: false },
      ));
    }
  } catch {
    return readError(metaError(
      META_ERROR_CODES.NETWORK,
      'provider returned an unparseable paging.next',
      { details: { field: 'paging.next' }, retryable: false },
    ));
  }
  return readOk(next);
}

export class LiveMetaAdsProvider {
  /**
   * Credentials come from the arguments or the environment; neither is
   * required to construct, but reads refuse with META_NOT_CONFIGURED until
   * both are present, so an unconfigured provider never touches the network.
   */
  constructor({ token, adAccountId, fetchImpl, env = process.env } = {}) {
    this.token = token ?? env?.META_ADS_ACCESS_TOKEN ?? null;
    this.adAccountId = adAccountId ?? env?.META_AD_ACCOUNT_ID ?? null;
    // Resolved per request so a polyfilled global fetch is picked up late.
    this.fetchImpl = fetchImpl ?? null;
  }

  async listCampaigns() {
    return this.#readCollection('listCampaigns');
  }

  async listAdSets() {
    return this.#readCollection('listAdSets');
  }

  async listAds() {
    return this.#readCollection('listAds');
  }

  async getInsights() {
    return this.#readCollection('getInsights');
  }

  async #readCollection(method) {
    const gate = credentialGate({ token: this.token, adAccountId: this.adAccountId });
    if (gate) {
      return readError(gate);
    }
    const endpoint = ENDPOINTS[method];
    const pages = await this.#readPages(endpoint);
    if (!pages.ok) {
      return pages;
    }
    const rows = [];
    for (let index = 0; index < pages.data.length; index += 1) {
      const mapped = endpoint.map(pages.data[index]);
      if (!mapped.ok) {
        return readError(withRowContext(mapped.error, endpoint.collection, index));
      }
      const validated = endpoint.validate(mapped.data);
      if (!validated.ok) {
        return readError(withRowContext(validated.error, endpoint.collection, index));
      }
      rows.push(validated.data);
    }
    return readOk(sortById(rows));
  }

  async #readPages(endpoint) {
    const transport = this.fetchImpl ?? globalThis.fetch;
    const rows = [];
    let url = this.#buildUrl(endpoint);
    let pageCount = 0;
    while (url) {
      pageCount += 1;
      if (pageCount > MAX_PAGES) {
        return readError(metaError(
          META_ERROR_CODES.NETWORK,
          `Meta pagination exceeded ${MAX_PAGES} pages for ${endpoint.collection}`,
          { details: { collection: endpoint.collection }, retryable: true },
        ));
      }
      const page = await requestJson(transport, url, this.token);
      if (!page.ok) {
        return page;
      }
      if (!Array.isArray(page.data?.data)) {
        return readError(metaError(
          META_ERROR_CODES.NETWORK,
          `provider returned a non-array data field for ${endpoint.collection}`,
          { details: { collection: endpoint.collection }, retryable: false },
        ));
      }
      rows.push(...page.data.data);
      const next = followPaging(page.data?.paging);
      if (!next.ok) {
        return next;
      }
      url = next.data;
    }
    return readOk(rows);
  }

  #buildUrl(endpoint) {
    const params = new URLSearchParams({
      fields: endpoint.fields,
      limit: String(PAGE_LIMIT),
      ...endpoint.params,
    });
    return `${GRAPH_BASE_URL}/${GRAPH_API_VERSION}/${accountPath(this.adAccountId)}/${endpoint.path}?${params}`;
  }
}

function withRowContext(error, collection, index) {
  return metaError(error.code, `${collection}[${index}]: ${error.message}`, {
    details: { collection, index, ...error.details },
    retryable: error.retryable,
  });
}
