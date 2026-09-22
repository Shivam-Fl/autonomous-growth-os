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

const PATTERNS = [
  // "Depends on #2", "Depends on: #2, #3", "Blocked by #4"
  /(?:depends?\s+on|blocked\s+by|requires?)\s*:?\s*((?:#\d+[,\s]*)+)/gi,
];

/** Issue numbers this issue waits for. */
export function dependenciesOf(body = '') {
  // Strip fenced blocks and quotes: an example or a quoted comment is not a dependency.
  const text = String(body)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*>.*$/gm, '');

  const found = new Set();
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) {
      for (const n of m[1].match(/\d+/g) ?? []) found.add(Number(n));
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Can this issue start?
 *
 * @param {number[]} deps
 * @param {Map<number, string>} states  issue number -> 'open' | 'closed'
 * @returns {{ready: true} | {ready: false, waitingOn: number[], missing: number[]}}
 */
export function readyToStart(deps, states) {
  const waitingOn = deps.filter((n) => states.get(n) === 'open');
  // A dependency nobody can find is not a reason to wait forever — it is a reason to say so.
  const missing = deps.filter((n) => !states.has(n));
  return waitingOn.length || missing.length ? { ready: false, waitingOn, missing } : { ready: true };
}

/**
 * Which issues become startable now that `closed` has closed?
 *
 * Only issues whose EVERY dependency is now satisfied. Waking one whose other dependencies
 * are still open just moves the stall one step later and costs an attempt to discover it.
 */
export function unblockedBy(closed, issues) {
  const states = new Map(issues.map((i) => [i.number, i.state]));
  states.set(closed, 'closed');

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

/** Which epic, if any, an issue was split out of. */
export function epicOf(body = '') {
  const m = String(body).match(/(?:part of|epic)\s+#(\d+)/i);
  return m ? Number(m[1]) : null;
}

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
 * @param {{number: number, state: string, body?: string, labels?: {name: string}[]}[]} issues
 */
export function finishedEpics(issues = []) {
  const isEpic = (i) => (i.labels ?? []).some((l) => /^(sdlc:)?epic$/i.test(l.name ?? l));
  const byNumber = new Map(issues.map((i) => [i.number, i]));

  return issues
    .filter((i) => isEpic(i) && i.state === 'open')
    .filter((e) => {
      const kids = childrenOf(e.number, issues);
      return kids.length > 0 && kids.every((n) => byNumber.get(n)?.state === 'closed');
    })
    .map((e) => e.number);
}

/** Labels that mean an issue is mid-pipeline and holding an agent slot. */
export const IN_FLIGHT = new Set([
  'sdlc:triage', 'sdlc:planning', 'sdlc:plan-review', 'sdlc:implementing',
  'sdlc:ci-red', 'sdlc:ci-green', 'sdlc:review', 'sdlc:qa', 'sdlc:qa-fail',
]);

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
export function inFlight(issues = []) {
  return issues.filter((i) => i.state === 'open'
    && (i.labels ?? []).some((l) => IN_FLIGHT.has(l.name ?? l))).length;
}

/**
 * Every issue that COULD start — dependencies all closed, not already running, not parked
 * for a human.
 *
 * Used to top up after each merge. Without it a capped wake would strand whatever it left
 * behind: `unblockedBy` only answers "whose dependency just closed", so an issue skipped
 * once is never offered again.
 */
export function readyButNotStarted(issues = []) {
  const states = new Map(issues.map((i) => [i.number, i.state]));
  const parked = new Set(['sdlc:needs-human', 'sdlc:budget-exceeded', 'sdlc:merged', 'sdlc:done', 'sdlc:epic']);
  return issues
    .filter((i) => i.state === 'open')
    .filter((i) => !(i.labels ?? []).some((l) => IN_FLIGHT.has(l.name ?? l) || parked.has(l.name ?? l)))
    .filter((i) => readyToStart(dependenciesOf(i.body), states).ready)
    .map((i) => i.number);
}
