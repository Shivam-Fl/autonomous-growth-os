#!/usr/bin/env node
// Is this work order already implemented on its branch?
//
// The first real ticket on tabs wrote a complete vertical slice, pushed the branch, and then
// failed at the last step because Actions could not open a pull request. Re-dispatching
// re-ran the agent from scratch — redoing twenty minutes of work to recover from a
// permissions setting, and producing a *different* implementation of the same plan than the
// one already reviewed.
//
// A branch ahead of base, for the same work order version, is finished work — unless it was
// sent back, and has not moved since.

import { gh, ghJson, setOutput, loadConfig } from './lib/actions.js';
import { readLedger } from './lib/state-io.js';
import { readWorkOrder } from './lib/work-order.js';

const issue = process.env.ISSUE;
const branch = process.env.BRANCH ?? `sdlc/issue-${issue}`;
const base = process.env.BASE_BRANCH || 'main';
const repo = process.env.GITHUB_REPOSITORY;

const { ledger } = await readLedger(repo, Number(issue)).catch(() => ({ ledger: null }));
const pending = ledger?.pending?.stage === 'implement' ? ledger.pending : null;

// Why this run exists: the dispatch input, or what the dispatch recorded on the ledger. A retry,
// a cooldown resume or `/sdlc approve` re-enters with no inputs at all, and reading that as "no
// rework" skipped the agent on the very branch that had been rejected. Output, so the agent is
// told the same reason this decided on.
let rework = (process.env.REWORK ?? '').trim() || (pending?.rework ?? '');

const say = (finished, why) => {
  setOutput('done', String(finished));
  setOutput('rework', rework);
  process.stdout.write(why + '\n');
  process.exit(0);
};
const done = (why) => say(true, why);
const notDone = (why) => say(false, why);

const cmp = await ghJson(['api', `repos/${repo}/compare/${base}...${branch}`]).catch(() => null);
if (!cmp?.files?.length) notDone('branch has no changes yet — implementing');

const head = await gh(['api', `repos/${repo}/branches/${branch}`, '--jq', '.commit.sha']).catch(() => '');

// A person closed this branch's PR. The commit they rejected is not finished work, however far
// ahead of base it is — and it is not a base to build on either. on-close promised "a fresh
// branch" and nothing made one: the build checked out the rejected commits, the push
// fast-forwarded onto them, and open-pr proposed them again, where merge_approval false could
// merge exactly what the owner declined. So the build starts from base (`fresh`), the push
// replaces the rejected head and only that head (`rejected_head`), and the review or failure the
// rejected PR was answering is no longer this run's question. Checked before the work order's
// version, because a replan after the close is no reason to build on what was closed either.
const rejected = ledger?.rejected_pr;
if (rejected) {
  const closedAt = await gh(['pr', 'view', String(rejected.n), '--json', 'headRefOid', '--jq', '.headRefOid']).catch(() => '');
  if (!head || !closedAt || closedAt === head) {
    setOutput('fresh', 'true');
    // The head the push may replace. Unread, the one the rejected PR was closed at, and with
    // neither the push must find no branch at all: it never overwrites a head nobody saw.
    setOutput('rejected_head', head || closedAt);
    rework = '';
    notDone(`PR #${rejected.n} was closed by @${rejected.by} at this commit — building again from ${base}`);
  }
}

// A revised work order means the plan changed, so the existing work is answering the wrong
// question and must be redone. Version is the signal, not the file count — and it is the
// ledger's version, never the newest JSON block anyone commented.
const current = (await readWorkOrder(repo, issue, await loadConfig()))?.version ?? null;
const implemented = ledger?.implemented_version ?? null;
if (implemented !== current) {
  notDone(`branch implements work order v${implemented ?? '(none recorded)'}, but v${current} is current — reimplementing`);
}

// A rework is the case where an existing branch is NOT finished work — until it has been
// answered. Treating any rework as unanswered re-ran the agent over a pushed answer whenever a
// step after the push failed; treating a re-entry with no input as no rework skipped it on the
// rejected branch. The branch moving past the head the rework was asked at is the answer.
if (rework) {
  const asked = pending?.rework === rework ? pending.requested_at_head : null;
  if (asked) {
    if (head && head !== asked) done(`the ${rework} rework was already pushed (${asked} -> ${head}) — skipping the agent`);
    notDone(`rework requested (${rework}) at ${asked}, and the branch has not moved since — it is what was rejected`);
  }
  // Nobody recorded where it was asked. An open PR is then the thing sent back; with none, the
  // branch was pushed and never opened, which is the one case this script exists for.
  //
  // The ledger's PR, never `pr list --head`: that matches the branch name in every fork, so an
  // outsider's open PR from their own sdlc/issue-N read as the pipeline's PR sent back.
  const state = ledger?.pr
    ? await gh(['pr', 'view', String(ledger.pr), '--json', 'state', '--jq', '.state']).catch(() => '')
    : '';
  if (state === 'OPEN') notDone(`rework requested (${rework}) on PR #${ledger.pr} — the branch is what was rejected, not the answer to it`);
}
done(`branch ${branch} is already ${cmp.files.length} file(s) ahead of ${base} — skipping the agent and opening the PR`);
