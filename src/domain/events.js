// Event envelope validation and idempotent application, pure domain: no
// driver imports here. Errors are {code, message, details} with stable codes.

export function eventError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

const REQUIRED_FIELDS = ['event_id', 'event_type', 'occurred_at', 'tenant_id', 'schema_version', 'payload'];

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validateTimestamp(occurredAt) {
  if (!nonEmptyString(occurredAt)) {
    return 'MISSING_OCCURRED_AT';
  }
  if (Number.isNaN(Date.parse(occurredAt))) {
    return 'BAD_OCCURRED_AT';
  }
  // UTC ISO-8601 only: a 'Z' suffix or an explicit zero offset.
  if (!occurredAt.endsWith('Z') && !/[+-]00:?00$/.test(occurredAt)) {
    return 'NON_UTC_OCCURRED_AT';
  }
  return null;
}

/** Validate an event envelope, returning {ok, event} or {ok:false, error}. */
export function validateEvent(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return {
      ok: false,
      error: eventError('MISSING_EVENT_ID', 'event envelope must be an object'),
    };
  }
  if (envelope.payload === null || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    return {
      ok: false,
      error: eventError('MISSING_PAYLOAD', 'event envelope payload must be an object', { field: 'payload' }),
    };
  }
  for (const field of REQUIRED_FIELDS) {
    if (field === 'payload') {
      continue; // validated above as an object, not a string
    }
    if (field === 'schema_version' && typeof envelope.schema_version === 'number') {
      continue; // numeric versions are accepted and normalised below
    }
    if (!nonEmptyString(envelope[field])) {
      const code = `MISSING_${field.toUpperCase()}`;
      return {
        ok: false,
        error: eventError(code, `event envelope is missing or has an empty ${field}`, { field }),
      };
    }
  }
  const occurredAt = validateTimestamp(envelope.occurred_at);
  if (occurredAt) {
    return {
      ok: false,
      error: eventError(occurredAt, `occurred_at must be a UTC ISO-8601 timestamp, got ${JSON.stringify(envelope.occurred_at)}`, { field: 'occurred_at' }),
    };
  }
  return {
    ok: true,
    event: {
      event_id: envelope.event_id,
      event_type: envelope.event_type,
      occurred_at: new Date(envelope.occurred_at).toISOString(),
      tenant_id: envelope.tenant_id,
      schema_version: String(envelope.schema_version),
      payload: envelope.payload,
    },
  };
}

/**
 * Apply an event's effect at most once, keyed on (tenant_id, event_id).
 * `store` abstracts the idempotency table: { has(key), record(key) }.
 * The key is recorded only after the effect succeeds, so a failed effect
 * leaves the event free to be retried.
 *
 * Spec helper staged with the envelope (work order): production consumers
 * do NOT call this directly — scheduler.consume plus the idempotency
 * repository own live exactly-once delivery, keyed per (tenant, event,
 * consumer) and durable across restarts. A first real caller here should
 * back its store with that repository, not an in-memory map, or dedupe
 * resets on every process restart.
 */
export async function applyOnce(store, event, effect) {
  const key = `${event.tenant_id}:${event.event_id}`;
  if (await store.has(key)) {
    return { applied: false };
  }
  await effect();
  await store.record(key);
  return { applied: true };
}
