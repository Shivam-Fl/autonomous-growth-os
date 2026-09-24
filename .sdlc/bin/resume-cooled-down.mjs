#!/usr/bin/env node
// Restarts issues that were parked to wait out a provider outage.
//
// An agent runtime that fails before producing anything is almost always a rate or a quota
// limit, and the right answer is to wait — not to retry immediately (which proves the limit
// is still there and burns an attempt) and not to stop for a person (which, at 2am, means the
// pipeline is done for the night over something that cleared itself in twenty minutes).
//
// So those failures park with a `retry_after` on the ledger (lib/failure.js parkForCooldown),
// and this — the only thing in the framework that runs on a clock — starts them again once the
// time has passed. Bounded by `runtime_retries`, because a quota that has not returned in four
// cooldowns is not an outage any more, it is a wall, and a person should hear about it.
//
// Everything about WHICH stage and HOW is resolved before the cooldown is consumed. This used to
// delete retry_after, spend a cooldown, move the label and announce "starting qa again" — and
// only then notice there was no PR to start it on, and quietly `continue`.
import { gh, ghJson, loadConfig, repo as repoOf, setOutput, switchedOff } from './lib/actions.js';
import { readLedger, updateLedger } from './lib/state-io.js';
import { advance } from './lib/advance.js';
import { dispatchStage } from './lib/route-io.js';
import { rerunTarget, retryHint } from './lib/flow-graph.js';
import { runtimeTries } from './lib/failure.js';

// The owner's kill switch, as the guard exported it for the `always()` steps that still run after
// it. Clearing a cooldown and announcing a start that dispatchStage then refuses loses the
// schedule: the issue would never resume.
if (switchedOff()) {
  process.stdout.write('SDLC_ENABLED is "false" — leaving every cooldown for the sweep after `sdlc resume`\n');
  process.exit(0);
}

const repo = repoOf();
const cfg = await loadConfig();
const maxRetries = Number(cfg.limits?.runtime_retries ?? 4);
const now = new Date();

const clear = (issue) => updateLedger(repo, issue, (l) => {
  if (!l) return null;
  const next = { ...l };
  delete next.retry_after;
  delete next.retry_stage;
  delete next.parked_at;
  return next;
}).catch(() => {});
const say = (issue, body) => gh(['issue', 'comment', String(issue), '--body', body]).catch(() => {});

// The candidates, not every ledger ever written. This read all of them — done and merged
// included, one contents GET each — every fifteen minutes and on every sweep a move to
// needs-human or a merge dispatches, which on a big project is GITHUB_TOKEN's hourly budget
// spent on ledgers that can never hold a cooldown. One can exist only on an open issue parked at
// needs-human, or at qa-pass for a merge; everything below still checks that per ledger.
const candidates = new Set();
for (const label of ['sdlc:needs-human', 'sdlc:qa-pass']) {
  const pages = await ghJson(['api', '--paginate', '--slurp', `repos/${repo}/issues?state=open&labels=${label}&per_page=100`]);
  for (const i of pages.flat()) if (!i.pull_request) candidates.add(i.number);
}

let resumed = 0;
for (const issue of candidates) {
  const { ledger } = await readLedger(repo, issue).catch(() => ({ ledger: null }));
  if (!ledger?.retry_after) continue;
  if (new Date(ledger.retry_after) > now) continue;

  const stage = ledger.retry_stage;

  // Still waiting on THIS cooldown? A person may have stopped it, finished it by hand, or
  // closed the issue in the meantime — and restarting then is the pipeline overruling them.
  // `/sdlc stop` on a parked issue used to be followed, twenty minutes later, by "Cooldown over
  // — starting implement again". A merge waiting on GitHub's mergeability parks from qa-pass
  // rather than needs-human, because nothing about it stopped.
  const open = await ghJson(['issue', 'view', String(issue), '--json', 'state'])
    .then((d) => d.state === 'OPEN').catch(() => true);
  const parked = ledger.state === 'needs-human' || (stage === 'merge' && ledger.state === 'qa-pass');
  if (ledger.halted || !parked || !open) {
    await clear(issue);
    const why = ledger.halted ? `@${ledger.halted.by} stopped this issue`
      : !open ? 'the issue is closed'
        : `the issue has moved on to \`${ledger.state}\` since it was parked`;
    await say(issue, `Cooldown over, and not restarting \`${stage}\`: ${why}.`);
    continue;
  }

  // The implementer carries what it was answering; a resume has no dispatch inputs of its own.
  const rework = stage === 'implement' && ledger.pending?.stage === 'implement' ? ledger.pending.rework ?? null : null;
  // A flaked check or a crashed gate is the gate again, not the implementer (rerunTarget).
  const target = rerunTarget(stage, { issue, ledger, rework });
  // How many cooldowns this outage has had, read the same way the failure handler read it when
  // it parked: the run of runtime failures this stage has just had, which a success ends.
  const tries = runtimeTries(ledger.failure_history, stage);

  if (!target || tries > maxRetries) {
    // Out of cooldowns, or parked for a stage this cannot re-enter. Stop waiting and say so —
    // a ledger that keeps a `retry_after` nothing acts on is an issue that looks scheduled and
    // is actually abandoned.
    await clear(issue);
    await say(issue, !target
      ? `## Waited out the cooldown, and \`${stage ?? 'the stage'}\` cannot be started again\n\n` +
        `${ledger.pr ? '' : 'It runs on a pull request, and this issue has none recorded. '}` +
        'Nothing is running on this issue; it needs a person.'
      : `## Waited out ${maxRetries} cooldowns and the runtime is still failing\n\n` +
        `\`${stage}\` has been retried after the agent runtime failed before producing anything. ` +
        'A quota that has not returned by now is not an outage, it is a wall — the token, the ' +
        `plan or the provider needs a look.\n\n${retryHint(stage)} tries again once it is sorted.`);
    await advance(issue, 'needs-human', { agent: 'watchdog' }).catch(() => {});
    continue;
  }

  const waited = Math.round((now - new Date(ledger.parked_at ?? ledger.retry_after)) / 60000);
  await clear(issue);
  // merge-pr's "not yet" — checks still running, mergeability UNKNOWN — reuses this cooldown, and
  // parks without a parked_at. Announcing it as a runtime failure sent the owner off to look at
  // a token or a quota that nothing was wrong with.
  await say(issue, stage === 'merge' && !ledger.parked_at
    ? 'Retrying the merge: GitHub had not finished its checks or mergeability.'
    : `Cooldown over — starting \`${stage}\` again after the runtime failed. ` +
      `Waited ${waited} minute${waited === 1 ? '' : 's'}.`);
  const r = await dispatchStage({ repo, issue, target, agent: 'watchdog', why: 'the provider cooldown has passed' });
  if (r.dispatched) resumed += 1;
}

setOutput('resumed', String(resumed));
process.stdout.write(resumed ? `resumed ${resumed} issue(s) after a cooldown\n` : 'nothing was waiting on a cooldown\n');
