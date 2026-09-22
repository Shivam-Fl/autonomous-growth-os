// The pipeline's stage graph, and the one question every hand-off asks: what runs next?
//
// Until now that answer was a workflow filename written into whichever script happened to be
// finishing — `dispatch('sdlc-qa.yml')` in route-review, `handOff('sdlc-implement.yml')` in
// post-work-order. Six literals, each correct, together making the route a property of the
// code rather than of the ticket. Every issue therefore got the whole chain, including the
// audit-only ones that need no implementer and the one-line typos that need no council.
//
// The route is now data on the ledger and the edges are data in .sdlc/flow-graph.json, so a
// stage asks this instead of naming its successor. A ledger with no route gets exactly the
// old behaviour: this file is a router, not a rewrite of what already works.

import { readFileSync } from 'node:fs';

let cached = null;

export function loadGraph(root = process.env.SDLC_ROOT ?? process.cwd()) {
  if (cached) return cached;
  cached = JSON.parse(readFileSync(`${root}/.sdlc/flow-graph.json`, 'utf8'));
  return cached;
}

/** Testing seam, and the reason loadGraph caches at all. */
export function _setGraph(g) { cached = g; }

/**
 * What the pipeline did before there was a route, expressed as one.
 *
 * Not a fallback nobody chose: this is the linear chain the framework shipped with, and an
 * issue opened before the Router existed — or on a repo where routing is off — must keep
 * running exactly as it did.
 */
export const DEFAULT_ROUTE = ['plan', 'implement', 'review', 'qa'];

/**
 * Is this a route the graph allows?
 *
 * Two things are checked and they fail differently. An unknown stage name is a typo or an
 * invented step, and routing on it dispatches into nothing — the failure mode this repo keeps
 * finding by noticing nothing happened. An edge the graph does not have is a route that
 * cannot physically run: `["qa", "implement"]` asks QA to test a PR that does not exist yet.
 *
 * @returns {{ok: true} | {ok: false, errors: string[]}}
 */
export function validateRoute(route, graph = loadGraph()) {
  const errors = [];
  if (!Array.isArray(route)) return { ok: false, errors: ['route is not an array'] };

  for (const stage of route) {
    if (!graph.stages[stage]) errors.push(`"${stage}" is not a stage`);
    else if (!graph.routable.includes(stage)) {
      errors.push(`"${stage}" runs on its own schedule and cannot be placed in a route`);
    }
  }
  if (errors.length) return { ok: false, errors };

  for (let i = 0; i < route.length - 1; i++) {
    const from = route[i];
    const to = route[i + 1];
    if (reachable(from, to, graph)) continue;
    errors.push(`nothing gets from "${from}" to "${to}" — ${graph.stages[from].next.length
      ? `"${from}" leads to ${graph.stages[from].next.join(', ')}`
      : `"${from}" leads nowhere; it is the end of a route`}`);
  }

  // A stage marked `always` may be absent from the route only because it is implicit —
  // the gate is not something a route names, it is something that happens after implement.
  // What must never happen is a route that reaches a PR without one.
  if (route.includes('implement') && !route.includes('gate') && !graph.implicit.includes('gate')) {
    errors.push('a route that writes code must pass the gate');
  }

  // And a route that writes code must test it.
  //
  // Not a style rule: the merge happens at the END of the QA stage, because merging is the
  // one irreversible step and merge-pr.mjs re-establishes every claim there rather than
  // trusting a label. A route that opened a PR and skipped QA would therefore produce a
  // branch nothing ever merges and nothing ever says why — the silent stop this pipeline
  // keeps finding by noticing nothing happened.
  // The implementer only ever receives a VALIDATED WORK ORDER. ARCHITECTURE calls that
  // contract load-bearing and it does not get an exception for small tickets: a route that
  // reaches `implement` without a stage that writes one dispatches an agent whose first act
  // is to look for a file nobody wrote.
  //
  // This is also why the trivial-change route keeps its planner. A script CAN mechanically
  // assemble a work order for "fix the typo in `src/Button.tsx`" — one named file that exists,
  // the issue body as the change — and the moment the file is named a little less exactly it
  // is a script doing judgement, which is the mirror of asking a model to do arithmetic. The
  // saving worth having was the three-agent council and the review, and dropping those keeps
  // the contract intact.
  if (route.includes('implement') && !route.includes('plan') && !route.includes('debug')) {
    errors.push('nothing in this route writes a work order, and the implementer takes nothing else — ' +
                'add "plan" (or "debug" for a bug) before "implement"');
  }

  // The converse too: a stage that reads a pull request needs one to exist.
  for (const needsPr of ['review']) {
    if (route.includes(needsPr) && !route.includes('implement')) {
      errors.push(`"${needsPr}" reads a pull request, and nothing in this route opens one`);
    }
  }

  if (route.includes('implement') && !route.includes('qa')) {
    errors.push('a route that writes code must end in qa — that is where the change is tested ' +
                'and where the merge is decided, so a route without it opens a PR nothing finishes');
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * Can `to` follow `from`, allowing for the stages a route never names?
 *
 * `gate` sits between implement and whatever the route asked for next, and `root-cause` sits
 * between a failure and the next implement. Neither is written into a route — they are how
 * the pipeline works, not choices about a ticket — so the walk steps through them.
 */
function reachable(from, to, graph, seen = new Set()) {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  for (const step of graph.stages[from]?.next ?? []) {
    if (step === to) return true;
    if (graph.implicit.includes(step) && reachable(step, to, graph, seen)) return true;
  }
  return false;
}

/**
 * The stage after `from` on this issue's route.
 *
 * @param {string[]|null} route   planned_route from the ledger; null means the default chain
 * @param {string} from           the stage that has just finished
 * @returns {string|null}         null when the route is finished — the caller reads on_complete
 */
export function nextStage(route, from, graph = loadGraph()) {
  const plan = Array.isArray(route) && route.length ? route : DEFAULT_ROUTE;

  // An implicit stage is not on the route, so "the one after it" is the one after whichever
  // routed stage put us here. The gate follows implement; root-cause precedes another one.
  if (from === 'gate') return nextStage(plan, 'implement', graph);
  if (from === 'root-cause') return plan.includes('implement') ? 'implement' : null;

  const i = plan.indexOf(from);
  // A stage that ran but is not on the route is the Router and the pipeline disagreeing.
  // Falling back to the default chain keeps the issue moving rather than stranding it, and
  // the caller says so out loud.
  //
  // `debug` maps to `plan`'s position because they are the same slot filled by different
  // agents — a bug is diagnosed rather than designed, and everything after that is identical.
  // Without this a bug on an unrouted issue reaches the end of a chain it was never on.
  if (i === -1) {
    const alias = from === 'debug' ? 'plan' : from;
    const j = DEFAULT_ROUTE.indexOf(alias);
    return j === -1 || j + 1 >= DEFAULT_ROUTE.length ? null : DEFAULT_ROUTE[j + 1];
  }
  return plan[i + 1] ?? null;
}

/**
 * How to dispatch a stage: which workflow, and whether it is keyed by issue, PR or epic.
 *
 * `input_alt` exists for exactly one stage. QA normally runs on a pull request, and routed
 * alone it is an audit — no PR, no diff, driven by issue number against what is already
 * deployed. Rather than two entries for one workflow, the stage says what it prefers and what
 * it will accept, and the absence of a PR selects the second rather than producing a
 * hand-off into nothing.
 */
export function dispatchFor(stage, { issue, pr } = {}, graph = loadGraph()) {
  const s = graph.stages[stage];
  if (!s) return null;
  const present = (v) => v !== undefined && v !== null && v !== '';
  const value = (k) => (k === 'pr' ? pr : k === 'epic' ? issue : issue);

  for (const key of [s.input ?? 'issue', s.input_alt].filter(Boolean)) {
    if (present(value(key))) {
      return {
        workflow: s.workflow,
        args: ['-f', `${key}=${value(key)}`],
        state: s.state,
        counter: s.counter ?? null,
      };
    }
  }
  return null;
}
