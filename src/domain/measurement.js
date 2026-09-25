// Growth measurement domain: downstream quality funnel, maturity and policy
// bands, journey linkage — pure computations over event rows, no IO here
// (conventions: domain modules never import a driver). Errors cross module
// boundaries as {code, message, details} with stable codes.
//
// Aggregation convention pinned for #17: qualified CPL is TENANT-WIDE. It is
// the exact integer sum of ALL spend.observed amount_micros for the tenant
// divided by the count of ALL underscore lead_qualified events for the tenant
// — integer division, null when the volume is zero. Legacy dot-spelled
// `lead.qualified` is a pre-measurement event type and never counts toward
// qualified volume, so a cheap low-quality campaign that yields no qualified
// leads cannot win on quality-adjusted CPL.

import { ISO_CURRENCIES } from './money.js';

export function measurementError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

/** Event types the growth funnel recognises. `lead_qualified` (underscore) is
 * the only type counted as a qualified conversion. */
export const GROWTH_EVENTS = [
  'click', 'spend.observed', 'lead_created', 'lead_qualified', 'demo_booked',
  'opportunity_created', 'deal_won', 'purchase', 'refund',
  'subscription_renewed', 'churned', 'gross_margin_finalized',
];

/** Reference fields (identifiers, never PII) that may ride on any event. */
const REFERENCE_FIELDS = ['session_id', 'user_id', 'order_id', 'lead_id', 'opportunity_id', 'deal_id', 'campaign'];

/** Raw PII: normaliseGrowthEvent never copies these into the envelope. */
const PII_FIELDS = ['email', 'phone'];

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// Same rule the envelope validator applies: UTC ISO-8601 only.
function timestampError(occurredAt) {
  if (occurredAt === undefined || occurredAt === null || occurredAt === '') {
    return 'MISSING_OCCURRED_AT';
  }
  if (!nonEmptyString(occurredAt) || Number.isNaN(Date.parse(occurredAt))) {
    return 'BAD_OCCURRED_AT';
  }
  if (!occurredAt.endsWith('Z') && !/[+-]00:?00$/.test(occurredAt)) {
    return 'NON_UTC_OCCURRED_AT';
  }
  return null;
}

function invalidMoney(value) {
  return measurementError(
    'INVALID_MONEY',
    `value must be an integer number of micros, got ${JSON.stringify(value)}`,
    { received: typeof value === 'number' ? String(value) : typeof value },
  );
}

/**
 * Normalise a growth-event body into a validated envelope shape for
 * validateEvent(). event_name maps 1:1 to event_type for allowlisted names;
 * value+currency become payload.amount_micros/currency; user/session/order
 * references ride into the payload while raw email and phone are dropped.
 * Returns {ok, event} or {ok:false, error}.
 */
export function normaliseGrowthEvent(body, tenantId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      error: measurementError('MISSING_EVENT_ID', 'growth event body must be an object'),
    };
  }
  if (!nonEmptyString(body.event_id)) {
    return {
      ok: false,
      error: measurementError('MISSING_EVENT_ID', 'growth event is missing or has an empty event_id', { field: 'event_id' }),
    };
  }
  if (!nonEmptyString(body.event_name)) {
    return {
      ok: false,
      error: measurementError('MISSING_EVENT_NAME', 'growth event is missing or has an empty event_name', { field: 'event_name' }),
    };
  }
  if (!GROWTH_EVENTS.includes(body.event_name)) {
    return {
      ok: false,
      error: measurementError('UNKNOWN_EVENT', `unknown event_name ${JSON.stringify(body.event_name)}`, { field: 'event_name' }),
    };
  }
  const occurredAt = timestampError(body.occurred_at);
  if (occurredAt) {
    return {
      ok: false,
      error: measurementError(occurredAt, `occurred_at must be a UTC ISO-8601 timestamp, got ${JSON.stringify(body.occurred_at)}`, { field: 'occurred_at' }),
    };
  }

  const payload = {};
  for (const field of REFERENCE_FIELDS) {
    if (nonEmptyString(body[field])) {
      payload[field] = body[field];
    }
  }
  if (body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)) {
    for (const [key, value] of Object.entries(body.payload)) {
      if (PII_FIELDS.includes(key)) {
        continue; // raw PII never enters the envelope
      }
      payload[key] = value;
    }
  }
  // Money: body.value (integer micros) plus a currency, or a pre-normalised
  // payload.amount_micros. Floats never pass (TR-1). PII is dropped here.
  const currency = nonEmptyString(body.currency) ? body.currency : payload.currency;
  if (body.value !== undefined) {
    if (!Number.isSafeInteger(body.value)) {
      return { ok: false, error: invalidMoney(body.value) };
    }
    if (!nonEmptyString(currency) || !ISO_CURRENCIES.includes(currency)) {
      return {
        ok: false,
        error: measurementError('INVALID_CURRENCY', `currency must be a known ISO 4217 code, got ${JSON.stringify(currency)}`),
      };
    }
    payload.amount_micros = body.value;
    payload.currency = currency;
  }
  if (payload.amount_micros !== undefined && !Number.isSafeInteger(payload.amount_micros)) {
    return { ok: false, error: invalidMoney(payload.amount_micros) };
  }
  if (payload.currency !== undefined && !ISO_CURRENCIES.includes(payload.currency)) {
    return {
      ok: false,
      error: measurementError('INVALID_CURRENCY', `currency must be a known ISO 4217 code, got ${JSON.stringify(payload.currency)}`),
    };
  }
  // Money integrity (QA BUG-1): spend can never be zero or negative, on either
  // the body.value path or a pre-normalised payload.amount_micros — a negative
  // spend inverts qualified CPL and a +X/-X pair cancels real spend to zero.
  // Non-spend money (e.g. a negative refund) is not touched by this rule.
  if (body.event_name === 'spend.observed' && payload.amount_micros !== undefined && payload.amount_micros <= 0) {
    return {
      ok: false,
      error: measurementError(
        'NON_POSITIVE_SPEND',
        `spend.observed amount_micros must be a positive integer, got ${JSON.stringify(payload.amount_micros)}`,
        { received: String(payload.amount_micros) },
      ),
    };
  }

  return {
    ok: true,
    event: {
      event_id: body.event_id,
      event_type: body.event_name,
      occurred_at: new Date(body.occurred_at).toISOString(),
      tenant_id: tenantId,
      schema_version: '1',
      payload,
    },
  };
}

/**
 * Tenant-wide funnel over deduplicated event rows. `tenantCurrency` is the
 * optional unit of account: when supplied, spend rows carrying an explicitly
 * different currency are excluded, so legacy mixed-currency rows cannot
 * corrupt the CPL (QA BUG-2). Rows without a currency are treated as
 * tenant-currency for v1 leniency. Single-argument calls keep the behaviour
 * existing tests rely on: positive rows only, no currency filtering.
 * Returns {spend_micros, qualified_volume, qualified_cpl_micros}.
 */
export function computeFunnel(events, tenantCurrency) {
  const seen = new Set();
  const unique = [];
  for (const event of events) {
    const key = `${event.tenant_id ?? ''}:${event.event_id ?? ''}`;
    if (seen.has(key)) {
      continue; // duplicate event_id in a batch counts once
    }
    seen.add(key);
    unique.push(event);
  }
  let spend = 0;
  for (const event of unique) {
    if (event.event_type !== 'spend.observed') {
      continue;
    }
    const amount = event.payload?.amount_micros;
    // Non-positive money never enters the funnel: ingest now rejects it, but
    // raw_events is append-only (TR-20) so legacy batches can still hold it.
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
      continue; // corrupt, float or non-positive money never enters the funnel
    }
    if (tenantCurrency !== undefined) {
      const currency = event.payload?.currency;
      if (currency !== undefined && currency !== tenantCurrency) {
        continue; // foreign-currency legacy row: excluded, never summed
      }
    }
    spend += amount;
  }
  const qualified = unique.filter((event) => event.event_type === 'lead_qualified');
  const volume = qualified.length;
  // Exact integer division. Null (never a misleading number) when there is no
  // volume or no spend: zero volume cannot divide, and zero spend means no
  // cost data exists yet, so a "0 CPL" would claim free acquisitions.
  return {
    spend_micros: spend,
    qualified_volume: volume,
    qualified_cpl_micros: volume > 0 && spend > 0 ? Math.trunc(spend / volume) : null,
  };
}

/**
 * Piecewise-linear maturity score 0..1 through (0h, 0), (48h, 0.5), (120h, 1)
 * until per-account learning replaces the default lag model.
 */
export function maturityFor(ageHours) {
  if (typeof ageHours !== 'number' || Number.isNaN(ageHours) || ageHours <= 0) {
    return 0;
  }
  if (ageHours >= 120) {
    return 1;
  }
  let score;
  if (ageHours <= 48) {
    score = 0.5 * (ageHours / 48);
  } else {
    score = 0.5 + 0.5 * ((ageHours - 48) / 72);
  }
  return Math.min(1, Math.max(0, score));
}

/** Stale threshold past the last good data-through point. */
export const STALE_THRESHOLD_HOURS = 24;

const STRATEGIC_BAND = 0.9;

/**
 * TR-7 policy band: <0.35 emergency-only, <0.70 protective, <0.90 moderate,
 * >=0.90 strategic. Strategic actions are gated (blocked) for every maturity
 * below 0.90.
 */
export function policyBand(maturity) {
  const label = maturity < 0.35
    ? 'emergency-only'
    : maturity < 0.7
      ? 'protective'
      : maturity < STRATEGIC_BAND
        ? 'moderate'
        : 'strategic';
  return { label, gated: maturity < STRATEGIC_BAND };
}

/** Share of lead_qualified events carrying a session_id or user_id reference. */
export function coverageOf(events) {
  const qualified = events.filter((event) => event.event_type === 'lead_qualified');
  if (qualified.length === 0) {
    return 0;
  }
  const attached = qualified.filter((event) =>
    nonEmptyString(event.payload?.session_id) || nonEmptyString(event.payload?.user_id)).length;
  return attached / qualified.length;
}

/** Max occurred_at across events, or null when there is no data. */
export function dataThrough(events) {
  let latest = null;
  for (const event of events) {
    const occurredAt = event.occurred_at;
    if (!nonEmptyString(occurredAt)) {
      continue;
    }
    if (latest === null || occurredAt > latest) {
      latest = occurredAt;
    }
  }
  return latest;
}

/** Stale once data-through is older than thresholdHours (default 24h). */
export function isStale(nowIso, dataThroughIso, thresholdHours = STALE_THRESHOLD_HOURS) {
  if (!nonEmptyString(dataThroughIso)) {
    return false;
  }
  const ageHours = (Date.parse(nowIso) - Date.parse(dataThroughIso)) / 3_600_000;
  return ageHours > thresholdHours;
}

/** Whole-hour age copy for the stale banner, e.g. 26. */
export function staleAgeHours(nowIso, dataThroughIso) {
  const ageHours = (Date.parse(nowIso) - Date.parse(dataThroughIso)) / 3_600_000;
  return Math.max(0, Math.round(ageHours));
}

function stripPii(payload) {
  const copy = { ...payload };
  for (const field of PII_FIELDS) {
    delete copy[field];
  }
  return copy;
}

/**
 * Group events into journeys by reference ids only (session, then user, then
 * order); raw email/phone PII is stripped from the returned payloads.
 */
export function linkJourney(events) {
  const journeys = new Map();
  for (const event of events) {
    const payload = stripPii(event.payload ?? {});
    const sessionId = nonEmptyString(payload.session_id) ? payload.session_id : null;
    const userId = nonEmptyString(payload.user_id) ? payload.user_id : null;
    const orderId = nonEmptyString(payload.order_id) ? payload.order_id : null;
    const key = sessionId ?? userId ?? orderId ?? 'unlinked';
    if (!journeys.has(key)) {
      journeys.set(key, { session_id: sessionId, user_id: userId, order_id: orderId, events: [] });
    }
    journeys.get(key).events.push({ ...event, payload });
  }
  return [...journeys.values()];
}
