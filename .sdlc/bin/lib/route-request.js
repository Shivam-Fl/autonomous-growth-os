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

import { validateRoute, loadGraph } from './flow-graph.js';

/**
 * @param {{type: string, stage: string, reason: string}} request
 * @param {{route: string[], from: string, attempts?: number, maxAttempts?: number,
 *          granted_already?: number, graph?: object}} ctx
 * @returns {{granted: boolean, route?: string[], reason: string, escalate?: boolean}}
 */
export function grantRouteRequest(request, ctx = {}) {
  const graph = ctx.graph ?? loadGraph();
  const route = Array.isArray(ctx.route) ? [...ctx.route] : [];
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
    if (stage === 'maintainer') {
      return {
        granted: true,
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
  if (route.includes(stage) && route.indexOf(stage) > route.indexOf(from)) {
    return { granted: false, reason: `"${stage}" is already coming up later on this route` };
  }

  // Insert it as EARLY as the graph allows, at or after the asking stage.
  //
  // Not "immediately next", which was the obvious version and is wrong: a planner on a route
  // that dropped the review asks for one, and `["plan","review","implement","qa"]` puts a
  // reviewer in front of a pull request that does not exist yet. The stage has a position the
  // graph already implies; the request says it belongs on the route, not where.
  const at = route.indexOf(from);
  const start = at === -1 ? 0 : at + 1;
  let next = null;
  let lastError = null;

  for (let i = start; i <= route.length; i++) {
    const candidate = [...route.slice(0, i), stage, ...route.slice(i)];
    const legal = validateRoute(candidate, graph);
    if (legal.ok) { next = candidate; break; }
    lastError ??= legal.errors[0];
  }

  if (!next) {
    return {
      granted: false,
      reason: `"${stage}" cannot go anywhere after "${from}" on this route: ${lastError}`,
    };
  }

  return {
    granted: true,
    route: next,
    reason: `"${stage}" added to the route — the agent that asked had read the code, and the route ` +
            'was decided before anyone had',
  };
}

/** Pull a route request off whatever artifact carries one. */
export function requestIn(artifact) {
  const r = artifact?.route_request;
  if (!r || typeof r !== 'object') return null;
  return r;
}
