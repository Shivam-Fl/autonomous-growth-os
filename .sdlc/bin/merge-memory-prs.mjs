#!/usr/bin/env node
// Merges the Librarian's own memory pull requests on a repository where nobody else will.
//
// open-memory-pr opens one a night for a person to read. With `gates.merge_approval: false` no
// person reads memory, so none was merged: memory never updated, and every night added another
// memory/<date> PR cut from the same main, each conflicting with the last on index.md. This runs
// first each night, before the Librarian reads memory again, and merges what it opened — on the
// terms a repository that lets the pipeline merge its own work already set, and no looser:
//
// - merge approval is off (with it on, a person merges these, as before);
// - the PR is this repository's, the pipeline's, from a memory/<date> branch;
// - every file it changes is under .sdlc/memory/, and none is one the guard keeps a person's
//   there (project.md, the brief, the spec index, the ADRs);
// - its CI is green by the rule the gate and the merge use, and it does not conflict.
//
// Anything else is left open and the reason logged — unless a later night's PR of the same kind
// exists, which supersedes it: each night's is cut from the default branch, so an older one left
// open only conflicts with every later one on index.md and piles up. Those are closed, with a
// comment naming the PR that superseded them, and their branches kept so a person can reopen one.
import { gh, ghJson, loadConfig, isPipelineAuthor, repo as repoOf } from './lib/actions.js';
import { reservedChanges } from './lib/guards.js';
import { checkName, classifyRollup } from './lib/checks.js';

const cfg = await loadConfig();
const repo = repoOf();
if (cfg.gates?.merge_approval !== false) {
  process.stdout.write('gates.merge_approval is on — a person merges the memory pull requests\n');
  process.exit(0);
}

// A memory PR this pipeline opened in this repository: the only kind merged, or closed as superseded.
const identity = (pr) => (!/^memory\/\d{4}-\d{2}-\d{2}$/.test(pr.headRefName) ? 'not a memory/<date> branch'
  : pr.isCrossRepository !== false ? 'it comes from a fork'
    : !isPipelineAuthor(pr.author?.login) ? `@${pr.author?.login} opened it, not the pipeline` : null);

async function refusal(pr) {
  const who = identity(pr);
  if (who) return who;
  if (pr.mergeable === 'CONFLICTING') return 'it conflicts with the base branch';
  const files = (await gh(['api', `repos/${repo}/pulls/${pr.number}/files`, '--paginate', '--jq', '.[]']))
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // Both sides of a rename: moving a lesson out of .sdlc/memory/ changes what is outside it too.
  const changes = files.map((f) => ({ path: f.filename, from: f.previous_filename,
    status: f.status === 'removed' ? 'D' : f.status === 'renamed' ? 'R' : f.status === 'added' ? 'A' : 'M' }));
  const outside = changes.flatMap((c) => [c.from, c.path]).filter((p) => p && !p.startsWith('.sdlc/memory/'));
  if (outside.length) return `it changes ${outside.join(', ')}, outside .sdlc/memory/`;
  const hits = reservedChanges({ changes, cfg, headRef: pr.headRefName });
  if (hits.length) return `it changes what a person owns: ${hits.map((h) => h.path).join(', ')}`;
  const { missing, failing, pending } = classifyRollup(pr.statusCheckRollup, cfg);
  if (failing.length) return `${failing.map(checkName).join(', ')} failed`;
  if (missing.length || pending.length) return `${[...missing, ...pending.map(checkName)].join(', ')} has not passed`;
  return null;
}

const open = await ghJson(['pr', 'list', '--state', 'open', '--limit', '200', '--json',
  'number,headRefName,headRefOid,isCrossRepository,author,mergeable,statusCheckRollup']);
// Oldest first: the order they were written in.
const memory = open.filter((p) => String(p.headRefName).startsWith('memory/')).sort((a, b) => a.number - b.number);
const left = [];
for (const pr of memory) {
  const why = await refusal(pr);
  if (why) {
    process.stdout.write(`#${pr.number} (${pr.headRefName}): left open — ${why}\n`);
    left.push({ pr, why });
    continue;
  }
  // Bound to the head whose checks were just read: a push since then is refused, not merged.
  await gh(['pr', 'merge', String(pr.number), '--squash', '--delete-branch', '--match-head-commit', pr.headRefOid])
    .then(() => process.stdout.write(`#${pr.number} (${pr.headRefName}): merged\n`))
    .catch((e) => {
      process.stdout.write(`::warning::#${pr.number} (${pr.headRefName}) could not be merged: ${String(e.message).split('\n')[0]}\n`);
      left.push({ pr, why: 'the merge itself failed' });
    });
}

// The newest of the pipeline's own, merged just now or still open, supersedes every older one left.
const newest = memory.filter((p) => !identity(p)).at(-1);
for (const { pr, why } of left.filter(({ pr: p }) => newest && !identity(p) && p.number < newest.number)) {
  await gh(['pr', 'close', String(pr.number), '--comment',
    `Superseded by #${newest.number}, a later night's memory pull request. This one was not merged (${why}), ` +
    'and every night\'s is cut from the default branch, so left open it only conflicts with each one after it. ' +
    'Closed rather than left to pile up; the branch is kept, so reopening this carries forward anything only it says.'])
    .then(() => process.stdout.write(`#${pr.number} (${pr.headRefName}): closed — superseded by #${newest.number}\n`))
    .catch((e) => process.stdout.write(`::warning::#${pr.number} (${pr.headRefName}) could not be closed: ${String(e.message).split('\n')[0]}\n`));
}
