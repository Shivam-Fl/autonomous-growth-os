// The approval domain (issue #20): pure rules shared by the decide route, the
// page's partition, the seed reset and the test counts. The important property
// is that there is exactly ONE pending predicate and ONE partition, so a count
// asserted here and a card rendered on the page cannot disagree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_REASON_LENGTH,
  isPendingApproval,
  partitionApprovals,
  reasonRejection,
  validateApproval,
  visibleReason,
} from '../../src/domain/approvals.js';

const NOW = '2026-09-25T10:00:00.000Z';

const row = (overrides = {}) => ({
  approval_id: 'apv_1',
  action_class: 'campaign-status',
  action: 'set_campaign_status',
  resource: 'campaign_001',
  constraints: { status: 'PAUSED' },
  impact: 'pause brand defence',
  downside: 'brand coverage gap',
  evidence_refs: [],
  status: 'pending',
  expires_at: '2026-09-26T10:00:00.000Z',
  ...overrides,
});

const refused = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

test('validateApproval refuses an unknown action class', () => {
  assert.equal(refused(() => validateApproval(row({ action_class: 'not-a-class' }))).code, 'UNKNOWN_ACTION_CLASS');
  assert.equal(refused(() => validateApproval(row({ action_class: undefined }))).code, 'UNKNOWN_ACTION_CLASS');
  // Every class the roster knows is accepted, including the policy-only one.
  for (const actionClass of ['campaign-status', 'budget-change', 'creative-refresh', 'new-geography', 'campaign-launch']) {
    assert.ok(validateApproval(row({ action_class: actionClass })), actionClass);
  }
});

test('validateApproval refuses a non-parseable expires_at', () => {
  for (const expires of ['tomorrow', '', null, 1_700_000_000_000, undefined]) {
    assert.equal(refused(() => validateApproval(row({ expires_at: expires }))).code, 'BAD_EXPIRY', String(expires));
  }
  assert.ok(validateApproval(row({ expires_at: NOW })));
});

test('validateApproval refuses a missing impact or downside', () => {
  for (const field of ['impact', 'downside']) {
    for (const bad of [undefined, null, '', '   ', 7]) {
      const error = refused(() => validateApproval(row({ [field]: bad })));
      assert.equal(error.code, 'MISSING_FIELD', `${field}=${String(bad)}`);
      assert.equal(error.details.field, field);
    }
  }
});

test('validateApproval refuses a delta_micros that is not a non-negative safe integer', () => {
  for (const bad of [-1, 1.5, '400', Number.NaN, Infinity, 2 ** 53]) {
    const error = refused(() => validateApproval(row({ constraints: { delta_micros: bad } })));
    assert.equal(error.code, 'BAD_CONSTRAINT', String(bad));
    assert.equal(error.details.field, 'constraints.delta_micros');
  }
  assert.equal(refused(() => validateApproval(row({ constraints: [] }))).code, 'BAD_CONSTRAINTS');
  assert.equal(refused(() => validateApproval(row({ constraints: 'x' }))).code, 'BAD_CONSTRAINTS');
  // Money is integer micros (TR-1): zero and a whole number both stand.
  assert.ok(validateApproval(row({ constraints: { delta_micros: 0 } })));
  assert.ok(validateApproval(row({ constraints: { delta_micros: 40_000_000 } })));
});

test('validateApproval refuses a non-object', () => {
  for (const bad of [null, undefined, 'apv', 7, []]) {
    assert.equal(refused(() => validateApproval(bad)).code, 'MALFORMED_APPROVAL', String(bad));
  }
});

test('visibleReason returns null for a string that only looks empty', () => {
  // Each of these LOOKS empty in the input it was typed into and would be
  // stored as a reason while the audit row records nothing.
  for (const value of ['', '   ', '\n\t ', '', '‌‍', '⁠﻿', '́̈', '  \n ']) {
    assert.equal(visibleReason(value), null, JSON.stringify(value));
  }
  // ...and the non-strings, which is the other way "no reason" arrives.
  for (const value of [undefined, null, 7, {}, []]) {
    assert.equal(visibleReason(value), null, String(value));
  }
});

test('visibleReason returns the trimmed, invisible-stripped text otherwise', () => {
  assert.equal(visibleReason('  CPL doubled on brand  '), 'CPL doubled on brand');
  assert.equal(visibleReason('CPL doubled'), 'CPL doubled');
  assert.equal(visibleReason('a'), 'a');
  // The stored text is what the operator typed, not a rephrasing of it.
  const typed = '  paused because <CPA> doubled & stayed high  ';
  assert.equal(visibleReason(typed), 'paused because <CPA> doubled & stayed high');
});

test('a reason over the limit is REASON_TOO_LONG, not REASON_REQUIRED', () => {
  const long = 'x'.repeat(MAX_REASON_LENGTH + 1);
  assert.equal(visibleReason(long), null);
  const rejection = reasonRejection(long);
  assert.equal(rejection.code, 'REASON_TOO_LONG');
  assert.equal(rejection.details.length, MAX_REASON_LENGTH + 1);
  assert.equal(rejection.details.max, MAX_REASON_LENGTH);
  // Exactly at the limit stands.
  assert.ok(visibleReason('x'.repeat(MAX_REASON_LENGTH)));
  assert.equal(reasonRejection('x'.repeat(MAX_REASON_LENGTH)), null);
  // The length is measured on the TRIMMED text, so padding is not a loophole
  // in one direction or a trap in the other.
  assert.equal(reasonRejection(`  ${'x'.repeat(MAX_REASON_LENGTH)}  `), null);
});

test('isPendingApproval\'s boundary is exact: equal is not pending, a millisecond later is', () => {
  const boundary = row({ expires_at: NOW });
  assert.equal(isPendingApproval(boundary, { nowIso: NOW }), false);
  assert.equal(isPendingApproval(boundary, { nowIso: '2026-09-25T09:59:59.999Z' }), true);
  // Status and shape are the other two ways it is not pending.
  assert.equal(isPendingApproval(row({ expires_at: NOW, status: 'executed' }), { nowIso: NOW }), false);
  assert.equal(isPendingApproval(row({ expires_at: NOW, status: 'rejected' }), { nowIso: NOW }), false);
  assert.equal(isPendingApproval(row({ expires_at: 'never' }), { nowIso: NOW }), false);
  assert.equal(isPendingApproval(row({ expires_at: NOW }), { nowIso: 'never' }), false);
  assert.equal(isPendingApproval(null, { nowIso: NOW }), false);
  assert.equal(isPendingApproval('apv_1', { nowIso: NOW }), false);
});

test('partitionApprovals splits the four buckets in a deterministic order', () => {
  const rows = [
    row({ approval_id: 'apv_c', expires_at: '2026-09-26T10:00:00.000Z' }),
    row({ approval_id: 'apv_a', expires_at: '2026-09-25T12:00:00.000Z' }),
    row({ approval_id: 'apv_b', expires_at: '2026-09-25T12:00:00.000Z' }),
    row({ approval_id: 'apv_exec', status: 'executed', expires_at: '2026-09-27T10:00:00.000Z' }),
    row({ approval_id: 'apv_rej', status: 'rejected', expires_at: '2026-09-27T10:00:00.000Z' }),
    row({ approval_id: 'apv_lapsed', expires_at: '2026-09-24T10:00:00.000Z' }),
  ];
  const first = partitionApprovals(rows, { nowIso: NOW });
  assert.deepEqual(first.pending.map((entry) => entry.approval_id), ['apv_a', 'apv_b', 'apv_c']);
  assert.deepEqual(first.executed.map((entry) => entry.approval_id), ['apv_exec']);
  assert.deepEqual(first.rejected.map((entry) => entry.approval_id), ['apv_rej']);
  assert.deepEqual(first.lapsed.map((entry) => entry.approval_id), ['apv_lapsed']);

  // The same rows in a different input order render identically: ordering is
  // (expires_at, approval_id), not arrival.
  const shuffled = partitionApprovals([...rows].reverse(), { nowIso: NOW });
  assert.deepEqual(shuffled.pending.map((entry) => entry.approval_id), ['apv_a', 'apv_b', 'apv_c']);
  assert.deepEqual(shuffled.lapsed.map((entry) => entry.approval_id), ['apv_lapsed']);
});

test("'lapsed' is DERIVED from the stamp, never a stored status", () => {
  // A row whose status is literally 'lapsed' is still bucketed by the same
  // rule: anything pending-shaped that is not pending, and not executed or
  // rejected, is lapsed.
  const buckets = partitionApprovals([row({ status: 'lapsed', expires_at: '2026-09-30T10:00:00.000Z' })], { nowIso: NOW });
  assert.deepEqual(buckets.lapsed.map((entry) => entry.approval_id), ['apv_1']);
  assert.deepEqual(buckets.pending, []);
});

test('partitionApprovals copes with no rows at all', () => {
  for (const rows of [[], null, undefined]) {
    const buckets = partitionApprovals(rows, { nowIso: NOW });
    assert.deepEqual(buckets, { pending: [], executed: [], rejected: [], lapsed: [] });
  }
});
