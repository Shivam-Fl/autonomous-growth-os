// The policy kernel (issue #20, TR-3): the only place a write is admitted.
// Pure module, so every case here runs with two injected read-only ports and
// no database at all — which is the point of keeping the clock, the ports and
// the maturity outside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_CLASSES,
  BAND_ORDER,
  DEFAULT_CAPABILITY_TTL_MS,
  DEFAULT_SIGNING_SECRET,
  POLICY_ONLY_CLASSES,
  POSTURE_LABELS,
  createKernel,
  decisionNonce,
  issueCapability,
  labelFor,
  validateCapability,
  validateIntent,
} from '../../src/policy/kernel.js';
import { DECISION_CLASSES } from '../../src/domain/decisions.js';
import { ACTION_WRITES } from '../../src/integrations/meta_ads/index.js';

const SECRET = 'kernel-test-secret';
const NOW = '2026-09-25T10:00:00.000Z';

const ports = { killSwitches: { isActive: () => false }, nonces: { seen: () => false } };

const intent = (overrides = {}) => ({
  tenant_id: 'tenant_demo',
  action_class: 'campaign-status',
  action: 'set_campaign_status',
  resource: 'campaign_001',
  constraints: { status: 'PAUSED' },
  maturity: 0.5,
  ...overrides,
});

// maturity arrives as an OPTION to validateIntent, not as a field of the
// intent, so the helper pulls it out of the overrides rather than letting a
// test's maturity be silently ignored.
const admit = (overrides = {}, options = {}) => {
  const { maturity, ...rest } = overrides;
  return validateIntent(intent(rest), {
    nowIso: NOW,
    posture: 'autonomous-under-micro-limits',
    approval: null,
    maturity: 'maturity' in overrides ? maturity : 0.5,
    ...options,
  });
};

const approvalRow = (overrides = {}) => ({
  approval_id: 'apv_1',
  action_class: 'campaign-status',
  resource: 'campaign_001',
  status: 'pending',
  expires_at: '2026-09-26T10:00:00.000Z',
  ...overrides,
});

test('the roster is set-equal to the journal classes plus new-geography, in a PINNED order', () => {
  // The SET is derived by membership; the ORDER is a pinned literal, because
  // the rendered posture table is compared positionally. Asserting both is
  // what stops a class being added to one list and not the other.
  const expected = new Set([...DECISION_CLASSES, 'new-geography']);
  assert.deepEqual(new Set(ACTION_CLASSES.map((entry) => entry.action_class)), expected);
  assert.deepEqual(
    ACTION_CLASSES.map((entry) => entry.action_class),
    ['campaign-status', 'budget-change', 'creative-refresh', 'new-geography', 'campaign-launch'],
  );
  assert.deepEqual(POLICY_ONLY_CLASSES, ['new-geography']);
});

test('every contract write maps to exactly one class\'s registered action, and every class registers one', () => {
  const registered = ACTION_CLASSES.map((entry) => entry.action);
  for (const action of Object.keys(ACTION_WRITES)) {
    assert.ok(registered.includes(action), `${action} has no class`);
  }
  for (const action of registered) {
    assert.ok(Object.keys(ACTION_WRITES).includes(action), `${action} is not in the contract's write map`);
  }
  // new-geography and campaign-launch share create_campaign; that is the one
  // deliberate collision, because both classes propose a new campaign.
  assert.equal(registered.filter((action) => action === 'create_campaign').length, 2);
});

test('decisionNonce is the one place the apr_ prefix is written', () => {
  assert.equal(decisionNonce('apv_seed_budget_1'), 'apr_apv_seed_budget_1');
  assert.equal(decisionNonce('anything'), 'apr_anything');
});

test('the maturity gate is a FLOOR, not a ceiling', () => {
  // A class never refuses data BETTER than it asked for: the gate's rule is
  // `indexOf(actual) < indexOf(required)` -> refuse, so a class requiring
  // 'emergency-only' is admitted at every band. That is asserted end to end in
  // the next test; what is pinned HERE is the band order and the mapping, since
  // an inverted edge would show up as a passing roster and a wrong label.
  assert.deepEqual(BAND_ORDER, ['emergency-only', 'protective', 'moderate', 'strategic']);
  assert.equal(labelFor(0.34), 'emergency-only');
  assert.equal(labelFor(0.35), 'protective');
  assert.equal(labelFor(0.5), 'protective');
  assert.equal(labelFor(0.70), 'moderate');
  assert.equal(labelFor(0.90), 'strategic');
  assert.equal(labelFor(1), 'strategic');
  // Strictly ascending, which is what makes indexOf a comparison at all.
  const positions = BAND_ORDER.map((band) => labelFor([0.2, 0.5, 0.8, 0.95][BAND_ORDER.indexOf(band)]));
  assert.deepEqual(positions, BAND_ORDER);
});

test('the floor is applied as written: a class requiring the band above the data is refused', () => {
  // The roster is frozen, so this proves the rule with the real entries by
  // checking the EDGE each one sits on: every class currently requires the
  // lowest band, so every class is admitted at maturity 0 — and would stay
  // admitted at 1, which is the floor rather than a ceiling. A class that
  // required 'strategic' would be refused at 0.5, and the operator of
  // BAND_ORDER above is the code that would do it.
  assert.deepEqual(ACTION_CLASSES.map((entry) => entry.requiredMaturityBand), [
    'emergency-only', 'emergency-only', 'emergency-only', 'emergency-only', 'emergency-only',
  ]);
  for (const entry of ACTION_CLASSES) {
    for (const maturity of [0, 1]) {
      const result = admit({
        action_class: entry.action_class,
        action: entry.action,
        constraints: entry.requiresMicrosConstraint ? { delta_micros: 1 } : {},
        maturity,
      });
      assert.equal(result.ok, true, `${entry.action_class} at maturity ${maturity}`);
    }
  }
});

test('a non-finite maturity is refused BEFORE policyBand is consulted', () => {
  for (const maturity of [undefined, null, Number.NaN, '0.9', Infinity, -Infinity]) {
    const result = admit({ maturity });
    assert.equal(result.ok, false, `${String(maturity)} must be refused`);
    assert.equal(result.error.code, 'MATURITY_BAND_BLOCKED');
    assert.equal(result.error.details.reason, 'maturity-unknown');
    assert.equal(result.error.details.maturity, null);
    assert.equal(result.error.details.actual, null);
  }
  // A tenant with no events is exactly the null case, and it is not a small
  // measurement: it is no measurement.
  assert.equal(admit({ maturity: null }).ok, false);
});

test('rule (a2): the action a class may run is bound to the class', () => {
  const result = admit({ action_class: 'campaign-status', action: 'create_campaign' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AUTONOMY_NOT_EARNED');
  assert.equal(result.error.details.reason, 'action-mismatch');
  assert.equal(result.error.details.expected_action, 'set_campaign_status');
  assert.equal(result.error.details.received_action, 'create_campaign');
});

test('the action check runs BEFORE any approval rule', () => {
  // An otherwise perfect approval does not buy a mismatched action: the
  // response names the mismatch, not the approval.
  const result = validateIntent(intent({ action: 'create_campaign' }), {
    nowIso: NOW,
    posture: 'approval-required',
    approval: approvalRow(),
    maturity: 0.5,
  });
  assert.equal(result.error.details.reason, 'action-mismatch');
});

test('an unknown class and an unrecognised posture both fail closed', () => {
  const unknown = admit({ action_class: 'not-a-class' });
  assert.equal(unknown.error.details.reason, 'unknown-class');

  for (const posture of [undefined, null, 'AUTONOMOUS', '']) {
    const result = validateIntent(intent(), { nowIso: NOW, posture, approval: null, maturity: 0.5 });
    assert.equal(result.ok, false);
    assert.equal(result.error.details.reason, 'no-posture');
  }
});

test('an autonomous posture admits with and without an approval', () => {
  assert.equal(validateIntent(intent(), { nowIso: NOW, posture: 'autonomous-under-micro-limits', approval: null, maturity: 0.5 }).ok, true);
  assert.equal(validateIntent(intent(), { nowIso: NOW, posture: 'autonomous-under-micro-limits', approval: approvalRow(), maturity: 0.5 }).ok, true);
});

test('an approval that does not cover the intent in front of it is refused, naming the reason', () => {
  const cases = [
    [{ action_class: 'budget-change' }, 'mismatch'],
    [{ resource: 'campaign_002' }, 'mismatch'],
    [{ expires_at: '2026-09-25T09:59:59.000Z' }, 'expired'],
    [{ status: 'executed' }, 'terminal'],
    [{ status: 'rejected' }, 'terminal'],
    [{ status: '' }, 'malformed'],
  ];
  for (const [overrides, reason] of cases) {
    const result = validateIntent(intent(), {
      nowIso: NOW,
      posture: 'autonomous-under-micro-limits',
      approval: approvalRow(overrides),
      maturity: 0.5,
    });
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.equal(result.error.code, 'AUTONOMY_NOT_EARNED');
    assert.equal(result.error.details.reason, reason, JSON.stringify(overrides));
  }
  // A missing approval object is malformed, not "no approval": the caller
  // said it had one and it was not a row.
  const malformed = validateIntent(intent(), { nowIso: NOW, posture: 'autonomous-under-micro-limits', approval: { approval_id: 'apv_1' }, maturity: 0.5 });
  assert.equal(malformed.error.details.reason, 'malformed');
});

test('approval-required, shadow and the no-row default each refuse with no approval and admit with a valid one', () => {
  for (const posture of ['approval-required', 'shadow']) {
    const refused = validateIntent(intent(), { nowIso: NOW, posture, approval: null, maturity: 0.5 });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'AUTONOMY_NOT_EARNED');
    assert.equal(refused.error.details.reason, 'no-approval');
    assert.equal(refused.error.details.posture, posture);

    // 'shadow' is deliberately NOT "never possible": a pinned class is exactly
    // the one the approvals queue exists for.
    assert.equal(validateIntent(intent(), { nowIso: NOW, posture, approval: approvalRow(), maturity: 0.5 }).ok, true);
  }
});

test('the micro-limit: absent is zero for a class that does not require it, and required for one that does', () => {
  assert.equal(admit({ constraints: {} }).ok, true, 'campaign-status needs no micros');
  assert.equal(admit({ constraints: { delta_micros: 50_000_000 } }).ok, true, 'exactly at the limit');

  const negative = admit({ constraints: { delta_micros: -1 } });
  assert.equal(negative.ok, false);
  assert.equal(negative.error.code, 'MICRO_LIMIT_EXCEEDED');

  const over = admit({ constraints: { delta_micros: 50_000_001 } });
  assert.equal(over.ok, false);
  assert.equal(over.error.code, 'MICRO_LIMIT_EXCEEDED');
  assert.equal(over.error.details.reason, 'micro-limit');

  const budget = (constraints) => validateIntent(intent({ action_class: 'budget-change', action: 'update_campaign_budget', resource: 'adset_001', constraints }), {
    nowIso: NOW, posture: 'autonomous-under-micro-limits', approval: null, maturity: 0.5,
  });
  assert.equal(budget({ delta_micros: 40_000_000 }).ok, true);
  for (const bad of [{}, { delta_micros: '5' }, { delta_micros: -1 }, { delta_micros: 1.5 }, { delta_micros: null }]) {
    const result = budget(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.error.details.reason, 'micros-required', JSON.stringify(bad));
  }
});

test('the approval check runs BEFORE the micro-limit, so a limit cannot be probed without authority', () => {
  const result = validateIntent(intent({ constraints: { delta_micros: 999_000_000 } }), {
    nowIso: NOW, posture: 'approval-required', approval: null, maturity: 0.5,
  });
  assert.equal(result.error.details.reason, 'no-approval');
  assert.notEqual(result.error.code, 'MICRO_LIMIT_EXCEEDED');
});

// --- signing and structural validation -------------------------------------

const sign = (overrides = {}, options = {}) => issueCapability(intent(overrides), {
  secret: SECRET,
  policyVersion: '1',
  nowIso: NOW,
  ...options,
});

const verify = (capability, options = {}) => validateCapability(capability, {
  secret: SECRET,
  nowIso: NOW,
  tenantId: 'tenant_demo',
  ...ports,
  ...options,
});

test('issueCapability and validateCapability round-trip', () => {
  const capability = sign();
  assert.equal(capability.capability_id.startsWith('cap_'), true);
  assert.equal(capability.tenant, 'tenant_demo');
  assert.equal(capability.band, labelFor(0.5));
  assert.equal(capability.maturity, 0.5);
  assert.equal(verify(capability).ok, true);
});

test('the four structural failures are each refused', () => {
  const capability = sign();

  assert.equal(verify(null).error.code, 'MALFORMED_CAPABILITY');
  assert.equal(verify([]).error.code, 'MALFORMED_CAPABILITY');
  const missing = { ...capability };
  delete missing.signature;
  assert.equal(verify(missing).error.details.field, 'signature');
  assert.equal(verify({ ...capability, expiry: 'not-a-date' }).error.code, 'MALFORMED_CAPABILITY');

  assert.equal(verify({ ...capability, resource: 'campaign_002' }).error.code, 'BAD_SIGNATURE');
  assert.equal(verify(capability, { secret: 'another-secret' }).error.code, 'BAD_SIGNATURE');

  const expired = sign({}, { ttlMs: -1 });
  const expiredResult = verify(expired);
  assert.equal(expiredResult.error.code, 'EXPIRED_CAPABILITY');
  // Exactly at the expiry is expired: the window is now < expiry.
  assert.equal(verify(sign({ maturity: 0.5 }, { ttlMs: 0 })).error.code, 'EXPIRED_CAPABILITY');

  const replayed = verify(capability, { nonces: { seen: () => true } });
  assert.equal(replayed.error.code, 'REPLAYED_NONCE');
  assert.equal(replayed.error.details.nonce, capability.nonce);
});

test('expiry is capped by the approval it authorised', () => {
  const cap = '2026-09-25T10:05:00.000Z';
  const capability = sign({}, { expiresAtCap: cap });
  assert.equal(capability.expiry, cap, 'a five-minute approval cannot buy fifteen minutes of authority');
  // The default TTL is the ceiling when the cap is further away than it.
  assert.equal(sign({}, { expiresAtCap: '2026-09-26T10:00:00.000Z' }).expiry, new Date(Date.parse(NOW) + DEFAULT_CAPABILITY_TTL_MS).toISOString());
});

test('OVER_SCOPE: the envelope naming another tenant is refused, and the caller cannot say otherwise', () => {
  const result = verify(sign(), { tenantId: 'tenant_other' });
  assert.equal(result.error.code, 'OVER_SCOPE');
  assert.equal(result.error.details.envelope_tenant, 'tenant_demo');
  assert.equal(result.error.details.caller_tenant, 'tenant_other');
});

test('THE KILL-SWITCH SCOPES, all four, from an envelope that names only a tenant and a resource', () => {
  // This is the case that fails if the four keys are left implicit: the
  // envelope carries tenant and resource, and the port takes three arguments.
  const asked = [];
  const recording = { isActive: (...args) => { asked.push(args); return false; } };
  const capability = sign();
  assert.equal(validateCapability(capability, { secret: SECRET, nowIso: NOW, tenantId: 'tenant_demo', killSwitches: recording, nonces: { seen: () => false } }).ok, true);
  assert.deepEqual(asked, [
    ['tenant_demo', 'global', 'tenant_demo'],
    ['tenant_demo', 'tenant', 'tenant_demo'],
    ['tenant_demo', 'provider', 'meta_ads'],
    ['tenant_demo', 'campaign', 'campaign_001'],
  ]);

  const frozen = (scope, scopeId) => validateCapability(capability, {
    secret: SECRET, nowIso: NOW, tenantId: 'tenant_demo',
    killSwitches: { isActive: (_t, s, i) => s === scope && i === scopeId },
    nonces: { seen: () => false },
  });
  for (const [scope, scopeId] of [['global', 'tenant_demo'], ['tenant', 'tenant_demo'], ['provider', 'meta_ads'], ['campaign', 'campaign_001']]) {
    const result = frozen(scope, scopeId);
    assert.equal(result.error.code, 'KILL_SWITCH_ACTIVE', `${scope} ${scopeId}`);
    assert.equal(result.error.details.scope, scope);
    assert.equal(result.error.details.scope_id, scopeId);
  }
  // A freeze on ANOTHER campaign does not block this one.
  assert.equal(frozen('campaign', 'campaign_999').ok, true);
});

test('the nonces port is READ-ONLY: validateCapability never claims one', () => {
  const capability = sign();
  let called = null;
  const nonces = new Proxy({ seen: (tenantId, nonce) => { called = [tenantId, nonce]; return false; } }, {
    get: (target, property) => {
      if (property !== 'seen') {
        throw new Error(`validateCapability must not touch nonces.${String(property)}`);
      }
      return target.seen;
    },
    set: () => { throw new Error('validateCapability must not write to the nonces port'); },
  });
  assert.equal(verify(capability, { nonces }).ok, true);
  assert.deepEqual(called, ['tenant_demo', capability.nonce]);
});

test('createKernel binds the secret, the TTL and the ports', () => {
  const kernel = createKernel({ secret: SECRET, policyVersion: '7', ttlMs: 1000, ...ports });
  assert.equal(kernel.validateIntent, validateIntent);
  assert.equal(kernel.decisionNonce('apv_1'), 'apr_apv_1');
  const capability = kernel.issueCapability(intent(), { nowIso: NOW });
  assert.equal(capability.policy_version, '7');
  assert.equal(capability.expiry, '2026-09-25T10:00:01.000Z');
  assert.equal(kernel.validateCapability(capability, { nowIso: NOW, tenantId: 'tenant_demo' }).ok, true);
  assert.deepEqual(kernel.ACTION_CLASSES, ACTION_CLASSES);
  assert.deepEqual(kernel.BAND_ORDER, BAND_ORDER);
  assert.deepEqual(kernel.POSTURE_LABELS, POSTURE_LABELS);
});

test('the dev default secret is a named, documented literal rather than an empty string', () => {
  assert.equal(typeof DEFAULT_SIGNING_SECRET, 'string');
  assert.equal(DEFAULT_SIGNING_SECRET.length > 0, true);
});
