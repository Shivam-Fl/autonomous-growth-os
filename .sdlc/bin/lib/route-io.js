// The hand-off, as one call, reading the route off the ledger.
//
// Every stage used to end by naming its successor as a filename. Six literals, each correct
// on its own, and together they made the route a property of the code rather than of the
// ticket — so an audit that needs no implementer still got one, and a one-line typo still
// bought a plan council.
//
// The literal is gone. A stage says which stage IT is; this works out what comes after,
// and what "after" means when there is nothing after.

import { readLedger, updateLedger } from './state-io.js';
import { handOff } from './handoff.js';
import { advance } from './advance.js';
import { gh } from './actions.js';
import { nextStage, dispatchFor, loadGraph } from './flow-graph.js';

/** @returns {{route: string[]|null, on_complete: string}} */
export async function routeOf(repo, issue) {
  const { ledger } = await readLedger(repo, Number(issue)).catch(() => ({ ledger: null }));
  return {
    route: ledger?.planned_route?.length ? ledger.planned_route : null,
    on_complete: ledger?.on_complete ?? 'merge',
    ledger,
  };
}

/**
 * Start whatever follows `from` on this issue's route.
 *
 * @param {{repo: string, issue: string|number, pr?: string|number, from: string,
 *          agent?: string, why?: string}} ctx
 * @returns {Promise<{dispatched: boolean, stage: string|null, on_complete: string}>}
 *
 * A route that has run out is not a failure: it is the ticket finishing, and what finishing
 * MEANS is `on_complete`. The caller decides what to do with that, because "merge" and
 * "close after filing what you found" are different endings and only the caller knows which
 * artifacts exist to end with.
 */
export async function handOffNext({ repo, issue, pr = null, from, agent = 'system', why = '' }) {
  const graph = loadGraph();
  const { route, on_complete } = await routeOf(repo, issue);
  const next = nextStage(route, from, graph);

  if (!next) {
    process.stdout.write(
      `issue #${issue}: "${from}" is the last stage of ${route ? route.join(' -> ') : 'the default chain'} ` +
      `— the ticket ends with "${on_complete}"\n`);
    return { dispatched: false, stage: null, on_complete };
  }

  const d = dispatchFor(next, { issue, pr }, graph);
  if (!d) {
    // A stage the graph cannot dispatch is a stage with no PR when it needs one, or a typo in
    // the route. Either way this is a hand-off into nothing, and this pipeline's whole history
    // is of those being silent. Say it where a person is looking.
    await gh(['issue', 'comment', String(issue), '--body',
      `## The route names a stage that cannot start\n\n` +
      `\`${from}\` should hand off to \`${next}\`, and there is nothing to dispatch it with` +
      (graph.stages[next]?.input === 'pr' ? ' — that stage runs on a pull request, and this issue has none.' : '.') +
      '\n\nNothing else is running on this issue.']).catch(() => {});
    process.stdout.write(`::error::cannot dispatch "${next}" for issue #${issue}\n`);
    return { dispatched: false, stage: next, on_complete };
  }

  await advance(issue, d.state, { agent });
  const ok = await handOff(d.workflow, d.args, {
    issue, pr, why: why || `"${next}" is the next stage on this issue's route`,
  });
  return { dispatched: ok, stage: next, on_complete };
}

/**
 * Record the stage to run when a human says go.
 *
 * `/sdlc approve` used to mean one thing — "start the implementer" — because there was one
 * gate and one chain. With a route there are several, and they do not all resume the same
 * way, which is the distinction that made "remember the stage that stopped it" wrong:
 *
 *   - a GATE passed means run what comes AFTER the stage that gated
 *   - a FAILURE escalated means run that stage AGAIN
 *
 * Storing the stopping stage and working the rest out later put that decision at the call
 * site of `/sdlc approve`, which does not know which of the two happened. So the stage that
 * stops the issue resolves it — it is the only thing that knows — and approving is a
 * dispatch, not a deduction.
 *
 * @param {'after'|'retry'} how  passed a gate, or stopped on a failure
 */
export async function markResume(repo, issue, stage, how = 'after') {
  const resume = how === 'retry' ? stage : nextStage((await routeOf(repo, issue)).route, stage);
  await updateLedger(repo, Number(issue), (l) => (l ? { ...l, resume_at: resume ?? null, stopped_at: stage } : null))
    .catch((e) => process.stdout.write(`::warning::could not record where to resume: ${e.message}\n`));
  process.stdout.write(
    `issue #${issue}: stopped at "${stage}" — ` +
    `${resume ? `\`/sdlc approve\` runs "${resume}"` : 'the route has nothing after it'}\n`);
  return resume;
}
