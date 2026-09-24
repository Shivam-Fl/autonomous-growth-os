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

import { gh, ghJson, setOutput, loadConfig, die, isPipelineAuthor } from './lib/actions.js';
import { acceptanceChecklist } from './lib/pr-body.js';
import { readWorkOrder } from './lib/work-order.js';
import { readLedger, updateLedger } from './lib/state-io.js';
import { retryHint } from './lib/flow-graph.js';

const issue = process.env.ISSUE;
const repo = process.env.GITHUB_REPOSITORY;
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
await ghJson(['api', `repos/${repo}/branches/${base}`])
  .catch(() => die(`base branch "${base}" does not exist in this repo — check base_branch in .sdlc/config.yml`));

// The work order the branch answers, from the ledger — never the newest JSON block in the
// comments. That was anyone's block: an outsider's acceptance criteria became the checklist
// review and QA judged the PR against, and a /sdlc status dump (`acceptance: []`) listed none.
const wo = await readWorkOrder(repo, issue, cfg)
  ?? die(`no work order recorded for issue #${issue} — refusing to open a PR nothing planned`);
const workOrderVersion = wo.version ?? 1;

const { ledger } = await readLedger(repo, Number(issue)).catch(() => ({ ledger: null }));

// Already open? This runs on every implement attempt, including retries after QA failures,
// and a second PR for the same branch is worse than none.
//
// Only the pipeline's own PR. `gh pr list --head <branch>` matches that branch name in EVERY
// repository, forks included, and taking the first answer recorded an outsider's fork PR from
// their own sdlc/issue-5 as ledger.pr: the gate ran on it with a write token, and every stage
// after it acted on whatever issue its body named. The ledger is the PR's identity and this is
// the one place that finds one, so every other reader takes ledger.pr and never lists.
//
// It says which version the branch now answers on this path too. It used to only on the create
// path, so implemented_version stayed at the first PR's version forever and a replan built on
// that PR looked, to the next re-entry, like work already done.
const ours = (p) => p && p.isCrossRepository === false && isPipelineAuthor(p.author?.login);
let existing = null;
if (ledger?.pr) {
  const p = await ghJson(['pr', 'view', String(ledger.pr), '--json', 'number,state,headRefName,isCrossRepository,author'])
    .catch(() => null);
  if (p?.state === 'OPEN' && p.headRefName === branch && ours(p)) existing = p;
}
existing ??= (await ghJson(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,isCrossRepository,author']))
  .find(ours) ?? null;
if (existing) {
  setOutput('pr', String(existing.number));
  setOutput('created', 'false');
  setOutput('work_order_version', String(workOrderVersion));
  process.stdout.write(`PR #${existing.number} already open for ${branch}\n`);
  process.exit(0);
}

// A person closed this branch's last PR. Opening a fresh one from the same branch is the
// pipeline overruling them: a triage "resume" already in flight skipped the agent, found no
// OPEN PR and opened #47 from the commit the owner had just rejected, and it merged. Only a
// person resuming the issue after that close lets a new one open.
const rejected = ledger?.rejected_pr;
if (rejected) {
  const resumed = (ledger.history ?? []).filter((h) => h.agent === 'human').map((h) => String(h.at)).sort().at(-1);
  if (!resumed || resumed < String(rejected.at)) {
    die(`PR #${rejected.n} for this branch was closed by @${rejected.by} — not opening another from it. ` +
        `A person resumes the issue (${retryHint('implement')}) when it should be built again.`);
  }
  // And the resume is a rebuild, not a reopening. The retry after a close satisfied the check
  // above and the build ran on the rejected commits, so a PR opened from that head proposed
  // again exactly what the owner declined. A head nobody could read is not proof it moved.
  const [was, now] = await Promise.all([
    gh(['pr', 'view', String(rejected.n), '--json', 'headRefOid', '--jq', '.headRefOid']).catch(() => ''),
    gh(['api', `repos/${repo}/branches/${branch}`, '--jq', '.commit.sha']).catch(() => ''),
  ]);
  if (!was || !now || was === now) {
    die(`${branch} is still at ${now || 'a head that could not be read'}, the commit PR #${rejected.n} was closed at — ` +
        'not proposing it again. The rebuild starts from the base branch and pushes over it.');
  }
}

// Did the agent actually change anything? An empty branch means the implementer stopped —
// usually because the work order was wrong — and that deserves a clear message rather than
// an empty PR.
const cmp = await ghJson(['api', `repos/${repo}/compare/${base}...${branch}`]);
if (!cmp.files?.length) {
  die(`branch ${branch} has no changes against ${base} — the implementer did not apply the work order`);
}

const issueData = await ghJson(['issue', 'view', issue, '--json', 'title']);

// The acceptance criteria, so review and QA can see what they are checking against without
// opening the issue.
const acceptance = wo.acceptance ?? [];

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
// The close is answered. Left standing, the next re-entry that could not read the closed PR's
// head would take this branch for the rejected one and rebuild over the new PR's work.
if (rejected) {
  await updateLedger(repo, Number(issue), (l) => { if (!l?.rejected_pr) return null; delete l.rejected_pr; })
    .catch((e) => process.stdout.write(`::warning::could not clear rejected_pr on issue #${issue}: ${e.message}\n`));
}
setOutput('pr', num);
setOutput('created', 'true');
// Which plan this branch answers. A later revision bumps the version, and that is the signal
// that tells a re-run whether the existing work is still the right work.
setOutput('work_order_version', String(workOrderVersion));
process.stdout.write(`opened PR #${num}: ${url.trim()}\n`);
