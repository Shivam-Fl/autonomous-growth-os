// An agent asking for a detour, and the Router deciding whether it gets one.
//
// The Router runs once, on a cheap tier, before anybody has read the code. The agents after
// it have far more context — a planner discovers the ticket is really six tickets, QA on a
// route that skipped review finds a change nobody should have merged unread. Until now their
// only recourse was to carry on or to stop and ask a person.
//
// The obvious design is to let each of them dispatch the next stage itself. That is how you
// get infinite loops, unbounded spend and a pipeline nobody can audit afterwards — which is
// unacceptable in something that merges PRs unattended. So the shape is: any agent may ASK,
// in its own structured output, and exactly one thing grants it, deterministically, against
// the same graph and the same budget everything else obeys.
//
// Pure. A granted detour changes what runs next on a live ticket, so it is testable without
// a network.

import { validateRoute, loadGraph, DEFAULT_ROUTE } from './flow-graph.js';
import { transition } from './ledger.js';

/**
 * Where the asking stage stands on the route: the index of the stage it is, or stands in for.
 *
 * It was `route.indexOf(from)`, which is -1 for the askers never on a route by their own name:
 * root-cause, and a debugger on a route that says `plan` (or a planner on one that says
 * `debug`). From -1 every insertion was tried from the top, and route-request read a route
 * without the asker on it as a new one and restarted the ticket at its first stage — a fresh
 * planner overwrote the revision root-cause had just recorded, without the QA evidence.
 *
 * root-cause hands straight to `implement` (nextStage), so it stands where implement does: a
 * stage placed after it runs after the implementer. `debug` and `plan` fill the same slot.
 */
export function slotOf(route, from) {
  if (from === 'root-cause') return route.indexOf('implement');
  const i = route.indexOf(from);
  if (i !== -1 || (from !== 'debug' && from !== 'plan')) return i;
  return route.indexOf(from === 'debug' ? 'plan' : 'debug');
}

/**
 * @param {{type: string, stage: string, reason: string}} request
 * @param {{route: string[], from: string, attempts?: number, maxAttempts?: number,
 *          granted_already?: number, hasPr?: boolean, graph?: object}} ctx
 * @returns {{granted: boolean, route?: string[], reason: string, escalate?: boolean,
 *            replaced?: true, rewinds?: string}}  `replaced`: the route was swapped for a new
 *          one; `rewinds`: the stage went in before the asker and has to be started now
 */
export function grantRouteRequest(request, ctx = {}) {
  const graph = ctx.graph ?? loadGraph();
  // No route of its own is the default chain, and that is what a request is placed on. Against
  // an empty list every insertion was the stage alone — ["review"], with no PR before it — so
  // every request on the default chain was refused for a reason that was not the reason.
  const route = Array.isArray(ctx.route) && ctx.route.length ? [...ctx.route] : [...DEFAULT_ROUTE];
  const from = ctx.from;

  if (!request || typeof request !== 'object') {
    return { granted: false, reason: 'no request' };
  }
  const { type, stage, reason } = request;
  if (!reason || String(reason).trim().length < 10) {
    // A detour with no stated reason is a stage appearing in the route with nothing on the
    // timeline explaining it, which is the opposite of what this mechanism is for.
    return { granted: false, reason: 'the request gives no reason, and an unexplained detour is worse than none' };
  }

  // The budget is the outer bound here as everywhere. A ticket that has spent its attempts
  // does not get more of them by asking for a different shape of work.
  const attempts = ctx.attempts ?? 0;
  const maxAttempts = ctx.maxAttempts ?? 10;
  if (attempts >= maxAttempts) {
    return {
      granted: false, escalate: true,
      reason: `the request is reasonable but this issue has spent ${attempts} of ${maxAttempts} attempts`,
    };
  }

  // Two detours on one ticket is the Router having been wrong twice, and a third is a loop
  // rather than a correction.
  if ((ctx.granted_already ?? 0) >= 2) {
    return {
      granted: false, escalate: true,
      reason: 'this issue has already been re-routed twice — a third detour is a loop, not a correction',
    };
  }

  // `scope_changed` is not a request for a stage. It is an agent saying the ticket is not what
  // the Router was shown, and the honest answers are both outside its own route: either this
  // is an epic and the maintainer splits it, or a person decides.
  if (type === 'scope_changed') {
    // Not once a pull request exists, and never from QA. Granted from QA, the route became
    // ["maintainer"], its dispatch was an illegal qa -> planning move that only warned — the
    // ledger stayed at qa while the labels said planning — and the PR built for the whole
    // ticket was never merged or closed. What happens to that PR is a person's call; and QA's
    // state has no way back to planning even on an audit, which has no PR.
    if (stage === 'maintainer' && (ctx.hasPr || from === 'qa')) {
      return {
        granted: false, escalate: true,
        reason: 'the ticket may be several tickets, and it is past planning — splitting it now means ' +
                'deciding what happens to the work already built for it, which is a person\'s call',
      };
    }
    if (stage === 'maintainer') {
      return {
        granted: true,
        replaced: true,
        route: ['maintainer'],
        reason: 'the ticket turned out to be larger than one work order, so the rest of the route is ' +
                'replaced by a split — each piece is then routed on its own',
      };
    }
    return {
      granted: false, escalate: true,
      reason: 'an agent reports the scope is not what this issue was routed as. Nothing automatic ' +
              'follows from that: what a ticket is for is a product decision',
    };
  }

  if (type !== 'insert_stage' && type !== 'needs_earlier_stage') {
    return { granted: false, reason: `"${type}" is not a kind of request this can grant` };
  }
  if (!graph.stages[stage]) {
    return { granted: false, reason: `"${stage}" is not a stage` };
  }
  if (!graph.routable.includes(stage)) {
    return {
      granted: false,
      reason: `"${stage}" is not something a route places — it runs when the pipeline says it runs`,
    };
  }
  const at = slotOf(route, from);
  // Earlier on the route too: a second copy of a stage that has run is a loop, not a detour — and
  // with placement before the asker below, it would otherwise be granted.
  if (route.includes(stage)) {
    return { granted: false, reason: route.indexOf(stage) > at
      ? `"${stage}" is already coming up later on this route`
      : `"${stage}" is already on this route and has run — a second copy is a loop, not a detour` };
  }

  // Insert it as EARLY as the graph allows, at or after the asking stage.
  //
  // Not "immediately next", which was the obvious version and is wrong: a planner on a route
  // that dropped the review asks for one, and `["plan","review","implement","qa"]` puts a
  // reviewer in front of a pull request that does not exist yet. The stage has a position the
  // graph already implies; the request says it belongs on the route, not where.
  let next = null;
  let lastError = null;
  const legalAt = (i) => {
    const candidate = [...route.slice(0, i), stage, ...route.slice(i)];
    const legal = validateRoute(candidate, graph);
    if (!legal.ok) lastError ??= legal.errors[0];
    return legal.ok ? candidate : null;
  };

  for (let i = at + 1; !next && i <= route.length; i++) next = legalAt(i);

  // Nothing may follow QA, so QA — the one agent that has watched the change run — asking for
  // the review its route dropped could never be granted: the request was refused, nothing
  // escalated, and the PR merged in the same run. When nothing after the asker is legal, the
  // stage goes in as LATE as the graph allows before it, and runs now; the route carries on from
  // it, which brings the asker round again. Only a stage the ledger can move to from where the
  // asker stands: QA's state has no way back to planning, so a plan or project put before QA
  // would be a dispatch whose claim the ledger refuses while its label moves.
  const here = graph.stages[from]?.state;
  const startable = !here || transition({ state: here, history: [] }, graph.stages[stage].state).ok;
  let rewinds = null;
  for (let i = at; !next && startable && i >= 0; i--) {
    next = legalAt(i);
    if (next) rewinds = stage;
  }

  if (!next) {
    return {
      granted: false,
      reason: `"${stage}" cannot go anywhere on this route around "${from}": ${lastError}`,
    };
  }

  return {
    granted: true,
    route: next,
    ...(rewinds ? { rewinds } : {}),
    reason: `"${stage}" added to the route${rewinds ? ` before "${from}", starting now` : ''} — the agent ` +
            'that asked had read the code, and the route was decided before anyone had',
  };
}

/** Pull a route request off whatever artifact carries one. */
export function requestIn(artifact) {
  const r = artifact?.route_request;
  if (!r || typeof r !== 'object') return null;
  return r;
}
