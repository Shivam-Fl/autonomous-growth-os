// Which checks gate a commit, and whether they are green: one rule for the gate and the merge.
//
// wait-for-checks (the gate) and merge-pr (the one irreversible step) each carried their own
// reading of the PR's check rollup, and they disagreed. Required checks were matched on `name`,
// which only check RUNS have — a legacy commit status carries `context`, and ci-verify reports
// as exactly that, so a repo requiring ci-verify read "no checks ran". And merge-pr accepted an
// empty rollup as clean, so a head no CI had ever seen could merge.

/** A check run's name, or a legacy status's context. */
export const checkName = (c) => c?.name ?? c?.context ?? '';

/** Does this repo say a PR has CI? If so, a rollup with nothing in it is broken, not clean. */
export const expectsCi = (cfg) =>
  (cfg?.verify?.mode ?? 'none') !== 'none' || (cfg?.verify?.required_checks ?? []).length > 0;

/** The checks that must pass by name: the configured list, or our own when we run it. */
export function expectedChecks(cfg) {
  const required = cfg?.verify?.required_checks ?? [];
  if (required.length) return [...required];
  return cfg?.verify?.mode === 'own' ? ['ci-verify'] : [];
}

// Our own gate must not wait for itself.
const SELF = /^(sdlc-|gate\b)/;
const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const WAITING = new Set(['PENDING', 'EXPECTED', 'QUEUED']);

/**
 * @param {object[]} rollup  the PR's check rollup: check runs ({name, status, conclusion}) and
 *                           legacy statuses ({context, state}) mixed
 * @returns {{wanted: object[], missing: string[], failing: object[], pending: object[], passing: object[]}}
 *          green means: nothing missing, failing or pending
 */
export function classifyRollup(rollup = [], cfg = {}) {
  const expected = expectedChecks(cfg);
  const wanted = (rollup ?? []).filter((c) => (expected.length
    ? expected.includes(checkName(c))
    : !SELF.test(checkName(c))));

  const missing = expected.length
    ? expected.filter((n) => !wanted.some((c) => checkName(c) === n))
    : (expectsCi(cfg) && !wanted.length ? ['(any gating check)'] : []);

  const failing = [];
  const pending = [];
  const passing = [];
  for (const c of wanted) {
    // Two shapes, not interchangeable: a check run finishes with status COMPLETED and a
    // conclusion; a legacy status has `state` alone, and says PENDING while it is running.
    const isRun = c.status !== undefined;
    const outcome = String((isRun ? c.conclusion : c.state) ?? '').toUpperCase();
    const finished = isRun ? String(c.status).toUpperCase() === 'COMPLETED' && Boolean(outcome)
                           : ['SUCCESS', 'FAILURE', 'ERROR'].includes(outcome);
    if (FAILED.has(outcome)) failing.push(c);
    else if (!finished || WAITING.has(outcome)) pending.push(c);
    else if (outcome === 'SUCCESS') passing.push(c);
    // NEUTRAL and SKIPPED are fine for a check nobody named. A check the repo REQUIRES that
    // skipped verified nothing, so it fails rather than disappearing between the buckets —
    // where a caller testing "nothing failing, nothing pending" would read it as green.
    else if (['NEUTRAL', 'SKIPPED'].includes(outcome) && !expected.includes(checkName(c))) passing.push(c);
    else failing.push(c);
  }
  return { wanted, missing, failing, pending, passing };
}
