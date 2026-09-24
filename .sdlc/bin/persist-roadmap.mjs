#!/usr/bin/env node
// Keeps the roadmap the maintainer's survey rebuilt, on the sdlc-state branch.
//
// The survey was told to "open ONE pull request with the roadmap change". Its pack forbids it
// to open PRs, its job could not write one, and nothing else committed roadmap.md — so every
// survey rebuilt the roadmap from nothing, and the epic dependency graph it exists to carry
// between runs was never there to read. The state branch is where the pipeline keeps what it
// writes for itself: no review gate, no CI, no conflict with a feature branch.

import { existsSync, readFileSync } from 'node:fs';
import { gh, die, repo as repoOf } from './lib/actions.js';
import { STATE_BRANCH } from './lib/state-io.js';

const repo = repoOf();
const file = 'roadmap.md';
if (!existsSync(file)) die('the survey wrote no roadmap.md — nothing to keep, and the next survey starts from nothing');
const content = Buffer.from(readFileSync(file, 'utf8')).toString('base64');

// Compare-and-swap on the file's sha, retried: every ledger write commits to this branch too,
// and a head that moved between the read and the write is a 409, not a reason to lose this.
for (let i = 0; ; i++) {
  const sha = await gh(['api', `repos/${repo}/contents/${file}?ref=${STATE_BRANCH}`, '--jq', '.sha'])
    .catch((e) => {
      if (/404|Not Found/.test(String(e.stderr ?? e.message))) return '';
      throw e;
    });
  // On stdin, as writeLedger does: a roadmap past 96 KiB is a base64 argv entry past the 128 KiB
  // Linux allows one, and E2BIG is not a 409 this loop would retry.
  try {
    await gh(['api', `repos/${repo}/contents/${file}`, '-X', 'PUT', '--input', '-'], { input: JSON.stringify({
      message: `roadmap: survey of ${new Date().toISOString().slice(0, 10)}`,
      content, branch: STATE_BRANCH, ...(sha ? { sha } : {}) }) });
    break;
  } catch (e) {
    if (i >= 4 || !/409|conflict|does not match/i.test(String(e.stderr ?? e.message))) throw e;
    await new Promise((r) => setTimeout(r, Math.random() * 200 * 2 ** i));
  }
}
process.stdout.write(`roadmap.md kept on ${STATE_BRANCH}\n`);
