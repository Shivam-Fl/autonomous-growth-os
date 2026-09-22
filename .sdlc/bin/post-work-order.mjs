#!/usr/bin/env node
// Posts the validated work order to the issue and routes according to the approval gate.
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gh, setOutput, loadConfig, repo as repoOf } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { handOffNext, routeOf, markResume } from './lib/route-io.js';
import { updateLedger } from './lib/state-io.js';
import { replaceSection, acceptanceChecklist } from './lib/pr-body.js';

const exec = promisify(execFile);

const issue = process.env.ISSUE;
const cfg = await loadConfig();
const wo = JSON.parse(readFileSync('work-order.json', 'utf8'));

// A work order written for a route that stops after planning is an ANSWER, not an
// instruction. It is posted, read and argued with; nothing builds it. Marked here rather
// than asked of the agent, because the agent does not know the route and an instruction a
// model can satisfy in more than one way is eventually satisfied the other way.
const ending = (await routeOf(repoOf(), issue).catch(() => ({ on_complete: 'merge' }))).on_complete;
if (ending === 'comment-only') wo.mode = 'proposal';

const list = (items, f) => (items ?? []).map(f).join('\n') || '_none_';

const body = [
  '## Work order v' + wo.version + (wo.mode === 'proposal' ? ' — a proposal, not scheduled work' : ''),
  wo.mode === 'proposal'
    ? '\n_This issue was routed as a question. The plan below is the answer; nothing implements ' +
      'it. `/sdlc replan "build this"` re-routes it if it should be built._'
    : '',
  '',
  '**Understanding.** ' + wo.understanding,
  wo.root_cause ? '\n**Root cause.** ' + wo.root_cause : '',
  '\n**Approach.** ' + wo.approach,
  '\n### Files',
  list(wo.files, (f) => '- `' + f.path + '` (' + f.action + ') — ' + f.change),
  '\n### Tests',
  list(wo.tests, (t) => '- `' + t.path + '` — ' + (t.cases ?? []).join('; ')),
  '\n### Acceptance criteria',
  list(wo.acceptance, (a) => '- **' + a.id + '** ' + a.check),
  wo.risks?.length ? '\n### Risks\n' + list(wo.risks, (r) => '- ' + r) : '',
  wo.out_of_scope?.length ? '\n### Deliberately out of scope\n' + list(wo.out_of_scope, (r) => '- ' + r) : '',
  '',
  '```json',
  JSON.stringify(wo, null, 2),
  '```',
].filter(Boolean).join('\n');

await gh(['issue', 'comment', issue, '--body', body]);

// Posted, so the resume stash has done its job. Left in place it would make the next genuine
// replan of this issue post the old plan instead of writing a new one.
await updateLedger(repoOf(), Number(issue), (l) => { delete l.approved_work_order; })
  .catch((e) => process.stdout.write(`::warning::could not clear the resume stash: ${e.message}\n`));

// Did the planner ask for a detour? It has just read the code, which the Router had not, so
// this is the first point in the pipeline where the route can be corrected on evidence. It
// only ASKS — one thing grants a detour, against the graph and the attempt budget.
//
// Before the gating read below, deliberately: a refused request that escalates sets
// sdlc:needs-human, and the parked check further down is what then stops the dispatch.
await exec('node', ['.sdlc/bin/route-request.mjs'], {
  env: {
    ...process.env,
    ARTIFACT: 'work-order.json',
    FROM_STAGE: process.env.FROM_STAGE || 'plan',
    ISSUE: String(issue),
  },
}).then((r) => process.stdout.write(r.stdout))
  .catch((e) => process.stdout.write(`::warning::route request step failed: ${String(e.message).split('\n')[0]}\n`));

// Record which files this plan expects to touch. Used only to flag overlap with other work
// in flight — never to block it. A plan's file list is a forecast, and forecasts should
// inform a reviewer rather than gate a pipeline.
const paths = [...(wo.files ?? []), ...(wo.tests ?? [])].map((f) => f.path).filter(Boolean);
if (paths.length) {
  await exec('node', ['.sdlc/bin/sdlc-ctl.mjs', 'link', '--issue', String(issue), '--paths', paths.join(',')])
    .catch(() => {});   // advisory data; never fail a plan over it
}

// A revised work order changes the contract, so the PR has to say so.
//
// The body is written once, when the PR is opened, from the work order of that moment. A QA
// failure produces a revision — new acceptance criteria, often for the bugs QA just found —
// and the PR went on advertising the old list. A reviewer reads the PR, not the issue's comment
// history, so they were checking against a contract that no longer existed. Observed live: a PR
// body listing five criteria while its work order had six.
const openPr = await gh(['pr', 'list', '--head', `sdlc/issue-${issue}`, '--state', 'open', '--json', 'number,body'])
  .then((o) => JSON.parse(o)[0]).catch(() => null);

if (openPr) {
  const updated = replaceSection(openPr.body, 'Acceptance criteria', acceptanceChecklist(wo.acceptance));
  if (updated !== openPr.body) {
    await gh(['pr', 'edit', String(openPr.number), '--body', updated])
      .then(() => process.stdout.write(`PR #${openPr.number}: acceptance criteria updated to work order v${wo.version}\n`))
      .catch((e) => process.stdout.write(`::warning::could not refresh PR #${openPr.number}'s acceptance criteria: ${String(e.message).split('\n')[0]}\n`));
  }
}

// Never start work on an issue a human has just been asked to look at.
//
// The plan reviewer's `escalate` path used to fail the run, which stopped everything by
// accident. Now that it exits cleanly — so the human actually gets the plan to read — the stop
// has to be deliberate: an issue at needs-human is posted to, never dispatched from.
const labels = await gh(['issue', 'view', issue, '--json', 'labels', '--jq', '.labels[].name'])
  .then((o) => o.split('\n').map((l) => l.trim()).filter(Boolean))
  .catch(() => []);
const parked = labels.find((l) => l === 'sdlc:needs-human' || l === 'sdlc:blocked');

const gatedFrom = process.env.FROM_STAGE || 'plan';

if (parked) {
  await markResume(repoOf(), issue, gatedFrom, 'after');
  await gh(['issue', 'comment', issue,
    '--body', `The work order above is posted for review. Nothing will act on it while this issue is \`${parked}\` — ` +
      'comment `/sdlc approve` to proceed, or `/sdlc reject` with what to change.']);
  setOutput('gated', 'true');
  process.stdout.write(`issue #${issue} is ${parked} — posted the work order, dispatching nothing\n`);
} else if (cfg.gates?.plan_approval) {
  await markResume(repoOf(), issue, gatedFrom, 'after');
  await gh(['issue', 'edit', issue, '--remove-label', 'sdlc:planning', '--add-label', 'sdlc:plan-review']);
  await gh(['issue', 'comment', issue, '--body',
    'Waiting for approval before any code is written. Comment `/sdlc approve` to proceed, or `/sdlc reject` with what to change.']);
  setOutput('gated', 'true');
} else {
  // sdlc:plan-review is cleared here: left over from a run when the human gate was still on,
  // it says "waiting for you" on an issue that is waiting for nobody. The state itself is set
  // by the hand-off below, which knows which stage is actually next.
  await gh(['issue', 'edit', issue, '--remove-label', 'sdlc:plan-review']).catch(() => {});

  // Where this goes next is the ROUTE's decision, not this file's. It was `sdlc-implement.yml`
  // written as a literal, which is correct for a feature and wrong for a design question: a
  // ticket asking "should we do X" was answered with a plan and then had the plan built.
  const from = gatedFrom;
  const { dispatched, stage, on_complete } = await handOffNext({
    repo: repoOf(), issue, from, agent: 'planner',
    why: 'the work order is approved and nothing else will start the next stage',
  });

  if (!dispatched && !stage) {
    // The route ends here on purpose. A plan that was asked for as an ANSWER is finished when
    // it is written down; building it is a separate decision a person makes.
    await advance(issue, 'needs-human', { agent: 'planner' });
    await gh(['issue', 'comment', issue, '--body',
      on_complete === 'comment-only'
        ? 'This issue was routed as a question, so the work order above is the answer and the ' +
          'pipeline stops here on purpose. Nothing is being built from it.\n\n' +
          'If it should be built, comment `/sdlc replan "build this"` to re-route it.'
        : `The route has no stage after \`${from}\`, so nothing follows this work order. ` +
          'Handing to a human rather than picking a next stage nobody chose.']).catch(() => {});
  }
  setOutput('gated', 'false');
  setOutput('next', stage ?? '');
}
