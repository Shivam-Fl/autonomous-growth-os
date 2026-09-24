#!/usr/bin/env node
// Opens the Librarian's memory pull request from what its agent handed over.
//
// The agent used to open it itself, with Bash and a token that could push any branch and
// dispatch any stage, in a run whose whole input was the day's merged PR bodies and closed
// issues — on a public repository, anyone's words. It now edits .sdlc/memory/ in a job that can
// write nothing, and this script, in a job that runs no agent, turns that into a branch and a PR.
//
// The patch is the untrusted part, so git reads it and nothing runs it. It is applied to a
// scratch index, never to this checkout: a patch that rewrote .sdlc/bin/ here would have that
// code run by the next step, holding this job's token. And what the resulting tree changes is
// checked before anything is committed — .sdlc/memory/ and plain files, or nothing at all.
// Memory is outside forbidden_paths only on a memory/* branch whose PR a person reviews, or
// merge-memory-prs merges by those same rules (lib/guards.js reservedRules), so this PR carrying
// anything else is the one thing it must not.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gh, ghJson, setOutput, die } from './lib/actions.js';

const exec = promisify(execFile);
const OUT = process.env.MEMORY_OUT ?? '_out';
const patch = join(OUT, 'memory.patch');
const bot = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
const git = (args) => exec('git', args, {
  maxBuffer: 64 * 1024 * 1024,
  env: {
    ...process.env,
    GIT_INDEX_FILE: join(process.env.RUNNER_TEMP || tmpdir(), `memory-${process.pid}.index`),
    GIT_AUTHOR_NAME: bot.name, GIT_AUTHOR_EMAIL: bot.email,
    GIT_COMMITTER_NAME: bot.name, GIT_COMMITTER_EMAIL: bot.email,
  },
}).then((r) => r.stdout);
const nothing = (why) => { process.stdout.write(`${why} — no memory pull request tonight\n`); process.exit(0); };

if (!existsSync(patch) || statSync(patch).size === 0) nothing('the librarian changed nothing in .sdlc/memory/');

await git(['read-tree', 'HEAD']);
await git(['apply', '--cached', patch])
  .catch((e) => die(`the memory patch does not apply to the commit the agent read: ${String(e.stderr || e.message).trim()}`));

// What the tree would change, as git sees it after applying — not what the patch claims.
// `--no-renames` reports both sides of a move, so a rename out of .sdlc/memory/ is caught too.
const fields = (await git(['diff-index', '--cached', '--no-renames', '-z', 'HEAD'])).split('\0');
const changes = [];
for (let i = 0; i + 1 < fields.length; i += 2) {
  const [, mode, , , status] = fields[i].slice(1).split(' ');
  changes.push({ path: fields[i + 1], mode, status });
}
// A symlink or a submodule is not a memory: a link from .sdlc/memory/ into the framework would
// have every agent read the target as a lesson, and would move with it. 000000 is a deletion.
const refused = changes.filter((c) => !c.path.startsWith('.sdlc/memory/') || !['100644', '000000'].includes(c.mode));
if (refused.length) {
  die('the memory patch reaches outside .sdlc/memory/ or is not plain files, so none of it is applied: ' +
    refused.map((c) => `${c.path} (${c.mode})`).join(', ') + '. The agent\'s handover only diffs ' +
    '.sdlc/memory/, so a patch like this was not written by it.');
}
if (!changes.length) nothing('the memory patch changes nothing');

// One branch per night, cut from the commit the agent read. Forced, so a re-run of this job
// or a second run the same day replaces the day's branch (and so its open PR) rather than
// failing: memory/* is the Librarian's namespace, and nothing else pushes to it.
const date = new Date().toISOString().slice(0, 10);
const branch = `memory/${date}`;
const commit = (await git(['commit-tree', (await git(['write-tree'])).trim(), '-p', 'HEAD', '-m',
  `memory: ${date}\n\nThe Librarian's changes to .sdlc/memory/, for a person to review.`])).trim();
await git(['push', 'origin', `+${commit}:refs/heads/${branch}`]);

// The agent's words, posted under the pipeline's name — so quoted. A heading, a marker or a
// fenced block it wrote must not read as one of the pipeline's own.
const notesFile = join(OUT, 'memory-pr.md');
const notes = existsSync(notesFile) ? readFileSync(notesFile, 'utf8').trim().slice(0, 60000) : '';
// Who merges it, said as it is. "Nothing merges this for you" stopped being true when nobody did:
// on a repo with merge approval off, merge-memory-prs merges it itself, the next night.
const body = [
  `The Librarian's changes to \`.sdlc/memory/\` for ${date}. Every agent reads this directory ` +
  'before it decides anything. With `gates.merge_approval: false` the Librarian merges this ' +
  'itself the next night, before it runs again — only while its CI is green, it does not ' +
  'conflict, and it changes nothing outside `.sdlc/memory/` or anything there a person owns ' +
  '(project.md, the brief, the spec index, the ADRs). Otherwise, and whenever merge approval ' +
  'is on, a person reads and merges it.',
  '',
  '### What the Librarian says it added, merged and deleted, and why',
  '',
  notes ? notes.split('\n').map((l) => `> ${l}`).join('\n') : '> It wrote no notes. Read the diff.',
].join('\n');

const number = await gh(['pr', 'create', '--head', branch, '--title', `memory: ${date}`, '--body', body])
  .then((url) => url.trim().split('/').pop())
  .catch(async (e) => {
    // Already open from an earlier run today: the push above updated it, so update what it
    // says. This repository's own branch only — `--head` matches a fork's memory/<date> too.
    const open = (await ghJson(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,isCrossRepository'])
      .catch(() => [])).find((p) => p.isCrossRepository === false);
    if (!open) die(`could not open the memory pull request for ${branch}: ${String(e.stderr || e.message).split('\n')[0]}`);
    await gh(['pr', 'edit', String(open.number), '--body', body]);
    return String(open.number);
  });

setOutput('pr', number);
setOutput('branch', branch);
process.stdout.write(`memory pull request #${number} from ${branch}: ${changes.length} file(s)\n`);
