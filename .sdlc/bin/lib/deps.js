// Issue dependencies.
//
// The maintainer splits an epic into pieces that depend on each other — you cannot record an
// expense before groups exist. It already writes those links; nothing acted on them, so every
// piece started at once and the later ones planned against code that did not exist yet.
//
// Deliberately NOT a queue. A queue needs an owner, and an owner that dies leaves everything
// parked with no way to tell whether it is waiting or broken. Instead each issue answers one
// question about itself — "are my dependencies closed?" — and a merge wakes whatever was
// waiting on it. There is no central state, so there is nothing to get stuck.

import { gh } from './actions.js';
import { STATES } from './ledger.js';

const PATTERNS = [
  // "Depends on #2", "Depends on: #2, #3", "Depends on #3 and #5", "Blocked by #4"
  /(?:depends?\s+on|blocked\s+by|requires?)\s*:?\s*(#\d+(?:(?:\s*,\s*|\s*&\s*|\s+)(?:and\s+)?#\d+)*)/gi,
];

// Markdown a person or an agent wraps a link in. `**Depends on:** #3 and #5` read as NO
// dependency — the bold closed between "on:" and "#3", and "and" ended the list — so the
// issue started at once and planned against code that did not exist yet.
const plain = (text) => text.replace(/\*\*|__|`/g, '');

/** Issue numbers this issue waits for. */
export function dependenciesOf(body = '') {
  // Strip fenced blocks and quotes: an example or a quoted comment is not a dependency.
  const text = plain(String(body ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*>.*$/gm, ''));

  const found = new Set();
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) {
      for (const n of m[1].match(/\d+/g) ?? []) found.add(Number(n));
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * What each dependency's issue actually is, asked by number.
 *
 * Callers used to build this from `gh issue list --limit 100`, so on a project past a hundred
 * issues an old, long-closed dependency was simply not in the list and read as "missing" — the
 * newest work parked on the oldest. And `state` alone said "closed" for an issue closed as
 * NOT PLANNED, which is a dependency that will never be built, not one that was.
 *
 * @returns {Promise<Map<number, 'open'|'closed'|'not_planned'>>}  a 404 is left absent
 */
export async function dependencyStates(repo, numbers = []) {
  const states = new Map();
  for (const n of new Set(numbers.map(Number))) {
    try {
      const i = JSON.parse(await gh(['api', `repos/${repo}/issues/${n}`]));
      states.set(n, i.state === 'closed' ? (i.state_reason === 'not_planned' ? 'not_planned' : 'closed') : 'open');
    } catch (e) {
      if (!/404|Not Found/.test(String(e.stderr ?? e.message))) throw e;
    }
  }
  return states;
}

/** A listed issue's state in the terms readyToStart judges, from `state` and `stateReason`. */
const stateOf = (i) => (i.state === 'closed'
  ? (String(i.stateReason ?? '').toUpperCase() === 'NOT_PLANNED' ? 'not_planned' : 'closed')
  : i.state);

/**
 * Can this issue start?
 *
 * @param {number[]} deps
 * @param {Map<number, string>} states  issue number -> 'open' | 'closed' | 'not_planned'
 *                                      ('closed' from an older caller means completed)
 * @returns {{ready: boolean, waitingOn: number[], missing: number[], abandoned: number[]}}
 */
export function readyToStart(deps, states) {
  // A dependency nobody can find is not a reason to wait forever — it is a reason to say so.
  const missing = deps.filter((n) => !states.has(n));
  // Closed as not planned is not done. Starting on it plans against work nobody will build,
  // so it is reported as its own reason rather than satisfied or waited on.
  const abandoned = deps.filter((n) => states.get(n) === 'not_planned');
  const waitingOn = deps.filter((n) => states.has(n) && !['closed', 'not_planned'].includes(states.get(n)));
  return { ready: deps.every((n) => states.get(n) === 'closed'), waitingOn, missing, abandoned };
}

/**
 * Which issues become startable now that `closed` has closed?
 *
 * Only issues whose EVERY dependency is now satisfied. Waking one whose other dependencies
 * are still open just moves the stall one step later and costs an attempt to discover it.
 */
export function unblockedBy(closed, issues) {
  const states = new Map(issues.map((i) => [i.number, stateOf(i)]));
  if (states.get(closed) !== 'not_planned') states.set(closed, 'closed');

  return issues
    .filter((i) => i.state === 'open' && i.number !== closed)
    .filter((i) => {
      const deps = dependenciesOf(i.body);
      return deps.includes(closed) && readyToStart(deps, states).ready;
    })
    .map((i) => i.number);
}

/** A cycle means nothing can ever start, and it is the maintainer's mistake, not a deadlock. */
export function findCycle(issues) {
  const graph = new Map(issues.map((i) => [i.number, dependenciesOf(i.body)]));
  const state = new Map();      // 0 = visiting, 1 = done

  const walk = (n, path) => {
    if (state.get(n) === 1) return null;
    if (state.get(n) === 0) return [...path.slice(path.indexOf(n)), n];
    state.set(n, 0);
    for (const dep of graph.get(n) ?? []) {
      if (!graph.has(dep)) continue;
      const cycle = walk(dep, [...path, n]);
      if (cycle) return cycle;
    }
    state.set(n, 1);
    return null;
  };

  for (const n of graph.keys()) {
    const cycle = walk(n, []);
    if (cycle) return cycle;
  }
  return null;
}

// --- epics ------------------------------------------------------------------
//
// An epic is an issue, so everything above already applies to one: "Depends on #N" in an
// epic's body parks it exactly as it parks any other ticket. What did NOT exist is the other
// half — nothing ever closed a finished epic.
//
// start-split-issues.mjs says, in a comment posted to every epic, that it "closes when its
// children do". Nothing implemented that. So an epic stayed open forever, and an epic
// depending on it waited forever, silently, because a blocked issue looks exactly like an
// open one. The framework had only ever been run against products with a single epic, which
// is why nobody noticed.

/**
 * Which epic, if any, an issue was split out of.
 *
 * "Part of #N", "Epic #N", "Epic: #N", "Parent epic: #N", "Parent: #N" — with any bold around
 * them. `**Epic:** #9` read as no parent at all, so the child never counted towards its epic
 * and the epic could never finish.
 */
export function epicOf(body = '') {
  const m = plain(String(body ?? '')).match(/(?:part\s+of(?:\s+epic)?|parent(?:\s+epic)?|epic)\s*:?\s*#(\d+)/i);
  return m ? Number(m[1]) : null;
}

/** An epic is split, never built; nothing may start one as an ordinary issue. */
export const isEpic = (issue) => (issue.labels ?? []).some((l) => /^(sdlc:)?epic$/i.test(l.name ?? l));

/** @param {{number: number, body?: string}[]} issues */
export function childrenOf(epic, issues = []) {
  return issues.filter((i) => epicOf(i.body) === Number(epic)).map((i) => i.number);
}

/**
 * Epics whose every child has closed — and which had children in the first place.
 *
 * The "in the first place" matters: an epic that has not been split yet has no children, and
 * "all zero of its children are closed" would close it before it was ever broken down.
 *
 * `children` (epic number -> child numbers), when the caller has it, replaces reading the
 * link out of each child's prose: a child whose body an agent or a person reworded drops out
 * of the epic, and the epic then "finishes" without it. And a child closed as NOT PLANNED is
 * a piece of the epic nobody built, so it holds the epic open for a person to decide.
 *
 * @param {{number: number, state: string, stateReason?: string, body?: string,
 *          labels?: {name: string}[]}[]} issues
 * @param {Map<number, number[]>|null} children
 */
export function finishedEpics(issues = [], children = null) {
  const byNumber = new Map(issues.map((i) => [i.number, i]));

  return issues
    .filter((i) => isEpic(i) && i.state === 'open')
    .filter((e) => {
      const kids = children ? (children.get(e.number) ?? []) : childrenOf(e.number, issues);
      return kids.length > 0 && kids.every((n) => byNumber.has(n) && stateOf(byNumber.get(n)) === 'closed');
    })
    .map((e) => e.number);
}

/** Labels that mean an issue is mid-pipeline and holding an agent slot. */
export const IN_FLIGHT = new Set([
  'sdlc:triage', 'sdlc:planning', 'sdlc:plan-review', 'sdlc:implementing',
  'sdlc:ci-red', 'sdlc:ci-green', 'sdlc:review', 'sdlc:qa', 'sdlc:qa-fail',
]);

/** Labels that mean an issue is deliberately not running, and nothing should start it. */
export const PARKED = new Set([
  'sdlc:needs-human', 'sdlc:budget-exceeded', 'sdlc:merged', 'sdlc:done',
  'sdlc:deferred', 'sdlc:ignore', 'sdlc:coverage',
]);

// Every label that states where an issue is in the pipeline.
const STATE_LABELS = new Set([...STATES.map((s) => `sdlc:${s}`), 'sdlc:plan-review']);
const labelsOf = (i) => (i.labels ?? []).map((l) => l.name ?? l);

/**
 * How many issues are currently occupying the pipeline.
 *
 * Every agent stage in this framework runs on ONE token. Eight issues woken by a single
 * merge became ten concurrent model sessions, and they exhausted it inside a minute — plan,
 * review and implement all failing together with the same runtime error. The cap is not a
 * style preference about work-in-progress; it is the number of agents the credentials can
 * actually serve.
 *
 * `sdlc:qa-pass` is deliberately absent: it is waiting for a merge, not running anything.
 */
export function inFlight(issues = [], ledgered = null) {
  // `ledgered` is the set of issue numbers that have a ledger. An issue an agent filed with
  // `sdlc:triage` already on it — a coverage gap, a follow-up — carries the label and has
  // never been through intake, so nothing will ever move it. Counted as running, two of those
  // held both slots forever.
  //
  // And a parked issue runs nothing, whatever else it is labelled. A plan the gate sends to a
  // person is at sdlc:needs-human AND keeps sdlc:plan-review, which is in flight: two such plans
  // — a low-confidence arbiter, an unreproduced bug — held both slots, and nothing else started
  // until a person had acted on both.
  return issues.filter((i) => i.state === 'open'
    && labelsOf(i).some((l) => IN_FLIGHT.has(l))
    && !labelsOf(i).some((l) => PARKED.has(l))
    && (ledgered === null || ledgered.has(i.number))).length;
}

/**
 * Every issue that COULD start — dependencies all closed, not already running, not parked
 * for a human.
 *
 * Used to top up after each merge. Without it a capped wake would strand whatever it left
 * behind: `unblockedBy` only answers "whose dependency just closed", so an issue skipped
 * once is never offered again.
 */
//
// "Not started" is decided by what the issue's STATE labels say, not by the absence of the
// ones this file happened to list. `sdlc:qa-pass` was neither in flight nor parked, so a PR
// waiting to merge was offered as a fresh start and re-planned; a plain `epic` label was not
// the `sdlc:epic` the parked list named, so an epic was re-split. An issue is startable when
// it carries no state label, only `sdlc:blocked` (parked on a dependency), or only
// `sdlc:triage` with no ledger behind it (labelled by an agent, never taken by intake).
export function readyButNotStarted(issues = [], ledgered = null) {
  const states = new Map(issues.map((i) => [i.number, stateOf(i)]));
  const startable = (i) => {
    const labels = labelsOf(i);
    if (labels.some((l) => PARKED.has(l))) return false;
    const at = labels.filter((l) => STATE_LABELS.has(l));
    return at.length === 0
      || (at.length === 1 && at[0] === 'sdlc:blocked')
      || (at.length === 1 && at[0] === 'sdlc:triage' && ledgered !== null && !ledgered.has(i.number));
  };
  return issues
    .filter((i) => i.state === 'open' && !isEpic(i) && startable(i))
    .filter((i) => readyToStart(dependenciesOf(i.body), states).ready)
    .map((i) => i.number);
}
