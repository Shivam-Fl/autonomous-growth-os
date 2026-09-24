#!/usr/bin/env node
// A person closed an issue, or closed the pipeline's pull request without merging it.
//
// Both are a person saying no, and neither was heard. sdlc-loop listened for merged PRs only,
// so after a close the stage already running carried on — QA could still pass and merge-pr
// still merge — the next implement found the branch and reopened the PR that had just been
// rejected, and the issue held its in-flight slot forever.
//
// A close is recorded the way `/sdlc stop` is: as a halt on the ledger, which every claim,
// verdict and hand-off writes through and refuses. It is not an error to find nothing to do —
// most closes are of issues the pipeline never touched, or of work that just merged.
import { gh, ghJson, isPipelineAuthor, repo as repoOf } from './lib/actions.js';
import { readLedger, updateLedger } from './lib/state-io.js';
import { advance } from './lib/advance.js';
import { markResume } from './lib/route-io.js';
import { retryHint } from './lib/flow-graph.js';

const repo = repoOf();
const by = process.env.ACTOR || 'someone';
const at = new Date().toISOString();
const done = (why) => { process.stdout.write(`${why} — nothing to stop\n`); process.exit(0); };

if (process.env.PR) {
  const pr = Number(process.env.PR);
  const d = await ghJson(['pr', 'view', String(pr), '--json', 'headRefName,state,author,isCrossRepository']);
  if (d.state === 'MERGED') done(`PR #${pr} merged`);
  // Only the pipeline's own PR. Anyone can open a fork PR from a branch named sdlc/issue-5 and
  // close it again; that must not halt issue #5 or unlink the PR actually being built.
  const [, kind, n] = String(d.headRefName ?? '').match(/^sdlc\/(issue|project)-(\d+)$/) ?? [];
  const issue = Number(n);
  if (!issue || d.isCrossRepository || !isPipelineAuthor(d.author?.login)) done(`PR #${pr} is not the pipeline's`);

  const { ledger } = await readLedger(repo, issue);

  // The architecture brief, declined. This matched only sdlc/issue-<n>, so closing the one PR a
  // person is asked to read went unheard: the issue kept "approve runs the maintainer", and a
  // later `/sdlc approve` split the epic against the stub architecture nobody had merged.
  if (kind === 'project') {
    if (!ledger || (ledger.brief_pr && Number(ledger.brief_pr) !== pr)) done(`issue #${issue}'s brief is not PR #${pr}`);
    await updateLedger(repo, issue, (l) => (l ? { ...l, halted: { by, at, why: `the brief PR #${pr} closed without merging by @${by}` } } : null));
    await advance(issue, 'needs-human', { agent: 'human' });
    await markResume(repo, issue, 'project', 'retry');
    await gh(['issue', 'comment', String(issue), '--body',
      `## Stopped: the architecture brief #${pr} was closed without merging\n\n` +
      `@${by} closed it, so the architecture is not on the default branch and nothing is planned here.\n\n` +
      '- `/sdlc replan-project "<what to change>"` redoes the brief with that note.\n' +
      '- `/sdlc answer "<the decision>"` settles what the brief could not, and redoes it.\n' +
      '- Closing this issue ends it.']);
    process.stdout.write(`issue #${issue}: brief PR #${pr} closed unmerged by @${by} — halted\n`);
    process.exit(0);
  }
  if (!ledger || (ledger.pr && Number(ledger.pr) !== pr)) done(`issue #${issue} is not building PR #${pr}`);

  // `rejected_pr` is what the next implement reads to start a fresh branch instead of
  // reopening this one, and `pr: null` is what stops review, QA and merge-pr acting on it.
  await updateLedger(repo, issue, (l) => (l ? {
    ...l, pr: null, rejected_pr: { n: pr, by, at },
    halted: { by, at, why: `PR #${pr} closed without merging by @${by}` },
  } : null));
  await advance(issue, 'needs-human', { agent: 'human' });
  await markResume(repo, issue, 'implement', 'retry');
  await gh(['issue', 'comment', String(issue), '--body',
    `## Stopped: PR #${pr} was closed without merging\n\n` +
    `@${by} closed it, so nothing more runs on this issue and the PR stays closed.\n\n` +
    `- ${retryHint('implement')} builds it again on a fresh branch from the current work order.\n` +
    '- `/sdlc replan "<what to do instead>"` changes the plan first.\n' +
    '- Closing this issue ends it.']);
  process.stdout.write(`issue #${issue}: PR #${pr} closed unmerged by @${by} — halted\n`);
} else {
  const issue = Number(process.env.ISSUE);
  const { ledger } = await readLedger(repo, issue);
  if (!ledger) done(`issue #${issue} was never in the pipeline`);
  if (['merged', 'done'].includes(ledger.state)) done(`issue #${issue} is ${ledger.state}`);

  // The issue's own PRs, by the numbers its ledger recorded. A listing by branch name also found
  // any fork's PR on sdlc/issue-<n>: this closed it "because @x closed #N", and a fork PR that had
  // merged made a real close read as the work finishing.
  const prs = [];
  for (const n of [ledger.pr, ledger.rejected_pr?.n].filter(Boolean)) {
    const p = await ghJson(['pr', 'view', String(n), '--json', 'state,isCrossRepository']).catch(() => null);
    if (p && !p.isCrossRepository) prs.push({ number: Number(n), state: p.state });
  }

  // A merge closes its issue too, and a person merging the pipeline's PR fires this event
  // before on-merge has recorded anything. That close is the work finishing, not a no.
  if (prs.some((p) => p.state === 'MERGED')) done(`issue #${issue} closed by its merge`);

  await updateLedger(repo, issue, (l) => (l ? { ...l, halted: { by, at, why: `issue closed by @${by}` } } : null));
  // Parked, not left at the stage it was in: a reopened issue still labelled in flight holds a
  // slot nothing is using.
  await advance(issue, 'needs-human', { agent: 'human' });
  for (const p of prs.filter((x) => x.state === 'OPEN')) {
    await gh(['pr', 'close', String(p.number), '--comment',
      `Closed because @${by} closed #${issue}, the issue this pull request was built for.`])
      .catch((e) => process.stdout.write(`::warning::could not close PR #${p.number}: ${e.message}\n`));
  }
  await gh(['issue', 'comment', String(issue), '--body',
    `Closed by @${by}, so the pipeline has stopped work on it` +
    (prs.some((x) => x.state === 'OPEN') ? ' and closed its pull request' : '') + '.\n\n' +
    // Not "`/sdlc approve` continues": the stage that was running recorded no resume point, so
    // approve would have nothing to dispatch that is not a guess.
    'Reopening does not restart it on its own — the halt stands until a person resumes it. ' +
    `After reopening, ${retryHint('planning')} starts it again from the plan.`]).catch(() => {});
  process.stdout.write(`issue #${issue}: closed by @${by} — halted\n`);
}
