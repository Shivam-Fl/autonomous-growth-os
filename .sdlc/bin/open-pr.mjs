#!/usr/bin/env node
// Opens the PR for an implemented work order.
//
// Deliberately NOT the agent's job. On the first live run the implementer made exactly the
// right change and pushed the branch, then simply did not open a PR — no error, nothing to
// debug, the pipeline just stopped with a correct fix sitting on a branch nobody looked at.
//
// Asking a model to perform a mechanical step means sometimes it won't, and you find out by
// noticing the absence of something. So the workflow does it: deterministic, and it fails
// loudly when it cannot.

import { gh, ghJson, setOutput, loadConfig, die } from './lib/actions.js';
import { acceptanceChecklist } from './lib/pr-body.js';

const issue = process.env.ISSUE;
const branch = process.env.BRANCH ?? `sdlc/issue-${issue}`;
// Precedence: explicit env, then config.base_branch, then the repo's default.
//
// Never a hardcoded guess. Defaulting to "main" silently targets a branch that may not exist,
// and the default branch is often not where the team integrates — plenty of repos keep
// main/master as the released state and merge to `development`. A PR opened against the wrong
// base shows every unrelated commit as part of its diff, which misleads the reviewer's caller
// analysis and QA's blast-radius reasoning long before anyone notices the merge target.
const cfg = await loadConfig();
const base = process.env.BASE_BRANCH
  || cfg.base_branch
  || (await ghJson(['repo', 'view', '--json', 'defaultBranchRef'])).defaultBranchRef?.name
  || die('could not determine a base branch — set base_branch in .sdlc/config.yml');

// A base that does not exist fails at `gh pr create` with a message about the head ref,
// which sends you looking at the wrong branch entirely.
await ghJson(['api', `repos/${process.env.GITHUB_REPOSITORY}/branches/${base}`])
  .catch(() => die(`base branch "${base}" does not exist in this repo — check base_branch in .sdlc/config.yml`));

// Already open? This runs on every implement attempt, including retries after QA failures,
// and a second PR for the same branch is worse than none.
const existing = await ghJson(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number']);
if (existing.length) {
  setOutput('pr', String(existing[0].number));
  setOutput('created', 'false');
  process.stdout.write(`PR #${existing[0].number} already open for ${branch}\n`);
  process.exit(0);
}

// Did the agent actually change anything? An empty branch means the implementer stopped —
// usually because the work order was wrong — and that deserves a clear message rather than
// an empty PR.
const cmp = await ghJson(['api', `repos/${process.env.GITHUB_REPOSITORY}/compare/${base}...${branch}`]);
if (!cmp.files?.length) {
  die(`branch ${branch} has no changes against ${base} — the implementer did not apply the work order`);
}

const issueData = await ghJson(['issue', 'view', issue, '--json', 'title,comments']);

// Pull the acceptance criteria out of the posted work order so review and QA can see what
// they are checking against without opening the issue.
let acceptance = [];
let workOrderVersion = 1;
for (const c of (issueData.comments ?? []).slice().reverse()) {
  const m = c.body?.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) continue;
  try {
    const wo = JSON.parse(m[1]);
    if (wo.acceptance) { acceptance = wo.acceptance; workOrderVersion = wo.version ?? 1; break; }
  } catch { /* not a work order block */ }
}

const changed = cmp.files.map((f) => `- \`${f.filename}\` (+${f.additions} −${f.deletions})`).join('\n');
// Shared with post-work-order.mjs, which rewrites this same section when a revision lands —
// two renderers would drift the moment either changed.
const criteria = acceptanceChecklist(acceptance).join('\n');

const body = [
  `Closes #${issue}`,
  '',
  '## Changed',
  changed,
  '',
  '## Acceptance criteria',
  criteria,
  '',
  '---',
  '_Opened by the SDLC pipeline from the approved work order on the issue. ' +
  'CI runs next, then QA against a live browser._',
].join('\n');

const url = await gh([
  'pr', 'create',
  '--base', base,
  '--head', branch,
  '--title', `fix: ${issueData.title}`,
  '--body', body,
]);

const num = url.trim().split('/').pop();
setOutput('pr', num);
setOutput('created', 'true');
// Which plan this branch answers. A later revision bumps the version, and that is the signal
// that tells a re-run whether the existing work is still the right work.
setOutput('work_order_version', String(workOrderVersion));
process.stdout.write(`opened PR #${num}: ${url.trim()}\n`);
