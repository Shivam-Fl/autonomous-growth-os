#!/usr/bin/env node
// Restarts issues that were parked to wait out a provider outage.
//
// An agent runtime that fails before producing anything is almost always a rate or a quota
// limit, and the right answer is to wait — not to retry immediately (which proves the limit
// is still there and burns an attempt) and not to stop for a person (which, at 2am, means the
// pipeline is done for the night over something that cleared itself in twenty minutes).
//
// So those failures park with a `retry_after` on the ledger, and this — the only thing in the
// framework that runs on a clock — starts them again once the time has passed. Bounded by
// `runtime_retries`, because a quota that has not returned in four cooldowns is not an outage
// any more, it is a wall, and a person should hear about it.
import { gh, loadConfig, repo as repoOf, setOutput } from './lib/actions.js';
import { listLedgers, readLedger, updateLedger } from './lib/state-io.js';
import { handOff } from './lib/handoff.js';
import { advance } from './lib/advance.js';

const repo = repoOf();
const cfg = await loadConfig();
const maxRetries = Number(cfg.limits?.runtime_retries ?? 4);
const now = new Date();

// Which workflow re-runs a given stage. The stage is what was parked, so this is a re-entry,
// never a successor.
const STAGE = {
  plan:      { workflow: 'sdlc-plan.yml',      state: 'planning' },
  implement: { workflow: 'sdlc-implement.yml', state: 'implementing' },
  ci:        { workflow: 'sdlc-implement.yml', state: 'implementing' },
  gate:      { workflow: 'sdlc-implement.yml', state: 'implementing' },
  review:    { workflow: 'sdlc-review.yml',    state: 'review' },
  qa:        { workflow: 'sdlc-qa.yml',        state: 'qa' },
};

let resumed = 0;
for (const issue of await listLedgers(repo)) {
  const { ledger } = await readLedger(repo, issue).catch(() => ({ ledger: null }));
  if (!ledger?.retry_after) continue;
  if (new Date(ledger.retry_after) > now) continue;

  const stage = ledger.retry_stage;
  const route = STAGE[stage];
  const tries = Number(ledger.runtime_retries ?? 0);

  if (!route || tries >= maxRetries) {
    // Out of cooldowns, or parked for a stage this cannot re-enter. Stop waiting and say so —
    // a ledger that keeps a `retry_after` nothing acts on is an issue that looks scheduled and
    // is actually abandoned.
    await updateLedger(repo, issue, (l) => { delete l.retry_after; }).catch(() => {});
    await gh(['issue', 'comment', String(issue), '--body',
      `## Waited out ${tries} cooldown${tries === 1 ? '' : 's'} and the runtime is still failing\n\n` +
      (route
        ? `\`${stage}\` has been retried ${tries} times after the agent runtime failed before ` +
          'producing anything. A quota that has not returned by now is not an outage, it is a ' +
          'wall — the token, the plan or the provider needs a look.\n\n' +
          `\`/sdlc retry ${stage}\` tries again once it is sorted.`
        : `this was parked waiting for a runtime, but \`${stage ?? 'the stage'}\` is not one ` +
          'this can re-enter on its own. It needs a person.')]).catch(() => {});
    await advance(issue, 'needs-human', { agent: 'watchdog' }).catch(() => {});
    continue;
  }

  const waited = Math.round((now - new Date(ledger.parked_at ?? ledger.retry_after)) / 60000);
  await updateLedger(repo, issue, (l) => {
    delete l.retry_after;
    l.runtime_retries = tries + 1;
  }).catch(() => {});
  await advance(issue, route.state, { agent: 'watchdog' }).catch(() => {});
  await gh(['issue', 'comment', String(issue), '--body',
    `Cooldown over — starting \`${stage}\` again (attempt ${tries + 1} of ${maxRetries} after ` +
    `the runtime failed). Waited ${waited} minute${waited === 1 ? '' : 's'}.`]).catch(() => {});

  const args = ['-f', `issue=${issue}`];
  if (route.workflow === 'sdlc-review.yml' || route.workflow === 'sdlc-qa.yml') {
    if (!ledger.pr) continue;
    args.length = 0;
    args.push('-f', `pr=${ledger.pr}`);
  }
  await handOff(route.workflow, args, {
    issue, pr: ledger.pr ?? null, why: 'the provider cooldown has passed',
  });
  resumed += 1;
}

setOutput('resumed', String(resumed));
process.stdout.write(resumed ? `resumed ${resumed} issue(s) after a cooldown\n` : 'nothing was waiting on a cooldown\n');
