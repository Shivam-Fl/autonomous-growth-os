// Learning records (TR-10, spec §10): an evidence-backed claim with its
// applicability scope, confidence and status lifecycle. Embeddings assist
// retrieval only — cosineSimilarity is a ranking hint, and the structured
// gate (scope, freshness, confidence) always runs after it (IAC-3). Pure
// domain: no driver imports here; errors cross boundaries as
// {code, message, details} with stable codes.

export const EVIDENCE_TYPES = Object.freeze([
  'randomized_experiment',
  'quasi_experiment',
  'observational',
  'external_research',
  'system_eval',
]);

/** Evidence type → research-mesh tier (A strongest … E weakest), so a
 * learning's displayed grade follows its evidence class, never its wording. */
export const EVIDENCE_TYPE_TIERS = Object.freeze({
  randomized_experiment: 'A',
  quasi_experiment: 'B',
  system_eval: 'B',
  observational: 'C',
  external_research: 'C',
});

/** The scope vocabulary. Repositories may use it to build a SQL-level
 * prefilter; scopeMatch is the authority that decides admission. */
export const SCOPE_FIELDS = Object.freeze(['tenant', 'product', 'platform', 'campaignType', 'persona', 'geography', 'season']);

const LEARNING_STATUSES = Object.freeze(['candidate', 'accepted', 'contradicted', 'stale', 'rejected']);

/** Every learning id carries the lrn_ prefix, like evt_ and dec_ upstream. */
const LEARNING_ID_PREFIX = 'lrn_';

export function learningError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function utcTimestamp(value) {
  if (!nonEmptyString(value) || Number.isNaN(Date.parse(value))) {
    return null;
  }
  if (!value.endsWith('Z') && !/[+-]00:?00$/.test(value)) {
    return null;
  }
  return new Date(value).toISOString();
}

/**
 * Validate one learning. Returns {ok, learning} or {ok:false, error}.
 * A learning with no id gets one stamped here so the caller never invents
 * id formats; explicit ids must carry the lrn_ prefix.
 */
export function validateLearning({
  id = null,
  claim,
  scope,
  evidenceRefs = [],
  evidenceType,
  effect = null,
  confidence,
  applicability = 1,
  status = 'candidate',
  createdAt = null,
  validFrom = null,
  staleAfter = null,
  updatedAt = null,
} = {}) {
  if (!nonEmptyString(claim)) {
    return { ok: false, error: learningError('LEARNING_BAD_CLAIM', 'claim must be a non-empty string', { field: 'claim' }) };
  }
  if (id !== null && !String(id).startsWith(LEARNING_ID_PREFIX)) {
    return { ok: false, error: learningError('LEARNING_BAD_ID', `learning ids carry the ${LEARNING_ID_PREFIX} prefix, got ${JSON.stringify(id)}`, { field: 'id' }) };
  }
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    return { ok: false, error: learningError('LEARNING_BAD_SCOPE', 'scope must be an object of scope fields', { field: 'scope' }) };
  }
  for (const key of Object.keys(scope)) {
    if (!SCOPE_FIELDS.includes(key)) {
      return { ok: false, error: learningError('LEARNING_BAD_SCOPE', `unknown scope field ${JSON.stringify(key)}`, { field: 'scope', field_list: SCOPE_FIELDS }) };
    }
    if (!nonEmptyString(scope[key])) {
      return { ok: false, error: learningError('LEARNING_BAD_SCOPE', `scope field ${key} must be a non-empty string`, { field: `scope.${key}` }) };
    }
  }
  if (!Array.isArray(evidenceRefs) || evidenceRefs.some((ref) => !nonEmptyString(ref))) {
    return { ok: false, error: learningError('LEARNING_BAD_EVIDENCE', 'evidenceRefs must be an array of non-empty strings', { field: 'evidenceRefs' }) };
  }
  if (evidenceRefs.length === 0) {
    return { ok: false, error: learningError('LEARNING_BAD_EVIDENCE', 'a learning without evidence refs is conjecture, not a learning', { field: 'evidenceRefs' }) };
  }
  if (!EVIDENCE_TYPES.includes(evidenceType)) {
    return { ok: false, error: learningError('LEARNING_BAD_EVIDENCE_TYPE', `evidenceType must be one of ${EVIDENCE_TYPES.join('|')}, got ${JSON.stringify(evidenceType)}`, { field: 'evidenceType', allowed: EVIDENCE_TYPES }) };
  }
  if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, error: learningError('LEARNING_BAD_CONFIDENCE', `confidence must be a number in [0, 1], got ${JSON.stringify(confidence)}`, { field: 'confidence' }) };
  }
  if (typeof applicability !== 'number' || Number.isNaN(applicability) || applicability < 0 || applicability > 1) {
    return { ok: false, error: learningError('LEARNING_BAD_APPLICABILITY', `applicability must be a number in [0, 1], got ${JSON.stringify(applicability)}`, { field: 'applicability' }) };
  }
  if (!LEARNING_STATUSES.includes(status)) {
    return { ok: false, error: learningError('LEARNING_BAD_STATUS', `status must be one of ${LEARNING_STATUSES.join('|')}, got ${JSON.stringify(status)}`, { field: 'status', allowed: LEARNING_STATUSES }) };
  }
  let effectValue = null;
  if (effect !== null) {
    if (!effect || typeof effect !== 'object' || Array.isArray(effect)) {
      return { ok: false, error: learningError('LEARNING_BAD_EFFECT', 'effect must be {metric, estimate, interval:[lo, hi]} or null', { field: 'effect' }) };
    }
    if (!nonEmptyString(effect.metric)) {
      return { ok: false, error: learningError('LEARNING_BAD_EFFECT', 'effect.metric must be a non-empty string', { field: 'effect.metric' }) };
    }
    if (typeof effect.estimate !== 'number' || Number.isNaN(effect.estimate)) {
      return { ok: false, error: learningError('LEARNING_BAD_EFFECT', `effect.estimate must be a number, got ${JSON.stringify(effect.estimate)}`, { field: 'effect.estimate' }) };
    }
    if (!Array.isArray(effect.interval) || effect.interval.length !== 2
      || effect.interval.some((bound) => typeof bound !== 'number' || Number.isNaN(bound))) {
      return { ok: false, error: learningError('LEARNING_BAD_EFFECT', 'effect.interval must be [lo, hi] numbers', { field: 'effect.interval' }) };
    }
    effectValue = { metric: effect.metric, estimate: effect.estimate, interval: [effect.interval[0], effect.interval[1]] };
  }
  const now = new Date().toISOString();
  const validFromIso = validFrom === null ? now : utcTimestamp(validFrom);
  if (validFrom !== null && !validFromIso) {
    return { ok: false, error: learningError('LEARNING_BAD_VALID_FROM', `validFrom must be a UTC ISO-8601 timestamp, got ${JSON.stringify(validFrom)}`, { field: 'validFrom' }) };
  }
  let staleAfterIso = null;
  if (staleAfter !== null) {
    staleAfterIso = utcTimestamp(staleAfter);
    if (!staleAfterIso) {
      return { ok: false, error: learningError('LEARNING_BAD_STALE_AFTER', `staleAfter must be a UTC ISO-8601 timestamp, got ${JSON.stringify(staleAfter)}`, { field: 'staleAfter' }) };
    }
  }
  const createdAtIso = createdAt === null ? now : utcTimestamp(createdAt);
  if (createdAt !== null && !createdAtIso) {
    return { ok: false, error: learningError('LEARNING_BAD_CREATED_AT', `createdAt must be a UTC ISO-8601 timestamp, got ${JSON.stringify(createdAt)}`, { field: 'createdAt' }) };
  }
  return {
    ok: true,
    learning: {
      id: id ?? `${LEARNING_ID_PREFIX}${crypto.randomUUID()}`,
      claim,
      scope: { ...scope },
      evidenceRefs: [...evidenceRefs],
      evidenceType,
      effect: effectValue,
      confidence,
      applicability,
      status,
      createdAt: createdAtIso,
      validFrom: validFromIso,
      staleAfter: staleAfterIso,
      updatedAt: updatedAt ? utcTimestamp(updatedAt) ?? now : now,
    },
  };
}

/**
 * Exact scope match: every scope field the learning defines must equal the
 * same field in the context, exactly. A learning scoped more broadly than
 * the question (a defined field the context never names) does not match,
 * so a learning can never apply where its scope cannot be verified.
 */
export function scopeMatch(scope, context) {
  if (!scope || typeof scope !== 'object') {
    return false;
  }
  if (!context || typeof context !== 'object') {
    return false;
  }
  for (const [field, value] of Object.entries(scope)) {
    if (context[field] !== value) {
      return false;
    }
  }
  return true;
}

/** Past its staleAfter timestamp (or has none): no longer fresh. */
export function isStale(learning, nowIso) {
  if (!learning?.staleAfter) {
    return false;
  }
  return Date.parse(nowIso) >= Date.parse(learning.staleAfter);
}

/** Not yet valid: validFrom sits in the future relative to nowIso. */
export function isExpired(learning, nowIso) {
  if (!learning?.validFrom) {
    return false;
  }
  return Date.parse(nowIso) < Date.parse(learning.validFrom);
}

const TRANSITIONS = Object.freeze({
  candidate: { accept: 'accepted', reject: 'rejected', contradict: 'contradicted' },
  accepted: { contradict: 'contradicted', stale: 'stale' },
  stale: { accept: 'accepted', reject: 'rejected' },
  contradicted: { reject: 'rejected' },
  rejected: {},
});

/**
 * The status state machine for one transition. Throws
 * LEARNING_BAD_TRANSITION with the offending pair so a caller cannot move a
 * learning to an invented status.
 */
export function transition(state, event) {
  const next = TRANSITIONS[state]?.[event];
  if (!next) {
    throw learningError(
      'LEARNING_BAD_TRANSITION',
      `learning status ${JSON.stringify(state)} has no ${JSON.stringify(event)} transition`,
      { state, event, allowed: Object.keys(TRANSITIONS[state] ?? {}) },
    );
  }
  return next;
}

/**
 * Contradiction merge: the surviving learning keeps both evidence ref
 * lists and both sources — never a silent overwrite (IAC-2, TR-10).
 * The merged learning moves straight to contradicted.
 */
export function mergeContradiction(a, b) {
  if (!a || !b) {
    throw learningError('LEARNING_BAD_MERGE', 'mergeContradiction needs two learnings');
  }
  if (a.id !== b.id) {
    throw learningError('LEARNING_BAD_MERGE', `mergeContradiction needs the same learning id, got ${a.id} and ${b.id}`, { ids: [a.id, b.id] });
  }
  const seen = new Set();
  const evidenceRefs = [...a.evidenceRefs, ...b.evidenceRefs].filter((ref) => {
    if (seen.has(ref)) {
      return false;
    }
    seen.add(ref);
    return true;
  });
  return {
    ...a,
    evidenceRefs,
    confidence: Math.min(a.confidence, b.confidence),
    status: 'contradicted',
    updatedAt: new Date().toISOString(),
  };
}

const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MAX_AGE_DAYS = 180;

/**
 * The retrieval gate (IAC-3): only accepted, in-scope, fresh, confident
 * rows come back. Anything one notch short — wrong geography, past its
 * stale_after, under the confidence band — never reaches a consumer.
 */
export function gateForRetrieval(learnings, { context, nowIso, minConfidence = DEFAULT_MIN_CONFIDENCE, maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
  const now = nonEmptyString(nowIso) ? nowIso : new Date().toISOString();
  return learnings.filter((learning) => {
    if (learning.status !== 'accepted') {
      return false;
    }
    if (!scopeMatch(learning.scope, context)) {
      return false;
    }
    if (isExpired(learning, now)) {
      return false;
    }
    if (isStale(learning, now)) {
      return false;
    }
    // No staleAfter means the max-age fallback applies so a learning
    // without an explicit expiry cannot outlive its evidence quietly.
    if (!learning.staleAfter) {
      const ageDays = (Date.parse(now) - Date.parse(learning.updatedAt)) / 86_400_000;
      if (ageDays > maxAgeDays) {
        return false;
      }
    }
    if (learning.confidence < minConfidence) {
      return false;
    }
    return true;
  });
}

/**
 * Cosine similarity over two equal-length numeric vectors, used to RANK
 * learnings near a query context. This is a hint only: gateForRetrieval
 * always runs the structured scope + freshness + confidence gate after it,
 * so an inadmissible learning can never be retrieved by similarity alone
 * (TR-10: embeddings assist retrieval, never substitute for the gate).
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    throw learningError('LEARNING_BAD_VECTOR', `cosineSimilarity needs two equal-length non-empty vectors, got lengths ${a?.length} and ${b?.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
