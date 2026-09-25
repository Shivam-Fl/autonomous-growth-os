// Fake Meta provider (TR-13): implements the full typed read interface with
// deterministic fixture data, so tests and simulation need no network and no
// credentials. Failure modes ok|quota|revoked inject the same typed error
// envelopes the live provider maps 429/403 to, so one contract suite drives
// both providers with zero business-logic changes.

import {
  META_ERROR_CODES,
  READ_METHODS,
  insightRowId,
  metaError,
  readError,
  readOk,
  sortById,
} from './index.js';

/** Simulation failure modes accepted by the FakeMetaAdsProvider constructor. */
export const FAILURE_MODES = new Set(['ok', 'quota', 'revoked']);

/** When the fixture data was last synced; deterministic like everything here. */
export const FIXTURE_SYNCED_AT = '2026-09-25T08:00:00.000Z';

// Fixtures for one demo ad account, declared in non-id order on purpose: the
// provider sorts on the way out, so a pass-through would fail the contract
// suite's id-order assertion. Money is integer micros (TR-1).
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

export class FakeMetaAdsProvider {
  constructor({ failureMode = 'ok' } = {}) {
    if (!FAILURE_MODES.has(failureMode)) {
      throw new Error(`unknown Meta fake failure mode: ${failureMode}`);
    }
    this.failureMode = failureMode;
  }

  /**
   * The provider's last good read: rows plus the sync timestamp the dashboard
   * shows in ideal and error states. Not part of the typed read interface —
   * it is the simulation affordance the page layer renders from.
   */
  lastGood() {
    return lastGoodSnapshot();
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

  // A quota exhaustion or revoked permission blocks every read the account
  // makes, so the injected failure applies to the whole interface at once.
  #read(collection) {
    if (this.failureMode === 'quota') {
      return readError(metaError(
        META_ERROR_CODES.QUOTA,
        'Meta Ads read quota is exhausted for this account (simulated)',
        { details: { simulated: true }, retryable: true },
      ));
    }
    if (this.failureMode === 'revoked') {
      return readError(metaError(
        META_ERROR_CODES.PERMISSION,
        'Meta Ads read access was revoked for this account (simulated)',
        { details: { simulated: true }, retryable: false },
      ));
    }
    return readOk(sortById(FIXTURES[collection]));
  }
}

// The interface check lives next to the fixtures it guards: any provider that
// stops implementing a read fails this at import time in the contract suite.
export function implementsReadInterface(provider) {
  return READ_METHODS.every((method) => typeof provider[method] === 'function');
}
