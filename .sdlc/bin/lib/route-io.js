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
import { gh, switchedOff } from './actions.js';
import { nextStage, resolveStage, loadGraph } from './flow-graph.js';

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
 * Start a stage — the ONE way anything starts one, from a hand-off or from a stop.
 *
 * @param {{repo: string, issue: string|number, target: object, agent?: string, why?: string,
 *          human?: boolean, extra?: {qa_run?: string, from?: string, head?: string}}} ctx
 *        `target` is a resolveStage() result.
 * @returns {Promise<{dispatched: boolean, stage: string, halted?: true}>}
 *
 * Three things every dispatch has to do, and each was being done by some callers and not
 * others:
 *
 *   - Respect a halt. `/sdlc stop` wrote nothing a script-driven dispatch read, so a gate
 *     outcome or a review verdict arriving after the stop started the next stage anyway. Only
 *     a person (`human`) dispatches a halted issue, and doing so is what lifts the halt.
 *   - Clear the resume point. `markResume` was the only writer of resume_at and nothing ever
 *     cleared it, so a stage that ran by any other route left "approve runs X" standing: the
 *     architecture brief merged, on-merge started the maintainer, and a later `/sdlc approve`
 *     read the stale resume_at and split the epic a second time.
 *   - Say why. The rework reason and root-cause's QA run lived only in the dispatch inputs,
 *     so a retry, a cooldown resume or an approve re-entered with none of it. They are written
 *     to `ledger.pending` in the same write, before anything is dispatched.
 *   - Supersede a pending cooldown. Only the cooldown's own resume and `/sdlc stop` cleared
 *     retry_after, so a review a person restarted with `/sdlc retry review` while it was parked
 *     ran, escalated to a person — and the watchdog's next sweep read the old retry_after and
 *     started review again over that escalation. Whatever starts a stage has answered the wait.
 */
export async function dispatchStage({ repo, issue, target, agent = 'system', why = '', human = false, extra = {} }) {
  const stage = target.stage;
  const pr = target.pr ?? null;
  const carries = stage === 'implement' || stage === 'root-cause';

  // The owner's kill switch, as the guard left it for the steps that still run after it. The
  // watchdog's sweep steps are `always()`, so they ran on behind a guard that had stopped the
  // job — and a cooled-down issue was moved to its stage and dispatched into a run that stops
  // at its own guard, leaving a label that says work is in flight and nothing running.
  if (switchedOff()) {
    process.stdout.write(`issue #${issue}: SDLC_ENABLED is "false" — not starting "${stage}"\n`);
    return { dispatched: false, stage, halted: true };
  }

  // The head the rework was asked at, so a later reader can tell a rework not yet pushed apart
  // from one that already landed.
  let head = extra.head ?? null;
  if (!head && stage === 'implement' && pr) {
    head = await gh(['pr', 'view', String(pr), '--json', 'headRefOid', '--jq', '.headRefOid']).catch(() => null) || null;
  }

  let halted = null;
  await updateLedger(repo, Number(issue), (l) => {
    halted = null;
    if (!l) return null;
    if (l.halted && !human) { halted = l.halted; return null; }
    // Which stage this is, for every stage. `planning` is the state of the project decision, the
    // planner, the maintainer and root-cause, and `pending` is written only for two of them — so
    // `sdlc resume` after a halt cancelled a project or maintainer run restarted the planner.
    const next = { ...l, resume_at: null, stopped_at: null, dispatched_stage: stage };
    delete next.retry_after;
    delete next.retry_stage;
    delete next.parked_at;
    if (human) delete next.halted;
    if (carries) {
      // A re-entry of the same stage — a retry, a resume after an outage — has no inputs of its
      // own, so what it is about carries over rather than being blanked for the next one.
      const prior = l.pending?.stage === stage ? l.pending : {};
      const version = l.work_order?.version ?? l.work_order_version ?? null;
      // The same goes for the implementer's rework. Triage's `resume` after the agent died
      // mid-rework dispatched with no reason, and writing rework: null here told
      // already-implemented nothing had been sent back — so it called the rejected, unchanged
      // branch done. A reasonless re-entry for the same PR and the same work order keeps the
      // reason AND the head it was asked at: the branch is the answer only once it has moved
      // past that head. A replan is a new target, and an old rework carried onto it would hand
      // the implementer a stale review or failure packet for a plan it no longer builds.
      const reentry = stage === 'implement' && target.rework == null && prior.stage === stage
        && String(prior.pr ?? '') === String(pr ?? l.pr ?? '') && (prior.work_order_version ?? null) === version;
      next.pending = {
        stage, rework: reentry ? prior.rework ?? null : target.rework ?? null,
        requested_at_head: reentry ? prior.requested_at_head ?? null : head,
        qa_run: extra.qa_run ?? prior.qa_run ?? null, from: extra.from ?? prior.from ?? null,
        pr: pr ?? l.pr ?? null, work_order_version: version, at: new Date().toISOString(),
      };
    }
    return next;
  }).catch((e) => {
    // Not fatal: the stage's own claim below goes through the same halt check, so a ledger
    // that cannot be written here cannot let a halted issue through — it only leaves a stale
    // resume point, which is the lesser harm next to a stage that never starts.
    process.stdout.write(`::warning::issue #${issue}: could not record the dispatch of "${stage}": ${e.message}\n`);
  });

  if (halted) {
    process.stdout.write(
      `issue #${issue}: halted by @${halted.by} — not starting "${stage}". ` +
      'A person resumes it with `/sdlc approve`, `retry` or `answer`.\n');
    return { dispatched: false, stage, halted: true };
  }

  try {
    await advance(issue, target.state, { agent: human ? 'human' : agent });
  } catch (e) {
    // The halt landed between the write above and this claim.
    if (/halted by @/.test(e.message)) return { dispatched: false, stage, halted: true };
    throw e;
  }

  const args = [...target.args];
  if (stage === 'root-cause') {
    for (const k of ['qa_run', 'from']) {
      if (extra[k] && !args.some((a) => a.startsWith(`${k}=`))) args.push('-f', `${k}=${extra[k]}`);
    }
  }
  const ok = await handOff(target.workflow, args, { issue, pr, why: why || `"${stage}" was requested` });
  return { dispatched: ok, stage };
}

/**
 * Start whatever follows `from` on this issue's route.
 *
 * @param {{repo: string, issue: string|number, pr?: string|number, from: string,
 *          agent?: string, why?: string}} ctx
 * @returns {Promise<{dispatched: boolean, stage: string|null, on_complete: string, halted?: true}>}
 *
 * A route that has run out is not a failure: it is the ticket finishing, and what finishing
 * MEANS is `on_complete`. The caller decides what to do with that, because "merge" and
 * "close after filing what you found" are different endings and only the caller knows which
 * artifacts exist to end with.
 *
 * Built on dispatchStage, so every ordinary hand-off also clears a stale resume point and
 * stops for a halt.
 */
export async function handOffNext({ repo, issue, pr = null, from, agent = 'system', why = '' }) {
  const graph = loadGraph();
  const { route, on_complete, ledger } = await routeOf(repo, issue);
  const next = nextStage(route, from, graph);

  if (!next) {
    // Either the route is finished or `from` is not on it. Neither is guessed past any more:
    // falling back to the default chain is how a re-route to the maintainer started the
    // implementer.
    process.stdout.write(
      `issue #${issue}: ${route ? route.join(' -> ') : 'the default chain'} has no stage after "${from}" ` +
      `— the ticket ends with "${on_complete}"\n`);
    return { dispatched: false, stage: null, on_complete };
  }

  const target = resolveStage(next, { issue, pr: pr ?? ledger?.pr ?? null, ledger }, graph);
  if (!target) {
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

  const r = await dispatchStage({
    repo, issue, target, agent, why: why || `"${next}" is the next stage on this issue's route`,
  });
  return { dispatched: r.dispatched, stage: next, on_complete, ...(r.halted ? { halted: true } : {}) };
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
