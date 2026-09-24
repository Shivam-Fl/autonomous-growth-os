#!/usr/bin/env node
// Waits for the checks that gate a PR, whoever runs them.
//
// A repo that already has CI does not need ours. Duplicating it burns runner minutes and,
// worse, drifts from it — the pipeline ends up gating on a weaker set of checks than the
// team actually trusts. So the framework waits for whatever already gates the PR.
//
// This exists as a script rather than a `workflow_run` trigger because that trigger's
// `workflows:` list is static YAML and cannot be driven from config.
//
// WHICH checks gate the PR, and what green means, is lib/checks.js's decision, shared with
// merge-pr. This file used to match required checks on `name`, and only check RUNS have one: a
// legacy commit status carries `context`, and ci-verify reports as exactly that. A repo
// requiring ci-verify read "no checks ran" on a PR its CI had passed — and a required check
// that never appeared was filtered out rather than waited for, so the other checks going green
// passed the PR without the one the repo named.

import { ghJson, setOutput, loadConfig, die } from './lib/actions.js';
import { classifyRollup, checkName, expectsCi } from './lib/checks.js';

const pr = process.env.PR ?? die('PR not set');
const cfg = await loadConfig();
const timeoutMin = Number(cfg.verify?.wait_minutes ?? 30);
const deadline = Date.now() + timeoutMin * 60_000;

// A check that has not been created YET looks exactly like a check that will never exist.
// The gate starts ci-verify and then polls; on the first poll, a second later, the rollup is
// still empty — and concluding from that marked a PR red while its CI was still booting.
// Absent is not the same as absent-for-good, so a missing check gets a grace period before it
// is allowed to mean anything.
const EMPTY_GRACE_MS = 3 * 60_000;
let emptySince = null;

// The runs ensure-ci re-ran for a flake ("id:attempt-before", comma-separated), waited for within
// this one deadline. Until a run finishes a newer attempt its old red is still in the rollup, and
// that is a check still running, not an answer.
const rerun = new Map((process.env.RERUN ?? '').split(',').filter(Boolean)
  .map((r) => { const [id, before] = r.split(':'); return [id, before ? Number(before) : null]; }));
const runOf = (c) => String(c.detailsUrl ?? c.targetUrl ?? '').match(/\/actions\/runs\/(\d+)/)?.[1];
async function settleReruns() {
  for (const [id, before] of rerun) {
    const r = await ghJson(['run', 'view', id, '--json', 'attempt,status']).catch(() => null);
    if (r?.status === 'completed' && (before == null || r.attempt > before)) rerun.delete(id);
  }
}

let last = '';
while (Date.now() < deadline) {
  const { statusCheckRollup = [] } = await ghJson([
    'pr', 'view', pr, '--json', 'statusCheckRollup',
  ]);
  const { wanted, missing, failing, pending } = classifyRollup(statusCheckRollup, cfg);

  const summary = wanted.map((c) => `${checkName(c)}:${c.conclusion || c.status || c.state}`).join(' ');
  if (summary && summary !== last) { process.stdout.write(summary + '\n'); last = summary; }

  if (failing.length && rerun.size) {
    const running = rerun.size;
    await settleReruns();
    const waiting = failing.every((c) => rerun.has(runOf(c)));
    if (waiting) {
      process.stdout.write(`re-running: ${failing.map(checkName).join(', ')} — their red is the attempt before\n`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
    // One that has just finished is read again: this rollup was read before it did.
    if (waiting || rerun.size < running) continue;
  }

  // A red check is an answer, whatever else has not reported yet.
  if (failing.length) {
    const names = failing.map(checkName).join(',');
    process.stdout.write(`failing: ${names}\n`);
    setOutput('conclusion', 'failure');
    setOutput('passed', 'false');
    setOutput('failed_checks', names);
    process.exit(0);          // not an error: a red PR is a normal outcome the loop handles
  }

  // "No checks" and "no CI configured" are NOT the same thing, and treating them the same
  // sent a PR to review and QA with nothing verified at all.
  //
  // What actually happened: the implementer pushed the rework as github-actions[bot], so
  // GitHub held every `pull_request` run at `action_required` awaiting a human. A held run
  // produces no check run, the rollup came back empty, and this read that as "this repo has
  // no CI" — the most dangerous reading available, because it is indistinguishable from the
  // legitimate one right up to the moment it ships something.
  //
  // So the config decides. A repo that says it has CI and shows none is broken, not clean.
  if (!wanted.length && !expectsCi(cfg)) {
    process.stdout.write('no gating checks, and verify.mode is "none" — nothing to wait for\n');
    setOutput('conclusion', 'none');
    setOutput('passed', 'true');
    process.exit(0);
  }

  if (missing.length) {
    emptySince ??= Date.now();
    const waited = Date.now() - emptySince;
    if (waited < EMPTY_GRACE_MS) {
      process.stdout.write(`not reporting yet: ${missing.join(', ')} — waiting (${Math.round(waited / 1000)}s of ${EMPTY_GRACE_MS / 1000}s)\n`);
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }

    // Name the likeliest cause, because an empty rollup says nothing about why it is empty.
    const held = await ghJson(['run', 'list', '--limit', '20', '--json', 'conclusion,name,event'])
      .then((runs) => runs.filter((r) => r.conclusion === 'action_required'))
      .catch(() => []);

    process.stdout.write(
      `verify.mode is "${cfg.verify?.mode}" but ${missing.join(', ')} never reported on this PR.\n` +
      (held.length
        ? `${held.length} run(s) are held at "action_required" — GitHub is waiting for a human to ` +
          'approve workflows on this PR. That is what it looks like when the pipeline pushes as ' +
          'github-actions[bot]: the run exists, produces no check, and the rollup comes back empty.\n' +
          'Settings -> Actions -> General -> "Approve and run" clears it for this PR; the repo ' +
          'setting stops it recurring.\n'
        : 'Either the workflow did not trigger, or it is still queuing.\n'));

    setOutput('conclusion', 'failure');
    setOutput('passed', 'false');
    if (wanted.length) setOutput('failed_checks', `never reported: ${missing.join(',')}`);
    else setOutput('failed_checks', 'none ran');
    process.exit(0);          // a normal red outcome, handled by the loop — not a crash
  }
  emptySince = null;

  if (!pending.length) {
    process.stdout.write(`all ${wanted.length} check(s) passed\n`);
    setOutput('conclusion', 'success');
    setOutput('passed', 'true');
    process.exit(0);
  }

  await new Promise((r) => setTimeout(r, 15_000));
}

// A timeout is an outcome, not a crash. Exiting non-zero failed the gate step, so nothing
// recorded the result, nothing commented, and the issue sat at whatever state it was already
// in — the pipeline stopping with no trace, which is the failure mode this repo keeps fixing.
process.stdout.write(
  `checks did not finish within ${timeoutMin} minutes. Raise verify.wait_minutes if this ` +
  "repo's CI is slower than that.\n");
setOutput('conclusion', 'failure');
setOutput('passed', 'false');
setOutput('failed_checks', `timed out after ${timeoutMin}m`);
