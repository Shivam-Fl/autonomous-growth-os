#!/usr/bin/env node
// Applies — or refuses — a detour an agent asked for in its own output.
//
// The instinct this replaces is "let any agent hand off to any other agent". That is right in
// spirit and disastrous if built literally: a flat network where every agent picks its own
// successor is how you get infinite loops, unbounded spend and a pipeline nobody can audit
// after the fact. So agents ask, in their structured output, and exactly one thing decides —
// this one, deterministically, against the same graph and budget as everything else.
//
// Refusals are as loud as grants. An agent that asked for a review and did not get one should
// find out on the issue, not by noticing the review never happened.

import { readFileSync, existsSync } from 'node:fs';
import { gh, setOutput, loadConfig, die, repo as repoOf } from './lib/actions.js';
import { grantRouteRequest, requestIn } from './lib/route-request.js';
import { loadGraph, resolveStage } from './lib/flow-graph.js';
import { readLedger, updateLedger } from './lib/state-io.js';
import { dispatchStage, markResume } from './lib/route-io.js';

const file = process.env.ARTIFACT ?? die('ARTIFACT is required (the file that may carry a route_request)');
const from = process.env.FROM_STAGE ?? die('FROM_STAGE is required');
const issue = Number(process.env.ISSUE ?? die('ISSUE is required'));
const pr = process.env.PR || '';
const repo = repoOf();

if (!existsSync(file)) { setOutput('granted', 'false'); process.exit(0); }

const artifact = JSON.parse(readFileSync(file, 'utf8'));
const request = requestIn(artifact);
if (!request) { setOutput('granted', 'false'); process.exit(0); }

const cfg = await loadConfig();
const graph = loadGraph();
const { ledger } = await readLedger(repo, issue).catch(() => ({ ledger: null }));
const route = ledger?.planned_route?.length ? ledger.planned_route : [];
const counter = graph.stages[from]?.counter;

const verdict = grantRouteRequest(request, {
  route,
  from,
  graph,
  attempts: counter ? (ledger?.attempts?.[counter] ?? 0) : 0,
  maxAttempts: Number(cfg.limits?.attempts ?? 10),
  granted_already: (ledger?.history ?? []).filter((h) => String(h.action).startsWith('re-routed')).length,
  // A split once the work is built orphans that work. intake and on-close clear ledger.pr, so it
  // names an open PR of this issue's own.
  hasPr: Boolean(pr || ledger?.pr),
});

const head = `## Route request from \`${from}\` — ${verdict.granted ? 'granted' : 'refused'}`;
const body = [
  head,
  '',
  `**${request.type}** \`${request.stage}\``,
  '',
  `> ${String(request.reason).replace(/\n/g, '\n> ')}`,
  '',
  verdict.reason,
  verdict.granted
    ? `\nRoute is now \`${verdict.route.join('` → `')}\`.` +
      (verdict.rewinds ? ` \`${verdict.rewinds}\` starts now, and the route carries on from it.` : '')
    : '\nThe route is unchanged. Asking is all an agent does here — one thing grants a detour, ' +
      'against the graph and the attempt budget, because a pipeline where every agent picks ' +
      'its own successor is one nobody can audit afterwards.',
].join('\n');

await gh([pr ? 'pr' : 'issue', 'comment', String(pr || issue), '--body', body]).catch((e) =>
  process.stdout.write(`::warning::could not post the route request: ${String(e.message).split('\n')[0]}\n`));

if (verdict.granted) {
  await updateLedger(repo, issue, (l) => {
    if (!l) return null;
    return {
      ...l,
      planned_route: verdict.route,
      // A resume point from the OLD route is a lie once the route changes.
      //
      // The planner on a project issue noticed it had been routed to plan -> implement when the
      // architecture was already decided, asked to be re-routed to the maintainer, and was
      // granted it. The route became ["maintainer"]. `resume_at` still said `implement`, from
      // the route that no longer existed — so `/sdlc approve` dispatched the implementer on an
      // issue whose job was to split epics, and the run died with nothing to implement.
      //
      // Kept only when the stage it names is still somewhere on the new route.
      resume_at: (l.resume_at && verdict.route.includes(l.resume_at)) ? l.resume_at : null,
      history: [...(l.history ?? []), {
        at: new Date().toISOString(),
        agent: from,
        action: `re-routed to ${verdict.route.join(' -> ')} (${request.type} ${request.stage})`,
      }].slice(-200),
    };
  }).catch((e) => process.stdout.write(`::warning::could not record the new route: ${e.message}\n`));
  setOutput('granted', 'true');
  setOutput('route', verdict.route.join(','));
  process.stdout.write(`issue #${issue}: re-routed to ${verdict.route.join(' -> ')}\n`);

  // Started here only when the caller's own hand-off cannot reach it: a route that was REPLACED
  // (a planner's split: ["maintainer"] was granted and nothing dispatched, and the oversized work
  // order went to the implementer), or a stage that went in BEFORE the asker (QA's review, with
  // the PR). It started route[0] whenever the new route did not name the asker — every grant from
  // root-cause, which no route names, and from a debugger on a route that says `plan` — and the
  // ticket restarted at its first stage.
  const start = verdict.replaced ? verdict.route[0] : verdict.rewinds;
  if (start) {
    const target = resolveStage(start, { issue, pr: pr || null, ledger }, graph);
    const r = target
      ? await dispatchStage({ repo, issue, target, agent: from, why: `the route changed: ${verdict.reason}` })
      : { dispatched: false };
    if (!r.dispatched) process.stdout.write(`::error::issue #${issue}: re-routed, and "${start}" could not be started\n`);
    setOutput('redirected', 'true');
  }
  process.exit(0);
}

setOutput('granted', 'false');

// A refusal an agent could not have anticipated — the budget is gone, or the scope claim is a
// product question — is not the pipeline carrying on regardless. It is a person's turn.
if (verdict.escalate) {
  // Resumed by running the stage that asked. The dispatch into it cleared the resume point, so
  // `/sdlc approve` after this found nothing recorded and pointed at a replan.
  await markResume(repo, issue, from, 'retry');
  const { advance } = await import('./lib/advance.js');
  await advance(issue, 'needs-human', { agent: 'router' });
  setOutput('escalated', 'true');
  process.stdout.write(`issue #${issue}: route request escalated — ${verdict.reason}\n`);
  process.exit(0);
}

process.stdout.write(`issue #${issue}: route request refused — ${verdict.reason}\n`);
