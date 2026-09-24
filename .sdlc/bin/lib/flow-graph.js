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
 * @param {string[]|null} route   planned_route from the ledger; empty or null means the default chain
 * @param {string} from           the stage that has just finished
 * @returns {string|null}         null when the route is finished, or when `from` is not on it —
 *                                the caller reads on_complete, or reports the disagreement
 */
export function nextStage(route, from, graph = loadGraph()) {
  const plan = Array.isArray(route) && route.length ? route : DEFAULT_ROUTE;

  // An implicit stage is not on the route, so "the one after it" is the one after whichever
  // routed stage put us here. The gate follows implement; root-cause precedes another one.
  if (from === 'gate') return nextStage(plan, 'implement', graph);
  if (from === 'root-cause') return plan.includes('implement') ? 'implement' : null;

  // `debug` and `plan` are the same slot filled by different agents — a bug is diagnosed rather
  // than designed, and everything after that is identical — so each stands in for the other,
  // on the default chain and on an explicit route alike.
  let i = plan.indexOf(from);
  if (i === -1 && (from === 'debug' || from === 'plan')) i = plan.indexOf(from === 'debug' ? 'plan' : 'debug');

  // A stage that ran but is not on an EXPLICIT route is the route and the pipeline disagreeing,
  // and that is an answer to report, not a gap to fill. This used to fall back to the default
  // chain: a planner granted a re-route to ["maintainer"] finished, "plan" was no longer on the
  // route, and the fallback started the implementer on an epic whose job was to be split.
  return i === -1 ? null : plan[i + 1] ?? null;
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
  // Own keys only: a name typed by a person reaches here, and `constructor` is on every object.
  const s = Object.hasOwn(graph.stages, String(stage)) ? graph.stages[stage] : null;
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

// What a person, a resume or a retry may call a stage, beyond the graph's own names. `ci` and
// `gate` are where a red PR stops, and a person retrying either, or a repair, means the
// implementer fixing it — with the reason carried, because an implementer told only "rework"
// re-reads the whole review. A re-run of a flake is not that: see rerunTarget below.
const ALIASES = {
  implementing: { stage: 'implement' },
  ci:           { stage: 'implement', rework: 'fix:ci-red' },
  gate:         { stage: 'implement', rework: 'fix:gate-failed' },
  triage:       { stage: 'intake' },
};

/**
 * Everything needed to start a stage by name: which workflow, with which inputs, claiming which
 * state. The ONE place a stage name becomes a dispatch.
 *
 * There were three hand-copied tables — dispatch-fix, apply-triage and resume-cooled-down —
 * plus `/sdlc retry` mapping ledger STATES to workflows, and they disagreed: `planning` is the
 * state of the project decision, the planner, the maintainer and root-cause, so "retry
 * planning" re-ran whichever one the table happened to list. The recovery hints printed stage
 * names retry could not parse. This accepts every graph stage, the aliases above, `planning`
 * (resolved to the planning-state stage that actually stopped), and `merge`, which is not a
 * stage but the QA workflow re-running only its merge step.
 *
 * @param {string} name
 * @param {{issue?: string|number, pr?: string|number|null, ledger?: object|null, rework?: string|null}} ctx
 * @returns {{stage: string, workflow: string, args: string[], state: string, counter: string|null,
 *            rework: string|null, pr: string|number|null} | null}  null for a name nothing can
 *            start, or a stage that needs a PR when there is none — never a throw
 */
export function resolveStage(name, { issue, pr, ledger = null, rework = null } = {}, graph = loadGraph()) {
  const present = (v) => v !== undefined && v !== null && v !== '';
  const prNumber = present(pr) ? pr : ledger?.pr ?? null;

  if (name === 'merge') {
    if (!present(prNumber)) return null;
    return { stage: 'merge', workflow: graph.stages.qa.workflow,
      args: ['-f', `pr=${prNumber}`, '-f', 'merge_only=true'],
      state: 'qa-pass', counter: null, rework: null, pr: prNumber };
  }

  let stage = name;
  let why = rework;
  if (name === 'planning') {
    const stopped = ledger?.stopped_at;
    stage = stopped && graph.stages[stopped]?.state === 'planning' ? stopped : 'plan';
  } else if (Object.hasOwn(ALIASES, name)) {
    stage = ALIASES[name].stage;
    why = rework ?? ALIASES[name].rework ?? null;
  }

  const d = dispatchFor(stage, { issue, pr: prNumber }, graph);
  if (!d) return null;
  const args = [...d.args];
  if (stage === 'implement' && why) args.push('-f', `rework=${why}`);
  if (stage === 'root-cause') {
    // What root-cause is putting on trial lives on the ledger, because a re-entry — a retry, a
    // resume after an outage — has no dispatch inputs to carry it.
    const p = ledger?.pending;
    if (present(prNumber)) args.push('-f', `pr=${prNumber}`);
    if (p?.stage === 'root-cause' && present(p.from)) args.push('-f', `from=${p.from}`);
    if (p?.stage === 'root-cause' && present(p.qa_run)) args.push('-f', `qa_run=${p.qa_run}`);
  }
  return { stage, workflow: d.workflow, args, state: d.state, counter: d.counter,
    rework: why ?? null, pr: prNumber };
}

/**
 * What running a failed stage AGAIN starts — a triage's `rerun` or `resume`, or a cooldown ending.
 *
 * Not resolveStage, for two stages. Its `ci` and `gate` aliases are the implementer with a
 * `fix:` rework, which is right for a person's `/sdlc retry ci` and for a `repair`, and wrong for
 * a flake: nothing re-ran the check or the gate, so a transient red cost an implement run with
 * nothing to fix, came back red on the same head with the same signature, and that second
 * occurrence sent a sound work order to root-cause. A re-run of either is the gate again on the
 * same PR — for `ci` re-running the checks that failed first — claiming `implementing` as the
 * implementer's hand-off to the gate does, and spending the `ci` counter, which sdlc-gate does
 * not spend for itself.
 *
 * @returns same shape as resolveStage, or null
 */
export function rerunTarget(stage, ctx = {}, graph = loadGraph()) {
  const pr = ctx.pr !== undefined && ctx.pr !== null && ctx.pr !== '' ? ctx.pr : ctx.ledger?.pr ?? null;
  if ((stage === 'ci' || stage === 'gate') && pr !== null && pr !== '') {
    return { stage: 'gate', workflow: graph.stages.gate.workflow,
      args: ['-f', `pr=${pr}`, ...(stage === 'ci' ? ['-f', 'rerun_failed=true'] : [])],
      state: 'implementing', counter: 'ci', rework: null, pr };
  }
  return resolveStage(stage, ctx, graph);
}

/** The only form any message may print to tell a person how to run a stage again. */
export function retryHint(stage) {
  return '`/sdlc retry ' + stage + '`';
}
