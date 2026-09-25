#!/usr/bin/env node
// Posts the validated work order to the issue and routes according to the approval gate.
//
// Every producer posts through here — the planner, the debugger, a council, root-cause — so
// this is where what an agent wrote becomes THE work order the pipeline builds.
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gh, ghJson, setOutput, loadConfig, die, repo as repoOf } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { handOffNext, markResume, dispatchStage } from './lib/route-io.js';
import { readLedger, updateLedger } from './lib/state-io.js';
import { newLedger } from './lib/ledger.js';
import { resolveStage } from './lib/flow-graph.js';
import { splitCriteriaOf, renderSplitCriteria, SPLIT_CRITERIA_HEADING, deferredSplitCriteria, unansweredSplitCriteria } from './lib/issue-body.js';
import { rememberRejected } from './lib/artifact.js';
import { epicOf } from './lib/deps.js';
import { fileIssue } from './lib/file-issue.js';
import { replaceSection, acceptanceChecklist } from './lib/pr-body.js';
import { WORK_ORDER_MARKER, nextWorkOrderVersion, recordWorkOrder, readWorkOrder } from './lib/work-order.js';

const exec = promisify(execFile);

const issue = process.env.ISSUE;
const repo = repoOf();
const cfg = await loadConfig();
const wo = JSON.parse(readFileSync('work-order.json', 'utf8'));
// Not caught: the version and the record below both come from it, and a guess at either is the
// bug this file exists to prevent.
const { ledger } = await readLedger(repo, Number(issue));

// The version is the pipeline's, never the agent's.
//
// It is what tells the implementer that the branch answers an older plan. Only root-cause ever
// renumbered, so a replan the planner wrote as v1 — the obvious number to write — met a branch
// built from v1 and was skipped as "already implemented": the human's replan was never built.
// Counted from the ledger's own record, and past whatever the branch already implements, so an
// issue planned before the ledger held its work order cannot collide with that number either.
wo.version = Math.max(nextWorkOrderVersion(ledger), (ledger?.implemented_version ?? 0) + 1);

// A work order written for a route that stops after planning is an ANSWER, not an
// instruction. It is posted, read and argued with; nothing builds it. Marked here rather
// than asked of the agent, because the agent does not know the route and an instruction a
// model can satisfy in more than one way is eventually satisfied the other way.
// Both ways: the schema says the agent never sets it, and an agent that wrote "proposal" into a
// work order for a merge route had it posted as "routed as a question — nothing implements it"
// on an issue the pipeline was about to build (growth-os #40).
wo.mode = (ledger?.on_complete ?? 'merge') === 'comment-only' ? 'proposal' : 'committed';

// Every criterion the split gave this issue is answered or deferred, by id.
//
// Work-order criteria had no link back to the issue's, and all had to be browser-observable, so
// a split piece's "rows older than 90 days are purged nightly" or "p95 under 300 ms" landed in
// out_of_scope as prose and vanished: nothing built it, nothing filed it, and the epic closed as
// done. Now each IAC-n must be the `source` of a criterion (a `verify: test` one where no browser
// can see it) or be deferred as "IAC-n: reason", which files it as its own issue below. Anything
// else is refused, and the failure path re-runs the planner with this message.
//
// A refusal of what the plan SAYS is not a crash, and it must not leave the plan where the retry
// finds it. The plan workflow stashes a plan as validated, then as approved, before this runs; a
// die() here cleared neither, so every retry restored the same plan, re-posted it and died on the
// same line. Both stashes are dropped, and the plan is kept as the validator keeps a rejected one,
// so the planner (or root-cause) that reruns is handed it and this reason as previous-output.json.
// The plan gate runs the same split-criteria check before it stashes anything; this is the one
// every producer passes, root-cause included.
async function refuse(message) {
  await updateLedger(repo, Number(issue), (l) => {
    if (!l || !(l.approved_work_order || l.validated_work_order)) return null;
    const next = { ...l };
    delete next.approved_work_order;
    delete next.validated_work_order;
    return next;
  }).catch((e) => process.stdout.write(`::warning::could not drop the refused plan's stash: ${e.message}\n`));
  await rememberRejected(repo, issue, 'work-order', readFileSync('work-order.json', 'utf8'), [message]);
  die(message);
}

const issueBody = await ghJson(['issue', 'view', issue, '--json', 'body']).then((d) => d.body ?? '');
const required = splitCriteriaOf(issueBody);
const deferred = deferredSplitCriteria(wo);
const unanswered = unansweredSplitCriteria(wo, issueBody);
if (unanswered.ids.length) await refuse(unanswered.message);

// A revision may ADD criteria. Dropping or rewriting one that QA holds the PR to is a decision
// about what "done" means, and root-cause is the one stage that can make it — so it is judged.
//
// Root-cause's revision went straight from its own run to here, and nothing compared its
// acceptance[] with the plan before it: the criterion that had just failed QA could be reworded
// to match the defect, or dropped, and the next QA run certified the result. A dropped id is
// refused outright (the failure path re-runs root-cause with this message). A changed one is
// kept on the ledger and handed to the plan workflow, whose gate and reviewer judge it before
// anything is built; that run posts it with REVIEWED set.
if (process.env.FROM_STAGE === 'root-cause') {
  const before = (await readWorkOrder(repo, issue, cfg))?.acceptance ?? [];
  const now = new Map((wo.acceptance ?? []).map((a) => [a.id, a]));
  const dropped = before.filter((a) => !now.has(a.id)).map((a) => a.id);
  if (dropped.length) {
    await refuse(`root-cause dropped ${dropped.join(', ')}: a revision keeps every acceptance criterion of the ` +
      'plan it revises (correct one in place, keeping its id), and numbers new ones after them');
  }
  const changed = before
    .filter((a) => now.get(a.id).check !== a.check || (now.get(a.id).how_to_verify ?? '') !== (a.how_to_verify ?? ''))
    .map((a) => ({ id: a.id, was: a, now: now.get(a.id) }));
  if (changed.length && process.env.REVIEWED !== 'true') {
    await updateLedger(repo, Number(issue), (l) => (l ? {
      ...l, validated_work_order: wo, validated_from: 'root-cause',
      validated_at: new Date().toISOString(), validated_ac_changes: changed,
    } : null));
    await gh(['issue', 'comment', issue, '--body',
      `## Root-cause changed ${changed.map((c) => c.id).join(', ')}

` +
      'A criterion QA holds this PR to was rewritten, so the revision goes to the plan gate and the ' +
      'plan reviewer before anything is built. A correction that makes a criterion say what the plan ' +
      'meant goes through; a criterion rewritten to match the defect does not.']);
    const target = resolveStage('plan', { issue, ledger });
    await dispatchStage({ repo, issue, target, agent: 'root-cause',
      why: 'a revision that rewrites acceptance criteria is reviewed before it is built' });
    setOutput('gated', 'true');
    process.stdout.write(`issue #${issue}: root-cause changed ${changed.map((c) => c.id).join(', ')} — sent for review\n`);
    process.exit(0);
  }
}

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
  // Marks this block as the pipeline's work order for the legacy comment reader; a quoted plan,
  // a rejected one, or an outsider's comment carries no marker and is never taken for it.
  WORK_ORDER_MARKER(wo.version),
  '```json',
  JSON.stringify(wo, null, 2),
  '```',
].filter(Boolean).join('\n');

const posted = await gh(['issue', 'comment', issue, '--body', body]);

// Recorded, not just posted: the ledger is the one copy the implementer, the PR body and QA read.
// Every reader used to take the newest JSON block on the issue, whoever wrote it — an outsider's
// comment, or the rejected plan quoted inside a rejection. Recording also clears the stashes of
// any earlier plan, which left in place would re-post the old plan on the next genuine replan.
await recordWorkOrder(repo, issue, wo, {
  commentId: String(posted).match(/issuecomment-(\d+)/)?.[1] ?? null,
  from: process.env.FROM_STAGE || 'plan',
});

// Each deferred split criterion becomes its own issue, once. It depends on this one and waits
// (sdlc:blocked) until this ships; wake-dependents starts it then. Numbers are kept on the
// ledger, so a replan that defers the same criterion again does not file it twice.
const alreadyFiled = ledger?.deferred_criteria ?? {};
const epic = epicOf(issueBody);
const filed = {};
for (const c of required.filter((r) => deferred.has(r.id) && !alreadyFiled[r.id])) {
  const made = await fileIssue({
    title: c.text.length > 120 ? `${c.text.slice(0, 117)}...` : c.text,
    body: [
      `Deferred from #${issue} by its work order: ${deferred.get(c.id)}`, '',
      SPLIT_CRITERIA_HEADING, '', renderSplitCriteria([c.text]), '',
      ...(epic ? [`Part of #${epic}.`] : []), `Depends on #${issue}.`,
    ].join('\n'),
    labels: ['sdlc:blocked'],
    start: false,
  });
  if (!made) {
    process.stdout.write(`::warning::could not file ${c.id} (deferred from #${issue}) as its own issue\n`);
    continue;
  }
  filed[c.id] = made.number;
  // Its own ledger, knowing its epic, as the split writes one for every piece. The criterion is
  // the epic's own words, and without `epic` there intake's keyword stop parked it for a person
  // after the owner had already passed the epic.
  if (epic) {
    await updateLedger(repo, made.number, (l) => ({ ...(l ?? { ...newLedger(made.number), state: 'blocked' }), epic }))
      .catch((e) => process.stdout.write(`::warning::could not record #${made.number}'s epic: ${e.message}\n`));
  }
}
if (Object.keys(filed).length) {
  await updateLedger(repo, Number(issue), (l) => (l ? { ...l, deferred_criteria: { ...(l.deferred_criteria ?? {}), ...filed } } : null))
    .catch((e) => process.stdout.write(`::warning::could not record the deferred criteria: ${e.message}\n`));
  await gh(['issue', 'comment', issue, '--body',
    `Deferred to their own issues: ${Object.entries(filed).map(([id, n]) => `${id} -> #${n}`).join(', ')}. ` +
    'Each waits for this one to ship.']).catch(() => {});

  // Each is a piece of the epic as much as this issue is. The epic is finished when every child
  // on its ledger has closed, and a follow-up filed here was on no ledger: the epic closed as
  // done with the follow-up still open, and what it deferred was built after a "done" nobody
  // re-checked. Only an epic whose own split recorded this issue — "Part of #N" in a body is
  // prose anyone filing an issue can type, and would hold someone else's epic open.
  const parent = Number(ledger?.epic ?? epic);
  if (parent) {
    await updateLedger(repo, parent, (l) => (l?.children?.map(Number).includes(Number(issue))
      ? { ...l, children: [...new Set([...l.children.map(Number), ...Object.values(filed)])] }
      : null))
      .catch((e) => process.stdout.write(`::warning::could not add ${Object.values(filed).map((n) => `#${n}`).join(', ')} ` +
        `to epic #${parent}'s children: ${e.message}\n`));
  }
}

// Did the planner ask for a detour? It has just read the code, which the Router had not, so
// this is the first point in the pipeline where the route can be corrected on evidence. It
// only ASKS — one thing grants a detour, against the graph and the attempt budget.
//
// Its answer is read — setOutput also prints each output as a key=value line, which is how a
// script exec'd inside this step answers — not inferred from labels afterwards. A grant that replaced the route has
// already started the new route, and an escalation has already asked a person — either way
// this plan's own hand-off below would be a second, contradicting one. Both used to be ignored:
// a scope_changed -> maintainer grant then handed the oversized plan to the implementer.
const asked = await exec('node', ['.sdlc/bin/route-request.mjs'], {
  env: {
    ...process.env,
    ARTIFACT: 'work-order.json',
    FROM_STAGE: process.env.FROM_STAGE || 'plan',
    ISSUE: String(issue),
  },
}).then((r) => { process.stdout.write(r.stdout); return r.stdout; })
  .catch((e) => { process.stdout.write(`::warning::route request step failed: ${String(e.message).split('\n')[0]}\n`); return ''; });
if (/^redirected=true$/m.test(asked)) {
  setOutput('gated', 'true');
  process.stdout.write(`issue #${issue}: re-routed — the new route was started, nothing follows this plan\n`);
  process.exit(0);
}
if (/^escalated=true$/m.test(asked)) {
  // `/sdlc approve` then means "build this plan on the route it has".
  await markResume(repo, issue, process.env.FROM_STAGE || 'plan', 'after');
  setOutput('gated', 'true');
  process.stdout.write(`issue #${issue}: the route request went to a person — dispatching nothing\n`);
  process.exit(0);
}

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
//
// The PR the ledger recorded, never one found by branch name: `gh pr list --head` matches the
// branch name in ANY repository, so a fork's PR from a branch named sdlc/issue-N had its body
// rewritten under the pipeline's name. And only while it is open.
const openPr = ledger?.pr
  ? await gh(['pr', 'view', String(ledger.pr), '--json', 'number,body,state'])
    .then((o) => JSON.parse(o)).then((p) => (p.state === 'OPEN' ? p : null)).catch(() => null)
  : null;

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

// Who must look at this plan, decided by plan-gate — the one place it is decided — for every
// producer, root-cause included. Not caught: a gate that could not be computed is not a pass.
const verdict = await exec('node', ['.sdlc/bin/plan-gate.mjs'], {
  env: { ...process.env, FROM_STAGE: gatedFrom, ISSUE: String(issue) },
}).then((r) => r.stdout);
const gate = verdict.match(/^gate=(.*)$/m)?.[1];
const reason = verdict.match(/^reason=(.*)$/m)?.[1];

if (parked) {
  await markResume(repoOf(), issue, gatedFrom, 'after');
  await gh(['issue', 'comment', issue,
    '--body', `The work order above is posted for review. Nothing will act on it while this issue is \`${parked}\` — ` +
      'comment `/sdlc approve` to proceed, or `/sdlc reject` with what to change.']);
  setOutput('gated', 'true');
  process.stdout.write(`issue #${issue} is ${parked} — posted the work order, dispatching nothing\n`);
} else if (gate === 'human') {
  // Whatever `gates.plan_approval` says. A plan below min_confidence, a bug nobody watched fail,
  // a route that asked for approval, a reviewer who called the confidence too high: each of
  // those went straight to the implementer while the comment above it said a person would
  // decide — the least-trusted plans with no review at all.
  await markResume(repoOf(), issue, gatedFrom, 'after');
  await advance(issue, 'needs-human', { agent: 'planner' });
  await gh(['issue', 'edit', issue, '--add-label', 'sdlc:plan-review']);
  await gh(['issue', 'comment', issue, '--body',
    `## Waiting for a person before any code is written\n\nBecause **${reason}**.\n\n` +
    'Comment `/sdlc approve` to build the work order above, or `/sdlc reject` with what to change.']);
  setOutput('gated', 'true');
  process.stdout.write(`issue #${issue}: ${reason} — posted the work order, dispatching nothing\n`);
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
