// Every check that gates an agent's artifact, in one place.
//
// A gate that enforces a rule the agent was never told about fails a finished run, and on
// growth-os that was the commonest stall of all: a retested bug cited on its test, a fixture kind
// outside an enum, a HAR recorded where the check did not look, API cases with no screenshot, a
// plan naming a reserved path, evidence cited from the evidence directory rather than the repo
// root. Each was found by a live run, fixed one at a time, and the next one was waiting.
//
// So the agent runs the gate itself before it finishes: preflight.mjs takes this list and runs,
// on the files the agent wrote, exactly what the job runs on them afterwards — and every agent
// that writes one of these is told to (claude-args.mjs). A mismatch costs a turn inside the
// session instead of a run, a triage and a person. The job's own run stays the gate; this is the
// same check, earlier. A workflow gate that is not in this list fails a test
// (tests/gate-checks.test.js), so the two cannot drift apart.
//
//   schema  the file's schema, through the loader every acting script uses (lib/artifact.js),
//           and QA's internal consistency for a report
//   then    the scripts the job runs after the schema, with PREFLIGHT=1 so none of them writes
export const GATES = {
  'work-order': { file: 'work-order.json', then: [
    ['check-forbidden.mjs', '--file', 'work-order.json'],
    ['check-split-criteria.mjs'],
  ] },
  stop: { file: 'stop.json' },
  'qa-report': { file: 'qa-report.json', then: [['check-evidence.mjs']] },
  'plan-review': { file: 'plan-review.json' },
  'review-correctness': { file: 'review/correctness.json' },
  'review-design': { file: 'review/design.json' },
  triage: { file: 'triage.json' },
  breakdown: { file: 'breakdown.json' },
  survey: { file: 'survey.json' },
  'project-brief': { file: 'project-brief.json' },
  'flow-plan': { file: 'flow-plan.json' },
  'self-fix-consult': { file: 'self-fix-consult.json' },
};

/** The roles whose output is gated here, and so are told to run the preflight. */
export const GATED_ROLES = ['plan', 'plan_arbiter', 'plan_reviewer', 'debug', 'review_correctness', 'review_design',
  'qa', 'root_cause', 'triage', 'maintainer', 'project', 'router'];
