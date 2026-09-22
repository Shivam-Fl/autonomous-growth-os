#!/usr/bin/env node
// Acts on the failure-triage agent's verdict.
//
// The decision itself is the agent's. This file only does what the agent decided, posts the
// diagnosis where a person will find it, and refuses two things the agent is not allowed to
// have: a `rerun` it could not justify, and a framework edit.
import { readFileSync, existsSync } from 'node:fs';
import { gh, setOutput, die, repo as repoOf } from './lib/actions.js';
import { handOff } from './lib/handoff.js';
import { advance } from './lib/advance.js';
import { markResume } from './lib/route-io.js';
import { updateLedger } from './lib/state-io.js';

const issue = Number(process.env.ISSUE);
const pr = process.env.PR ? Number(process.env.PR) : null;
const stage = process.env.STAGE;
const failedRun = process.env.FAILED_RUN;
const runUrl = process.env.RUN_URL ?? '';

if (!existsSync('triage.json')) die('the triage agent produced no verdict');
const t = JSON.parse(readFileSync('triage.json', 'utf8'));

// Which workflow re-runs a given stage, and which counter it spends. Same table the self-heal
// script uses, because "run the review again" has to mean the same thing in both places.
const STAGE = {
  plan:      { workflow: 'sdlc-plan.yml',      counter: 'plan',   state: 'planning',    rework: null },
  implement: { workflow: 'sdlc-implement.yml', counter: 'ci',     state: 'implementing', rework: 'fix:implement-failed' },
  ci:        { workflow: 'sdlc-implement.yml', counter: 'ci',     state: 'implementing', rework: 'fix:ci-red' },
  gate:      { workflow: 'sdlc-implement.yml', counter: 'ci',     state: 'implementing', rework: 'fix:gate-failed' },
  review:    { workflow: 'sdlc-review.yml',    counter: 'review', state: 'review',      rework: null },
  qa:        { workflow: 'sdlc-qa.yml',        counter: 'qa',     state: 'qa',          rework: null },
};
const route = STAGE[stage] ?? die(`unknown stage "${stage}"`);

// --- the verdict, and the two the agent does not get to make ------------------
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

// --- say it where someone is looking -----------------------------------------
const heading = {
  rerun:    `## ${stage} failed — transient, running it again`,
  resume:   `## ${stage} failed after the work was done — resuming, not redoing`,
  repair:   `## ${stage} failed — a defect in the code, sending it back with the diagnosis`,
  replan:   `## ${stage} failed because the plan cannot be built as written`,
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
  override ? `\n_Overridden to \`escalate\`: ${override}._` : null,
  '',
  `_Diagnosed by an agent that read the whole log of [the run that failed](${
    process.env.FAILED_URL ?? `../../actions/runs/${failedRun}`}) — [triage run](${runUrl})._`,
  // Drop absent sections, keep the blank lines. `.filter(Boolean)` removed both, so the
  // heading, the diagnosis, the evidence and the confidence rendered as one run-on paragraph —
  // markdown needs a blank line between block elements.
].filter((l) => l !== null).join('\n');

await gh(['issue', 'comment', String(issue), '--body', body])
  .catch((e) => process.stdout.write(`::warning::could not post the diagnosis: ${e.message}\n`));

// The diagnosis outlives this run: the next stage reads it off the ledger, and a repeat
// failure is answered against what was already concluded rather than from scratch.
await updateLedger(repoOf(), issue, (l) => {
  l.triage_history = [...(l.triage_history ?? []).slice(-9), {
    at: new Date().toISOString(), stage, verdict, confidence: t.confidence,
    diagnosis: String(t.diagnosis).slice(0, 500), run: failedRun,
  }];
}).catch((e) => process.stdout.write(`::warning::could not record the diagnosis: ${e.message}\n`));

setOutput('verdict', verdict);

// --- act ----------------------------------------------------------------------
if (verdict === 'escalate') {
  await markResume(repoOf(), issue, stage === 'ci' || stage === 'gate' ? 'implement' : stage, 'retry')
    .catch(() => {});
  await advance(issue, 'needs-human', { agent: 'triage' });
  process.stdout.write(`issue #${issue}: escalated — ${t.diagnosis}\n`);
  process.exit(0);
}

if (verdict === 'replan') {
  await advance(issue, 'planning', { agent: 'triage' });
  const args = ['-f', `issue=${issue}`];
  if (pr) args.push('-f', `pr=${pr}`);
  args.push('-f', 'from=failure');
  await handOff('sdlc-root-cause.yml', args, {
    issue, pr, why: 'the triage found the plan cannot be built as written',
  });
  process.exit(0);
}

// rerun, resume and repair all re-enter the same stage. What differs is what the stage finds
// waiting for it: `resume` means the expensive work is already on the branch or the ledger and
// the stage's own "is this already done?" checks will skip past it.
await advance(issue, route.state, { agent: 'triage' });

const args = [];
if (route.workflow === 'sdlc-implement.yml') {
  // `repair` carries the diagnosis as the rework reason, so the implementer is answering a
  // specific finding rather than re-reading a red CI log.
  args.push('-f', `issue=${issue}`, '-f', `rework=${verdict === 'repair' ? 'fix:triage' : route.rework ?? 'fix:retry'}`);
} else if (route.workflow === 'sdlc-review.yml' || route.workflow === 'sdlc-qa.yml') {
  args.push('-f', `pr=${pr}`);
} else {
  args.push('-f', `issue=${issue}`);
}

await handOff(route.workflow, args, { issue, pr, why: `the triage decided to ${verdict}` });
process.stdout.write(`issue #${issue}: ${stage} failed -> ${verdict} via ${route.workflow}\n`);
