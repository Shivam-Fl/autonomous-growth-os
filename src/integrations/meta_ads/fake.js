// Fake Meta provider (TR-13): implements the full typed read interface with
// deterministic fixture data, so tests and simulation need no network and no
// credentials. Failure modes ok|quota|revoked inject the same typed error
// envelopes the live provider maps 429/403 to, so one contract suite drives
// both providers with zero business-logic changes.
//
// Issue #20 adds the WRITE half. Writes run against a PER-INSTANCE deep copy of
// the fixtures, never the module constant: the fake is rebuilt on every request
// (routes.js builds one per request), so a write in one request is not visible
// in the next. That is deliberate — it is why "executes exactly once" can only
// be observed through the durable store in action_records and never through
// the provider.

import {
  META_ERROR_CODES,
  READ_METHODS,
  WRITE_METHODS,
  insightRowId,
  metaError,
  readError,
  readOk,
  sortById,
  writeError,
  writeOk,
} from './index.js';

/** Simulation failure modes accepted by the FakeMetaAdsProvider constructor. */
export const FAILURE_MODES = new Set(['ok', 'quota', 'revoked']);

/** When the fixture data was last synced; deterministic like everything here. */
export const FIXTURE_SYNCED_AT = '2026-09-25T08:00:00.000Z';

/** Campaign statuses a write may set. A new campaign is never born ACTIVE, so
 * nothing here can create a campaign that is spending before anyone read it. */
export const CAMPAIGN_STATUSES = new Set(['ACTIVE', 'PAUSED']);

/** Drift sources the provider can report on the write it just made. */
export const DRIFT_SOURCES = Object.freeze(['none', 'manual', 'platform', 'third-party']);

// Fixtures for one demo ad account, declared in non-id order on purpose: the
// provider sorts on the way out, so a pass-through would fail the contract
// suite's id-order assertion. A write that APPENDED would break that same
// assertion, which is why every list the writes can change goes back through
// sortById. Money is integer micros (TR-1).
const FIXTURES = {
  campaigns: [
    { id: 'campaign_002', name: 'Generic prospecting — search', status: 'ACTIVE', objective: 'OUTCOME_LEADS' },
    { id: 'campaign_001', name: 'Search — brand defence', status: 'ACTIVE', objective: 'OUTCOME_LEADS' },
    { id: 'campaign_003', name: 'Retargeting — funnel revisit', status: 'PAUSED', objective: 'OUTCOME_TRAFFIC' },
  ],
  adSets: [
    { id: 'adset_002', campaign_id: 'campaign_002', name: 'Prospecting · broad', status: 'ACTIVE', daily_budget_micros: 1_000_000_000 },
    { id: 'adset_001', campaign_id: 'campaign_001', name: 'Search · exact', status: 'ACTIVE', daily_budget_micros: 500_000_000 },
    { id: 'adset_003', campaign_id: 'campaign_003', name: 'Retargeting · 30 days', status: 'PAUSED', daily_budget_micros: 250_000_000 },
  ],
  ads: [
    { id: 'ad_002', ad_set_id: 'adset_002', name: 'Prospecting — RSA A', status: 'ACTIVE' },
    { id: 'ad_001', ad_set_id: 'adset_001', name: 'Brand — RSA A', status: 'ACTIVE' },
    { id: 'ad_003', ad_set_id: 'adset_003', name: 'Retargeting — static A', status: 'PAUSED' },
  ],
  insights: [
    { id: insightRowId('campaign_002'), campaign_id: 'campaign_002', spend_micros: 8_750_000_000, impressions: 210_000, clicks: 2_100 },
    { id: insightRowId('campaign_001'), campaign_id: 'campaign_001', spend_micros: 4_000_000_000, impressions: 90_000, clicks: 1_200 },
    { id: insightRowId('campaign_003'), campaign_id: 'campaign_003', spend_micros: 1_250_000_000, impressions: 30_000, clicks: 300 },
  ],
};

/**
 * The last good sync is the fixture set itself: this slice deliberately does
 * not persist Meta rows (derived_metrics stays derived-only), so the fake is
 * both the source and the snapshot the dashboard preserves on error.
 */
function lastGoodSnapshot() {
  return {
    synced_at: FIXTURE_SYNCED_AT,
    campaigns: sortById(FIXTURES.campaigns),
    adSets: sortById(FIXTURES.adSets),
    ads: sortById(FIXTURES.ads),
    insights: sortById(FIXTURES.insights),
  };
}

/** A per-instance copy, so one request's write is invisible to the next. */
function instanceFixtures() {
  return structuredClone(FIXTURES);
}

function badRequest(message, details = {}) {
  return metaError(META_ERROR_CODES.NETWORK, message, { details, retryable: false });
}

export class FakeMetaAdsProvider {
  constructor({ failureMode = 'ok', writeDrift = 'none' } = {}) {
    if (!FAILURE_MODES.has(failureMode)) {
      throw new Error(`unknown Meta fake failure mode: ${failureMode}`);
    }
    if (!DRIFT_SOURCES.includes(writeDrift)) {
      throw new Error(`unknown Meta fake write drift source: ${writeDrift}`);
    }
    this.failureMode = failureMode;
    this.writeDrift = writeDrift;
    this.state = instanceFixtures();
    this.lastWriteResult = null;
  }

  /**
   * The provider's last good read: rows plus the sync timestamp the dashboard
   * shows in ideal and error states. Not part of the typed read interface —
   * it is the simulation affordance the page layer renders from.
   */
  lastGood() {
    return lastGoodSnapshot();
  }

  /**
   * The drift source the provider itself reports for the write it just made,
   * alongside the state it now holds. Not part of the typed interface either,
   * for the same reason lastGood() is not: it is the simulation affordance the
   * executor classifies, and a live adapter would source it from a
   * platform-side signal instead.
   */
  lastWrite() {
    return this.lastWriteResult;
  }

  async listCampaigns() {
    return this.#read('campaigns');
  }

  async listAdSets() {
    return this.#read('adSets');
  }

  async listAds() {
    return this.#read('ads');
  }

  async getInsights() {
    return this.#read('insights');
  }

  async setCampaignStatus({ campaignId, status }) {
    const blocked = this.#writeGuard();
    if (blocked) {
      return writeError(blocked);
    }
    if (!CAMPAIGN_STATUSES.has(status)) {
      return writeError(badRequest(`campaign status must be one of ${[...CAMPAIGN_STATUSES].join('|')}`, { status: status ?? null }));
    }
    const campaign = this.state.campaigns.find((row) => row.id === campaignId);
    if (!campaign) {
      return writeError(badRequest(`no campaign ${campaignId}`, { campaignId }));
    }
    campaign.status = status;
    return this.#record({ action: 'set_campaign_status', resource: campaignId, requested: { status }, reported: { status: campaign.status } });
  }

  async updateAdSetBudget({ adSetId, deltaMicros }) {
    const blocked = this.#writeGuard();
    if (blocked) {
      return writeError(blocked);
    }
    // Integer micros only, and never divided: a float reaching a budget is a
    // float a later reconciliation would report as drift that never happened.
    if (!Number.isSafeInteger(deltaMicros) || deltaMicros < 0) {
      return writeError(badRequest('delta_micros must be a non-negative safe integer', { delta_micros: deltaMicros ?? null }));
    }
    const adSet = this.state.adSets.find((row) => row.id === adSetId);
    if (!adSet) {
      return writeError(badRequest(`no ad set ${adSetId}`, { adSetId }));
    }
    adSet.daily_budget_micros += deltaMicros;
    return this.#record({ action: 'update_campaign_budget', resource: adSetId, requested: { delta_micros: deltaMicros }, reported: { daily_budget_micros: adSet.daily_budget_micros } });
  }

  async updateCampaignCreative({ campaignId, name }) {
    const blocked = this.#writeGuard();
    if (blocked) {
      return writeError(blocked);
    }
    if (typeof name !== 'string' || name.length === 0) {
      return writeError(badRequest('a creative name is required', { name: name ?? null }));
    }
    if (!this.state.campaigns.some((row) => row.id === campaignId)) {
      return writeError(badRequest(`no campaign ${campaignId}`, { campaignId }));
    }
    const adSetIds = new Set(this.state.adSets.filter((row) => row.campaign_id === campaignId).map((row) => row.id));
    const ads = this.state.ads.filter((row) => adSetIds.has(row.ad_set_id));
    if (ads.length === 0) {
      return writeError(badRequest(`campaign ${campaignId} holds no creative to refresh`, { campaignId }));
    }
    for (const ad of ads) {
      ad.name = name;
    }
    return this.#record({ action: 'update_campaign_creative', resource: campaignId, requested: { name }, reported: { name, ads: ads.map((ad) => ad.id) } });
  }

  async createCampaign({ name }) {
    const blocked = this.#writeGuard();
    if (blocked) {
      return writeError(blocked);
    }
    if (typeof name !== 'string' || name.length === 0) {
      return writeError(badRequest('a campaign name is required', { name: name ?? null }));
    }
    // The next id in sequence, minted here rather than taken from the
    // envelope's resource: for create_campaign the resource is a PROPOSED id
    // that does not exist yet, and a campaign literally called 'campaign_004'
    // is what reading the name off it would produce.
    const highest = this.state.campaigns.reduce((max, row) => Math.max(max, Number.parseInt(row.id.replace('campaign_', ''), 10) || 0), 0);
    const created = {
      id: `campaign_${String(highest + 1).padStart(3, '0')}`,
      name,
      // Never born ACTIVE: a new campaign must be read before it spends.
      status: 'PAUSED',
      objective: 'OUTCOME_LEADS',
    };
    this.state.campaigns.push(created);
    return this.#record({ action: 'create_campaign', resource: created.id, requested: { name }, reported: { id: created.id, name: created.name, status: created.status } });
  }

  // A quota exhaustion or revoked permission blocks every call the account
  // makes, so the injected failure applies to the whole interface at once —
  // reads AND writes, with the same codes, messages and simulated details.
  // The ?meta_error browser clause is a write-path clause, and a fake that
  // only failed on reads could not produce it.
  #writeGuard() {
    if (this.failureMode === 'ok') {
      return null;
    }
    return this.#failureError();
  }

  #failureError() {
    if (this.failureMode === 'quota') {
      return metaError(
        META_ERROR_CODES.QUOTA,
        'Meta Ads read quota is exhausted for this account (simulated)',
        { details: { simulated: true }, retryable: true },
      );
    }
    return metaError(
      META_ERROR_CODES.PERMISSION,
      'Meta Ads read access was revoked for this account (simulated)',
      { details: { simulated: true }, retryable: false },
    );
  }

  #read(collection) {
    if (this.failureMode !== 'ok') {
      return readError(this.#failureError());
    }
    return readOk(sortById(this.state[collection]));
  }

  #record({ action, resource, requested, reported }) {
    this.lastWriteResult = { action, resource, requested, reported, drift: this.writeDrift };
    return writeOk({ ...this.lastWriteResult });
  }
}

// The interface checks live next to the fixtures they guard: any provider that
// stops implementing a read fails this at import time in the contract suite.
export function implementsReadInterface(provider) {
  return READ_METHODS.every((method) => typeof provider[method] === 'function');
}

/** The WRITE interface check. live.js is deliberately NOT required to pass it
 * in this slice: the write interface is typed, the fake is the only
 * implementation, and the live adapter is a later slice — so nothing here
 * commits to a live write contract. */
export function implementsWriteInterface(provider) {
  return WRITE_METHODS.every((method) => typeof provider[method] === 'function');
}
