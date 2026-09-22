#!/usr/bin/env node
// Acts on the plan reviewer's verdict.
import { readFileSync, existsSync } from 'node:fs';
import { gh, setOutput, loadConfig, die, repo as repoOf } from './lib/actions.js';
import { updateLedger } from './lib/state-io.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { advance } from './lib/advance.js';

const issue = process.env.ISSUE;
if (!existsSync('plan-review.json')) die('the plan reviewer produced no verdict');
const r = JSON.parse(readFileSync('plan-review.json', 'utf8'));

const blocking = (r.blocking ?? []).map((b, i) =>
  `${i + 1}. **${b.claim}**\n   - evidence: ${b.evidence ?? '_none given_'}\n   - required: ${b.required_change}`).join('\n');

// The plan the objections are ABOUT.
//
// A rejection is never posted alongside the work order it rejects — that step is skipped, by
// design, so a rejected plan is not implemented. But the objections cite it by field path
// ("qa_script step 4", "files[4] renders no per-member share"), and the council that replans
// reads the issue, not this runner's filesystem. Feedback whose subject is missing is feedback
// the next attempt has to guess at, so the rejected plan travels with it.
const rejectedPlan = (() => {
  if (!existsSync('work-order.json')) return '';
  try {
    const wo = JSON.parse(readFileSync('work-order.json', 'utf8'));
    return ['', '<details><summary>The plan these objections are about (v' + (wo.version ?? 1) + ')</summary>', '',
      '```json', JSON.stringify(wo, null, 2), '```', '', '</details>'].join('\n');
  } catch { return ''; }
})();

// Whatever the verdict, this issue is no longer waiting on a human — the agent read it.
await gh(['issue', 'edit', issue, '--remove-label', 'sdlc:plan-review']).catch(() => {});

if (r.verdict === 'approve') {
  // An approved plan must outlive the rest of this run.
  //
  // A council spent 33 minutes on a work order, this reviewer approved it, and then posting
  // it threw — so the self-heal loop saw a failed plan stage, did the only thing it can do
  // with one, and dispatched a fresh council. The plan was never the problem; it just lived
  // nowhere but the runner's disk, and an approved plan that only exists there is an approved
  // plan one `gh` call away from being paid for twice.
  //
  // Stashed on the ledger, cleared once it is posted. `plan-strategy` picks it up on the way
  // in and skips straight to posting, so a failure after this point costs a retry, not a
  // replan.
  await updateLedger(repoOf(), Number(issue), (l) => {
    l.approved_work_order = JSON.parse(readFileSync('work-order.json', 'utf8'));
  }).catch((e) => process.stdout.write(`::warning::could not stash the approved plan: ${e.message}\n`));

  await gh(['issue', 'comment', issue, '--body',
    '## Plan review: approved\n\nThe plan reviewer verified the diagnosis and the caller analysis. ' +
    'Proceeding to implementation.' +
    (r.notes?.length ? `\n\nNon-blocking notes:\n${r.notes.map((n) => `- ${n}`).join('\n')}` : '')]);
  setOutput('verdict', 'approve');
} else if (r.verdict === 'reject') {
  await gh(['issue', 'comment', issue, '--body',
    `## Plan review: rejected\n\n${blocking}\n\nReplanning with these as the brief.${rejectedPlan}`]);
  await advance(issue, 'planning', { agent: 'plan-reviewer' });
  setOutput('verdict', 'reject');

  // A rejection is the reviewer WORKING, so it must not look like a crash. Exiting non-zero
  // failed the run, which fired the workflow's failure handler — and that handler posted
  // "Planner failed or produced an invalid work order", which was false, and parked the issue
  // at needs-human. So a correct rejection read as a broken planner and stopped the pipeline.
  //
  // What a rejection actually means is: plan again, with these objections as the brief.
  // Dispatched explicitly, because the label alone starts nothing, and bounded by the plan
  // stage's attempt budget like any other loop.
  await exec('node', ['.sdlc/bin/dispatch.mjs', 'sdlc-plan.yml', '-f', `issue=${issue}`])
    .catch((e) => process.stdout.write(`::warning::could not start the replan: ${e.message}\n`));
  process.exit(0);
} else {
  // An escalation says WHO has to act, and only one of the three answers is a person.
  //
  // The reviewer is a critic, not a gate. "I could not verify this plan" is feedback the
  // planner can answer — it names what is missing — so with the human gate off it goes back
  // round the loop like any other rejection. Sending it to a human instead stopped an
  // automated pipeline for a critique that had an author waiting to act on it.
  //
  // Product ambiguity and reserved risk areas are different in kind: no amount of replanning
  // turns payments into not-payments, and a loop there burns the budget to reach the same
  // person anyway. Those always reach a human, gate or no gate.
  const reason = r.escalation_reason ?? 'product-ambiguity';
  const cfg = await loadConfig();
  const autoPlan = !cfg.gates?.plan_approval;
  const critique = reason === 'cannot-verify';

  if (critique && autoPlan) {
    await gh(['issue', 'comment', issue, '--body',
      `## Plan review: could not verify this plan\n\n${blocking || '_no specifics given_'}\n\n` +
      'Back to the planner with these as the brief. The reviewer is a critic, not a gate — ' +
      'a plan it cannot verify is a plan that has not said enough yet, which is the planner\'s ' +
      `to fix, not a human's.${rejectedPlan}`]);
    await advance(issue, 'planning', { agent: 'plan-reviewer' });
    setOutput('verdict', 'reject');
    setOutput('escalation_reason', reason);
    await exec('node', ['.sdlc/bin/dispatch.mjs', 'sdlc-plan.yml', '-f', `issue=${issue}`])
      .catch((e) => process.stdout.write(`::warning::could not start the replan: ${e.message}\n`));
    process.exit(0);
  }

  const why = {
    'product-ambiguity': 'the requirement itself is ambiguous — that is a product decision, not a planning one',
    'human-authority-required': 'this touches an area reserved for a human decision',
    'cannot-verify': 'the reviewer could not verify the plan, and the human gate is on',
  }[reason];
  await gh(['issue', 'comment', issue, '--body',
    `## Plan review: escalated to a human\n\n_Because ${why}._\n\n${blocking || '_no specifics given_'}\n\n` +
    'Escalation is this agent working, not failing. The work order is posted below so you can ' +
    'judge it yourself; nothing will act on it until you say so.']);
  await advance(issue, 'needs-human', { agent: 'plan-reviewer' });
  setOutput('verdict', 'escalate');
  setOutput('escalation_reason', reason);
  // Exit 0 deliberately. Exiting non-zero failed the workflow, which skipped the step that
  // POSTS the work order — so an escalation to a human left that human with a reviewer's
  // objections and no plan to read them against. The gate that stops the pipeline is the
  // needs-human state, not a red run.
}
