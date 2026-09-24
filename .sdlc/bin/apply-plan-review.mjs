#!/usr/bin/env node
// Acts on the plan reviewer's verdict.
import { readFileSync, existsSync } from 'node:fs';
import { gh, setOutput, loadConfig, die, repo as repoOf } from './lib/actions.js';
import { readLedger, updateLedger } from './lib/state-io.js';
import { advance } from './lib/advance.js';
import { loadArtifact, rememberRejected } from './lib/artifact.js';
import { resolveStage } from './lib/flow-graph.js';
import { dispatchStage } from './lib/route-io.js';

const issue = process.env.ISSUE;

// Repaired and validated before anything routes on it.
//
// The verdict was JSON.parsed and compared exactly, and anything that was not `approve` or
// `reject` fell into the escalate branch with its reason defaulting to product-ambiguity. An
// open-weight reviewer writing "Approve" therefore parked an approved plan at needs-human with
// "the requirement itself is ambiguous" — a person pulled in under a false reason. Case is now
// repaired, and a verdict that is still not one of the three is a failed run (the failure path
// reruns the reviewer), never a decision this script makes up.
const loaded = loadArtifact('plan-review', 'plan-review.json');
if (!loaded.ok) die(`the plan reviewer's verdict cannot be acted on: ${loaded.errors.join('; ')}`);
const r = loaded.data;

// The reviewer's words, posted under the pipeline's name — so quoted. Readers of the pipeline's
// own comments take a fenced JSON block there as a failure packet or a work order, and a claim
// is free text: one carrying such a block, or the work-order marker (matched anywhere, hence
// `<!--`), turned a rejection — which carries the rejected plan's JSON below — into the plan to build.
const quote = (s) => String(s ?? '').replace(/<!--/g, '&lt;!--').split('\n').map((l) => `> ${l}`).join('\n');
const listed = (r.blocking ?? []).map((b, i) =>
  `${i + 1}. **${b.claim}**\n   - evidence: ${b.evidence ?? '_none given_'}\n   - required: ${b.required_change}`).join('\n');
const blocking = listed && quote(listed);

// The plan the objections are ABOUT.
//
// A rejection is never posted alongside the work order it rejects — that step is skipped, by
// design, so a rejected plan is not implemented. But the objections cite it by field path
// ("qa_script step 4", "files[4] renders no per-member share"), and the council that replans
// reads the issue, not this runner's filesystem. Feedback whose subject is missing is feedback
// the next attempt has to guess at, so the rejected plan travels with it.
//
// Without a work-order marker, deliberately: the readers used to take the newest JSON block on
// the issue as the plan to build, and this block is the newest one right after a rejection.
const rejectedPlan = (() => {
  if (!existsSync('work-order.json')) return '';
  try {
    const wo = JSON.parse(readFileSync('work-order.json', 'utf8'));
    return ['', '<details><summary>The plan these objections are about (v' + (wo.version ?? 1) + ')</summary>', '',
      '```json', JSON.stringify(wo, null, 2), '```', '', '</details>'].join('\n');
  } catch { return ''; }
})();

// A rejected plan is no longer the plan waiting for review. Left stashed, the replan this
// dispatches would restore it and have it reviewed again instead of writing a new one.
const dropStash = () => updateLedger(repoOf(), Number(issue), (l) => {
  if (!l) return null;
  const next = { ...l };
  delete next.validated_work_order;
  return next;
}).catch((e) => process.stdout.write(`::warning::could not clear the reviewed plan: ${e.message}\n`));

// Plan again, by the stage that wrote the plan.
//
// This ran `dispatch.mjs sdlc-plan.yml` whoever wrote it. A root-cause revision that rewrote a
// criterion is reviewed here, and the reviewer rejecting it — the rewrite matched the defect —
// sent it to a fresh planner: no QA evidence, no failure packet, and a post as `plan`, which
// skips the check that refuses a dropped criterion. The criterion that failed QA could then be
// dropped with nobody comparing. So it goes back to root-cause, whose pending QA run, origin and
// PR carry over through dispatchStage, and it is handed the objections as its refused revision.
// And through dispatchStage either way, which a person's `/sdlc stop` holds.
const replan = async () => {
  const { ledger } = await readLedger(repoOf(), Number(issue));
  const author = ledger?.validated_from === 'root-cause' ? 'root-cause' : 'plan';
  if (author === 'root-cause') {
    await rememberRejected(repoOf(), issue, 'work-order', readFileSync('work-order.json', 'utf8'),
      (r.blocking ?? []).map((b) => `the plan reviewer rejected this revision: ${b.claim} — ${b.required_change}`));
  }
  await dropStash();
  const done = await dispatchStage({ repo: repoOf(), issue, target: resolveStage(author, { issue, ledger }),
    agent: 'plan-reviewer', why: `the plan reviewer sent the plan back to ${author === 'plan' ? 'the planner' : 'root-cause'}` });
  if (!done.dispatched && !done.halted) process.stdout.write(`::warning::could not start the replan (${author})\n`);
};

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
  //
  // Approved, but "the confidence is too high" is the finding min_confidence exists for, reached
  // by a reader rather than a number — and no code read it. post-work-order takes it to plan-gate
  // (TOO_HIGH), which sends the plan to a person like any other plan under the bar. Stashed with
  // the plan, because a resumed post skips this step and would otherwise build it unreviewed.
  const tooHigh = r.confidence_agreement === 'too-high';
  await updateLedger(repoOf(), Number(issue), (l) => {
    l.approved_work_order = JSON.parse(readFileSync('work-order.json', 'utf8'));
    l.approved_too_high = tooHigh;
  }).catch((e) => process.stdout.write(`::warning::could not stash the approved plan: ${e.message}\n`));

  await gh(['issue', 'comment', issue, '--body',
    '## Plan review: approved\n\n' +
    (tooHigh
      ? 'The plan reviewer approved this plan but judged its confidence higher than what it verified, ' +
        'so a person decides before any code is written.'
      : 'The plan reviewer approved this plan. Proceeding to implementation.') +
    (r.notes?.length ? `\n\nNon-blocking notes:\n${quote(r.notes.map((n) => `- ${n}`).join('\n'))}` : '')]);
  setOutput('verdict', 'approve');
  setOutput('too_high', tooHigh ? 'true' : 'false');
} else if (r.verdict === 'reject') {
  await gh(['issue', 'comment', issue, '--body',
    `## Plan review: rejected\n\n${blocking}\n\nReplanning with these as the brief.${rejectedPlan}`]);
  setOutput('verdict', 'reject');

  // A rejection is the reviewer WORKING, so it must not look like a crash. Exiting non-zero
  // failed the run, which fired the workflow's failure handler — and that handler posted
  // "Planner failed or produced an invalid work order", which was false, and parked the issue
  // at needs-human. So a correct rejection read as a broken planner and stopped the pipeline.
  //
  // What a rejection actually means is: plan again, with these objections as the brief.
  // Dispatched explicitly, because the label alone starts nothing, and bounded by the plan
  // stage's attempt budget like any other loop.
  await replan();
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
  //
  // An escalation that names no reason is treated as the one that returns to the planner. It
  // defaulted to product-ambiguity, which always reaches a person — so a reviewer that forgot one
  // optional field stopped an automated pipeline with a false "the requirement is ambiguous".
  const reason = r.escalation_reason ?? 'cannot-verify';
  const cfg = await loadConfig();
  const autoPlan = !cfg.gates?.plan_approval;
  const critique = reason === 'cannot-verify';

  if (critique && autoPlan) {
    await gh(['issue', 'comment', issue, '--body',
      `## Plan review: could not verify this plan\n\n${blocking || '_no specifics given_'}\n\n` +
      'Back to the planner with these as the brief. The reviewer is a critic, not a gate — ' +
      'a plan it cannot verify is a plan that has not said enough yet, which is the planner\'s ' +
      `to fix, not a human's.${rejectedPlan}`]);
    setOutput('verdict', 'reject');
    setOutput('escalation_reason', reason);
    await replan();
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
