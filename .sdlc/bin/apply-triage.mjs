#!/usr/bin/env node
// Acts on the failure-triage agent's verdict.
//
// The decision itself is the agent's. This file only does what the agent decided, posts the
// diagnosis where a person will find it, and refuses two things the agent is not allowed to
// have: a `rerun` it could not justify, and a framework edit.
//
// In that order, deliberately: the diagnosis is posted and recorded BEFORE anything is resolved
// that could fail. This used to look the stage up in its own table first, and the table had no
// `root-cause` — so every root-cause failure spent a full triage run, died on `unknown stage`,
// and threw away the diagnosis it had just paid for.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { gh, setOutput, loadConfig, repo as repoOf } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { markResume, dispatchStage } from './lib/route-io.js';
import { readLedger, updateLedger } from './lib/state-io.js';
import { loadArtifact } from './lib/artifact.js';
import { resolveStage, rerunTarget, retryHint } from './lib/flow-graph.js';
import { readWorkOrder } from './lib/work-order.js';
import { parkForCooldown, waitTries, mergeOnlyStage } from './lib/failure.js';

const exec = promisify(execFile);
const repo = repoOf();
const issue = Number(process.env.ISSUE);
const stage = process.env.STAGE;
const failedRun = process.env.FAILED_RUN;
const runUrl = process.env.RUN_URL ?? '';
const failedUrl = process.env.FAILED_URL ?? `../../actions/runs/${failedRun}`;

const cfg = await loadConfig();
const { ledger } = await readLedger(repo, issue).catch(() => ({ ledger: null }));
const pr = process.env.PR ? Number(process.env.PR) : ledger?.pr ?? null;
// QA passed on this head and only the merge after it failed: that re-enters, waits and stops as
// a merge, at qa-pass (lib/failure.js mergeOnlyStage).
const merging = (await mergeOnlyStage(ledger, stage, pr)) === 'merge';

/** Stop for a person, recording the failed stage as the one `/sdlc approve` runs again. */
async function stop(body) {
  // Except a merge. Moved to needs-human, a passed PR could get back to qa-pass only through a
  // whole new QA run; left at qa-pass, approving merges it.
  const said = merging ? [body, 'QA passed on this head and only the merge after it failed, so the ' +
    'issue stays at `qa-pass`: `/sdlc approve` merges it.'].filter(Boolean).join('\n\n') : body;
  if (said) {
    await gh(['issue', 'comment', String(issue), '--body', said])
      .catch((e) => process.stdout.write(`::warning::could not post: ${e.message}\n`));
  }
  if (merging) return;
  await markResume(repo, issue, resolveStage(stage, { issue, pr })?.stage ?? stage, 'retry');
  await advance(issue, 'needs-human', { agent: 'triage' });
}

// --- the verdict, repaired and validated -------------------------------------
//
// Parsed and exact-matched, it was routed on whatever the model typed: "Escalate" and "retry"
// matched no branch and fell through to re-running the stage, and `"transient": "false"` — a
// truthy string — walked past the one guard on that re-run. The heading read "undefined".
// Repair case-folds the enum and reads the boolean; what is still invalid is not guessed at.
const art = loadArtifact('triage', 'triage.json');
if (!art.ok) {
  await stop([
    `## ${stage} failed, and the triage's verdict cannot be acted on`,
    '',
    `The triage agent read [the run that failed](${failedUrl}), and what it wrote does not match ` +
      '`.sdlc/schemas/triage.json`:',
    '',
    ...art.errors.map((e) => `- ${e}`),
    '',
    'Nothing has been re-run. A verdict nobody can read is not an instruction to try again. ' +
      `${retryHint(stage)} runs the stage again once someone has looked.`,
    art.raw ? `\n<details><summary>What it wrote</summary>\n\n\`\`\`\n${art.raw.slice(0, 60000)}\n\`\`\`\n\n</details>` : '',
    runUrl ? `\n[Triage run](${runUrl})` : '',
  ].join('\n'));
  setOutput('verdict', 'invalid');
  process.stdout.write(`issue #${issue}: the triage verdict is invalid — ${art.errors.join('; ')}\n`);
  process.exit(0);
}
const t = art.data;

// --- the verdict, and the ones the agent does not get to make -----------------
//
// `rerun` without `transient` is the behaviour this agent replaced: nothing about the
// repository changed, so a re-run only makes the next attempt different if the cause was
// genuinely outside the repository. The contract says so; this enforces it, because an
// instruction a model can satisfy in more than one way is eventually satisfied the other way.
let verdict = t.verdict;
let override = null;
if (verdict === 'rerun' && !t.transient) {
  verdict = 'escalate';
  override = 'a `rerun` verdict has to name a transient cause — nothing about the repository ' +
             'changed, so re-running an unexplained failure spends an attempt to learn nothing';
}
// A framework defect is diagnosed here and fixed by a person, always. An agent that repairs
// its own rules to make its own failure go away leaves no auditable failure behind.
if (t.framework_defect && verdict !== 'escalate') {
  verdict = 'escalate';
  override = 'the defect is in the pipeline itself, which no agent here may change — the ' +
             'diagnosis and the proposed fix are above, for a person to apply';
}
// A repair is a change to the code, and before a pull request exists there is no code to
// change: what a planning stage's defect can be repaired with is a better plan.
if (verdict === 'repair' && !pr) {
  verdict = 'replan';
  override = 'there is no pull request yet, so there is no code to repair — the plan is revised instead';
}

// --- say it where someone is looking -----------------------------------------
const heading = {
  rerun:    `## ${stage} failed — transient, running it again`,
  resume:   `## ${stage} failed after the work was done — resuming, not redoing`,
  repair:   `## ${stage} failed — a defect in the code, sending it back with the diagnosis`,
  replan:   `## ${stage} failed because the plan cannot be built as written`,
  wait:     `## ${stage} failed on an outage — waiting it out`,
  escalate: `## ${stage} failed — stopping for a person`,
}[verdict];

const body = [
  heading,
  '',
  `**${t.diagnosis}**`,
  '',
  `_Evidence:_ ${t.evidence}`,
  '',
  `Confidence ${t.confidence}${t.transient ? ' · called transient' : ''}${
    t.survived ? `\n\nAlready done and kept: ${t.survived}` : ''}`,
  t.framework_defect ? [
    '',
    '### A defect in the pipeline itself',
    '',
    `\`${t.framework_defect.file}\` — ${t.framework_defect.what}`,
    '',
    `**The fix it would apply:** ${t.framework_defect.fix}`,
    '',
    '_No agent here can change `.sdlc/**` or `.github/**`. That is deliberate: an agent that ' +
    'rewrites its own rules to make its own failure go away leaves nothing behind to audit. ' +
    'This is a diagnosis for a person to act on._',
  ].join('\n') : null,
  override ? `\n_Overridden to \`${verdict}\`: ${override}._` : null,
  '',
  `_Diagnosed by an agent that read the whole log of [the run that failed](${failedUrl}) — [triage run](${runUrl})._`,
  // Drop absent sections, keep the blank lines. `.filter(Boolean)` removed both, so the
  // heading, the diagnosis, the evidence and the confidence rendered as one run-on paragraph —
  // markdown needs a blank line between block elements.
].filter((l) => l !== null).join('\n');

await gh(['issue', 'comment', String(issue), '--body', body])
  .catch((e) => process.stdout.write(`::warning::could not post the diagnosis: ${e.message}\n`));

// The diagnosis outlives this run, and travels with the failure packet — the one file the
// implementer and root-cause are told to read first. It used to be posted as prose and kept in
// triage_history, which nothing reads, so a `repair` was the implementer re-guessing from the
// same raw compiler output the pre-triage loop handed it.
let waited = waitTries(ledger?.triage_history, stage);
await updateLedger(repo, issue, (l) => {
  if (!l) return null;
  waited = waitTries(l.triage_history, stage);
  const next = {
    ...l,
    triage_history: [...(l.triage_history ?? []).slice(-9), {
      at: new Date().toISOString(), stage, verdict, confidence: t.confidence,
      diagnosis: String(t.diagnosis).slice(0, 500), run: failedRun,
    }],
  };
  if (l.failure_packet) {
    next.failure_packet = { ...l.failure_packet, triage: {
      verdict, diagnosis: t.diagnosis, evidence: t.evidence,
      ...(t.framework_defect ? { framework_defect: t.framework_defect } : {}),
    } };
  }
  return next;
}).catch((e) => process.stdout.write(`::warning::could not record the diagnosis: ${e.message}\n`));

setOutput('verdict', verdict);

// --- act ----------------------------------------------------------------------
if (verdict === 'escalate') {
  await stop();
  process.stdout.write(`issue #${issue}: escalated — ${t.diagnosis}\n`);
  process.exit(0);
}

// An outage, a rate limit, a provider returning 529: nothing to fix and nothing to re-plan, and
// re-running at once proves the limit is still there. The same cooldown the failure handler
// parks a crashed model run on, bounded by the same count.
if (verdict === 'wait') {
  const max = Number(cfg.limits?.runtime_retries ?? 4);
  const parked = await parkForCooldown(repo, issue, merging ? 'merge' : stage, waited, {
    maxRetries: max, agent: 'triage',
    why: 'the triage traced this failure to an outage or a limit outside the repository, not to anything a change would fix',
  });
  if (!parked) {
    await stop(`## Waited out ${waited} cooldown${waited === 1 ? '' : 's'} and \`${stage}\` is still failing on an outage\n\n` +
      'An outage that has not cleared by now is not an outage any more, it is a wall — the token, ' +
      `the quota or the provider needs a look. ${retryHint(stage)} tries again once it is sorted.`);
  }
  process.exit(0);
}

let target;
const extra = {};
if (verdict === 'repair') {
  // A defect in the code goes to the code's author, with the diagnosis. Re-running a failed QA or
  // review against the same commit fails the same way — each lap a QA attempt and a browser
  // install — until the budget stops it, and the implementer never hears what was wrong.
  target = resolveStage('implement', { issue, pr, rework: 'fix:triage' });
} else if (verdict === 'replan') {
  // Root cause revises a WORK ORDER, and exits when there is none. A project-stage failure has
  // none — that stage emits a brief — and neither has a planning stage before its first plan.
  // Where there is nothing to revise, the honest replan is to run the stage again: the
  // diagnosis is on the issue, and the stage reads the issue.
  const workOrder = await readWorkOrder(repo, issue, cfg).catch(() => null);
  if (workOrder) {
    // Without the ledger's pending context: that belongs to whatever root-cause was last asked.
    target = resolveStage('root-cause', { issue, pr });
    extra.from = 'failure';
  } else {
    target = resolveStage(stage, { issue, pr, ledger });
  }
} else {
  // rerun and resume re-enter the stage that failed. What differs is what the stage finds
  // waiting for it: `resume` means the expensive work is already on the branch or the ledger
  // and the stage's own "is this already done?" checks will skip past it — which is why only a
  // rerun carries a rework reason: already-implemented treats any rework as "the branch is not
  // finished", and a resumed implementer would rebuild the change it had already pushed. A red
  // check or a crashed gate re-enters the gate, not the implementer (rerunTarget).
  target = merging
    ? resolveStage('merge', { issue, pr })
    : rerunTarget(stage, { issue, pr, ledger,
      rework: stage === 'implement' && verdict === 'rerun' ? 'fix:implement-failed' : null });
}

if (!target) {
  // A stage name the flow graph cannot start — or one that needs a pull request there is none
  // of. That is the pipeline's defect, not the issue's, and it is said as one: this used to
  // die here, and the triage's failure step then announced that the triage had crashed.
  await stop(`## The triage decided \`${verdict}\`, and nothing can start \`${stage}\`\n\n` +
    `\`${stage}\` is not a stage this pipeline can dispatch${pr ? '' : ' without a pull request'} — ` +
    'a defect in the pipeline, not in this issue. The diagnosis above stands; a person has to ' +
    'decide what runs next.');
  process.stdout.write(`::error::issue #${issue}: cannot resolve stage "${stage}" for ${verdict}\n`);
  process.exit(0);
}

// Stopped while the triage was reading the log. The diagnosis above stands; nothing is started,
// and no attempt is charged for a run the halt would refuse anyway.
if (ledger?.halted) {
  process.stdout.write(`issue #${issue}: halted by @${ledger.halted.by} — the diagnosis is posted, nothing is started\n`);
  process.exit(0);
}

// The attempt this dispatch costs, spent BEFORE it. This never spent one: implement -> red CI ->
// triage -> repair -> implement went round for as long as the model kept choosing `repair`,
// because neither the implementer nor root-cause spent its own counter as it started.
//
// Spent here only for a workflow that does not spend its own — plan, review, QA, implement and
// root-cause now do, as an early step, and charging one dispatch twice halves the budget of
// every issue a triage touches.
// Read off the workflow itself rather than a list here, so a stage that starts spending its own
// stops being charged twice without anyone remembering this file. For one that does, a cap
// already reached is still tripped here: that run would stop at its first step anyway.
const spendsOwn = (() => {
  try {
    return new RegExp(`sdlc-ctl\\.mjs attempt\\b[^\\n]*--stage\\s+"?${target.counter}\\b`)
      .test(readFileSync(`.github/workflows/${target.workflow}`, 'utf8'));
  } catch { return false; }
})();
const atCap = (ledger?.attempts?.[target.counter] ?? 0) >= Number(cfg.limits?.attempts ?? 10);
if (target.counter && (!spendsOwn || atCap)) {
  const spent = await exec('node', ['.sdlc/bin/sdlc-ctl.mjs', 'attempt',
    '--issue', String(issue), '--stage', target.counter, '--agent', 'triage'])
    .then((out) => { process.stdout.write(out.stdout); return true; })
    .catch((e) => {
      const said = String(e.stdout || e.stderr || e.message).trim();
      process.stdout.write(`${said}\n`);
      return /budget exceeded/.test(said) ? 'budget' : false;
    });
  if (spent !== true) {
    // At the cap `attempt` has already moved the issue to budget-exceeded and said so. Anything
    // else is `attempt` itself failing, and a dispatch nothing was charged for is the unbounded
    // loop this exists to close — so a person hears about it instead.
    if (!spent) {
      await stop(`## The triage decided \`${verdict}\`, and no attempt could be spent on it\n\n` +
        `\`sdlc-ctl attempt --stage ${target.counter}\` failed (the triage run has its output), so ` +
        `nothing was started: an unbudgeted re-run is how a loop runs forever. ${retryHint(stage)} ` +
        'starts it once that is sorted.');
    }
    setOutput('verdict', 'budget-exceeded');
    process.exit(0);
  }
}

const r = await dispatchStage({ repo, issue, target, agent: 'triage', extra,
  why: `the triage decided to ${verdict}` });
process.stdout.write(`issue #${issue}: ${stage} failed -> ${verdict} via ${target.workflow}` +
  `${r.dispatched ? '' : r.halted ? ' (halted — not dispatched)' : ' (not dispatched)'}\n`);
