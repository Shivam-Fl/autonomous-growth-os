// The work order being built, kept on the ledger rather than found in a comment.
//
// Every reader — fetch-work-order, open-pr, already-implemented, bump-version, apply-triage,
// dispatch-fix, QA coverage, merge-pr — used to scan the issue for the newest comment carrying a
// JSON block with `files` and `acceptance`. That was whichever comment was newest and whoever
// wrote it: an outsider's block, or an old plan quoted in a reply, became the thing the
// implementer built. And the version was the model's own choice, so a replan written as v1 was
// skipped as "already implemented".
//
// The ledger is written only by the pipeline, compare-and-swap. The comment stays, for people.

import { readLedger, updateLedger } from './state-io.js';
import { trustedComments, lastJsonBlock } from './actions.js';

/** Written immediately before the fenced block of every posted work order. */
export const WORK_ORDER_MARKER = (v) => `<!-- sdlc:work-order v${v} -->`;

const ANY_MARKER = /<!-- sdlc:work-order v\d+ -->/;
// What post-work-order headed every work order with before the marker existed.
const LEGACY_HEADING = /^## Work order v\d+/m;

const isWorkOrder = (o) => Array.isArray(o.files) && Array.isArray(o.acceptance) && o.acceptance.length > 0;

/** The version the next posted work order gets — computed, never the model's to choose. */
export function nextWorkOrderVersion(ledger) {
  return (ledger?.work_order?.version ?? ledger?.work_order_version ?? 0) + 1;
}

/**
 * Record a posted work order as THE work order, in one ledger write.
 *
 * Clears the stashes that described an earlier plan (an approved or validated one waiting to be
 * posted, a replan in flight): once this is recorded they are about something superseded.
 */
export async function recordWorkOrder(repo, issue, wo, { commentId = null, from = 'plan' } = {}) {
  return updateLedger(repo, Number(issue), (l) => {
    // Throw rather than skip: a work order posted and not recorded is the comment scan again.
    if (!l) throw new Error(`issue #${issue} has no ledger to record work order v${wo?.version} on`);
    const next = {
      ...l, work_order: wo, work_order_version: wo.version,
      work_order_posted_at: new Date().toISOString(), work_order_from: from, work_order_comment: commentId,
    };
    delete next.approved_work_order;
    delete next.validated_work_order;
    delete next.replan_requested_at;
    return next;
  });
}

/**
 * The work order to build, or null.
 *
 * The ledger's copy when there is one. Otherwise — an issue planned before the ledger held it —
 * the newest PIPELINE-authored comment that is a work order: marked, or headed the way
 * post-work-order headed them before the marker existed. Nobody else's comment is ever read.
 */
export async function readWorkOrder(repo, issue, cfg) {
  const { ledger } = await readLedger(repo, Number(issue));
  if (ledger?.work_order) return ledger.work_order;

  const comments = await trustedComments('issue', issue, cfg, { pipelineOnly: true });
  for (const c of comments.reverse()) {
    if (!ANY_MARKER.test(c.body) && !LEGACY_HEADING.test(c.body)) continue;
    const wo = lastJsonBlock(c.body, isWorkOrder);
    if (wo) return wo;
  }
  return null;
}
