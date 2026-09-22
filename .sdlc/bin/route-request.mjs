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
import { loadGraph } from './lib/flow-graph.js';
import { readLedger, updateLedger } from './lib/state-io.js';

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
    ? `\nRoute is now \`${verdict.route.join('` → `')}\`.`
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
  process.exit(0);
}

setOutput('granted', 'false');

// A refusal an agent could not have anticipated — the budget is gone, or the scope claim is a
// product question — is not the pipeline carrying on regardless. It is a person's turn.
if (verdict.escalate) {
  const { advance } = await import('./lib/advance.js');
  await advance(issue, 'needs-human', { agent: 'router' });
  setOutput('escalated', 'true');
  process.stdout.write(`issue #${issue}: route request escalated — ${verdict.reason}\n`);
  process.exit(0);
}

process.stdout.write(`issue #${issue}: route request refused — ${verdict.reason}\n`);
