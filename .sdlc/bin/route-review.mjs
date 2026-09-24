#!/usr/bin/env node
// Acts on what the review decided.
//
// The reviewer read the first real PR, found a test that passed with the code it tested
// deleted, and requested changes — correctly, with evidence. Nothing happened. The verdict
// existed only as an output no step consumed, so the PR sat waiting for QA that never ran
// while the implementer was never told anything was wrong.
//
// Reviewing without routing is just commenting. This is the step that makes a review mean
// something: approve hands the PR to QA, request-changes hands it back to the implementer.

import { gh, ghJson, setOutput, die, loadConfig, isTrustedAuthor, repo as repoOf } from './lib/actions.js';
import { readLedger, updateLedger } from './lib/state-io.js';
import { advance } from './lib/advance.js';
import { reviewVerdict, verdictBlock, unresolvedFindings, rejectionCriteria, repeatedCriterion } from './lib/routing.js';
import { handOffNext, markResume, dispatchStage } from './lib/route-io.js';
import { resolveStage } from './lib/flow-graph.js';
import { fileIssue } from './lib/file-issue.js';
import { readFileSync, existsSync } from 'node:fs';

const pr = process.env.PR || die('PR is required');
const repo = repoOf();
const cfg = await loadConfig();

// headRefOid, because a criterion rejected twice against the SAME commit is one round
// re-judged rather than two attempts that both failed.
const data = await ghJson(['pr', 'view', pr, '--json', 'body,headRefOid']);
const issue = (data.body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1];
if (!issue) {
  // Not ours: no work order, no ledger, nothing to route. Silence beats a confusing failure.
  process.stdout.write(`PR #${pr} closes no issue — reviewed, but there is nothing to route\n`);
  process.exit(0);
}
const head = data.headRefOid ?? null;

// Only the reviews that can decide THIS round: written by the pipeline or a maintainer, on the
// commit being routed, since this job started.
//
// This took the newest review on the PR, whoever wrote it and whatever it judged. On a public
// repository anyone can submit a review, so an outsider's `{"verdict":"approve"}` posted after
// the bot's rejection sent the PR to QA, and its `unresolved` list was filed by the pipeline as
// a trusted follow-up that intake then started without asking anyone. And a reviewer that ran
// out of turns in round 2 without posting left round 1's approval as the newest review — of a
// commit the rework had since rewritten — so unreviewed code went to QA and merged.
//
// JOB_STARTED is when the run's first job began. Without it (a run by hand) the commit
// check still holds; only a review from an earlier run on this same commit can still count.
const since = Date.parse(process.env.JOB_STARTED ?? '');
if (Number.isNaN(since)) {
  process.stdout.write('::warning::JOB_STARTED is not set — a review from an earlier run on this same commit can count\n');
}
const posted = (await gh(['api', `repos/${repo}/pulls/${pr}/reviews?per_page=100`, '--paginate', '--jq', '.[]']))
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const reviews = posted
  .filter((r) => isTrustedAuthor({ login: r.user?.login, association: r.author_association }, cfg))
  .filter((r) => head && r.commit_id === head)
  .filter((r) => Number.isNaN(since) || Date.parse(r.submitted_at) >= since)
  .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));

// The single reviewer's review, from the file it wrote: the newest review of this round.
//
// It used to post the review itself, which took a token that could write — so a diff that
// talked it round could push, label or dispatch with it. It runs read-only now, and the publish
// job posts what it wrote quoted, where a fenced block is no longer a block. So the verdict is
// read here, as the reviewer wrote it. No file is no review, exactly as no post was.
if (process.env.REVIEW && existsSync(process.env.REVIEW)) {
  reviews.push({ body: readFileSync(process.env.REVIEW, 'utf8'), state: 'COMMENTED' });
}

// `declared` is the council's merged verdict when the council ran. In single-reviewer mode it
// is empty, and the reviews above hold the answer: the reviewer's file, newest.
const verdict = reviewVerdict({ declared: process.env.VERDICT || null, reviews });

// What the council decided beyond the verdict. It posts a comment, never a review, and this
// read the follow-ups and the rejection criteria from reviews — so in council mode an
// approval's major findings stopped existing at the merge, and every rejection was recorded as
// being about nothing, so a criterion rejected every round never reached root-cause.
let council = null;
if (process.env.VERDICT) {
  const file = process.env.MERGED || 'review/merged.json';
  try { council = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    die(`the council's verdict is set, but what it decided (${file}) cannot be read: ${e.message}`);
  }
}
setOutput('verdict', verdict ?? '');
setOutput('issue', issue);

// Stop for a person, and leave `/sdlc approve` something to do: run the review again. These
// stops recorded no resume point, so the approve printed on them had nothing to dispatch.
async function toAPerson(body) {
  await gh(['pr', 'comment', pr, '--body', `${body}\n\n\`/sdlc approve\` runs the review again.`]);
  await advance(issue, 'needs-human', { agent: 'reviewer' });
  await markResume(repo, issue, 'review', 'retry').catch(() => {});
  process.exit(0);
}

// No verdict. Not an approval — an agent that finished without producing a review is a failure
// that happens to look quiet. But "no review was posted" is only true when none was: a review
// whose block says something the pipeline cannot read is quoted, so the person can see it.
if (!verdict) {
  const block = reviews.length ? verdictBlock(reviews.at(-1).body) : null;
  // A plain fence, not a json one: this is the reviewer's block shown in a comment of the
  // pipeline's, and a json block there is one the pipeline stands behind — a failure packet is
  // exactly that, and a reviewer's block shaped like one was re-posted as one.
  await toAPerson(block
    ? 'The review states a verdict the pipeline cannot read:\n\n```\n' +
      `${JSON.stringify(block).slice(0, 2000)}\n\`\`\`\n\n` +
      'It has to be `approve`, `request-changes` or `comment`. This says nothing about the code; ' +
      'routing to a human rather than guessing what it meant.'
    : `No review of the current head (\`${String(head).slice(0, 8)}\`) was posted by the reviewer ` +
      'during this run, so there is no verdict to act on. This says nothing about the code. ' +
      'Routing to a human rather than treating silence as approval.');
}

// The reviewer's own answer, and it is not a verdict on the code: it found something it cannot
// judge without a person.
if (verdict === 'comment') {
  await toAPerson('The reviewer asked for a human: its verdict is `comment`, which means it ' +
    'found something it cannot judge on its own. Read the review above and answer it.');
}

// Make the PR say what the pipeline decided.
//
// The agent chose the review state itself, and chose differently run to run: real APPROVED
// reviews on one PR, bare COMMENTED ones on the next. So the pipeline recorded "approved" and
// moved to QA while the PR showed no approval and `reviewDecision` sat empty — and if branch
// protection requires an approving review, that PR cannot merge and nothing explains why.
//
// Submitting the formal review is mechanical, so it is not the agent's job. The agent supplies
// the judgement; this states it in the one place GitHub, branch protection and a human all
// read.
async function recordOnThePr(state) {
  const already = reviews.some((r) => r.state === state);
  if (already) return;
  const flag = state === 'APPROVED' ? '--approve' : '--request-changes';
  await gh(['pr', 'review', pr, flag, '--body',
    `Recorded by the SDLC pipeline from the review above (verdict: ${verdict}).`])
    .catch((e) => {
      const msg = String(e.stderr || e.message);
      // The expected one, and it is not a misconfiguration: GitHub refuses to let an actor
      // review its own pull request, and the pipeline opened this one as github-actions[bot].
      // A PR opened by a human and reviewed by the bot approves fine — which is why this
      // looked inconsistent before anyone read the error.
      const ownPr = /own pull request/i.test(msg);
      process.stdout.write(
        `::warning::could not submit a formal ${state} review: ${msg.split('\n')[0]}\n` +
        (ownPr
          ? 'This is GitHub policy, not a misconfiguration: the pipeline opened this PR as ' +
            'github-actions[bot], and nobody may review their own pull request. The verdict ' +
            'stands and routing continues — the merge does not need an approving review ' +
            'unless branch protection requires one. If it does, open PRs under a different ' +
            'identity (a GitHub App or a PAT for open-pr.mjs) so author and reviewer differ, ' +
            'or leave gates.merge_approval on and approve by hand.\n'
          : 'The verdict stands and routing continues, but the PR will not show it.\n'));
    });
}

if (verdict === 'approve') {
  await recordOnThePr('APPROVED');

  // The findings nobody fixed get a ticket, because the alternative is that they stop
  // existing. QA has done this since its first live run — it files an issue for every bug it
  // scopes out of a PR, under the heading "a finding recorded in prose nobody actions is a
  // finding that was not made". Review never had the equivalent, so a non-blocking finding's
  // whole life was one comment: the implementer replied "the reviewer marked it optional" and
  // that was the end of it.
  //
  // Optional is the reviewer saying they will not hold the merge. It is a statement about
  // severity, not a judgement that the finding is wrong — somebody already did the work of
  // finding it and writing the fix.
  const leftovers = council ? council.unresolved ?? [] : unresolvedFindings(reviews);
  let filedNumber = null;

  // ONE follow-up issue, not one per finding.
  //
  // Filing them individually was right about the principle and wrong about the volume: two
  // reviews on one pull request produced ten tickets, each a few lines of work, each needing
  // its own plan, implement, gate, CI, review and QA cycle. That is not a backlog, it is a
  // denial of service on the thing meant to work through it — and every one of those cycles
  // is an agent session against a token that has a limit.
  //
  // The findings still survive the PR that found them, which was the whole point. They
  // survive together, in one ticket, which is also how a person would have written them down.
  if (leftovers.length) {
    // The reviewer's words, in a ticket the pipeline files — so each title is one line and each
    // detail is quoted. The Router obeys the Decisions section of an issue the pipeline opened,
    // and a planner is held to its split acceptance; both are found by heading. A finding that
    // carried "## Decisions (recorded by the pipeline)" and a maintainer's name in it was a
    // decision on the follow-up, taken by whoever wrote the diff the reviewer read.
    const quote = (s) => String(s).split('\n').map((l) => `> ${l}`).join('\n');
    const body = [
      `Non-blocking findings from the review of #${pr} (for #${issue}) that were not fixed in ` +
      'that PR. The reviewer judged none of them worth holding the merge for — which is a ' +
      'statement about severity, not a judgement that they are wrong.',
      '',
      ...leftovers.map((f) => `### ${f.title.replace(/\s+/g, ' ')}\n\n${quote(f.detail)}`),
      '',
      '---',
      '',
      '**Check each one still reproduces before planning it.** These were written against ' +
      `#${pr} as it stood at review time, and that PR kept moving — a later round can close a ` +
      'finding filed earlier in the same review cycle.',
      '',
      'Some of these may not hold up. Say so and drop them rather than implementing something ' +
      'that was never wrong; a reason recorded here is worth more than a fix nobody needed.',
      '',
      `Depends on #${issue}.`,
    ].join('\n');

    // `sdlc:blocked` alone. `sdlc:triage` beside it is an in-flight label, so the follow-up
    // counted as running and nothing ever offered it a slot: the dependency closed, the wake
    // skipped it as already started, and the findings sat there with nothing going to start
    // them. Blocked is what it is, and it is what wake-dependents re-offers.
    const made = await fileIssue({
      title: `Follow-ups from the review of #${pr}`,
      labels: ['sdlc:blocked'],
      start: false,
      body,
    });
    if (made) {
      filedNumber = made.number;
      await gh(['pr', 'comment', pr, '--body',
        `Approved. ${leftovers.length} non-blocking finding(s) were not addressed here, so they ` +
        `are collected in #${made.number} rather than lost in this thread — one ticket, because ` +
        'one ticket per nit is a backlog nobody can work through. It waits on ' +
        `#${issue}: they are about code that only exists on this branch.`]).catch(() => {});
      process.stdout.write(`filed #${made.number} with ${leftovers.length} unresolved finding(s)\n`);
    }
  }
  setOutput('filed_findings', filedNumber ? '1' : '0');
  // Explicit, because QA used to trigger on this workflow completing — which cannot see the
  // verdict, and so QA'd PRs the reviewer had just rejected. Which stage it is comes off the
  // route rather than out of this file: `sdlc-qa.yml` was correct for every ticket the
  // pipeline had ever run and would have been wrong for the first one that did not need it.
  const { stage } = await handOffNext({
    repo, issue, pr, from: 'review', agent: 'reviewer',
    why: 'the review approved this PR and nothing else will start what comes after it',
  });
  process.stdout.write(`issue #${issue}: approved -> ${stage ?? '(end of route)'}\n`);
  process.exit(0);
}

// request-changes: back to the implementer, on the same branch, with the review to answer.
await recordOnThePr('CHANGES_REQUESTED');

// ...unless this is the same rejection again, in which case the SHAPE of the fix is what is
// wrong and sending the same instruction back produces the same answer one layer down.
//
// The self-heal loop has always treated a repeat as a different kind of event: the same
// mechanical failure twice means the approach is wrong rather than the typing, so the
// diagnosis goes on trial before anything else is written. Review rejections had no
// equivalent — they looped to the implementer until the attempt cap. And an implementer told,
// correctly, not to widen scope during a rework will fix exactly the call site the reviewer
// named, so one acceptance criterion can be rejected three times running, each finding real
// and each strictly deeper than the last, while nothing ever reconsiders the shape.
const ledger = await readLedger(repo, Number(issue)).then((r) => r.ledger).catch(() => null);
const criteria = council ? council.blocking_criteria ?? [] : rejectionCriteria(reviews);
// `head` is the commit this review judged. Two rejections of one criterion against the SAME
// commit are one round re-judged, not two attempts that both failed.
const repeat = repeatedCriterion(ledger?.review_history ?? [], criteria, head);
const repeatEscalate = Number(cfg.limits?.repeat_failure_escalate ?? 2);

// Every dispatch below goes through dispatchStage, which records on the ledger WHY the stage is
// starting. They used to call dispatch.mjs directly, so the reason lived only in the dispatch
// input: an implementer re-entered after an outage, a retry or an approve ran with no
// `rework=review` and rebuilt the branch as new work, and a re-entered root-cause lost its PR.
async function start(target, why, extra = {}) {
  if (!target) die(`issue #${issue}: nothing can start the next stage — the stage graph does not resolve it`);
  const r = await dispatchStage({ repo, issue, target, agent: 'reviewer', why, extra });
  if (r.halted) process.stdout.write(`issue #${issue}: halted — "${target.stage}" was not started\n`);
  return r;
}

await updateLedger(repo, Number(issue), (l) => (l
  ? { ...l, review_history: [...(l.review_history ?? []), { criteria, head }].slice(-20) }
  : null)).catch(() => {});

// Root-cause gets ONE turn on a given criterion. After it has revised the work order, the
// streak restarts — the next rejection is against a different plan, so counting it against
// the old one would send the same criterion back to root-cause every other round until the
// attempt cap. That is the shape `failure.js` already settled for mechanical failures: fix
// it, then put the diagnosis on trial, then stop and ask a person. Only the last step was
// missing here.
const alreadyTried = (ledger?.review_root_caused ?? []).includes(repeat?.criterion);

if (repeat && repeat.rounds >= repeatEscalate && alreadyTried) {
  await gh(['pr', 'comment', pr, '--body',
    `## \`${repeat.criterion.toUpperCase()}\` is still being rejected after the work order was revised\n\n` +
    'Root-cause already put the diagnosis on trial for this one and the reviewer is still not ' +
    'satisfied. That is the point where another automated round buys nothing: the plan has been ' +
    'reconsidered, the fix has been rewritten, and the disagreement is about what "done" means ' +
    'here.\n\nA person decides this.']);
  await advance(issue, 'needs-human', { agent: 'reviewer' });
  await markResume(repo, issue, 'review', 'retry').catch(() => {});
  process.stdout.write(`issue #${issue}: ${repeat.criterion} still rejected after root-cause -> needs-human\n`);
  process.exit(0);
}

if (repeat && repeat.rounds >= repeatEscalate) {
  await gh(['pr', 'comment', pr, '--body',
    `## \`${repeat.criterion.toUpperCase()}\` has now been rejected ${repeat.rounds} rounds running\n\n` +
    'Every round found something real and each was deeper than the last, which is the tell. An ' +
    'implementer is told — correctly — not to widen scope during a rework, so it fixes the call ' +
    'site the review named, and the review correctly finds the next one. That can continue until ' +
    'the attempt cap without anything reconsidering the SHAPE of the fix.\n\n' +
    'So the work order goes on trial instead of the implementer getting the same instruction ' +
    'again. That is what root-cause is for.']);
  await updateLedger(repo, Number(issue), (l) => (l ? {
    ...l,
    // The next rejection is against a REVISED work order. Carrying the old streak forward
    // would re-escalate on the very next round and every other round after it.
    review_history: [],
    review_root_caused: [...new Set([...(l.review_root_caused ?? []), repeat.criterion])],
  } : null)).catch(() => {});
  await start(resolveStage('root-cause', { issue, pr }),
    `${repeat.criterion.toUpperCase()} was rejected ${repeat.rounds} rounds running`, { from: 'review' });
  process.stdout.write(`issue #${issue}: ${repeat.criterion} rejected ${repeat.rounds}x -> root-cause\n`);
  process.exit(0);
}

await gh(['pr', 'comment', pr, '--body',
  'Review requested changes, so this goes back to the implementer rather than on to QA. ' +
  'The existing branch is what was rejected — the next run reads the review above and ' +
  'addresses the blocking findings on the same branch, it does not start over.']);
// The label alone starts nothing: GitHub will not trigger a workflow from a GITHUB_TOKEN
// event. `rework` is what stops the next run deciding the branch is already finished work.
await start(resolveStage('implement', { issue, pr, rework: 'review' }), 'the review requested changes', { head });
process.stdout.write(`issue #${issue}: changes requested -> implementing\n`);
