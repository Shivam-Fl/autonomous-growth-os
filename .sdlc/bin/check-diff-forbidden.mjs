#!/usr/bin/env node
// What the branch ACTUALLY changed, against the paths a human reserved.
//
// `check-forbidden.mjs` reads the work order — which is written by the agent whose output is
// being constrained. An implementer can declare three innocent files, edit `.github/workflows`
// with its shell, and pass a check that only ever looked at the declaration. The reserved
// paths include the workflows, the schemas, the validators and the agent instructions: exactly
// the machinery that would have caught it.
//
// A prompt is not an authorization boundary and neither is a self-reported file list. This
// asks git, or GitHub.
//
// Exit codes, because the callers must tell them apart: 0 nothing reserved was touched; 2 it
// was, and (on a PR) the PR and the issue have been told and the issue parked for a person;
// 1 the change could not be listed at all. A tool error used to exit exactly like a violation,
// so a transient API failure was reported as "the diff touches reserved paths".

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reservedChanges, isTestFile } from './lib/guards.js';
import { loadConfig, setOutput, die, gh, repo } from './lib/actions.js';
const exec = promisify(execFile);

const cfg = await loadConfig();
const pr = process.env.PR;

// Two callers, two sources, both authoritative in their own context.
//
// Before the PR exists the implementer has the branch on disk, so ask git. Once it exists, ask
// GitHub for the PR's own file list: that is the diff a reviewer and a merge will see, and it
// cannot be affected by anything left in a runner's working tree.
//
// Both sides of a rename, in both modes. `--name-only` reported only the new path, so moving
// .sdlc/agents/reviewer.md to docs/ — deleting the reviewer's rules — passed.
let changes, headRef, added = {}, readPkg, meta = null;
if (pr) {
  const r = repo();
  try {
    meta = JSON.parse(await gh(['api', `repos/${r}/pulls/${pr}`]));
    const files = (await gh(['api', `repos/${r}/pulls/${pr}/files`, '--paginate', '--jq', '.[]']))
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    changes = files.map((f) => ({
      path: f.filename,
      from: f.previous_filename,
      status: f.status === 'removed' ? 'D' : f.status === 'renamed' ? 'R' : f.status === 'added' ? 'A' : 'M',
    }));
    for (const f of files) {
      if (isTestFile(f.filename) && f.patch) added[f.filename] = f.patch.split('\n').filter((l) => /^\+(?!\+\+)/.test(l));
    }
  } catch (e) { die(`could not list the files PR #${pr} changes: ${String(e.message).split('\n')[0]}`); }
  headRef = meta.head?.ref ?? '';
  readPkg = (side) => gh(['api', `repos/${r}/contents/package.json?ref=${meta[side].sha}`])
    .then((j) => Buffer.from(JSON.parse(j).content ?? '', 'base64').toString('utf8'))
    .catch(() => null);
} else {
  const base = process.env.BASE_BRANCH || die('BASE_BRANCH is required when PR is not set');
  const head = process.env.HEAD_REF || 'HEAD';
  const git = async (...args) => (await exec('git', args, { maxBuffer: 64 << 20 })).stdout;
  try {
    // --diff-filter is deliberately absent: a DELETED workflow is as much a rewrite of the rules
    // as an edited one. -z because a path may contain anything, including a newline.
    const tokens = (await git('diff', '--name-status', '-z', '-M', `${base}...${head}`)).split('\0').filter(Boolean);
    changes = [];
    for (let i = 0; i < tokens.length;) {
      const status = tokens[i++][0];
      if (status === 'R' || status === 'C') changes.push({ status: 'R', from: tokens[i++], path: tokens[i++] });
      else changes.push({ status, path: tokens[i++] });
    }
    for (const c of changes.filter((c) => c.status !== 'D' && isTestFile(c.path))) {
      added[c.path] = (await git('diff', '-U0', `${base}...${head}`, '--', c.path)).split('\n').filter((l) => /^\+(?!\+\+)/.test(l));
    }
    const mergeBase = (await git('merge-base', base, head)).trim();
    headRef = process.env.HEAD_BRANCH ?? (head === 'HEAD' ? (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim() : head);
    readPkg = (side) => git('show', `${side === 'base' ? mergeBase : head}:package.json`).catch(() => null);
  } catch (e) { die(`could not diff ${base}...${head}: ${String(e.message).split('\n')[0]}`); }
}

// The root package.json holds the scripts verify runs; compare them only when it changed.
let pkg = null;
if (changes.some((c) => c.path === 'package.json' || c.from === 'package.json')) {
  const scripts = (text) => { try { return JSON.parse(text ?? '{}').scripts ?? {}; } catch { return {}; } };
  pkg = { base: scripts(await readPkg('base')), head: scripts(await readPkg('head')) };
}

const hits = reservedChanges({ changes, cfg, headRef, added, pkg });
setOutput('changed', String(changes.length));
setOutput('violations', String(hits.length));

if (!hits.length) {
  process.stdout.write(`no reserved paths touched (${changes.length} file(s) changed)\n`);
  process.exit(0);
}

// Reserved paths are the pipeline's limits, not a person's. The gate runs on every
// `pull_request`, so an owner's own PR that edited a workflow went red here with a comment
// telling them "an agent may not change these". A PR is the pipeline's when an issue's ledger
// records it as the PR being built — the same identity the park below and merge-pr use — and a
// person pushing to that PR is still checked. Anything else merges, if at all, by a person's
// hand, which is exactly what the refusal would have asked for. An unreadable ledger is not
// "someone else's PR": it fails the step rather than waving the diff through.
let prIssue = null, prLedger = null;
if (pr) {
  prIssue = String(meta.body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1] ?? null;
  if (prIssue) {
    const { readLedger } = await import('./lib/state-io.js');
    try { ({ ledger: prLedger } = await readLedger(repo(), Number(prIssue))); }
    catch (e) { die(`could not read issue #${prIssue}'s ledger to tell whose PR #${pr} is: ${String(e.message).split('\n')[0]}`); }
  }
  if (!prLedger || String(prLedger.pr ?? '') !== String(pr)) {
    process.stdout.write(`PR #${pr} changes ${hits.length} reserved path(s), and it is not a PR the pipeline is ` +
      'building, so they are for the person who opened it to land — nothing here refuses it.\n');
    setOutput('refused', 'false');
    process.exit(0);
  }
}

const list = hits.map((h) => `  ${h.path}  (${h.rule.includes(' ') ? h.rule : `matched ${h.rule}`})`).join('\n');
process.stdout.write(`this branch changes ${hits.length} reserved path(s):\n${list}\n\n` +
  'These are reserved because they are the machinery that constrains the pipeline — workflows, ' +
  'schemas, validators, agent instructions, the approved spec, and what "green" means. The work ' +
  'order did not have to declare them for this to be caught: the diff is the authority, not the ' +
  'plan.\nA human must review and land this change deliberately.\n');

// A refusal nobody hears is a stall: the gate job went red with no comment, the ledger stayed
// at implementing, and the watchdog reported an unexplained six-hour silence. So a PR's
// refusal is posted where people look, and the issue parks for a person with the implementer
// as what `/sdlc approve` resumes.
if (pr) {
  const issue = prIssue;
  const body = `## Reserved paths — this PR needs a person\n\n\`\`\`\n${list}\n\`\`\`\n\n` +
    'An agent may not change these on its own. Land the change by hand, or `/sdlc approve` ' +
    're-runs the implementer, told to take these out.';
  await gh(['pr', 'comment', String(pr), '--body', body])
    .catch((e) => process.stdout.write(`::warning::could not comment on PR #${pr}: ${e.message}\n`));
  if (issue) {
    await gh(['issue', 'comment', issue, '--body', body.replace('this PR', `PR #${pr}`)])
      .catch((e) => process.stdout.write(`::warning::could not comment on issue #${issue}: ${e.message}\n`));
    try {
      const { advance } = await import('./lib/advance.js');
      const { markResume } = await import('./lib/route-io.js');
      const { readLedger, updateLedger } = await import('./lib/state-io.js');
      // Only the PR the issue is building parks it. Any same-repo PR can name an issue in its
      // body, and on a `pull_request` run this parked that issue at needs-human and pointed its
      // approve at the implementer, while the PR actually being built was never touched.
      const { ledger } = await readLedger(repo(), Number(issue));
      if (String(ledger?.pr ?? '') !== String(pr)) throw new Error(`it is not building PR #${pr}`);
      await advance(issue, 'needs-human', { agent: 'gate' });
      await markResume(repo(), issue, 'implement', 'retry');
      // Why the implementer runs again, and at which head. A first implementation's pending
      // rework is null, so the approve this asks for re-entered with no reason: already-
      // implemented saw a branch ahead of base for the current work order and skipped the agent,
      // and the identical diff went back to this gate, parked again, and spent a ci attempt each
      // time. A rework asked at this head is unanswered until the branch moves past it, and
      // rework-context hands the implementer the refusal above. Only for the PR the issue is
      // building: the head of any other PR whose body names it is not what the implementer answers.
      await updateLedger(repo(), Number(issue), (l) => (l && String(l.pr ?? '') === String(pr) ? { ...l, pending: {
        stage: 'implement', rework: 'reserved-paths', requested_at_head: meta.head?.sha ?? null, pr: Number(pr),
        work_order_version: l.work_order?.version ?? l.work_order_version ?? null, at: new Date().toISOString(),
      } } : null));
    } catch (e) { process.stdout.write(`::warning::issue #${issue} could not be parked: ${e.message}\n`); }
  }
}
// For the gate's failure() handler: this refusal is reported and parked, not a crash to triage.
setOutput('refused', 'true');
process.exit(2);
