#!/usr/bin/env node
// PR merged: advance the ledger and kick the release agent.
import { ghJson, gh, setOutput } from './lib/actions.js';
import { handOff } from './lib/handoff.js';
import { advance } from './lib/advance.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const pr = process.env.PR;
const detail = await ghJson(['pr', 'view', pr, '--json', 'body']);
const issue = (detail.body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1];
if (!issue) { process.stdout.write('PR #' + pr + ' closes no issue — nothing to advance\n'); process.exit(0); }

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

setOutput('issue', issue);
