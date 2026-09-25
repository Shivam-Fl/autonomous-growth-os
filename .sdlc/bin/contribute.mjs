#!/usr/bin/env node
// Opens a self-fix on the framework's repository, from a person's own clone of it.
//
// The pipeline opens the upstream PR itself when it holds SDLC_FRAMEWORK_TOKEN. A project whose
// owner is not a collaborator on the framework has no such token to give it, and the fix would
// stay local for ever. This takes the patch the self-fix run kept (30 days), applies it here, and
// opens the PR — pushing to a fork when this account cannot push to the framework.
//
//   sdlc contribute <owner/project> <self-fix run id>     run inside a clone of the framework
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const run = (cmd, args) => exec(cmd, args, { maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout.trim());
const [project, runId] = process.argv.slice(2);
if (!project || !runId) {
  process.stderr.write('usage: sdlc contribute <owner/project> <self-fix run id>   (inside a clone of the framework)\n');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'self-fix-'));
await run('gh', ['run', 'download', runId, '-R', project, '-n', 'self-fix-patch', '-D', dir]);
const patch = join(dir, readdirSync(dir).find((f) => f.endsWith('.patch')) ?? 'self-fix.patch');

// What it fixed, from the project's own record, for the PR's title and body.
const record = await run('gh', ['api', `repos/${project}/contents/state/self-fix.json?ref=sdlc-state`, '--jq', '.content'])
  .then((b) => JSON.parse(Buffer.from(b, 'base64').toString('utf8'))).catch(() => ({}));
const fix = (record.fixes ?? []).find((f) => String(f.run) === String(runId)) ?? {};
const title = `fix(self): ${String(fix.what ?? `a pipeline defect found on ${project}`).replace(/\s+/g, ' ').slice(0, 180)}`;

const branch = `sdlc/self-fix/${project.split('/')[1]}-${runId}`;
await run('git', ['checkout', '-b', branch]);
try {
  await run('git', ['apply', '--3way', '--index', patch]);
} catch (e) {
  process.stderr.write(`the patch does not apply to this checkout — the framework has moved on since ${project} installed it:\n${e.stderr ?? e.message}\n`);
  process.exit(1);
}
await run('git', ['commit', '-q', '-m', title, '-m', `Self-fix from ${project}, run ${runId}.`]);

const upstream = await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
let head = branch;
try {
  await run('git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
} catch {
  // Not a collaborator: through a fork, which is what a pull request from outside always was.
  await run('gh', ['repo', 'fork', '--remote', '--remote-name', 'fork']).catch(() => {});
  await run('git', ['push', '-q', 'fork', `HEAD:refs/heads/${branch}`]);
  head = `${await run('gh', ['api', 'user', '--jq', '.login'])}:${branch}`;
}
const url = await run('gh', ['pr', 'create', '-R', upstream, '--head', head, '--title', title, '--body', [
  `Fixed by the pipeline itself on ${project} ([self-fix run](https://github.com/${project}/actions/runs/${runId})).`,
  '',
  fix.diagnosis ? `**Diagnosis (failure triage).** ${fix.diagnosis}` : '',
  fix.file ? `\`${fix.file}\` — ${fix.what}` : '',
  '',
  'Proven there before it merged: its regression test fails without the fix, the whole suite passes with it, and the project maintainer allowed it.',
].filter(Boolean).join('\n')]);
process.stdout.write(`${url}\n`);
