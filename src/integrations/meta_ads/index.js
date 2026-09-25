// The Meta Ads adapter contract (TR-13, ADR-0004). The pinned Graph version
// lives exactly here, the typed read interface and its row shapes are defined
// once, and every failure that crosses the boundary carries the same envelope.
// fake.js and live.js implement the interface against this contract; neither
// redefines a shape, an error code, or the version.

/** The pinned Graph API version (ADR-0004). Defined here and nowhere else. */
export const GRAPH_API_VERSION = 'v26.0';

/** Stable error codes crossing the adapter boundary. */
export const META_ERROR_CODES = Object.freeze({
  QUOTA: 'META_QUOTA_EXHAUSTED',
  PERMISSION: 'META_PERMISSION_REVOKED',
  NOT_CONFIGURED: 'META_NOT_CONFIGURED',
  NETWORK: 'META_NETWORK',
});

/**
 * Typed error envelope: {code, message, details, retryable}. Never a raw
 * provider payload and never a thrown error — reads report failures as data
 * so callers can render them.
 */
export function metaError(code, message, { details = {}, retryable = false } = {}) {
  if (!Object.values(META_ERROR_CODES).includes(code)) {
    throw new Error(`unknown Meta adapter error code: ${code}`);
  }
  return { code, message, details, retryable };
}

/** Reads resolve to { ok: true, data } on success. */
export function readOk(data) {
  return { ok: true, data };
}

/** Reads resolve to { ok: false, error } on failure; error is a metaError envelope. */
export function readError(error) {
  return { ok: false, error };
}

/** The typed read interface: every provider implements exactly these reads. */
export const READ_METHODS = Object.freeze([
  'listCampaigns',
  'listAdSets',
  'listAds',
  'getInsights',
]);

/**
 * Deterministic by-id sort (ui.md: every table sorts deterministically). Ids
 * are strings per the row shapes, compared by code unit so the order is
 * locale-independent. Returns a new array; the input is never reordered.
 */
export function sortById(rows) {
  return [...rows].sort((a, b) => {
    if (a.id === b.id) {
      return 0;
    }
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * Insight rows are keyed by the campaign they aggregate, so fake and live
 * derive the same id from the same campaign and the contract suite can
 * require identical rows from both.
 */
export function insightRowId(campaignId) {
  return `insight_${campaignId}`;
}

/**
 * Credential gate for live reads: without a token and an ad account the
 * provider refuses up front with META_NOT_CONFIGURED and never touches the
 * transport. Returns the envelope to fail with, or null when configured.
 */
export function credentialGate({ token, adAccountId }) {
  if (!token) {
    return metaError(
      META_ERROR_CODES.NOT_CONFIGURED,
      'no Meta access token is configured, so live reads are refused',
      { details: { credential: 'META_ADS_ACCESS_TOKEN' }, retryable: false },
    );
  }
  if (!adAccountId) {
    return metaError(
      META_ERROR_CODES.NOT_CONFIGURED,
      'no Meta ad account is configured, so live reads are refused',
      { details: { credential: 'META_AD_ACCOUNT_ID' }, retryable: false },
    );
  }
  return null;
}

// Row shapes, validated field by field. The providers never cast: a value is
// either already the documented type or the row is rejected, so a provider
// change can never surface as a half-formed row on the dashboard.

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** Integer counts and micros: safe integers only, never floats (TR-1). */
function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateRow(row, fields) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return readError(metaError(
      META_ERROR_CODES.NETWORK,
      'provider payload rejected: row is not an object',
      { details: { field: null }, retryable: false },
    ));
  }
  for (const [field, check] of fields) {
    if (!check(row[field])) {
      return readError(metaError(
        META_ERROR_CODES.NETWORK,
        `provider payload rejected: ${field} is missing or has the wrong type`,
        { details: { field }, retryable: false },
      ));
    }
  }
  return readOk(row);
}

export const validateCampaign = (row) => validateRow(row, [
  ['id', isNonEmptyString],
  ['name', isNonEmptyString],
  ['status', isNonEmptyString],
  ['objective', isNonEmptyString],
]);

export const validateAdSet = (row) => validateRow(row, [
  ['id', isNonEmptyString],
  ['campaign_id', isNonEmptyString],
  ['name', isNonEmptyString],
  ['status', isNonEmptyString],
  ['daily_budget_micros', isCount],
]);

export const validateAd = (row) => validateRow(row, [
  ['id', isNonEmptyString],
  ['ad_set_id', isNonEmptyString],
  ['name', isNonEmptyString],
  ['status', isNonEmptyString],
]);

export const validateInsight = (row) => validateRow(row, [
  ['id', isNonEmptyString],
  ['campaign_id', isNonEmptyString],
  ['spend_micros', isCount],
  ['impressions', isCount],
  ['clicks', isCount],
]);
