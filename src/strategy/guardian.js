// The guardian (issue #20, TR-4): two deterministic detectors, the freeze they
// raise, and the human re-enable that clears it. The detectors read FIXED
// fixtures exported from here, so the trigger route, the tests and the page
// all read one set — the alternative is a live anomaly scanner, which is a
// later slice and not something this one should pretend to be.
//
// Freeze scope is an explicit argument rather than a constant because the
// issue names four levels (global, tenant, provider, campaign) and a signature
// that could only write one would not cover them. The DEFAULT is the provider
// scope because Meta Ads is the only provider this epic integrates — and the
// id that goes with it is DERIVED THROUGH THE KERNEL'S OWN FUNCTION rather than
// written here, because this module is the writer and a second literal for the
// same key is how a global freeze ended up stored under a provider id that no
// reader ever asked for.

import { randomUUID } from 'node:crypto';
import { STALE_THRESHOLD_HOURS } from '../domain/measurement.js';
import { FREEZE_SCOPES, freezeScopeId } from '../policy/kernel.js';

/** Every scope the freeze may name. The LIST is the kernel's — one roster, one
 * place — re-exported under the name this module's own callers already use. */
export { FREEZE_SCOPES };

/** The scope freeze() and reEnable() default to. Declared HERE rather than in
 * the route so the two defaults can be compared by a test: a re-enable that
 * named no scope must clear the row the demo's trigger wrote, and a re-enable
 * whose scope did not match the frozen row's would clear nothing and still
 * report success — the exact failure this default removes. */
export const DEFAULT_FREEZE_SCOPE = 'provider';

/** The provider scope's canonical key, read out of the kernel's derivation
 * rather than typed: a test can compare this with what the gate asks for
 * because both sides are the same function. */
export const DEFAULT_FREEZE_SCOPE_ID = freezeScopeId(DEFAULT_FREEZE_SCOPE, {});

export const GUARDIAN_KINDS = Object.freeze(['spend-spike', 'tracking-loss']);

/**
 * The deterministic fixtures the detectors read. Timestamps are held as
 * HOURS BEFORE NOW and resolved at read time, so the demo is live whenever it
 * runs: a fixture pinned to an absolute date would quietly become "quiet" the
 * first time the clock moved past it.
 *
 * spend-spike observes 9,000,000,000 micros over a 6h window against a
 * 7,200,000,000 baseline — a 25% overspend.
 * tracking-loss last saw a qualified event 72h ago, past the 24h threshold.
 */
export const GUARDIAN_FIXTURES = Object.freeze({
  'spend-spike': Object.freeze({
    kind: 'spend-spike',
    baseline_spend_micros: 7_200_000_000,
    window_hours: 6,
    spend_hours_ago: Object.freeze([
      Object.freeze({ hours: 1, amount_micros: 5_000_000_000 }),
      Object.freeze({ hours: 3, amount_micros: 4_000_000_000 }),
    ]),
  }),
  'tracking-loss': Object.freeze({
    kind: 'tracking-loss',
    qualified_hours_ago: Object.freeze([
      Object.freeze({ hours: 72, lead_id: 'lead_seed_stale_1' }),
      Object.freeze({ hours: 96, lead_id: 'lead_seed_stale_2' }),
    ]),
  }),
});

function resolveNow(nowIso) {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) {
    throw new Error(`guardian: nowIso is not a parseable timestamp: ${nowIso}`);
  }
  return now;
}

/** Integer micros throughout: the same rule the money invariant states, and
 * the reason a spend spike is a comparison of two integers rather than of two
 * sums a float crept into. */
export function spendSpike(fixture, { nowIso }) {
  const now = resolveNow(nowIso);
  const windowStart = now - fixture.window_hours * 3_600_000;
  let observed = 0;
  for (const entry of fixture.spend_hours_ago) {
    const at = now - entry.hours * 3_600_000;
    if (at >= windowStart && at <= now) {
      observed += entry.amount_micros;
    }
  }
  return {
    kind: 'spend-spike',
    tripped: observed > fixture.baseline_spend_micros,
    details: {
      observed_spend_micros: observed,
      baseline_spend_micros: fixture.baseline_spend_micros,
      window_hours: fixture.window_hours,
      ratio: fixture.baseline_spend_micros > 0 ? observed / fixture.baseline_spend_micros : null,
    },
  };
}

export function trackingLoss(fixture, { nowIso }) {
  const now = resolveNow(nowIso);
  const newest = fixture.qualified_hours_ago.reduce(
    (latest, entry) => Math.max(latest, now - entry.hours * 3_600_000),
    0,
  );
  const ageHours = (now - newest) / 3_600_000;
  return {
    kind: 'tracking-loss',
    tripped: ageHours > STALE_THRESHOLD_HOURS,
    details: {
      stale_age_hours: Math.round(ageHours),
      threshold_hours: STALE_THRESHOLD_HOURS,
      last_qualified_at: new Date(newest).toISOString(),
    },
  };
}

/** Dispatch on kind. An unknown kind trips nothing and says so, rather than
 * throwing inside a route that is trying to answer a browser. */
export function evaluate(fixture, { nowIso }) {
  if (fixture.kind === 'spend-spike') {
    return spendSpike(fixture, { nowIso });
  }
  if (fixture.kind === 'tracking-loss') {
    return trackingLoss(fixture, { nowIso });
  }
  return { tripped: false, kind: fixture.kind ?? 'unknown', details: { reason: 'unknown-kind' } };
}

/**
 * The deterministic recovery predicate, NAMED and EXPORTED because an earlier
 * revision invoked "the deterministic recovery predicate" without ever
 * defining it. It is the INVERSE of the matching detector: true exactly when
 * evaluate() does not trip — for a spend spike, observed spend over the window
 * is at or below the seeded baseline; for tracking loss, a qualified event
 * exists within STALE_THRESHOLD_HOURS.
 *
 * It is what an AUTOMATIC re-enable would require, and nothing in this slice
 * calls it, and that is a decision rather than an oversight: on the seeded
 * fixture the spend spike is produced by evaluating static seed data, so the
 * spike never subsides and an enforced predicate would make the re-enable
 * criterion permanently unreachable. IAC-3 asks for "explicit human OR
 * deterministic-policy re-enable" — the human half is the live route's job and
 * this is the machine half, waiting for the later slice that owns the live
 * evaluator.
 */
export function recoveryHolds(fixture, { nowIso }) {
  return evaluate(fixture, { nowIso }).tripped === false;
}

function guardianError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

/**
 * The scope_id a freeze at `scope` is WRITTEN under, and the one place the two
 * sides of the pair are allowed to disagree: never, silently. An id the kernel
 * derives is derived here too, so a caller who names a different one is
 * refused rather than obeyed — a contradiction is a mistake worth naming, not
 * a row to store where nothing will look for it.
 *
 * A campaign freeze is the one scope whose id is not derivable from a tenant
 * alone, so the caller is the only possible source for it and there is nothing
 * to contradict: any real id is the canonical one.
 */
function resolveFreezeScopeId(scope, tenantId, supplied) {
  const canonical = freezeScopeId(scope, { tenant: tenantId });
  if (supplied !== undefined) {
    if (typeof supplied !== 'string' || supplied.length === 0) {
      // A NULL in a rowid-composite primary key never matches an ON CONFLICT
      // target, so a re-trigger would append a SECOND active row that no
      // re-enable could clear. The scope_id is always a real id.
      throw guardianError('FREEZE_SCOPE_ID_REQUIRED', 'a freeze scope_id must be a real non-empty id', { scope });
    }
    if (canonical !== null && supplied !== canonical) {
      throw guardianError('FREEZE_SCOPE_ID_MISMATCH', `a ${scope} freeze is stored under ${canonical}, not ${supplied}`, {
        scope,
        scope_id: supplied,
        expected_scope_id: canonical,
      });
    }
  }
  if (canonical !== null) {
    return canonical;
  }
  if (supplied === undefined) {
    throw guardianError('FREEZE_SCOPE_ID_REQUIRED', 'a freeze scope_id must be a real non-empty id', { scope });
  }
  return supplied;
}

/**
 * Raise the freeze and record why. The kill-switch row carries the REAL
 * resolved tenant_id, never a '' global sentinel, because every query in
 * repositories.js binds tenant_id — a sentinel row would be a freeze no
 * reader could see. Incidents are appended and never updated: current state is
 * the join with the switch, and an editable incident would be a second, worse
 * source of truth.
 */
export function freeze({ repositories, tenantId, kind, details = {}, actor, scope = DEFAULT_FREEZE_SCOPE, scopeId, at = null }) {
  if (!FREEZE_SCOPES.includes(scope)) {
    throw guardianError('FREEZE_SCOPE_UNKNOWN', `a freeze scope must be one of ${FREEZE_SCOPES.join('|')}`, { scope });
  }
  const resolvedScopeId = resolveFreezeScopeId(scope, tenantId, scopeId);
  const frozenAt = at ?? new Date().toISOString();
  repositories.killSwitches.upsertFreeze({
    tenant_id: tenantId,
    scope,
    scope_id: resolvedScopeId,
    kind,
    reason: details.reason ?? `${kind} tripped`,
    actor,
    frozen_at: frozenAt,
  });
  const incidentId = `gin_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  repositories.guardianIncidents.append({
    tenant_id: tenantId,
    incident_id: incidentId,
    kind,
    details,
    frozen_at: frozenAt,
    detected_by: actor ?? 'guardian',
  });
  repositories.auditEvents.append({
    tenant_id: tenantId,
    actor: actor ?? 'guardian',
    action: 'guardian.freeze',
    subject: incidentId,
    details: { kind, scope, scope_id: resolvedScopeId, ...details },
    occurred_at: frozenAt,
  });
  return { frozen: true, scope, scope_id: resolvedScopeId, kind, incident_id: incidentId };
}

/**
 * Clear a freeze, and REPORT what was actually cleared. An EXPLICIT HUMAN
 * ACTOR is required and with none the call is refused: re-enabling automation
 * is the one operation in this slice where "the system decided to start again"
 * is not an acceptable answer. There is deliberately no recovery predicate
 * argument here — see recoveryHolds.
 *
 * A scope matching no ACTIVE row is refused with NO_ACTIVE_FREEZE rather than
 * reported as a success, because "automation is running again" is the one
 * answer an operator has to be able to trust. Such a re-enable writes no row
 * and appends no audit event, exactly as one refused for want of an actor
 * already does.
 */
export function reEnable({ repositories, tenantId, actor, scope = DEFAULT_FREEZE_SCOPE, scopeId, at = null }) {
  if (typeof actor !== 'string' || actor.trim().length === 0) {
    throw guardianError('RE_ENABLE_ACTOR_REQUIRED', 'a re-enable needs an explicit human actor', { field: 'actor' });
  }
  if (!FREEZE_SCOPES.includes(scope)) {
    throw guardianError('FREEZE_SCOPE_UNKNOWN', `a freeze scope must be one of ${FREEZE_SCOPES.join('|')}`, { scope });
  }
  const resolvedScopeId = resolveFreezeScopeId(scope, tenantId, scopeId);
  if (!repositories.killSwitches.isActive(tenantId, scope, resolvedScopeId)) {
    throw guardianError('NO_ACTIVE_FREEZE', `no active ${scope} freeze for ${resolvedScopeId}`, {
      scope,
      scope_id: resolvedScopeId,
    });
  }
  const when = at ?? new Date().toISOString();
  const row = repositories.killSwitches.reEnable(tenantId, scope, resolvedScopeId, { actor, at: when });
  repositories.auditEvents.append({
    tenant_id: tenantId,
    actor,
    action: 'guardian.re-enable',
    subject: `${scope}:${resolvedScopeId}`,
    details: { scope, scope_id: resolvedScopeId },
    occurred_at: when,
  });
  return { re_enabled: true, scope, scope_id: resolvedScopeId, row };
}

/**
 * The ONE documented exception to the actor requirement, and it is narrow on
 * purpose: clears exactly the row a live trigger writes at freeze()'s own
 * default scope, is reachable from no route, and exists so
 * scripts/seed.js --reset-approvals can put a demo database back into its
 * seeded state. The live re-enable path keeps its human-actor invariant.
 */
export function resetSeededKillSwitches({ repositories, tenantId }) {
  const at = new Date().toISOString();
  const row = repositories.killSwitches.reEnable(tenantId, DEFAULT_FREEZE_SCOPE, DEFAULT_FREEZE_SCOPE_ID, { actor: 'seed-reset', at });
  return { reset: row ? 1 : 0, scope: DEFAULT_FREEZE_SCOPE, scope_id: DEFAULT_FREEZE_SCOPE_ID };
}
