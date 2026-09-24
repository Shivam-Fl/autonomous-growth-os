#!/usr/bin/env node
// The failure triage did not reach a verdict it could act on. Say which way, and stop — or,
// when the triage's own model run died, wait.
//
// Triaging a triage failure is an infinite regress with a model bill attached, so this is the
// one failure in the pipeline that nothing diagnoses. A person gets the two run links and the
// stage name, which is all anyone needs to start looking.
//
// It used to say "the agent did not finish" whatever happened, which was false as often as not:
// the agent had finished, written its verdict, and the script applying it had died. Three
// different things, three different messages:
//
//   - the Diagnose step failed and wrote nothing: the triage's own model run died, which is an
//     outage far more often than anything else. The ORIGINAL stage parks on a cooldown, as it
//     would have had the failure been noticed there; parking it at a person made one rate limit
//     a human touch. Only with no triage.json: an agent that wrote its verdict and then hit its
//     turn cap has reached one, and the act job applies it — parking here threw it away with a
//     false "rate limit" message.
//   - triage.json exists: the verdict was reached and could not be applied. It is attached, so
//     nobody pays for the diagnosis twice.
//   - neither: the triage never got as far as diagnosing.
//
// A script rather than a shell heredoc in the workflow: a multi-line comment body inside a
// YAML block scalar has to be indented to stay inside it, and getting that wrong breaks the
// whole workflow file rather than just this message.
import { existsSync, readFileSync } from 'node:fs';
import { gh, loadConfig, repo as repoOf, switchedOff } from './lib/actions.js';
import { readLedger, updateLedger } from './lib/state-io.js';
import { markResume } from './lib/route-io.js';
import { advance } from './lib/advance.js';
import { resolveStage, retryHint } from './lib/flow-graph.js';
import { parkForCooldown, waitTries, mergeOnlyStage } from './lib/failure.js';

// The owner's kill switch, as the guard exported it for the failure() step that still runs after
// it. A triage the switch stopped reached no verdict because the owner stopped it, and escalating
// that makes the stop a person's problem.
if (switchedOff()) {
  process.stdout.write('SDLC_ENABLED is "false" — the triage was stopped, not failed; nothing to escalate\n');
  process.exit(0);
}

const { ISSUE: issue, STAGE: stage, RUN_URL: runUrl, FAILED_URL: failedUrl, DIAGNOSE: diagnose } = process.env;
const repo = repoOf();
const links = `[The triage run](${runUrl}) · [the run it was reading](${failedUrl})`;
const { ledger } = await readLedger(repo, Number(issue)).catch(() => ({ ledger: null }));
// QA passed on this head and only the merge after it failed: that waits, and stops, at qa-pass —
// from needs-human only a whole new QA run gets back there (lib/failure.js mergeOnlyStage).
const at = await mergeOnlyStage(ledger, stage, process.env.PR || ledger?.pr);

if (diagnose === 'failure' && !existsSync('triage.json')) {
  const cfg = await loadConfig();
  const tries = waitTries(ledger?.triage_history, stage);
  // Counted with the triage's own `wait` verdicts: a triage that cannot run is a wait decided
  // by the script, and an outage that outlasts every cooldown is a wall however it was noticed.
  await updateLedger(repo, Number(issue), (l) => (l ? {
    ...l,
    triage_history: [...(l.triage_history ?? []).slice(-9), {
      at: new Date().toISOString(), stage, verdict: 'wait', confidence: 0,
      diagnosis: 'the triage agent itself did not finish', run: process.env.FAILED_RUN,
    }],
  } : null)).catch(() => {});
  const parked = await parkForCooldown(repo, issue, at, tries, {
    maxRetries: Number(cfg.limits?.runtime_retries ?? 4), agent: 'triage',
    why: `\`${stage}\` failed, and the agent dispatched to diagnose it could not run either — ` +
         `usually a rate or quota limit on its model, not a verdict about the code. ${links}`,
  });
  if (parked) process.exit(0);
}

const verdict = existsSync('triage.json') ? readFileSync('triage.json', 'utf8') : null;
if (at !== 'merge') {
  await markResume(repo, issue, resolveStage(stage, { issue })?.stage ?? stage, 'retry').catch(() => {});
  await advance(issue, 'needs-human', { agent: 'triage' }).catch((e) => process.stdout.write(`::warning::${e.message}\n`));
}
await gh(['issue', 'comment', String(issue), '--body', [
  verdict ? '## The triage reached a verdict, and it could not be applied' : '## The failure triage itself failed',
  '',
  verdict
    ? `The \`${stage}\` stage failed on this issue. The agent dispatched to diagnose it finished and ` +
      'wrote the verdict below, and applying it failed — the triage run says why. Nothing has been re-run.'
    : `The \`${stage}\` stage failed on this issue, and the triage dispatched to diagnose that ` +
      'failure did not finish either. Nothing has been re-run: triaging a triage failure is an ' +
      'infinite regress, so this stops here.',
  '',
  links,
  verdict ? `\n<details><summary>The verdict</summary>\n\n\`\`\`json\n${verdict.slice(0, 60000)}\n\`\`\`\n\n</details>` : '',
  '',
  at === 'merge'
    ? 'QA passed on this head and only the merge after it failed, so the issue stays at `qa-pass`: `/sdlc approve` merges it.'
    : `${retryHint(stage)} runs the stage again if you believe the failure was transient.`,
].join('\n')]).catch((e) => process.stdout.write(`::warning::${e.message}\n`));
