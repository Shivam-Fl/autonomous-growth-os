#!/usr/bin/env node
// Start the CI that gates this PR, because nothing else will.
//
// The pipeline pushes as github-actions[bot], and GitHub holds bot-triggered `pull_request`
// runs at `action_required` until a human approves them. A held run produces no check, so the
// PR has no CI at all — and the gate, reading an empty rollup, cannot tell that apart from a
// repo that simply has no CI configured. It proceeded, and a PR reached review and QA with
// nothing verified.
//
// Waiting for a human is not a fix: it turns every rework into a manual step. So the gate
// starts the run itself. Dispatch is the one trigger GitHub does not hold.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gh, ghJson, setOutput, loadConfig, triggersOf } from './lib/actions.js';
import { load } from './lib/js-yaml.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const pr = process.env.PR;
const cfg = await loadConfig();
const mode = cfg.verify?.mode ?? 'own';

const done = (why, dispatched = false) => {
  process.stdout.write(`${why}\n`);
  setOutput('dispatched', String(dispatched));
  process.exit(0);
};

if (mode === 'none') done('verify.mode is "none" — nothing gates this PR, so there is nothing to start');

// A flake is answered by running the check again, not by the implementer. A triage that read the
// log and called a red check transient — or a cooldown ending on one — dispatches the gate with
// RERUN_FAILED, and the gate used to re-read the same red rollup: the flake cost an implement run
// with nothing to fix, then came back red with the same signature, which sent a sound work order
// to root-cause. The failed Actions runs on this head are re-run, and handed to wait-for-checks,
// which waits for them: their red stays in the rollup until the re-run ends — ci-verify's status
// is rewritten only by its last job. This waited for them itself, on a clock of its own, and a
// re-run that outlasted it left wait-for-checks reading the old red as the answer.
if (process.env.RERUN_FAILED === 'true') {
  const { statusCheckRollup: rollup = [] } = await ghJson(['pr', 'view', pr, '--json', 'statusCheckRollup']);
  const ids = [...new Set(rollup
    .filter((c) => /^(FAILURE|ERROR|CANCELLED|TIMED_OUT|STARTUP_FAILURE)$/i.test(String(c.conclusion ?? c.state ?? '')))
    .map((c) => String(c.detailsUrl ?? c.targetUrl ?? '').match(/\/actions\/runs\/(\d+)/)?.[1])
    .filter(Boolean))];
  const rerun = [];
  for (const id of ids) {
    const before = await ghJson(['run', 'view', id, '--json', 'attempt']).then((r) => r.attempt).catch(() => null);
    await gh(['run', 'rerun', id, '--failed'])
      .then(() => rerun.push(`${id}:${before ?? ''}`))
      .catch((e) => process.stdout.write(`::warning::could not re-run run ${id}: ${String(e.stderr || e.message).trim()}\n`));
  }
  setOutput('rerun', rerun.join(','));
  if (rerun.length) done(`re-ran the failed checks on PR #${pr} (run ${rerun.map((r) => r.split(':')[0]).join(', ')}) — the gate waits for them`, true);
}

let started = false;

// The repo's own CI is held exactly the same way, and under `existing` it is the only CI there
// is: this script skipped that mode as "not ours to start", so the gate waited out
// verify.wait_minutes on checks nothing would ever start, on every PR. A workflow that runs on
// `pull_request` — the owner's word that it is safe on PR code — and also declares
// `workflow_dispatch` is started on the PR's branch. One that cannot be dispatched is named, since
// only a person can start it, and doctor fails a repo whose required checks depend on one.
// ponytail: no dedupe — a gate re-run on the same head starts their CI again; skip by the rollup
// if the minutes matter.
if (mode === 'existing' || mode === 'both') {
  const { headRefName } = await ghJson(['pr', 'view', pr, '--json', 'headRefName']);
  const dir = join(process.env.SDLC_ROOT ?? process.cwd(), '.github/workflows');
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort() : []) {
    if (/^(sdlc-.+|ci-verify)\.yml$/.test(f)) continue;
    let on;
    try { on = load(readFileSync(join(dir, f), 'utf8'))?.on; } catch { continue; }
    const events = triggersOf(on);
    if (!events.includes('pull_request')) continue;
    if (!events.includes('workflow_dispatch')) {
      process.stdout.write(`::warning::${f} runs on pull_request and declares no workflow_dispatch, so nothing can start ` +
        `it on PR #${pr}: GitHub holds its run on a bot's push at action_required until a person approves it in the ` +
        'Actions tab. Add `workflow_dispatch:` to it and the gate starts it on every pipeline PR.\n');
      continue;
    }
    const takesPr = Object.hasOwn(on?.workflow_dispatch?.inputs ?? {}, 'pr');
    await exec('node', ['.sdlc/bin/dispatch.mjs', f, '--ref', headRefName, ...(takesPr ? ['-f', `pr=${pr}`] : [])]);
    process.stdout.write(`started ${f} on ${headRefName}, since its pull_request run on a bot's push is held for approval\n`);
    started = true;
  }
}
if (mode === 'existing') done(started ? 'the repo\'s own CI was started' : 'none of this repo\'s CI could be started', started);

const { statusCheckRollup = [] } = await ghJson(['pr', 'view', pr, '--json', 'statusCheckRollup']);
const ours = statusCheckRollup.filter((c) => /ci-verify/i.test(c.name ?? c.context ?? ''));
if (ours.length) done(`ci-verify is already reporting on this PR (${ours[0].conclusion ?? ours[0].state ?? 'pending'})`, started);

await exec('node', ['.sdlc/bin/dispatch.mjs', 'ci-verify.yml', '-f', `pr=${pr}`]);
setOutput('dispatched', 'true');
process.stdout.write(`no ci-verify on PR #${pr} — dispatched it, since a bot-triggered run would be held for approval\n`);
