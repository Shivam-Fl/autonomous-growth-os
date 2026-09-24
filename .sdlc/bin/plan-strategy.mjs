#!/usr/bin/env node
// Resolves, for one issue: which agent plans it, and how much deliberation it gets.
// Emitted as step outputs so the workflow's conditions stay readable.
import { gh, ghJson, setOutput, loadConfig, trustedComments, repo as repoOf } from './lib/actions.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { agentForIssue, councilFor } from './lib/routing.js';
import { readLedger } from './lib/state-io.js';
import { isEpic } from './lib/deps.js';
import { isStub } from './lib/project.js';
import { resolveStage } from './lib/flow-graph.js';
import { dispatchStage } from './lib/route-io.js';

const issue = process.env.ISSUE;
const cfg = await loadConfig();
const data = await ghJson(['issue', 'view', issue, '--json', 'labels,title']);

const agent = agentForIssue({ labels: data.labels }, cfg);

// Not planned at all. Every later step of the plan job is gated on this, and this runs before
// the attempt, the claim and the lock, so a refusal spends and moves nothing.
const skip = (why) => {
  setOutput('mode', 'skip');
  setOutput('agent', agent);
  setOutput('pack', '');
  process.stdout.write(`#${issue}: not planned — ${why}\n`);
  process.exit(0);
};

// Never plan an epic: it is too large for one work order by definition, and the maintainer
// splits it first. The job's `if` read github.event.issue.labels, which a workflow_dispatch does
// not carry — and every hand-off is a dispatch — so a dispatched epic was planned as one ticket.
if (isEpic(data)) {
  await gh(['issue', 'comment', issue, '--body',
    'This issue is an epic, so it is not planned as one work order: the maintainer splits it into ' +
    'issues first, and each of those is planned. Nothing was planned here.']).catch(() => {});
  skip('it is an epic');
}

// Never plan against an architecture nobody has decided. A route with `project` in it says the
// stack is decided first, and a dispatch that reached the planner anyway — a retry, a resume —
// had it invent a stack for this ticket alone. So the architecture decision runs instead, unless
// it already ran and its brief is waiting for a person, in which case nothing does.
const { ledger } = await readLedger(repoOf(), Number(issue)).catch(() => ({ ledger: null }));
const projectMd = existsSync('.sdlc/memory/project.md') ? readFileSync('.sdlc/memory/project.md', 'utf8') : null;
if ((ledger?.planned_route ?? []).includes('project') && isStub(projectMd)) {
  if (ledger?.stopped_at === 'project') {
    await gh(['issue', 'comment', issue, '--body',
      'Not planned: this project\'s architecture is still undecided, and its brief is waiting for ' +
      'a person. Merging the architecture-brief PR is what starts planning.']).catch(() => {});
    skip('the architecture brief is waiting for a person');
  }
  const target = resolveStage('project', { issue, ledger });
  const r = target
    ? await dispatchStage({ repo: repoOf(), issue, target, agent: 'planner',
      why: 'the route decides the architecture first, and .sdlc/memory/project.md is still a stub' })
    : { dispatched: false };
  skip(r.dispatched ? 'the architecture is undecided, so the project stage was started instead'
    : 'the architecture is undecided and the project stage could not be started');
}

// A plan already approved is not replanned. It is posted.
//
// Everything between here and the post — validation, the gate, the reviewer — has already
// run and said yes. Re-running the stage from the top to repair a step after that point
// discards the expensive half of the work to retry the cheap half, which is how one failed
// `gh` call cost a second three-agent council.
if (ledger?.approved_work_order) {
  writeFileSync('work-order.json', JSON.stringify(ledger.approved_work_order, null, 2));
  setOutput('agent', agent);
  setOutput('mode', 'resume');
  setOutput('pack', '');
  setOutput('too_high', ledger.approved_too_high ? 'true' : 'false');
  setOutput('from_stage', agent === 'debugger' ? 'debug' : 'plan');
  process.stdout.write(
    `#${issue}: a plan for this issue was already approved (v${ledger.approved_work_order.version ?? '?'}) ` +
    'and never posted — posting it rather than planning again\n');
  process.exit(0);
}

// What this planner acts on besides the issue, written by a script from what only the pipeline
// writes: the decisions a person recorded with `/sdlc`, and the last rejection of a plan here.
//
// The prompts said to read "the most recent '## Plan review: rejected' comment", and the packs to
// obey any "## Answered" comment — headings anyone can post on a public repository, so an
// outsider could hand the planner its brief. The body's Decisions section can be forged the same
// way on an issue the outsider filed, so the ledger's copy is the one delivered.
const said = (e) => (typeof e === 'string' ? e : e?.answer ?? e?.note ?? e?.reason ?? e?.text ?? '');
// And what a person decided on the epic this issue was split from, first, so the issue's own
// decisions come after it. `/sdlc answer` on an epic is recorded on the EPIC's ledger, and a
// child's ledger is created with none: the brief said "Nothing recorded", the pack treats a body
// entry missing here as data, and the owner's "money is integer paise" reached no child planner.
// `epic` on a ledger is written by the split alone. Not caught: a decision that could not be
// read is not a decision nobody made.
const epic = ledger?.epic ? Number(ledger.epic) : null;
const { ledger: epicLedger } = epic ? await readLedger(repoOf(), epic) : { ledger: null };
const decided = [
  ...(epicLedger?.answers ?? []).map((e) => [`answer on epic #${epic}`, e]),
  ...(epicLedger?.route_notes ?? []).map((e) => [`route note on epic #${epic}`, e]),
  ...(ledger?.answers ?? []).map((e) => ['answer', e]),
  ...(ledger?.route_notes ?? []).map((e) => ['route note', e]),
  ...(ledger?.human_rejections ?? []).map((e) => ['plan rejected', e]),
].filter(([, e]) => said(e).trim());
const rejection = (await trustedComments('issue', issue, cfg, { pipelineOnly: true }).catch(() => []))
  .filter((c) => /^## Plan review: (rejected|could not verify)/.test(c.body)).at(-1);
mkdirSync('plan', { recursive: true });
writeFileSync('plan/brief.md', [
  '# Decided for this issue',
  '',
  decided.length
    ? decided.map(([kind, e]) => `- **${kind}** by @${e.by ?? 'a maintainer'}${e.at ? ` (${e.at})` : ''}:\n` +
        said(e).split('\n').map((l) => `  ${l}`).join('\n')).join('\n')
    : '_Nothing recorded._',
  '',
  '# The last rejection of a plan for this issue',
  '',
  rejection ? rejection.body : '_None — no plan for this issue has been rejected._',
  '',
].join('\n'));

// A validated plan whose review never finished is reviewed, not planned again.
//
// The council's plan lived only on the runner until the reviewer approved it, so a reviewer step
// that failed threw away three agents' work. A root-cause revision that rewrote a criterion is
// sent here the same way. Unless something newer supersedes it — a rejection, a replan — the
// stash is restored and only validation, the gate and the reviewer run.
const stash = ledger?.validated_work_order;
const newer = (t) => Boolean(t) && String(t) > String(ledger?.validated_at ?? '');
if (stash && !newer(rejection?.createdAt) && !newer(ledger?.replan_requested_at)) {
  writeFileSync('work-order.json', JSON.stringify(stash, null, 2));
  const changes = ledger.validated_ac_changes ?? [];
  if (changes.length) {
    writeFileSync('plan/ac-diff.md', [
      '# Acceptance criteria root-cause rewrote', '',
      ...changes.flatMap((c) => [`## ${c.id}`, '', `**Was:** ${c.was?.check}`,
        c.was?.how_to_verify ? `\n_Verified by:_ ${c.was.how_to_verify}` : '', '',
        `**Now:** ${c.now?.check}`, c.now?.how_to_verify ? `\n_Verified by:_ ${c.now.how_to_verify}` : '', '']),
    ].join('\n'));
  }
  setOutput('agent', agent);
  setOutput('mode', 'review');
  setOutput('pack', '');
  setOutput('from_stage', ledger.validated_from ?? (agent === 'debugger' ? 'debug' : 'plan'));
  process.stdout.write(`#${issue}: a validated plan was never reviewed — reviewing it rather than planning again` +
    `${changes.length ? ` (it rewrites ${changes.map((c) => c.id).join(', ')})` : ''}\n`);
  process.exit(0);
}

// The last output that failed validation, handed back instead of thrown away.
//
// A work order rejected by the validator existed only on the runner, so the rerun wrote the
// whole plan again — a council, to fix one field — and could fail the same way. sdlc-ctl
// validate keeps it on the ledger; it is only this plan's if nothing was posted since.
const failed = ledger?.rejected_artifacts?.['work-order'];
if (failed && String(failed.at ?? '') > String(ledger?.work_order_posted_at ?? '')) {
  writeFileSync('previous-output.json', JSON.stringify({ failed_validation_with: failed.errors ?? [], output: failed.text }, null, 2));
  process.stdout.write(`#${issue}: the previous work order failed validation — handing it back to be corrected\n`);
}

// The Router may ask for LESS deliberation on a ticket that does not need it — a council is
// for plans that are expensive to get wrong, and a wording change is not one. It may only
// ask downward: turning a single pass into a council costs three times as much on a ticket a
// cheap model classified, which is the wrong direction for a cheap model to be able to push.
const asked = ledger?.flow_plan?.councils?.plan;
const configured = councilFor('plan', cfg).length > 1 ? 'council' : 'single';
const mode = asked === 'single' ? 'single' : configured;
if (asked && asked !== configured) {
  process.stdout.write(
    `the route asked for a ${asked} plan and config says ${configured} — using ${mode}` +
    `${asked === 'council' ? ' (a route may reduce deliberation, never add cost)' : ''}\n`);
}
const stages = mode === 'council' ? councilFor('plan', { ...cfg, councils: { ...cfg.councils, plan: 'council' } }) : [{ role: 'plan' }];

// A bug is diagnosed by reproducing it, not by debating a plan for it — the debugger owns
// the investigation, and a council of three static readers adds cost without adding evidence.
const effectiveMode = agent === 'debugger' ? 'single' : mode;
void stages;

setOutput('agent', agent);
setOutput('mode', effectiveMode);
setOutput('pack', agent === 'debugger' ? 'debugger.md' : 'planner.md');
// Which slot on the route this run fills: `debug` and `plan` are one position held by different
// agents, and a reviewed root-cause revision (above) is root-cause's.
setOutput('from_stage', agent === 'debugger' ? 'debug' : 'plan');
process.stdout.write(`#${issue} "${data.title}" -> ${agent} (${effectiveMode})\n`);
