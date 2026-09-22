#!/usr/bin/env node
// Takes a flow plan — from the script rules or from the model — and makes it real.
//
// One place records the route, one place checks it against the graph, one place decides
// whether a person sees it first, one place starts the first stage. The alternative is the
// thing this framework has been unpicking since the beginning: the same decision made at six
// call sites, five of which are correct.
//
// It is also the boundary where the Router's authority stops. A route says how much
// deliberation a ticket gets. It does not say whether a human approves the plan or the merge,
// and it does not touch forbidden_paths — those are config, and a routing decision that could
// waive them is a routing decision that can ship unreviewed code.

import { readFileSync, existsSync } from 'node:fs';
import { gh, setOutput, loadConfig, die } from './lib/actions.js';
import { handOff } from './lib/handoff.js';
import { advance } from './lib/advance.js';
import { repair } from './lib/repair.js';
import { validate, formatErrors } from './lib/validate.js';
import { validateRoute, dispatchFor, loadGraph, DEFAULT_ROUTE } from './lib/flow-graph.js';
import { effectiveGates, routeGate } from './lib/route.js';
import { markResume } from './lib/route-io.js';
import { isStub } from './lib/project.js';
import { updateLedger } from './lib/state-io.js';

const repo = process.env.GITHUB_REPOSITORY ?? die('GITHUB_REPOSITORY is not set');
const issue = Number(process.env.ISSUE ?? die('ISSUE is required'));
const cfg = await loadConfig();
const graph = loadGraph();

// --- read whatever the Router produced ---------------------------------------
let plan;
if (existsSync('flow-plan.json')) {
  plan = JSON.parse(readFileSync('flow-plan.json', 'utf8'));
} else {
  // Both phases declined to write one. That is not "route it the usual way": the model pass
  // was dispatched precisely because the rules would not commit, and a missing artifact after
  // it means the run did not produce one. Falling back silently would make the Router look
  // like it decided something.
  process.stdout.write('::warning::no flow-plan.json — neither the rules nor the model produced a route\n');
  plan = {
    issue,
    kind: 'feature',
    reasoning: 'Neither the deterministic rules nor the model pass produced a route, so this falls back to the chain the framework shipped with. Recorded as a fallback, not as a decision.',
    route: [...DEFAULT_ROUTE],
    on_complete: 'merge',
    confidence: 0,
    matched_rule: 'fallback:no-plan-produced',
  };
}

// --- is it a well-formed plan ------------------------------------------------
const schema = JSON.parse(readFileSync('.sdlc/schemas/flow-plan.json', 'utf8'));
const fixed = repair(schema, plan);
if (fixed.repairs.length) {
  plan = fixed.data;
  process.stdout.write(
    `Repaired ${fixed.repairs.length} cosmetic issue(s) rather than rejecting the plan:\n` +
    fixed.repairs.map((r) => `- ${r}`).join('\n') + '\n');
}
plan.issue = issue;   // whatever the agent wrote, this is the issue being routed

const shape = validate(schema, plan);
if (!shape.ok) {
  // Repair has already fixed everything mechanically fixable, so what is left is a claim:
  // an invented stage name, a missing route, a kind nobody can act on. Route it to a person
  // rather than acting on a plan nothing validated.
  const detail = formatErrors(shape.errors);
  process.stdout.write(`the flow plan does not validate:\n${detail}\n`);
  await gh(['issue', 'comment', String(issue), '--body',
    `## The route could not be read\n\n${detail}\n\n` +
    'Nothing is dispatched from a plan that does not validate. `/sdlc replan "<why>"` runs the ' +
    'Router again with your note as context, or `/sdlc approve` starts the ordinary chain.']).catch(() => {});
  await advance(issue, 'needs-human', { agent: 'router' });
  setOutput('gate', 'human');
  process.exit(0);
}

// --- has anyone decided what this repo is built out of? ----------------------
//
// Not a heuristic about whether the ticket is "product-scale". A repo with no recorded
// architecture cannot have ANY ticket planned against it — the planner would invent a stack,
// differently each time, and nothing would ever say which one was chosen. So the question is
// about the repo, not the ticket, and it answers itself once: after the brief is approved,
// project.md is no longer a stub and the stage is never placed again.
const buildsSomething = plan.route.some((s) => ['plan', 'debug', 'maintainer'].includes(s));
const projectMd = existsSync('.sdlc/memory/project.md')
  ? readFileSync('.sdlc/memory/project.md', 'utf8')
  : null;

if (buildsSomething && !plan.route.includes('project') && isStub(projectMd)) {
  plan.route = ['project', ...plan.route];
  plan.reasoning = `${plan.reasoning} Nothing has recorded what this repository is built out of, ` +
    'so the architecture is decided first — once, with a human reading it.';
  process.stdout.write('.sdlc/memory/project.md is a stub — the architecture is decided before anything is planned\n');
}

// --- is it a route the pipeline can actually walk ----------------------------
const legal = validateRoute(plan.route, graph);
if (!legal.ok) {
  const detail = legal.errors.map((e) => `- ${e}`).join('\n');
  process.stdout.write(`the route is not walkable:\n${detail}\n`);
  await gh(['issue', 'comment', String(issue), '--body',
    `## The route does not exist\n\n\`${plan.route.join(' -> ')}\`\n\n${detail}\n\n` +
    'The stages and the edges between them live in `.sdlc/flow-graph.json`. Nothing is ' +
    'dispatched on a route that cannot be walked — that is a hand-off into nothing, which is ' +
    'this pipeline\'s signature failure.']).catch(() => {});
  await advance(issue, 'needs-human', { agent: 'router' });
  setOutput('gate', 'human');
  process.exit(0);
}

// --- does a human look at it first -------------------------------------------
const gates = effectiveGates(cfg.gates ?? {}, plan.gates ?? {});

// The fallback route is exempt from the confidence gate, and that is not a loophole.
//
// A route nobody decided carries no score, and an absent score counts as below the threshold
// everywhere else in this system — correctly, because those scores are claims. This one is
// not a claim: it is the chain the framework shipped with, which runs EVERY stage. Parking
// the ticket would trade a routing hiccup for a dead issue in exchange for nothing, since the
// thing being "risked" is the most careful route there is.
const gate = plan.matched_rule === 'fallback:no-plan-produced'
  ? {
    gate: 'none',
    reason: 'the Router produced nothing, so this gets the chain that runs every stage — ' +
            'more cautious than any route it could have chosen, not less',
  }
  : routeGate(plan, cfg);

// --- record it ----------------------------------------------------------------
// On the ledger, because a route is per-issue state and every hand-off after this reads it.
await updateLedger(repo, issue, (l) => {
  if (!l) return null;
  return {
    ...l,
    planned_route: plan.route,
    on_complete: plan.on_complete,
    flow_plan: {
      kind: plan.kind,
      confidence: plan.confidence ?? null,
      matched_rule: plan.matched_rule ?? null,
      // Additive only, and kept so the gate steps can read it. See effectiveGates().
      gates: plan.gates ?? {},
      decided_at: new Date().toISOString(),
    },
    // Deliberately no cursor.
    //
    // A cursor is a position in a line, and this pipeline's hardest-won lesson is that once a
    // PR exists the stages are a CYCLE: a review rejection puts it back at implement, a QA
    // failure puts it back at planning, and a cursor would then be pointing at somewhere the
    // issue has already left. The route plus the stage that just finished is enough, cannot
    // desync from itself, and re-entering a stage is an ordinary event rather than a
    // correction. `nextStage()` reads it that way.
    history: [...(l.history ?? []), {
      at: new Date().toISOString(),
      agent: 'router',
      action: `route ${plan.route.join(' -> ')} (${plan.matched_rule ?? 'model'}, confidence ${plan.confidence ?? '?'})`,
    }].slice(-200),
  };
}).catch((e) => process.stdout.write(`::warning::could not record the route on the ledger: ${e.message}\n`));

const skipped = ['plan', 'debug', 'implement', 'review', 'qa'].filter((s) => !plan.route.includes(s));
const body = [
  `## Route — ${plan.kind}`,
  '',
  `\`${plan.route.join('` → `')}\`` + (plan.on_complete === 'merge' ? ' → merge' : ` → ${plan.on_complete}`),
  '',
  plan.reasoning,
  '',
  plan.matched_rule
    ? `_Matched by script (\`${plan.matched_rule}\`) — no model was spent on this decision._`
    : '_Decided by the router agent; no deterministic rule covered this shape._',
  '',
  `Confidence ${plan.confidence ?? '(none)'}${typeof plan.risk === 'number' ? ` · risk ${plan.risk}` : ''}.` +
    (skipped.length ? ` Skipping ${skipped.map((s) => `\`${s}\``).join(', ')}.` : ' Nothing skipped.'),
  gates.plan_approval || gates.merge_approval
    ? `\nGates still on: ${[gates.plan_approval && 'plan approval', gates.merge_approval && 'merge approval'].filter(Boolean).join(', ')}. ` +
      'A route decides how much deliberation this gets, never whether a person sees it.'
    : null,
  '',
  '<details><summary>Flow plan</summary>',
  '',
  '```json',
  JSON.stringify(plan, null, 2),
  '```',
  '',
  '</details>',
].filter((l) => l !== null).join('\n');

await gh(['issue', 'comment', String(issue), '--body', body]).catch((e) =>
  process.stdout.write(`::warning::could not post the route: ${String(e.message).split('\n')[0]}\n`));

setOutput('route', plan.route.join(','));
setOutput('kind', plan.kind);
setOutput('on_complete', plan.on_complete);

if (gate.gate === 'human') {
  // Nothing has run yet, so approving starts the route rather than continuing it.
  await markResume(repo, issue, plan.route[0], 'retry');
  await gh(['issue', 'comment', String(issue), '--body',
    `Routing this to a human: **${gate.reason}**.\n\n` +
    'An uncertain route is worth more said out loud than guessed at — the whole point of the ' +
    'score is that it can stop something. `/sdlc approve` starts the route above anyway; ' +
    '`/sdlc replan "<why>"` runs the Router again with your note as context.']).catch(() => {});
  await advance(issue, 'needs-human', { agent: 'router' });
  setOutput('gate', 'human');
  process.stdout.write(`issue #${issue}: ${gate.reason} — parked\n`);
  process.exit(0);
}

// --- start the first stage ----------------------------------------------------
const first = plan.route[0];
const d = dispatchFor(first, { issue }, graph);
if (!d) die(`the graph has no way to dispatch "${first}"`);

await advance(issue, d.state, { agent: 'router' });
await handOff(d.workflow, d.args, {
  issue, why: `it is the first stage of this issue's route (${plan.route.join(' -> ')})`,
});
setOutput('gate', 'none');
setOutput('first', first);
process.stdout.write(`issue #${issue}: ${plan.route.join(' -> ')} — started ${first}\n`);
