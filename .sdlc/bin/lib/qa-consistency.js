// Cross-field invariants for a QA report.
//
// JSON Schema proves the SHAPE is right. It cannot prove the report is INTERNALLY
// HONEST — that the verdict matches the results, that every bug referenced exists,
// that a "pass" is not hiding a failed acceptance criterion. An agent under pressure
// to look successful will produce exactly that kind of report, so the orchestrator
// checks it rather than trusting it.

const BLOCKING_AC = new Set(['fail', 'blocked', 'not_covered']);

// The test id a criterion cites when CI, not the browser, is what proves it. Only a criterion
// the work order marks `verify: "test"` may rest on it — checkAcCoverage holds that line.
const CI = 'ci';

// AC ids are written by two different agents, so "ac-3" and "AC-3 " are the same criterion.
const norm = (id) => String(id ?? '').toUpperCase().replace(/\s+/g, '');

export function checkQaConsistency(r, { openBugs = [] } = {}) {
  const errors = [];
  const bad = (m) => errors.push(m);

  const testIds = new Set();
  for (const t of r.tests ?? []) {
    if (testIds.has(t.id)) bad(`duplicate test id ${t.id}`);
    testIds.add(t.id);
  }

  const bugIds = new Set();
  for (const b of r.bugs ?? []) {
    if (bugIds.has(b.id)) bad(`duplicate bug id ${b.id}`);
    bugIds.add(b.id);
  }

  // Dangling references in either direction.
  for (const t of r.tests ?? []) {
    if (t.bug_id && !bugIds.has(t.bug_id)) bad(`${t.id} references ${t.bug_id}, which is not in bugs[]`);
    if (t.status === 'blocked' && !t.blocked_reason) bad(`${t.id} is blocked but gives no blocked_reason`);
    if (t.status === 'fail' && !t.actual) bad(`${t.id} failed but does not say what actually happened`);
  }
  for (const ac of r.acceptance_rollup ?? []) {
    for (const id of ac.test_ids ?? []) {
      if (id !== CI && !testIds.has(id)) bad(`${ac.id} references ${id}, which is not in tests[]`);
    }
    if (ac.status === 'pass' && !(ac.test_ids ?? []).length) {
      bad(`${ac.id} is marked pass but cites no test that proves it`);
    }
  }

  // A failing test that files no bug is an unexplained failure.
  const unexplained = (r.tests ?? []).filter((t) => t.status === 'fail' && !t.bug_id);
  if (unexplained.length) {
    bad(`failing tests with no bug filed: ${unexplained.map((t) => t.id).join(', ')}`);
  }

  // The verdict must follow from the acceptance rollup, not from optimism.
  const acBlocking = (r.acceptance_rollup ?? []).filter((a) => BLOCKING_AC.has(a.status));
  if (r.verdict === 'pass' && acBlocking.length) {
    bad(`verdict is "pass" but ${acBlocking.map((a) => `${a.id}=${a.status}`).join(', ')}`);
  }
  // A bug this PR introduced does not merge. No severity carve-out, deliberately.
  //
  // This used to block only `critical` and `major`, and severity is the agent's own judgement
  // of its own work: QA found a real, reproducible, always-repeating bug it had just written,
  // graded it `minor`, and returned "pass — worth a follow-up fix". Nothing filed it either,
  // because filing is for PRE-EXISTING bugs, so the finding went in a comment and the PR went
  // to merge. Gating a guard on a field the thing being guarded chooses is not a guard.
  //
  // The cost of the strict rule is one rework loop on a cosmetic defect. The cost of the loose
  // one is shipping bugs the pipeline itself found, catalogued and reproduced.
  const introduced = (r.bugs ?? []).filter((b) => b.introduced_by_pr !== false);
  if (r.verdict === 'pass' && introduced.length) {
    bad(`verdict is "pass" but this PR introduced ${introduced.length} bug(s): ` +
        `${introduced.map((b) => `${b.id} (${b.severity})`).join(', ')} — a bug this PR caused ` +
        'is fixed here, not filed for later');
  }

  // Every bug must say where it came from. Absent, it is neither blocked (that reads it as
  // introduced only by luck of the `!== false` default) nor filed as its own issue (that
  // requires an explicit `false`) — it falls between the two and exists only in a comment.
  for (const b of r.bugs ?? []) {
    if (typeof b.introduced_by_pr !== 'boolean') {
      bad(`${b.id} does not say whether this PR introduced it — that decides whether it blocks ` +
          'the merge or becomes its own issue, so it cannot be left out');
    }
  }

  // next_action must agree with the verdict — it is what the orchestrator acts on.
  const allowed = {
    pass: ['merge', 'report-only'],
    fail: ['revise', 'escalate', 'report-only'],
    blocked: ['escalate', 'revise', 'report-only'],
  };
  if (r.verdict && r.next_action && !allowed[r.verdict].includes(r.next_action)) {
    bad(`verdict "${r.verdict}" is inconsistent with next_action "${r.next_action}"`);
  }

  // An audit is the one QA run with no PR: it tests what is already deployed and turns every
  // finding into its own issue. `pr` was required for exactly that reason — nothing else could
  // legitimately omit it — so dropping the requirement needs the invariant restated, in both
  // directions, or "the agent forgot the PR number" becomes indistinguishable from "there is
  // no PR", and a report about a branch would route as an audit and file its own bugs as
  // pre-existing ones.
  if (r.next_action === 'report-only' && r.pr) {
    bad(`next_action is "report-only", which is the audit route, but the report names PR #${r.pr} — ` +
        'an audit has no PR, and a PR\'s QA run is never report-only');
  }
  if (r.next_action && r.next_action !== 'report-only' && !r.pr) {
    bad(`next_action is "${r.next_action}" but the report names no PR — every action except ` +
        '"report-only" is something done to a pull request');
  }

  // Every bug found without a PR is pre-existing by construction: there is no diff to have
  // introduced it. A report claiming otherwise has misunderstood what it was doing.
  if (!r.pr) {
    const claimed = (r.bugs ?? []).filter((b) => b.introduced_by_pr === true);
    if (claimed.length) {
      bad(`${claimed.map((b) => b.id).join(', ')} claim to have been introduced by a PR, and this ` +
          'run tested no PR — with no diff there is nothing that could have introduced them');
    }
  }

  // A bug QA filed as introduced last round has to be looked at again this round.
  //
  // QA has no memory by design, so each run started from the diff alone and a bug it had filed,
  // and the implementer had "fixed", was simply never mentioned again — which reads as fixed. The
  // open list comes off the ledger (post-qa-report writes it), not from the agent, and each
  // entry needs a retest row saying what happened to it.
  const retested = new Set((r.retest ?? []).map((x) => norm(x.bug_id)));
  const unchecked = (openBugs ?? []).filter((b) => !retested.has(norm(b.id)));
  if (unchecked.length) {
    bad(`${unchecked.map((b) => b.id).join(', ')} ${unchecked.length === 1 ? 'was' : 'were'} filed as introduced by ` +
        'this PR last round and the report has no retest entry for it — a bug not mentioned again reads as fixed');
  }
  for (const x of r.retest ?? []) {
    if (x.test_id && !testIds.has(x.test_id)) bad(`retest of ${x.bug_id} references ${x.test_id}, which is not in tests[]`);
    if (x.status === 'still_present' && r.verdict === 'pass') bad(`verdict is "pass" but the retest says ${x.bug_id} is still present`);
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

/** The work order's criteria that none of these AC ids names — what merge-pr re-checks. */
export function missingCriteria(ids, workOrder) {
  const seen = new Set((ids ?? []).map(norm));
  return (workOrder?.acceptance ?? []).map((a) => norm(a.id)).filter((id) => !seen.has(id));
}

/**
 * Did this QA run exercise every acceptance criterion of the work order it was handed?
 *
 * checkQaConsistency only checks the report against itself, so a rollup of AC-1..AC-4, all
 * passing, was an honest "pass" on a work order with six criteria — the two nobody tested were
 * simply never mentioned. The work order is the floor; this is what makes it one.
 *
 * @param {object} r          the QA report
 * @param {object} workOrder  the work order QA was given (its `acceptance` array)
 * @returns {{ok: true} | {ok: false, errors: string[]}}
 */
export function checkAcCoverage(r, workOrder) {
  const errors = [];
  const criteria = new Map((workOrder?.acceptance ?? []).map((a) => [norm(a.id), a]));
  const rolled = new Map((r.acceptance_rollup ?? []).map((a) => [norm(a.id), a]));

  const missing = missingCriteria([...rolled.keys()], workOrder);
  if (missing.length) {
    errors.push(`the work order's ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing from acceptance_rollup — ` +
      'every criterion needs a verdict, and an unmentioned one is not a pass');
  }
  // Only an audit writes its own criteria, and an audit has no work order to compare with.
  const extra = [...rolled.keys()].filter((id) => !criteria.has(id));
  if (extra.length) {
    errors.push(`${extra.join(', ')} ${extra.length === 1 ? 'is not a criterion' : 'are not criteria'} of this work order`);
  }

  for (const [id, a] of rolled) {
    const c = criteria.get(id);
    if (!c) continue;
    if (r.verdict === 'pass' && a.status !== 'pass') errors.push(`verdict is "pass" but ${id} is ${a.status}`);
    if ((a.test_ids ?? []).includes(CI) && c.verify !== 'test') {
      errors.push(`${id} cites "ci" as its proof, but the work order has QA verify it in the running app`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
