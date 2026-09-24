#!/usr/bin/env node
// PR merged: advance the ledger and kick the release agent.
import { ghJson, gh, setOutput } from './lib/actions.js';
import { handOff } from './lib/handoff.js';
import { advance } from './lib/advance.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const pr = process.env.PR;
const detail = await ghJson(['pr', 'view', pr, '--json', 'body,headRefName']);
const closesOf = (d) => String(d.body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1];

// A merged REVERT takes a shipped issue's code back off the default branch.
//
// It closes nothing, so this printed "closes no issue — nothing to advance": the issue stayed
// done, and every issue that depends on it went on building against code that was gone.
// GitHub's revert button writes "Reverts owner/repo#40" and a `revert-40-…` branch.
const reverted = String(detail.body ?? '').match(/^Reverts [\w.-]+\/[\w.-]+#(\d+)/m)?.[1]
  ?? String(detail.headRefName ?? '').match(/^revert-(\d+)-/)?.[1];
if (reverted) {
  const original = await ghJson(['pr', 'view', reverted, '--json', 'body,headRefName']).catch(() => ({}));
  const undone = closesOf(original) ?? String(original.headRefName ?? '').match(/^sdlc\/issue-(\d+)$/)?.[1];
  if (!undone) {
    process.stdout.write(`PR #${pr} reverts #${reverted}, which closed no issue — nothing to reopen\n`);
    process.exit(0);
  }
  const { updateLedger } = await import('./lib/state-io.js');
  const { repo: repoOf } = await import('./lib/actions.js');
  const { dependenciesOf } = await import('./lib/deps.js');
  const { retryHint } = await import('./lib/flow-graph.js');

  await gh(['issue', 'reopen', undone]).catch((e) =>
    process.stdout.write(`::warning::could not reopen #${undone}: ${String(e.message).split('\n')[0]}\n`));
  await updateLedger(repoOf(), Number(undone), (l) => (l ? { ...l, reverted_by: Number(pr) } : null));
  // Through advance, not reconcile: every state may move to needs-human, and the labels have to
  // stop saying done.
  await advance(undone, 'needs-human', { agent: 'release' });
  await gh(['issue', 'comment', undone, '--body',
    `## Reverted in #${pr}\n\n#${reverted} shipped this, and #${pr} reverted it, so its code is no ` +
    'longer on the default branch. Reopened and parked; nothing restarts on its own.\n\n' +
    `- ${retryHint('planning')} plans it again against the default branch as it is now.\n` +
    '- `/sdlc replan "<what to do instead>"` changes the approach first.\n' +
    '- Closing this issue ends it.']);

  const open = await ghJson(['issue', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,body']);
  for (const d of open.filter((i) => dependenciesOf(i.body).includes(Number(undone)))) {
    await gh(['issue', 'comment', String(d.number), '--body',
      `#${undone}, which this issue depends on, was reverted in #${pr}: its code is no longer on ` +
      'the default branch. Anything built here on top of it needs checking before it merges.'])
      .catch((e) => process.stdout.write(`::warning::could not tell #${d.number}: ${String(e.message).split('\n')[0]}\n`));
  }
  process.stdout.write(`issue #${undone}: reverted by #${pr} — reopened, needs-human\n`);
  process.exit(0);
}

const issue = closesOf(detail);

// A merged pull request that does not CLOSE its issue still advances it.
//
// The project brief's PR deliberately carries no `Closes`: the architecture landing is not the
// end of that issue, it is the start of everything planned against it. So merging it matched
// nothing here, printed "closes no issue — nothing to advance", and the issue sat untouched.
// A person merged the brief and watched the pipeline do nothing, which is the worst possible
// answer — it looks like the merge was the wrong thing to do.
//
// The branch name is the link in that case. `sdlc/project-<n>` is written by
// apply-project-brief and by nothing else.
const advancing = issue ? null : (detail.headRefName ?? '').match(/^sdlc\/project-(\d+)$/)?.[1];

if (!issue && !advancing) {
  process.stdout.write('PR #' + pr + ' closes no issue and is not a project brief — nothing to advance\n');
  process.exit(0);
}

if (advancing) {
  // Not `merged`, and not closed: this issue continues. Hand it to whatever its route says
  // comes after the architecture decision — the maintainer on an epic, the planner otherwise.
  const { handOffNext } = await import('./lib/route-io.js');
  const { repo: repoOf } = await import('./lib/actions.js');
  await advance(advancing, 'planning', { agent: 'project-planner' }).catch(() => {});
  await gh(['issue', 'comment', String(advancing), '--body',
    `The architecture brief merged in #${pr}. \`.sdlc/memory/project.md\`, the ADRs and the ` +
    'documents under `docs/` are on the default branch now, and every ticket after this is ' +
    'planned against them.\n\nContinuing this issue — merging the brief is not the end of it.'])
    .catch(() => {});
  const { stage } = await handOffNext({
    repo: repoOf(), issue: advancing, from: 'project', agent: 'project-planner',
    why: 'the architecture brief merged, and what comes after it is on the route',
  });
  process.stdout.write(`issue #${advancing}: brief merged -> ${stage ?? '(end of route)'}\n`);
  process.exit(0);
}

const ctl = (...a) => exec('node', ['.sdlc/bin/sdlc-ctl.mjs', ...a]);
// The PR is merged — GitHub just said so. This records that fact; it does not ask the state
// machine for permission, because the merge has already happened and the steps below (release
// notes, waking whatever was blocked on this issue) must run regardless of what the ledger
// expected. merge-pr.mjs is where the pipeline is stopped from merging something unverified.
await ctl('reconcile', '--issue', issue, '--to', 'merged', '--agent', 'release',
  '--observed', `PR #${pr} merged`);
// Labels through advance(), like everything else: the ledger already says `merged` after the
// reconcile above, so its transition is a no-op and only the labels move. One writer for
// labels, or they drift from the ledger again.
await advance(issue, 'merged', { agent: 'release' });
await ctl('unlock', '--issue', issue);

// Close it ourselves. GitHub's linked-issue auto-close did not fire on a real merge with
// `Closes #3` as the first line of the PR body, squashed into the default branch — the
// issue's timeline has no `closed` event at all. Whatever the reason, an outcome the
// pipeline depends on cannot be a side effect it does not control.
//
// And everything downstream reads the issue's STATE, not its label. wake-dependents forces
// the merged issue to `closed` in its own map, so it woke the dependents correctly — and
// then intake re-checked against the real state, found this one still open, and put every
// one of them straight back to `sdlc:blocked`. Ten tickets waiting on an issue whose work
// had already shipped, with nothing left that would ever wake them again.
//
// Closed BEFORE wake-dependents, so both halves see the same fact.
await gh(['issue', 'close', String(issue), '--reason', 'completed']).catch(() => {});
// A 404 here on a fresh install means the workflow is not on the default branch yet.
await handOff('sdlc-release.yml', ['-f', `pr=${pr}`], { issue, pr, why: 'the PR merged and the release notes follow from it' });
// Whatever was waiting on this issue can start now. Done here rather than on an
// `issues.closed` trigger, because a PR closing an issue does so with GITHUB_TOKEN and
// fires no event anyone can listen for.
await exec('node', ['.sdlc/bin/wake-dependents.mjs'], {
  env: { ...process.env, CLOSED_ISSUE: String(issue) },
}).then((r) => process.stdout.write(r.stdout)).catch(async (e) => {
  // Not a nicety. Everything blocked on this issue stays blocked forever if this is missed,
  // and it is missed silently — four issues sat at `sdlc:blocked` behind a merged PR with no
  // red run anywhere, because the step before this one threw and never reached it.
  process.stdout.write(`::error::could not wake the issues blocked on #${issue}: ${e.message}\n`);
  await gh(['issue', 'comment', issue, '--body',
    `## Dependents were not woken\n\nThis merged, but the step that starts whatever was ` +
    `blocked on it failed:\n\n\`\`\`\n${String(e.message).split('\n')[0]}\n\`\`\`\n\n` +
    'Anything waiting on this issue is still parked and nothing will start it on its own. ' +
    'Re-run `wake-dependents.mjs`, or comment `/sdlc approve` on the blocked issues.']).catch(() => {});
});

// Nothing else moved `merged` to `done` — the release prompt asked a model to set the label —
// so every shipped issue sat at `merged`, and the watchdog reported each one as stalled on
// every sweep. Closed and its dependents woken: the pipeline's part is over.
await advance(issue, 'done', { agent: 'release' });

setOutput('issue', issue);
