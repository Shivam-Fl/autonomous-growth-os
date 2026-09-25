// The Browser Security Gateway wrapper (TR-11, spec §18): external web
// content enters the system as untrusted DATA, never instructions. Every
// fetch result is wrapped with origin metadata before the pipeline touches
// it, and content matching a prompt-injection pattern is dropped before any
// tool call can carry it downstream. This module never imports src/executor
// or src/policy: research code cannot reach the Executor or the kernel, and
// the wrap-then-classify boundary is the whole of its authority.

export const CONTENT_ORIGIN = 'external_untrusted_web';
export const ALLOWED_EFFECT = 'research_only';

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// Same rule the event validator applies: UTC ISO-8601 only.
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
 * Stable malicious-content reasons. Each maps to one prompt-injection shape
 * the spec names: a page demanding secrets or a credential upload, and a
 * page demanding the agent overwrite its own instructions.
 */
export const MALICIOUS_REASONS = Object.freeze({
  CREDENTIAL_UPLOAD: 'requests credential or secret upload',
  INSTRUCTION_OVERRIDE: 'demands instruction override',
});

const MALICIOUS_PATTERNS = [
  { reason: MALICIOUS_REASONS.CREDENTIAL_UPLOAD, pattern: /api[\s_-]?keys?|upload[\s\S]{0,24}credentials?|share[\s\S]{0,24}secrets?|upload[\s\S]{0,24}secrets?/i },
  { reason: MALICIOUS_REASONS.INSTRUCTION_OVERRIDE, pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?|disregard\s+(?:the\s+)?(?:previous|prior|above)?\s*instructions?|you\s+are\s+now|system\s+prompt\s+override/i },
];

/**
 * Wrap an external fetch result with origin metadata. Everything the
 * pipeline later sees is this wrapped envelope; the raw text is carried as
 * data inside it and never executed.
 */
export function wrapExternal({ url, text, retrievedAt }) {
  const occurredAt = utcTimestamp(retrievedAt);
  if (!occurredAt) {
    throw sanitizeError('BAD_RETRIEVED_AT', `retrieved_at must be a UTC ISO-8601 timestamp, got ${JSON.stringify(retrievedAt)}`, { field: 'retrieved_at' });
  }
  if (!nonEmptyString(url)) {
    throw sanitizeError('BAD_URL', `url must be a non-empty string, got ${JSON.stringify(url)}`, { field: 'url' });
  }
  if (!nonEmptyString(text)) {
    throw sanitizeError('BAD_TEXT', `text must be a non-empty string, got ${JSON.stringify(text)}`, { field: 'text' });
  }
  return {
    content_origin: CONTENT_ORIGIN,
    url,
    retrieved_at: occurredAt,
    text,
    allowed_effect: ALLOWED_EFFECT,
  };
}

/**
 * Classify wrapped content: benign text passes through unchanged, content
 * matching a prompt-injection pattern is malicious. The wrapped envelope is
 * data; the clauses inside it are page content, not an instruction, so the
 * verdict is computed from the text only and never from anything the text
 * asks for.
 */
export function classifyContent(wrapped) {
  if (!wrapped || typeof wrapped !== 'object') {
    throw sanitizeError('BAD_WRAPPED', 'classifyContent needs a wrapped external document');
  }
  for (const { reason, pattern } of MALICIOUS_PATTERNS) {
    if (pattern.test(wrapped.text ?? '')) {
      return { verdict: 'malicious', reason };
    }
  }
  return { verdict: 'benign' };
}

/**
 * The pipeline gate: takes the raw fetch result ({url, text, retrievedAt}),
 * wraps it as untrusted external content, and classifies the wrapped
 * envelope. Malicious content is dropped with no replacement text, and so is
 * a page with no text at all — it cannot be wrapped, carries no claim, and
 * failing closed keeps its reason visible in the audit note the mesh
 * records. Benign content returns as the wrapped envelope: content_origin
 * and allowed_effect ride on everything the pipeline keeps. A result without
 * a usable url or retrieved_at is a vendor contract violation, not page
 * content, so it still throws its stable code.
 */
export function sanitizeForPipeline({ url, text, retrievedAt }) {
  let wrapped;
  try {
    wrapped = wrapExternal({ url, text, retrievedAt });
  } catch (error) {
    if (error.code === 'BAD_TEXT') {
      return { dropped: true, reason: 'empty external document' };
    }
    throw error;
  }
  const classification = classifyContent(wrapped);
  if (classification.verdict === 'malicious') {
    return { dropped: true, reason: classification.reason };
  }
  return { dropped: false, content: wrapped };
}

function sanitizeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}
