#!/usr/bin/env node
// Start CI on the memory pull request this run just opened.
//
// That PR is opened by the pipeline's own token, so GitHub never starts its `pull_request`
// workflows — the runs exist, hold, and report `failure` with zero jobs and no check. The pull
// request then shows a red run that never ran, every night, and the person whose review it is
// waiting for has to work out that the red is not a red. One did; it cost an investigation.
//
// Dispatch is not held, which is the same reason `sdlc-gate` starts ci-verify itself for the
// pipeline's own pull requests. This PR is not part of that flow — it belongs to no issue and
// passes through no gate — so nothing was starting CI for it at all.
//
// The human review stays exactly as it was. `.sdlc/memory/` is deliberately outside
// `forbidden_paths` on the understanding that the Librarian reaches it through a reviewed PR,
// and this only makes that PR tell the truth about itself before a person reads it.
import { gh, ghJson } from './lib/actions.js';

// Only the PR this run opened, named by the step that opened it. This used to pick it out of the
// open PRs by look — a memory/ branch, this repository, the pipeline's account, opened in the
// last two hours — and a look is not an identity: a branch name is anyone's to push from a fork,
// and every other memory PR in that window passed too. The run that pushed the branch knows which
// PR it is, so it says, and nothing here reads the list at all.
const pr = process.env.PR;
const branch = process.env.BRANCH;
if (!pr || !branch) {
  process.stdout.write('no memory pull request from this run — nothing to verify\n');
  process.exit(0);
}

// And it is still that branch, in this repository, before this job's token starts CI on it.
const head = await ghJson(['pr', 'view', pr, '--json', 'headRefName,isCrossRepository']).catch(() => null);
if (head?.headRefName !== branch || head?.isCrossRepository !== false) {
  process.stdout.write(`::warning::#${pr} is not ${branch} in this repository — not starting CI on it\n`);
  process.exit(0);
}

await gh(['workflow', 'run', 'ci-verify.yml', '-f', `pr=${pr}`])
  .then(() => process.stdout.write(`started ci-verify on #${pr} (${branch})\n`))
  .catch((e) => process.stdout.write(
    `::warning::could not start ci-verify on #${pr}: ${String(e.message).split('\n')[0]}\n`));
