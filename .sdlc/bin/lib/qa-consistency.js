// Cross-field invariants for a QA report.
//
// JSON Schema proves the SHAPE is right. It cannot prove the report is INTERNALLY
// HONEST — that the verdict matches the results, that every bug referenced exists,
// that a "pass" is not hiding a failed acceptance criterion. An agent under pressure
// to look successful will produce exactly that kind of report, so the orchestrator
// checks it rather than trusting it.

const BLOCKING_AC = new Set(['fail', 'blocked', 'not_covered']);

export function checkQaConsistency(r) {
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
      if (!testIds.has(id)) bad(`${ac.id} references ${id}, which is not in tests[]`);
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

  return errors.length ? { ok: false, errors } : { ok: true };
}
