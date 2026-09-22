#!/usr/bin/env node
// Waits for the checks that gate a PR, whoever runs them.
//
// A repo that already has CI does not need ours. Duplicating it burns runner minutes and,
// worse, drifts from it — the pipeline ends up gating on a weaker set of checks than the
// team actually trusts. So the framework waits for whatever already gates the PR.
//
// This exists as a script rather than a `workflow_run` trigger because that trigger's
// `workflows:` list is static YAML and cannot be driven from config.

import { ghJson, setOutput, loadConfig, die } from './lib/actions.js';

const pr = process.env.PR ?? die('PR not set');
const cfg = await loadConfig();
const required = cfg.verify?.required_checks ?? [];
const timeoutMin = Number(cfg.verify?.wait_minutes ?? 30);
const deadline = Date.now() + timeoutMin * 60_000;

// A check that has not been created YET looks exactly like a check that will never exist.
// The gate starts ci-verify and then polls; on the first poll, a second later, the rollup is
// still empty — and concluding from that marked a PR red while its CI was still booting.
// Absent is not the same as absent-for-good, so an empty rollup gets a grace period before it
// is allowed to mean anything.
const EMPTY_GRACE_MS = 3 * 60_000;
let emptySince = null;

// Our own gate must not wait for itself.
const SELF = /^(sdlc-|gate\b)/;

const wanted = (c) => (required.length ? required.includes(c.name) : !SELF.test(c.name));

let last = '';
while (Date.now() < deadline) {
  const { statusCheckRollup = [] } = await ghJson([
    'pr', 'view', pr, '--json', 'statusCheckRollup',
  ]);

  const checks = statusCheckRollup.filter(wanted);

  if (!checks.length) {
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
    const expectsCi = (cfg.verify?.mode ?? 'none') !== 'none' || required.length > 0;

    if (expectsCi) {
      emptySince ??= Date.now();
      const waited = Date.now() - emptySince;
      if (waited < EMPTY_GRACE_MS) {
        process.stdout.write(`no checks reporting yet — waiting (${Math.round(waited / 1000)}s of ${EMPTY_GRACE_MS / 1000}s)\n`);
        await new Promise((r) => setTimeout(r, 15_000));
        continue;
      }
    }

    if (!expectsCi) {
      process.stdout.write('no gating checks, and verify.mode is "none" — nothing to wait for\n');
      setOutput('conclusion', 'none');
      setOutput('passed', 'true');
      process.exit(0);
    }

    // Name the likeliest cause, because an empty rollup says nothing about why it is empty.
    const held = await ghJson(['run', 'list', '--limit', '20', '--json', 'conclusion,name,event'])
      .then((runs) => runs.filter((r) => r.conclusion === 'action_required'))
      .catch(() => []);

    process.stdout.write(
      `verify.mode is "${cfg.verify?.mode}" but this PR has no gating checks at all.\n` +
      (held.length
        ? `${held.length} run(s) are held at "action_required" — GitHub is waiting for a human to ` +
          'approve workflows on this PR. That is what it looks like when the pipeline pushes as ' +
          'github-actions[bot]: the run exists, produces no check, and the rollup comes back empty.\n' +
          'Settings -> Actions -> General -> "Approve and run" clears it for this PR; the repo ' +
          'setting stops it recurring.\n'
        : 'Either the workflow did not trigger, or it is still queuing.\n'));

    setOutput('conclusion', 'failure');
    setOutput('passed', 'false');
    setOutput('failed_checks', 'none ran');
    process.exit(0);          // a normal red outcome, handled by the loop — not a crash
  }

  // Two shapes arrive in one rollup and they are NOT interchangeable.
  //
  // A check run reports `status` + `conclusion`; a legacy commit status reports `state` alone.
  // This used to call anything with a `state` finished — and a legacy status says
  // `state: "PENDING"` while it is still running. A pending status was therefore neither
  // failed nor pending, so the loop concluded "all checks passed" on CI that had not finished.
  //
  // That is not a stall, it is a green light on unverified code, and our own ci-verify posts
  // exactly that pending status before it starts work.
  const TERMINAL_STATES = new Set(['SUCCESS', 'FAILURE', 'ERROR']);
  const FAILED_CONCLUSIONS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
  const FAILED_STATES = new Set(['FAILURE', 'ERROR']);

  const isCheckRun = (c) => c.status !== undefined;
  const done = (c) => (isCheckRun(c)
    ? c.status === 'COMPLETED' && c.conclusion != null
    // Anything unrecognised counts as NOT done: it keeps waiting, and the timeout catches a
    // state that never resolves. Guessing "finished" is how this failed in the first place.
    : TERMINAL_STATES.has(String(c.state ?? '').toUpperCase()));

  const failed = checks.filter((c) => (isCheckRun(c)
    ? FAILED_CONCLUSIONS.has(String(c.conclusion ?? '').toUpperCase())
    : FAILED_STATES.has(String(c.state ?? '').toUpperCase())));
  const pending = checks.filter((c) => !done(c));

  const summary = checks.map((c) => `${c.name}:${c.conclusion ?? c.status ?? c.state}`).join(' ');
  if (summary !== last) { process.stdout.write(summary + '\n'); last = summary; }

  if (failed.length) {
    process.stdout.write(`failing: ${failed.map((c) => c.name).join(', ')}\n`);
    setOutput('conclusion', 'failure');
    setOutput('passed', 'false');
    setOutput('failed_checks', failed.map((c) => c.name).join(','));
    process.exit(0);          // not an error: a red PR is a normal outcome the loop handles
  }
  if (!pending.length) {
    process.stdout.write(`all ${checks.length} check(s) passed\n`);
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
