// Approval domain (issue #20, TR-21): the rules an approval ROW is judged by,
// kept pure so the decide route, the page, the seed reset and the tests all
// read one predicate instead of four implementations of it. No IO here, and no
// repository import (conventions: a domain module never imports a driver).
//
// The roster is imported from the policy kernel rather than restated: the gate
// is what admits a write, so the list of classes that can exist is the kernel's
// list and there is no second copy to fall out of step with it.

import { ACTION_CLASSES } from '../policy/kernel.js';

export const MAX_REASON_LENGTH = 500;

// Zero-width joiners and non-joiners, a word joiner, a zero-width no-break
// space and a BOM. None of them render, so a string made only of them looks
// empty in the input the operator typed it into and would be stored as a reason
// while the audit row records nothing.
const INVISIBLE = /[‌‍⁠﻿]/g;

// Anything that renders as a mark rather than a character of its own. A reason
// made only of these survives trim() and looks empty on the page while the
// audit row records something.
const COMBINING_MARKS = /\p{M}/gu;

function approvalError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function rejection(code, message, details = {}) {
  return { code, message, details };
}

/**
 * Why a reason was refused, with a stable code, or null when it stands. Split
 * from visibleReason so the signature below can stay a plain string|null for
 * the common "is there a reason at all" question while the ROUTE still gets to
 * answer REASON_TOO_LONG distinctly from REASON_REQUIRED rather than collapsing
 * both into one 400.
 */
export function reasonRejection(value) {
  if (typeof value !== 'string') {
    return rejection('REASON_REQUIRED', 'a reason is required to decide an approval', { field: 'reason' });
  }
  const cleaned = value.replaceAll(INVISIBLE, '').trim();
  if (cleaned.length === 0) {
    return rejection('REASON_REQUIRED', 'a reason is required to decide an approval', { field: 'reason' });
  }
  if (cleaned.replaceAll(/\s/g, '').replaceAll(COMBINING_MARKS, '') === '') {
    return rejection('REASON_REQUIRED', 'a reason must contain at least one readable character', { field: 'reason' });
  }
  if (cleaned.length > MAX_REASON_LENGTH) {
    return rejection('REASON_TOO_LONG', `a reason may be at most ${MAX_REASON_LENGTH} characters`, {
      field: 'reason',
      length: cleaned.length,
      max: MAX_REASON_LENGTH,
    });
  }
  return null;
}

/**
 * The reason as it should be STORED, or null when there is none to store.
 * Invisible characters are stripped and the result is trimmed; what comes back
 * is what is written to the approval row and the audit event verbatim, and
 * escapeHtml handles it on render.
 */
export function visibleReason(value) {
  return reasonRejection(value) === null ? value.replaceAll(INVISIBLE, '').trim() : null;
}

/**
 * THE pending predicate. Pending means still awaiting a human AND not yet past
 * its stamp; an expires_at exactly equal to nowIso is NOT pending, so the
 * boundary is exclusive and a lapsed item can never be decided by racing it.
 *
 * Four consumers read this and none of them implement it: the approve route's
 * rule (2), the page's partition, the seed reset's own reasoning about which
 * fixtures it may restore, and the test counts.
 */
export function isPendingApproval(row, { nowIso }) {
  if (row === null || typeof row !== 'object') {
    return false;
  }
  if (row.status !== 'pending') {
    return false;
  }
  const expires = Date.parse(row.expires_at);
  const now = Date.parse(nowIso);
  if (Number.isNaN(expires) || Number.isNaN(now)) {
    return false;
  }
  return expires > now;
}

function byExpiryThenId(left, right) {
  if (left.expires_at !== right.expires_at) {
    return left.expires_at < right.expires_at ? -1 : 1;
  }
  if (left.approval_id === right.approval_id) {
    return 0;
  }
  return left.approval_id < right.approval_id ? -1 : 1;
}

/**
 * Split approval rows into the four buckets the screen renders, each ordered
 * (expires_at, approval_id) so the page renders identically twice in a row.
 *
 * 'lapsed' is DERIVED, never stored: it is a pending row whose stamp is at or
 * before now. A stored 'lapsed' status would be a second answer to a question
 * the expiry already answers, and the two would drift.
 *
 * What this returns and does not: it buckets APPROVAL rows, so it cannot carry
 * a receipt id, a reconciliation or a drift, because the approvals table has no
 * such columns. The executed-receipts panel is therefore NOT driven by the
 * executed bucket here — it is driven by repositories.actionRecords, and the
 * page joins the two on approval_id. Stated so the next reader does not try to
 * render a receipt out of a bucket that has none.
 */
export function partitionApprovals(rows, { nowIso }) {
  const buckets = { pending: [], executed: [], rejected: [], lapsed: [] };
  for (const row of rows ?? []) {
    if (isPendingApproval(row, { nowIso })) {
      buckets.pending.push(row);
    } else if (row.status === 'executed') {
      buckets.executed.push(row);
    } else if (row.status === 'rejected') {
      buckets.rejected.push(row);
    } else {
      buckets.lapsed.push(row);
    }
  }
  for (const bucket of Object.values(buckets)) {
    bucket.sort(byExpiryThenId);
  }
  return buckets;
}

/**
 * Shape validation for an approval row, before it is stored. This is a
 * structural check and not the autonomy gate: it refuses a row the gate could
 * not later make sense of, and says nothing about whether the class has earned
 * the right to act without it.
 */
export function validateApproval(approval) {
  if (approval === null || typeof approval !== 'object' || Array.isArray(approval)) {
    throw approvalError('MALFORMED_APPROVAL', 'an approval must be an object', { field: null });
  }
  if (!ACTION_CLASSES.some((entry) => entry.action_class === approval.action_class)) {
    throw approvalError('UNKNOWN_ACTION_CLASS', `no roster entry for ${approval.action_class}`, {
      field: 'action_class',
      action_class: approval.action_class ?? null,
    });
  }
  if (typeof approval.expires_at !== 'string' || Number.isNaN(Date.parse(approval.expires_at))) {
    throw approvalError('BAD_EXPIRY', 'expires_at must be a parseable UTC ISO-8601 timestamp', {
      field: 'expires_at',
    });
  }
  for (const field of ['impact', 'downside']) {
    if (typeof approval[field] !== 'string' || approval[field].trim().length === 0) {
      throw approvalError('MISSING_FIELD', `${field} must say what the change does and what it costs`, { field });
    }
  }
  if (approval.constraints !== undefined && (approval.constraints === null || typeof approval.constraints !== 'object' || Array.isArray(approval.constraints))) {
    throw approvalError('BAD_CONSTRAINTS', 'constraints must be an object', { field: 'constraints' });
  }
  const delta = approval.constraints?.delta_micros;
  if (delta !== undefined && (!Number.isSafeInteger(delta) || delta < 0)) {
    throw approvalError('BAD_CONSTRAINT', 'constraints.delta_micros must be a non-negative safe integer', {
      field: 'constraints.delta_micros',
    });
  }
  return { ...approval, action_class: approval.action_class, constraints: approval.constraints ?? {} };
}
