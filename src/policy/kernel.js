// The policy kernel (issue #20, TR-3/TR-4/TR-5/TR-19/TR-24): the deterministic
// gate, and the only place a write is ever admitted. Pure — no IO, no driver,
// no sqlite, no clock and no process.env. Every input (maturity, posture,
// approval row, kill-switch state, spent nonces) arrives as an argument from
// the caller that owns its source, which is what lets the same gate run from
// the API, the executor and a unit test with nothing stubbed out.
//
// The signing secret lives HERE and not in src/api/routes.js, so the route file
// holds no key material and src/index.js stays the only reader of the
// POLICY_SIGNING_SECRET environment variable.

import { createHmac, randomUUID } from 'node:crypto';
import { policyBand } from '../domain/measurement.js';

/**
 * Dev-only default signing secret. A capability forged offline against this
 * literal is accepted, which is a real limitation of the slice and not an
 * oversight: it is a bearer surface whose only control is this string, and it
 * is bounded by the fact that the only writable provider is an in-memory fake.
 * Anything deployed sets POLICY_SIGNING_SECRET and index.js passes it in.
 */
export const DEFAULT_SIGNING_SECRET = 'dev-policy-signing-secret-not-a-production-secret';

/**
 * The action-class roster, in PINNED RENDER ORDER.
 *
 * The SET is derived from src/domain/decisions.js by membership — every
 * DECISION_CLASS the journal records is a class the gate can act on — plus the
 * one policy-only class the journal never proposes. That derivation is
 * asserted, not computed: DECISION_CLASSES is frozen with budget-change first
 * while every rendered surface here leads with campaign-status, and the
 * criterion compares the table positionally, so the array below is a PINNED
 * LITERAL and test/policy/kernel.test.js asserts BOTH set equality with
 * DECISION_CLASSES ∪ {new-geography} and this exact order. Neither the roster
 * nor its rendering can drift without a red test.
 *
 * requiredMaturityBand is the LOWEST band permitted to act, not a ceiling:
 * admitting data at maturity 0 that a class declared too immature, and
 * refusing data at 0.95 that it declared ready, would invert the property.
 * microLimitMicros is an upper bound on constraints.delta_micros.
 */
export const ACTION_CLASSES = Object.freeze([
  Object.freeze({
    action_class: 'campaign-status',
    microLimitMicros: 50_000_000,
    requiresMicrosConstraint: false,
    requiredMaturityBand: 'emergency-only',
    action: 'set_campaign_status',
  }),
  Object.freeze({
    action_class: 'budget-change',
    microLimitMicros: 50_000_000,
    requiresMicrosConstraint: true,
    requiredMaturityBand: 'emergency-only',
    action: 'update_campaign_budget',
  }),
  Object.freeze({
    action_class: 'creative-refresh',
    microLimitMicros: 10_000_000,
    requiresMicrosConstraint: false,
    requiredMaturityBand: 'emergency-only',
    action: 'update_campaign_creative',
  }),
  Object.freeze({
    action_class: 'new-geography',
    microLimitMicros: 0,
    requiresMicrosConstraint: false,
    requiredMaturityBand: 'emergency-only',
    action: 'create_campaign',
    policyOnly: true,
  }),
  Object.freeze({
    action_class: 'campaign-launch',
    microLimitMicros: 0,
    requiresMicrosConstraint: false,
    requiredMaturityBand: 'emergency-only',
    action: 'create_campaign',
  }),
]);

/** The classes the roster holds for the gate's sake rather than the journal's:
 * a caller can label a policy-only row without diffing two lists. */
export const POLICY_ONLY_CLASSES = Object.freeze(
  ACTION_CLASSES.filter((entry) => entry.policyOnly).map((entry) => entry.action_class),
);

/**
 * Maturity bands in ascending order, which is the order policyBand's own
 * <0.35 / <0.70 / <0.90 edges already encode. The gate and the metric surface
 * read policyBand, so a band edge moving shows up here as a failing assertion
 * rather than as a silently inverted floor.
 */
export const BAND_ORDER = Object.freeze(['emergency-only', 'protective', 'moderate', 'strategic']);

/** The three machine postures, as the display strings the page renders. */
export const POSTURE_LABELS = Object.freeze({
  'autonomous-under-micro-limits': 'autonomous under micro-limits',
  'approval-required': 'approval required',
  shadow: 'shadow',
});

const POSTURES = Object.freeze(Object.keys(POSTURE_LABELS));

/** The policy band a maturity score falls in. The gate reads bands through
 * this one function so it cannot disagree with GET /v1/metrics. */
export function labelFor(maturity) {
  return policyBand(maturity).label;
}

/**
 * The approval-decision nonce, defined ONCE. The prefix literal appears inside
 * this function and nowhere else in the repository: the approve route calls
 * decisionNonce(approvalId) and the seed reset builds its deletion list by
 * mapping decisionNonce over the same seeded ids, so a later rename of a
 * fixture cannot make the reset miss, and no caller assembles the string.
 */
export function decisionNonce(approvalId) {
  return `apr_${approvalId}`;
}

function refusal(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

const TERMINAL_STATUSES = new Set(['executed', 'rejected']);

/**
 * The approval check, kept separate so the admit/refuse decision below reads
 * as the list of reasons it is. An approval is ADDITIONAL authority: a class
 * already autonomous is still admitted with one, so this is never a
 * disqualifier — but a row that does not cover the intent in front of it must
 * be refused, because approving one thing is not approving another.
 */
function checkApproval(approval, intent, nowIso) {
  if (approval === null || typeof approval !== 'object') {
    return { ok: false, details: { reason: 'malformed' } };
  }
  for (const field of ['action_class', 'resource', 'status', 'expires_at']) {
    if (typeof approval[field] !== 'string' || approval[field].length === 0) {
      return { ok: false, details: { reason: 'malformed' } };
    }
  }
  if (TERMINAL_STATUSES.has(approval.status)) {
    return { ok: false, details: { reason: 'terminal', status: approval.status } };
  }
  const expires = Date.parse(approval.expires_at);
  const now = Date.parse(nowIso);
  if (Number.isNaN(expires) || Number.isNaN(now) || expires <= now) {
    return { ok: false, details: { reason: 'expired', expires_at: approval.expires_at } };
  }
  if (approval.action_class !== intent.action_class || approval.resource !== intent.resource) {
    return {
      ok: false,
      details: {
        reason: 'mismatch',
        approved_action_class: approval.action_class,
        approved_resource: approval.resource,
      },
    };
  }
  return { ok: true };
}

/**
 * The micro-limit, and the two classes of bad value it has to refuse.
 *
 * For a class that does not require a micros constraint, an ABSENT
 * delta_micros is 0 and the check is 0 <= microLimitMicros — so a
 * campaign-status intent with an empty constraints object is admitted. A
 * NEGATIVE delta_micros is refused on every class, flag or not, because a
 * number that lowers a budget is still a spend-move the limit exists to bound.
 *
 * For a class that DOES require the constraint, an absent, non-numeric,
 * negative or non-integer delta_micros is refused for the same reason from the
 * other direction: a missing number is not a small number, and an absent
 * constraint would otherwise pass an upper-bound check by not existing.
 */
function checkMicroLimit(entry, constraints) {
  const delta = constraints?.delta_micros;
  if (entry.requiresMicrosConstraint) {
    if (!Number.isSafeInteger(delta) || delta < 0) {
      return {
        ok: false,
        details: { reason: 'micros-required', delta_micros: delta ?? null, limit_micros: entry.microLimitMicros },
      };
    }
  } else if (delta !== undefined && delta !== null && (!Number.isFinite(delta) || delta < 0)) {
    return {
      ok: false,
      details: { reason: 'delta-invalid', delta_micros: delta, limit_micros: entry.microLimitMicros },
    };
  }
  const amount = Number.isFinite(delta) ? delta : 0;
  if (amount > entry.microLimitMicros) {
    return {
      ok: false,
      details: { reason: 'micro-limit', delta_micros: amount, limit_micros: entry.microLimitMicros },
    };
  }
  return { ok: true };
}

/**
 * THE AUTONOMY GATE, and the only place a write is admitted.
 *
 * The rules run in the order below and the order IS the contract: a class
 * refused for want of an approval must never reach the micro-limit or the band
 * check, so a caller cannot learn a class's limit by omitting its approval.
 * Every ambiguous input fails closed (TR-24) — a missing or unrecognised
 * posture, a malformed approval row, an unknown maturity.
 */
export function validateIntent(intent, { nowIso, posture, approval = null, maturity }) {
  if (intent === null || typeof intent !== 'object') {
    return refusal('MALFORMED_INTENT', 'an intent must be an object', { reason: 'not-an-object' });
  }
  const entry = ACTION_CLASSES.find((candidate) => candidate.action_class === intent.action_class);
  if (!entry) {
    return refusal('AUTONOMY_NOT_EARNED', `no autonomy roster entry for ${intent.action_class}`, {
      reason: 'unknown-class',
      action_class: intent.action_class ?? null,
    });
  }
  // The action a class may run is bound to the class. Without this the
  // calibration story is unenforced at the only place it is enforced: the seed
  // earns autonomy for campaign-status on a reversible action, and a caller
  // pairs that class with create_campaign to buy a signed envelope for an
  // irreversible write. Refusing the mismatch makes it a visible 403 with a
  // named reason rather than a silent overwrite of the envelope's action.
  if (intent.action !== entry.action) {
    return refusal('AUTONOMY_NOT_EARNED', `${entry.action_class} may not run ${intent.action}`, {
      reason: 'action-mismatch',
      expected_action: entry.action,
      received_action: intent.action ?? null,
    });
  }
  // A posture is never defaulted. An unrecognised one is a refusal, because a
  // typo that fell through to a permissive default is the fail-open this
  // whole file exists to prevent.
  if (!POSTURES.includes(posture)) {
    return refusal('AUTONOMY_NOT_EARNED', 'the stored posture is missing or unrecognised', {
      reason: 'no-posture',
      posture: posture ?? null,
    });
  }

  const hasApproval = approval !== null && approval !== undefined;
  if (hasApproval) {
    const checked = checkApproval(approval, intent, nowIso);
    if (!checked.ok) {
      return refusal('AUTONOMY_NOT_EARNED', `the approval does not cover this intent (${checked.details.reason})`, checked.details);
    }
  } else if (posture !== 'autonomous-under-micro-limits') {
    // 'shadow' lands here deliberately: shadow means NEVER AUTONOMOUS, not
    // never possible. A human approval is the whole point of the approvals
    // queue, and a reading in which a pinned class can never be approved makes
    // the queue a dead end for the highest-risk class the product knows.
    return refusal('AUTONOMY_NOT_EARNED', `${intent.action_class} is held to human approval (${posture})`, {
      reason: 'no-approval',
      posture,
    });
  }

  const limited = checkMicroLimit(entry, intent.constraints);
  if (!limited.ok) {
    return refusal('MICRO_LIMIT_EXCEEDED', `${intent.action_class} exceeds its micro-limit`, limited.details);
  }

  // Maturity is validated BEFORE it is used, and null is one of the bad
  // values: the caller's own computation substitutes 0 for a tenant with no
  // events, and laundering "no evidence" into a legitimate 0 is the same
  // fail-open by a different door. Anything that is not a finite number —
  // undefined, null, NaN, a numeric string — is refused here, BEFORE
  // policyBand is ever called.
  if (!Number.isFinite(maturity)) {
    return refusal('MATURITY_BAND_BLOCKED', `${intent.action_class} needs a measured maturity`, {
      reason: 'maturity-unknown',
      required: entry.requiredMaturityBand,
      actual: null,
      maturity: null,
    });
  }
  const actual = labelFor(maturity);
  if (BAND_ORDER.indexOf(actual) < BAND_ORDER.indexOf(entry.requiredMaturityBand)) {
    return refusal('MATURITY_BAND_BLOCKED', `${intent.action_class} needs ${entry.requiredMaturityBand} data to act`, {
      reason: 'band-blocked',
      required: entry.requiredMaturityBand,
      actual,
      maturity,
    });
  }

  return { ok: true, intent };
}

const SIGNED_FIELDS = Object.freeze([
  'tenant', 'action_class', 'action', 'resource', 'constraints', 'maturity', 'band', 'expiry', 'nonce', 'policy_version',
]);

/** The exact bytes that are signed: a fixed field order, so a re-ordering of
 * the envelope's keys can never change what the signature covers. */
function signingBytes(envelope) {
  return JSON.stringify(SIGNED_FIELDS.map((field) => envelope[field] ?? null));
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export const DEFAULT_CAPABILITY_TTL_MS = 900_000;

/**
 * Mint a signed capability for an intent the gate has already admitted.
 *
 * The envelope carries maturity AND band because they are properties of the
 * gate decision, and SIGNING them is what makes the receipt's audit columns
 * trustworthy: the executor copies both onto the action_records row, so a
 * receipt names the band that was actually enforced on the autonomous path as
 * well as the approval path.
 *
 * expiry is min(now + ttlMs, expiresAtCap) — an approval's own expiry caps a
 * capability it authorised, so approving an item that lapses in an hour cannot
 * buy authority past that hour.
 *
 * nonce is OPTIONAL and generated internally when omitted, which is what lets
 * the approve route pass decisionNonce(approvalId) instead of assembling the
 * string itself. The caller that owns the clock owns both nowIso and the cap.
 */
export function issueCapability(intent, { secret, policyVersion, ttlMs = DEFAULT_CAPABILITY_TTL_MS, nowIso, expiresAtCap = null, nonce = null }) {
  const entry = ACTION_CLASSES.find((candidate) => candidate.action_class === intent.action_class);
  const now = Date.parse(nowIso);
  const cap = expiresAtCap ? Date.parse(expiresAtCap) : null;
  const ttl = cap === null || Number.isNaN(cap) ? now + ttlMs : Math.min(now + ttlMs, cap);
  const envelope = {
    capability_id: `cap_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    tenant: intent.tenant_id,
    action_class: intent.action_class,
    action: intent.action ?? entry?.action ?? null,
    resource: intent.resource,
    constraints: intent.constraints ?? {},
    maturity: intent.maturity ?? null,
    band: intent.maturity === undefined || intent.maturity === null ? null : labelFor(intent.maturity),
    expiry: new Date(ttl).toISOString(),
    nonce: nonce ?? `nce_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    policy_version: policyVersion,
  };
  return { ...envelope, signature: sign(signingBytes(envelope), secret) };
}

/**
 * The four scope keys the kill-switch check evaluates, in order, refusing on
 * the first active one. Every key is derivable from the SIGNED envelope with
 * nothing added to it, which is the point: a freeze is checkable by whoever
 * holds the capability, with no extra state to keep in sync.
 *
 * ('global', tenant) is stored under the tenant that raised the freeze, never
 * under a '' sentinel, because every query in repositories.js binds tenant_id.
 * ('provider', 'meta_ads') names the only provider this epic integrates, as a
 * constant so the string is written once. A provider-wide freeze blocks a
 * campaign write; a campaign-wide freeze blocks only that campaign.
 */
const KILL_SWITCH_SCOPES = Object.freeze({
  PROVIDER_SCOPE_ID: 'meta_ads',
});

function killSwitchChecks(envelope) {
  return [
    { scope: 'global', scope_id: envelope.tenant },
    { scope: 'tenant', scope_id: envelope.tenant },
    { scope: 'provider', scope_id: KILL_SWITCH_SCOPES.PROVIDER_SCOPE_ID },
    { scope: 'campaign', scope_id: envelope.resource },
  ];
}

/**
 * Structural, signature, expiry, scope, replay and kill-switch validation of a
 * capability. Both injected ports are NON-MUTATING and read-only, and the
 * difference matters:
 *
 *   killSwitches { isActive(tenantId, scope, scopeId) } — a boolean read.
 *   nonces       { seen(tenantId, nonce) }               — NEVER claim. Claiming
 *               a nonce is the executor's job; the kernel must never reserve
 *               one, or a capability that is then refused would burn it.
 *
 * The nonces port is bound to action_records rather than to capabilities: a
 * capability row exists from the moment of issuance, so binding there would
 * report every nonce as seen and answer REPLAYED_NONCE on every execution.
 * action_records holds a row only after a successful write, so seen is false
 * for a freshly issued capability. REPLAYED_NONCE is therefore defence in
 * depth that the executor's earlier dedupe shadows on the live path — it is
 * not a branch anyone should "fix" into a 409 to make reachable.
 *
 * tenantId is the CALLER's tenant. A capability is bearer material, so
 * OVER_SCOPE — the envelope naming a tenant the caller does not own — is a
 * refusal here and not a check the caller can satisfy by saying so.
 */
export function validateCapability(capability, { secret, nowIso, tenantId, killSwitches, nonces }) {
  if (capability === null || typeof capability !== 'object' || Array.isArray(capability)) {
    return refusal('MALFORMED_CAPABILITY', 'a capability must be an object', { field: null });
  }
  for (const field of [...SIGNED_FIELDS, 'capability_id', 'signature']) {
    if (capability[field] === undefined || capability[field] === null) {
      return refusal('MALFORMED_CAPABILITY', `a capability is missing ${field}`, { field });
    }
  }
  if (Number.isNaN(Date.parse(capability.expiry))) {
    return refusal('MALFORMED_CAPABILITY', 'a capability expiry is not a parseable timestamp', { field: 'expiry' });
  }
  const expected = sign(signingBytes(capability), secret);
  // Length-insensitive comparison is unnecessary and wrong here: this is a
  // public key over a public value, not a password, and the length of a
  // mismatched digest leaks nothing the caller does not already hold.
  if (capability.signature !== expected) {
    return refusal('BAD_SIGNATURE', 'the capability signature does not verify', { field: 'signature' });
  }
  if (Date.parse(capability.expiry) <= Date.parse(nowIso)) {
    return refusal('EXPIRED_CAPABILITY', 'the capability expired', { expiry: capability.expiry });
  }
  if (typeof tenantId === 'string' && capability.tenant !== tenantId) {
    return refusal('OVER_SCOPE', 'the capability names another tenant', {
      envelope_tenant: capability.tenant,
      caller_tenant: tenantId,
    });
  }
  if (nonces?.seen(capability.tenant, capability.nonce)) {
    return refusal('REPLAYED_NONCE', 'this capability nonce has already been spent', { nonce: capability.nonce });
  }
  for (const check of killSwitchChecks(capability)) {
    if (killSwitches.isActive(capability.tenant, check.scope, check.scope_id)) {
      return refusal('KILL_SWITCH_ACTIVE', `automation is frozen at ${check.scope} ${check.scope_id}`, {
        scope: check.scope,
        scope_id: check.scope_id,
      });
    }
  }
  return { ok: true, capability };
}

/**
 * Bind the secret, the policy version, the TTL and the two read-only ports, so
 * a caller never assembles a validateCapability call by hand. The ports are
 * required, not defaulted: a kernel with no way to ask about a freeze would
 * silently stop enforcing one.
 */
export function createKernel({ secret, policyVersion, ttlMs = DEFAULT_CAPABILITY_TTL_MS, killSwitches, nonces }) {
  return {
    ACTION_CLASSES,
    BAND_ORDER,
    POSTURE_LABELS,
    decisionNonce,
    validateIntent,
    issueCapability(intent, options = {}) {
      return issueCapability(intent, { secret, policyVersion, ttlMs, ...options });
    },
    validateCapability(capability, options) {
      return validateCapability(capability, { secret, killSwitches, nonces, ...options });
    },
  };
}
