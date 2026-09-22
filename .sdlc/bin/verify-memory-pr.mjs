#!/usr/bin/env node
// Start CI on the memory pull request the Librarian just opened.
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

const prs = await ghJson(['pr', 'list', '--state', 'open', '--json', 'number,headRefName'])
  .catch(() => []);
const mine = prs.filter((p) => p.headRefName.startsWith('memory/'));

if (!mine.length) {
  process.stdout.write('no open memory pull request — nothing to verify\n');
  process.exit(0);
}

for (const pr of mine) {
  await gh(['workflow', 'run', 'ci-verify.yml', '-f', `pr=${pr.number}`])
    .then(() => process.stdout.write(`started ci-verify on #${pr.number} (${pr.headRefName})\n`))
    .catch((e) => process.stdout.write(
      `::warning::could not start ci-verify on #${pr.number}: ${String(e.message).split('\n')[0]}\n`));
}
