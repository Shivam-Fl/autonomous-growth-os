#!/usr/bin/env node
// Lands a proven self-fix, or says why it will not, and either way leaves the issue moving.
//
// Runs in the write job, from a fresh checkout nothing the fixer or its tests touched. It takes
// the verify job's report and the maintainer's consent as inputs, and re-checks the bound itself
// on its own copy of the framework: the report came from a job that ran the agent's code.
//
// Two lanes, because the fix belongs in two places:
//   local     this repository's copy of the framework — a PR, merged, and the failed stage run
//             again on the fixed code. Not for a workflow file: GitHub refuses GITHUB_TOKEN any
//             change under .github/workflows, so that fix waits for the framework to be synced.
//   upstream  the framework's own repository — a PR for its maintainer, never merged from here.
//             With SDLC_FRAMEWORK_TOKEN it is opened directly; without one (a project whose
//             owner is not a collaborator on the framework), the patch stays on this run and
//             `sdlc contribute` opens it from a fork.
//
// Refused at any point, the issue goes to a person with the triage's diagnosis above it —
// exactly where every framework defect went before this stage existed.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { gh, loadConfig, repo as repoOf } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { loadArtifact } from './lib/artifact.js';
import { expectedChecks } from './lib/checks.js';
import { rerunTarget } from './lib/flow-graph.js';
import { dispatchStage } from './lib/route-io.js';
import { checkFix, classOf, readFix } from './lib/self-fix.js';
import { readLedger, updateLedger } from './lib/state-io.js';

const exec = promisify(execFile);
const repo = repoOf();
const issue = Number(process.env.ISSUE);
const stage = process.env.STAGE;
const failedRun = process.env.FAILED_RUN;
const runId = process.env.GITHUB_RUN_ID ?? process.env.RUN_ID ?? '';
const runUrl = process.env.RUN_URL ?? `../../actions/runs/${runId}`;
const fw = resolve(process.env.FRAMEWORK_DIR ?? 'framework');
const frameworkRepo = process.env.FRAMEWORK_REPO ?? '';
const frameworkToken = process.env.FRAMEWORK_TOKEN ?? '';
const patch = resolve(process.env.PATCH ?? 'self-fix.patch');

const cfg = await loadConfig();
const id = `${issue}-${failedRun}`;
// apply-triage wrote the diagnosis here when it started this run: the failure packet is not
// always there to carry it, and this record is what the digest and the once-per-defect rule read.
const { ledger: fixes } = await readLedger(repo, 'self-fix').catch(() => ({ ledger: null }));
const entry = fixes?.fixes?.find((f) => f.id === id) ?? {};
const defect = { file: entry.file, what: entry.what, fix: entry.fix };
const diagnosis = entry.diagnosis ?? '';

const run = (cmd, args, opts = {}) => exec(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }).then((r) => r.stdout.trim());
const say = (body) => gh(['issue', 'comment', String(issue), '--body', body])
  .catch((e) => process.stdout.write(`::warning::could not post: ${e.message}\n`));
const record = (fields) => updateLedger(repo, 'self-fix', (s) => {
  const fixes = [...(s?.fixes ?? [])];
  const i = fixes.findIndex((f) => f.id === id);
  const entry = { ...(i >= 0 ? fixes[i] : { id, issue, stage, failed_run: failedRun, file: defect.file ?? null, what: defect.what ?? null }),
    ...fields, run: runId, updated_at: new Date().toISOString() };
  if (i >= 0) fixes[i] = entry; else fixes.push({ at: entry.updated_at, ...entry });
  return { ...(s ?? {}), fixes: fixes.slice(-200) };
}).catch((e) => process.stdout.write(`::warning::could not record the self-fix: ${e.message}\n`));
// The self-fix parked the issue with a backstop `retry_after`; whatever happens now replaces it.
const unpark = () => updateLedger(repo, issue, (l) => {
  if (!l) return null;
  const next = { ...l };
  delete next.retry_after; delete next.retry_stage; delete next.parked_at;
  return next;
}).catch(() => {});

async function refuse(why, extra = {}) {
  await record({ status: 'refused', why, ...extra });
  await unpark();
  await say([
    '## The pipeline could not fix itself — stopping for a person',
    '',
    why,
    '',
    defect.file ? `The defect triage found is in \`${defect.file}\`: ${defect.what}. **The fix it proposed:** ${defect.fix}` : '',
    extra.upstream?.url ? `\nThe fix was still raised on the framework: ${extra.upstream.url}` : '',
    '',
    `\`/sdlc retry\` runs \`${stage}\` again once the framework is fixed. [Self-fix run](${runUrl})`,
  ].filter((l) => l !== '').join('\n'));
  process.stdout.write(`issue #${issue}: self-fix refused — ${why}\n`);
  process.exit(0);
}

// --- what the earlier jobs hand over, checked ------------------------------------------------
if (!existsSync(patch)) {
  await refuse(!frameworkRepo || !process.env.FRAMEWORK_SHA
    ? 'This repository does not record which framework it runs: re-install it (install.mjs writes `source_repo` to .sdlc/manifest.json) or set `self_fix.framework_repo`.'
    : process.env.FRAMEWORK_CHECKOUT === 'failure'
      ? `The framework's source at ${frameworkRepo}@${process.env.FRAMEWORK_SHA.slice(0, 7)} could not be read — a private framework needs the \`SDLC_FRAMEWORK_TOKEN\` secret, with read access to it.`
      : 'The fixer made no change: it found the defect outside what the pipeline may change about itself, or its run failed.');
}
const verify = existsSync('self-fix-verify.json') ? JSON.parse(readFileSync('self-fix-verify.json', 'utf8')) : null;
if (!verify) await refuse('The fix was never verified: the verify job left no report.');
if (!verify.ok) await refuse(`The fix is not proven:\n${(verify.problems ?? []).map((p) => `- ${p}`).join('\n') || '- the verify job did not say why'}`);
const consult = loadArtifact('self-fix-consult', 'self-fix-consult.json');
if (!consult.ok) await refuse(`The maintainer's answer could not be read: ${consult.errors.join('; ')}.`);
if (consult.data.allow !== true) await refuse(`The maintainer would not allow it: ${consult.data.reason}`);

// The bound again, on this job's own checkout. The report above came from the job that ran the
// fixer's tests; this is the one check here that nothing the agent wrote has executed near.
await run('git', ['-C', fw, 'apply', '--index', '--whitespace=nowarn', patch])
  .catch((e) => refuse(`The patch no longer applies to the framework: ${e.stderr ?? e.message}`));
const files = await readFix(fw);
const problems = checkFix(files);
if (problems.length) await refuse(`The fix is outside what the pipeline may change about itself:\n${problems.map((p) => `- ${p}`).join('\n')}`);

const title = `fix(self): ${String(defect.what ?? 'a pipeline defect').replace(/\s+/g, ' ').slice(0, 180)}`;
const body = (lane) => [
  `Fixed by the pipeline itself, after \`${stage}\` failed on ${repo}#${issue} ([failed run](${failedRun ? `https://github.com/${repo}/actions/runs/${failedRun}` : runUrl}), [self-fix run](${runUrl})).`,
  '',
  `**Diagnosis (failure triage).** ${diagnosis}`,
  defect.file ? `\n\`${defect.file}\` — ${defect.what}` : '',
  '',
  `**Maintainer.** ${consult.data.reason}`,
  ...(consult.data.concerns?.length ? consult.data.concerns.map((c) => `- ${c}`) : []),
  '',
  `**Proof.** ${verify.tests.map((t) => `\`${t}\``).join(', ')} fail without the fix and pass with it; the framework's whole suite passes.`,
  '',
  `**Bound.** ${[...new Set(files.map((f) => classOf(f.path)))].join(', ')} — no rule, no prompt, no line naming either (lib/self-fix.js).`,
  lane,
].filter((l) => l !== '').join('\n');

// --- upstream: the framework's own repository -------------------------------------------------
let upstream = null;
if (frameworkToken && frameworkRepo) {
  const branch = `sdlc/self-fix/${repo.split('/')[1]}-${issue}-${runId}`;
  const env = { ...process.env, GH_TOKEN: frameworkToken };
  try {
    const base = await run('gh', ['repo', 'view', frameworkRepo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { env });
    await run('git', ['-C', fw, '-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '-q', '-m', title, '-m', `Self-fix from ${repo}#${issue}.`]);
    // The token goes in a header for this one command, never into .git/config.
    const auth = Buffer.from(`x-access-token:${frameworkToken}`).toString('base64');
    await run('git', ['-C', fw, '-c', `http.extraheader=AUTHORIZATION: basic ${auth}`, 'push', '-q',
      `https://github.com/${frameworkRepo}.git`, `HEAD:refs/heads/${branch}`]);
    const url = await run('gh', ['pr', 'create', '-R', frameworkRepo, '--base', base, '--head', branch, '--title', title,
      '--body', body(`\nBased on ${process.env.FRAMEWORK_SHA ?? 'the version the project runs'}; the project already runs this fix locally.`)], { env });
    upstream = { url };
  } catch (e) {
    upstream = { why: `could not open it on ${frameworkRepo}: ${String(e.stderr ?? e.message).replaceAll(frameworkToken, '***').trim().slice(0, 300)}` };
  }
} else {
  upstream = { why: frameworkRepo ? 'no SDLC_FRAMEWORK_TOKEN' : 'the framework repository is unknown' };
}
const contribute = upstream.url ? '' : `\`sdlc contribute ${repo} ${runId}\` from a clone of the framework opens it (from a fork if you cannot push there) — ${upstream.why}.`;

// --- local: this repository's copy ------------------------------------------------------------
const code = files.filter((f) => classOf(f.path) !== 'regression test');
const workflows = code.filter((f) => classOf(f.path) === 'workflow wiring');
if (workflows.length) {
  await refuse(`The fix changes ${workflows.map((f) => `\`${f.path}\``).join(', ')}, and GitHub does not let the pipeline's own token change a workflow — it lands when the framework is synced.`,
    { upstream, status: 'raised' });
}

const branch = `sdlc/self-fix-${issue}-${runId}`;
try {
  await run('git', ['config', 'user.name', 'github-actions[bot]']);
  await run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  await run('git', ['checkout', '-q', '-B', branch]);
  await run('git', ['apply', '--index', '--whitespace=nowarn', ...code.map((f) => `--include=${f.path}`), patch]);
} catch (e) {
  await refuse(`The fix does not apply to this repository's copy of the framework, which has changed since it was installed: ${String(e.stderr ?? e.message).trim().slice(0, 300)}`,
    { upstream, status: 'raised' });
}
// The manifest records what was installed; the fixed files are recorded as installed, so doctor
// does not call them edits, and as self-fixes, so the next sync can say whether it keeps them.
const MANIFEST = '.sdlc/manifest.json';
if (existsSync(MANIFEST)) {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  for (const f of code) if (m.files?.[f.path]) m.files[f.path] = sha(f.path);
  m.self_fixes = [...(m.self_fixes ?? []), {
    at: new Date().toISOString(), issue, run: runId, files: Object.fromEntries(code.map((f) => [f.path, sha(f.path)])),
    upstream: upstream.url ?? null,
  }];
  writeFileSync(MANIFEST, `${JSON.stringify(m, null, 2)}\n`);
  await run('git', ['add', MANIFEST]);
}
await run('git', ['commit', '-q', '-m', title, '-m', `Self-fix for #${issue}; ${upstream.url ? `raised on the framework: ${upstream.url}` : 'not yet raised on the framework'}.`]);
// The checkout keeps no credentials; the token goes in a header for this one push.
const auth = Buffer.from(`x-access-token:${process.env.GH_TOKEN ?? ''}`).toString('base64');
await run('git', ['-c', `http.extraheader=AUTHORIZATION: basic ${auth}`, 'push', '-q', '-f',
  `https://github.com/${repo}.git`, `HEAD:refs/heads/${branch}`]);
const head = await run('git', ['rev-parse', 'HEAD']);

const local = { pr: null, merged: false };
try {
  const base = (await gh(['api', `repos/${repo}`, '--jq', '.default_branch'])).trim();
  local.pr = await gh(['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body(upstream.url ? `\nRaised on the framework: ${upstream.url}` : `\n${contribute}`)]).then((o) => o.trim());
  await gh(['pr', 'edit', local.pr, '--add-label', 'sdlc:self-fix']).catch(() => {});
  // The product is unchanged, so the product's verification has nothing new to say; the
  // framework's suite is what proved this, in the verify job. Said on this exact commit, as the
  // architecture brief does, because a PR opened with GITHUB_TOKEN starts no workflow.
  if (expectedChecks(cfg).includes('ci-verify')) {
    await gh(['api', '-X', 'POST', `repos/${repo}/statuses/${head}`, '-f', 'state=success', '-f', 'context=ci-verify',
      '-f', `description=pipeline self-fix: framework suite passed, product unchanged`, '-f', `target_url=${runUrl}`]);
  }
  await gh(['pr', 'merge', local.pr, '--squash', '--delete-branch']);
  local.merged = true;
} catch (e) {
  local.why = String(e.stderr ?? e.message).trim().slice(0, 300);
}
if (!local.merged) {
  await refuse(`The fix is proven and was opened${local.pr ? ` as ${local.pr}` : ''}, but could not be merged here: ${local.why}`,
    { upstream, local, status: 'raised' });
}

// --- the stage that hit the defect, again, on the fixed code ------------------------------------
await record({ status: 'landed', local, upstream });
await unpark();
const { ledger: now } = await readLedger(repo, issue).catch(() => ({ ledger: null }));
const target = now && !now.halted ? rerunTarget(stage, { issue, ledger: now }) : null;
await say([
  `## Fixed the pipeline itself — running \`${stage}\` again`,
  '',
  `\`${defect.file}\`: ${defect.what}. Merged ${local.pr}; ${upstream.url ? `raised on the framework as ${upstream.url}` : contribute}`,
  '',
  `The maintainer allowed it (${consult.data.reason}); its regression test fails without it and the framework's suite passes. [Self-fix run](${runUrl})`,
].join('\n'));
if (target) await dispatchStage({ repo, issue, target, agent: 'self-fix', why: 'the framework defect it failed on is fixed' });
else await advance(issue, 'needs-human', { agent: 'self-fix' }).catch(() => {});
process.stdout.write(`issue #${issue}: self-fix landed (${local.pr})${target ? `, ${stage} dispatched` : ''}\n`);
