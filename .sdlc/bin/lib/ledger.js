// Per-issue state. Pure functions over a plain object — IO lives in lib/state-io.js
// so the state machine can be tested without a network or a git branch.
//
// This is the file that decides whether a runaway agent stops. Attempt counters increment on
// DISPATCH, never on success: an agent that crash-loops still burns its budget and halts.

export const STATES = [
  'triage', 'planning', 'implementing', 'ci-red', 'ci-green', 'review',
  'qa', 'qa-fail', 'qa-pass', 'merged', 'done',
  'blocked', 'needs-human', 'budget-exceeded',
];

// Terminal states nothing leaves automatically — only a human reopens them.
export const TERMINAL = new Set(['done', 'needs-human', 'budget-exceeded']);

// Once a PR exists, the stages are a CYCLE, not a line.
//
// This was a hand-written line — triage to planning to implementing to CI to review to QA to
// merged — and every real loop-back had to be discovered in production and added by hand:
// qa-pass to qa when a rule changed, qa-fail to planning when root-cause was wired, qa-fail to
// review when a rework was re-reviewed. Each addition looked like the last one needed. None
// was. A PR that is still open can take a new commit at any moment, and that puts it back at
// any earlier stage, in any order.
//
// So the working stages are generated as strongly connected, and the guards that actually
// carry weight are the exceptions written underneath:
//
//   - A QA VERDICT may only follow a QA run. qa-pass and qa-fail are not reachable from
//     anywhere else, because "QA passed" recorded from nowhere is the one claim this file
//     exists to make impossible.
//   - MERGED may only follow qa-pass (or a human). Everything else is bookkeeping; this is
//     the state that means code reached the default branch.
//   - Before a PR exists there is no cycle to re-enter: triage and planning stay linear.
const CYCLE = ['implementing', 'ci-red', 'ci-green', 'review', 'qa'];
const ESCAPES = ['needs-human', 'blocked', 'budget-exceeded'];

const cycleFrom = (state, extra = []) => [
  ...CYCLE.filter((s) => s !== state), ...extra, ...ESCAPES,
];

// `budget-exceeded` is reachable from every state a counter can be spent in, which is all of
// them before a PR exists too. project, plan, debug and root-cause all spend the plan counter
// at `planning`, and with no edge here the cap could not be recorded: the ledger stayed at
// planning under an in-flight label that held a slot, and every watchdog sweep re-posted
// "Budget exceeded" and then crashed on the refused move, dropping every report after it.
const LEGAL = {
  // `qa` as well as `planning`: an AUDIT route is `["qa"]` alone — nothing is planned because
  // nothing is being built — and without this edge that route could not start at all.
  //
  // `implementing` is deliberately NOT here. The implementer takes a validated work order and
  // nothing else, so an issue reaching it straight from triage would dispatch an agent whose
  // first act is to look for a file nobody wrote.
  'triage':          ['planning', 'qa', 'needs-human', 'blocked', 'budget-exceeded'],
  // `qa` here too, for the same audit route: intake moves EVERY issue to planning before the
  // route's first stage is dispatched, so the triage -> qa edge above is one the audit never
  // takes. Without this QA's claim was label-only and its verdict threw `planning -> qa-pass`.
  // The verdict guard is untouched — qa-pass still only follows qa.
  'planning':        ['implementing', 'qa', 'needs-human', 'blocked', 'budget-exceeded'],

  ...Object.fromEntries(CYCLE.map((s) => [s, cycleFrom(s)])),
  // Only a QA run may produce a QA verdict.
  'qa':              cycleFrom('qa', ['qa-pass', 'qa-fail']),

  // A verdict is not an end state: the PR is still open, and a new commit puts it back in the
  // cycle. `planning` too — a QA failure goes to root-cause, which writes a NEW work order.
  'qa-fail':         cycleFrom('qa-fail', ['planning', 'qa']),
  // `done` as well as `merged`: an AUDIT route has no PR, so there is nothing to merge and
  // qa-pass is genuinely the end of the ticket. That does not weaken the guard underneath —
  // `merged` still requires qa-pass, and a QA verdict still requires a QA run.
  'qa-pass':         cycleFrom('qa-pass', ['merged', 'qa', 'done']),

  // `triage` from both: a person REOPENED a shipped issue, and intake starts it over. With no
  // way out of `done` a reopened issue's next stage claim warned, its verdict threw, and the
  // issue could never record an outcome again.
  'merged':          ['done', 'needs-human', 'triage'],
  'done':            ['triage', 'needs-human'],
  'blocked':         ['triage', 'planning', 'needs-human', 'budget-exceeded'],
  // A human may route it anywhere EXCEPT to a verdict. `/sdlc stop` parks an issue here while a
  // QA run may still be in flight, and when this allowed `qa-pass` that run recorded its pass
  // straight over the stop and merge-pr merged it. A verdict follows a QA run and nothing else;
  // a PR merged by hand is recorded by `reconcile`, which does not need this edge.
  'needs-human':     STATES.filter((s) => !['needs-human', 'qa-pass', 'qa-fail'].includes(s)),
  'budget-exceeded': ['needs-human'],
};

export const STAGES = ['plan', 'ci', 'review', 'qa'];

export function newLedger(issue, now = new Date()) {
  return {
    issue,
    pr: null,
    state: 'triage',
    owner: null,
    lock_expires: null,
  // The run holding the lock, so a later caller can ask whether that run is still alive
  // rather than only how old the lock is. A cancelled job never reaches its unlock step.
  lock_run: null,
    attempts: Object.fromEntries(STAGES.map((s) => [s, 0])),
    // `/sdlc stop`, as {by, at, why}. While set, nothing but a human moves this issue anywhere
    // except needs-human or blocked — see transition().
    halted: null,
    // Why the next implement or root-cause run was dispatched ({stage, rework, qa_run, from, pr,
    // requested_at_head, at}), written by dispatchStage. It lived only in the dispatch inputs,
    // so every re-entry — a retry, a cooldown resume, an approve — started without it.
    pending: null,
    // The plan being built, in full (lib/work-order.js). The ledger is its source of truth,
    // not whichever comment on the issue looks most like one.
    work_order: null,
    touch_paths: [],
    acceptance: [],
    // Which stages this issue actually needs, decided once by the Router. Empty means nobody
    // has decided, and every hand-off falls back to the chain the framework shipped with —
    // an issue opened before the Router existed must keep running exactly as it did.
    //
    // There is deliberately no cursor alongside it. A cursor is a position in a line, and once
    // a PR exists these stages are a cycle: a review rejection goes back to implement, a QA
    // failure back to planning. The route plus the stage that just finished cannot desync
    // from itself; a cursor and the real position can, and would.
    planned_route: [],
    on_complete: null,
    artifacts: {},
    // Every mechanical failure this issue has had, newest last. The self-heal loop reads it
    // to tell "a new mistake" from "the same mistake again" — the second of those means the
    // work order's approach is wrong, and answering both with another blind retry is how a
    // budget is spent learning nothing.
    failure_history: [],
  // What each review rejection was ABOUT, newest last. The same criterion rejected twice
  // running means the shape of the fix is wrong, not the typing — the same reasoning
  // failure_history drives for mechanical failures.
  review_history: [],
  // Criteria root-cause has already been given a turn on. A second failure after that is a
  // disagreement about what done means, which is a person's to settle.
  review_root_caused: [],
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    history: [],
  };
}

const stamp = (l, now, agent, action) => ({
  ...l,
  updated_at: now.toISOString(),
  history: [...l.history, { at: now.toISOString(), agent, action }].slice(-200),
});

/** Legal-transition check. An illegal transition is a bug in a workflow, not a valid state. */
export function transition(ledger, to, { agent = 'system', now = new Date() } = {}) {
  if (!STATES.includes(to)) return { ok: false, reason: `unknown state "${to}"` };

  // A halted issue refuses every move but a human's, and the two that park it.
  //
  // `/sdlc stop` used to move the issue to needs-human and nothing else, so the stage already
  // running simply carried on: its next claim was legal from needs-human, a QA run recorded
  // qa-pass over the stop, and the PR merged. Every stage hand-off, claim and verdict writes
  // through this function, so refusing here stops all of them at their next ledger write —
  // including a same-state claim, which is the running stage re-asserting itself. The reason
  // always starts "halted by @", which advance() treats as fatal for any state.
  const h = ledger.halted;
  if (h && agent !== 'human' && to !== 'needs-human' && to !== 'blocked') {
    return { ok: false, halted: true, reason: `halted by @${h.by} at ${h.at}${h.why ? ` — ${h.why}` : ''}` };
  }

  // Landing on the state you are already in is a no-op, not an error. Re-running a stage is
  // ordinary — a retry, a reopened issue, a replayed workflow — and failing there turns a
  // harmless repeat into a red run that looks like a broken state machine.
  if (ledger.state === to) {
    return { ok: true, ledger, unchanged: true };
  }

  const allowed = LEGAL[ledger.state] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false, reason: `illegal transition ${ledger.state} -> ${to}` };
  }
  return { ok: true, ledger: stamp({ ...ledger, state: to }, now, agent, `-> ${to}`) };
}

/**
 * One agent per issue at a time. The lock is advisory but enforced at dispatch: without it,
 * two workflows racing on the same issue produce two branches that fight over the same files.
 */
/**
 * @param {{ttlMinutes?: number, now?: Date, runId?: string|number,
 *          holderIsDead?: boolean}} opts
 *
 * `runId` is the Actions run taking the lock, and `holderIsDead` is the caller's answer to
 * "is the run that currently holds this still going?". Both exist because the TTL alone is
 * the wrong question.
 *
 * A job that GitHub CANCELS — on its `timeout-minutes`, or because someone pressed the
 * button — skips its remaining steps, including the `if: always()` unlock. The lock then
 * survives its own holder, and nothing can touch that issue until the TTL runs out. That TTL
 * has to exceed the longest job or the watchdog reclaims a lock from a stage still using it,
 * so making jobs generous made every abandoned lock proportionally more expensive: the ticket
 * sits there, untouchable, for hours, looking exactly like one being worked on.
 *
 * Age is a proxy for "the holder is gone". The run's own status is the fact.
 */
export function acquireLock(ledger, agent, { ttlMinutes = 45, now = new Date(), runId = null, holderIsDead = false } = {}) {
  const expired = !(ledger.lock_expires && new Date(ledger.lock_expires) > now);
  const held = Boolean(ledger.owner) && !expired && !holderIsDead;
  if (held && ledger.owner !== agent) {
    return { ok: false, reason: `locked by ${ledger.owner} until ${ledger.lock_expires}` };
  }
  const expires = new Date(now.getTime() + ttlMinutes * 60000).toISOString();
  const reason = holderIsDead && ledger.owner && ledger.owner !== agent
    ? `lock acquired (reclaimed from ${ledger.owner}: run ${ledger.lock_run} is no longer running)`
    : 'lock acquired';
  return {
    ok: true,
    reclaimed: Boolean(holderIsDead && ledger.owner && ledger.owner !== agent),
    ledger: stamp({ ...ledger, owner: agent, lock_expires: expires, lock_run: runId ? String(runId) : null },
      now, agent, reason),
  };
}

export function releaseLock(ledger, { agent = 'system', now = new Date(), expect = null } = {}) {
  // A lock any caller can clear is not a lock.
  //
  // Every stage releases in an `if: always()` step, so a stalled workflow's cleanup runs
  // AFTER the watchdog has reclaimed the issue and a new stage has taken it. Releasing
  // unconditionally meant that late cleanup freed the current owner's lock, and two agents
  // could then work one issue — the exact race the lock exists to prevent.
  if (expect && ledger.owner && ledger.owner !== expect) {
    return { ...ledger, refused: `lock is held by ${ledger.owner}, not ${expect}` };
  }
  return stamp({ ...ledger, owner: null, lock_expires: null, lock_run: null }, now, agent, 'lock released');
}

/** A lock past its TTL is stale — the Watchdog reclaims it rather than letting the issue hang. */
export function isLockStale(ledger, now = new Date()) {
  return Boolean(ledger.owner && ledger.lock_expires && new Date(ledger.lock_expires) <= now);
}

/**
 * Increments on DISPATCH, not on success. An agent that fails to even start still consumed
 * an attempt — otherwise a crash loop is free and runs forever.
 */
export function bumpAttempt(ledger, stage, { agent = 'system', now = new Date() } = {}) {
  if (!STAGES.includes(stage)) return { ok: false, reason: `unknown stage "${stage}"` };
  const next = { ...ledger.attempts, [stage]: (ledger.attempts[stage] ?? 0) + 1 };
  return {
    ok: true,
    ledger: stamp({ ...ledger, attempts: next }, now, agent, `${stage} attempt ${next[stage]}`),
  };
}

/**
 * @returns {{ok: true} | {ok: false, reason: string, terminal: string}}
 *
 * Attempts only. There was a wall-clock clause, compared against `budget.minutes` — a counter
 * no code ever incremented, so the documented minute cap could never trip and only made a
 * bound look present that was not. The attempt caps are the bound; an old ledger still
 * carrying `budget` reads without error because nothing looks at it.
 */
export function checkBudget(ledger, limits = {}) {
  const maxAttempts = limits.attempts ?? 10;

  for (const [stage, n] of Object.entries(ledger.attempts ?? {})) {
    if (n > maxAttempts) {
      return {
        ok: false,
        reason: `${stage} exceeded ${maxAttempts} attempts (at ${n})`,
        counter: stage,
        terminal: 'budget-exceeded',
      };
    }
  }
  return { ok: true };
}

/** Escape every regex metacharacter, then re-enable the two glob wildcards. */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++; } else { out += '[^/]*'; }
    } else if ('.+^${}()|[]\\?'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

/**
 * Do two issues expect to touch the same files?
 *
 * ADVISORY ONLY. An earlier version blocked the second issue, which was wrong twice over:
 * overlapping edits are ordinary and git handles them, and the overlap is predicted from a
 * plan whose file list is a forecast the implementer routinely departs from. Blocking on a
 * forecast costs throughput permanently to avoid a two-minute merge conflict.
 *
 * What it is good for: telling a reviewer that another PR is moving the same ground.
 */
export function pathsCollide(a = [], b = []) {
  return a.some((x) => b.some((y) => x === y || globToRegExp(x).test(y) || globToRegExp(y).test(x)));
}

/**
 * A person's `/sdlc approve` of the merge — when it approved the QA result the ledger holds now.
 *
 * It was HUMAN_APPROVED, an env var only run-command set, because run-command ran merge-pr
 * itself: in sdlc-loop's command job, outside the merge-<pr> concurrency group the judge merges
 * in, so a person's approve and the autonomous merge could run at once. The approve dispatches
 * the judge's merge step now, and the approval has to travel with it, so run-command writes it
 * here. Bound to the QA run and the commit it passed: a newer QA result is a new decision.
 *
 * An approval given with no QA result on record still counts, bound to that absence, so merge-pr
 * gets past its quiet gate to the refusal a person should hear: nothing says which commit passed.
 *
 * @returns {{by: string, at: string, sha: string|null, qa_run: string|null} | null}
 */
export function mergeApproval(ledger) {
  const a = ledger?.merge_approval;
  const qa = ledger?.qa;
  return a && (a.sha ?? null) === (qa?.sha ?? null) && String(a.qa_run ?? '') === String(qa?.run_id ?? '') ? a : null;
}
