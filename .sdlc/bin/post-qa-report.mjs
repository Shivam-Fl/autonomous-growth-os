#!/usr/bin/env node
// Renders the QA report as a PR comment and routes the state machine on next_action.
import { readFileSync } from 'node:fs';
import { gh, setOutput, die } from './lib/actions.js';
import { handOff } from './lib/handoff.js';
import { advance } from './lib/advance.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// Empty on an audit: that route has no pull request, and the report lands on the issue
// instead. Everything below asks `target` rather than assuming a PR exists.
const pr = process.env.PR || '';
const issue = process.env.ISSUE;
const audit = !pr;
const target = pr || issue;
const commentOn = (body) => gh([pr ? 'pr' : 'issue', 'comment', target, '--body', body]);
const runUrl = process.env.RUN_URL ?? '';
const r = JSON.parse(readFileSync('qa-report.json', 'utf8'));

const icon = { pass: '🟢', fail: '🔴', blocked: '🟡', skipped: '⚪' };
const sev = { critical: '🔥', major: '🔴', minor: '🟠', trivial: '⚪' };

const counts = (r.tests ?? []).reduce((a, t) => ({ ...a, [t.status]: (a[t.status] ?? 0) + 1 }), {});
const blocking = (r.bugs ?? []).filter((b) => b.introduced_by_pr !== false);

const lines = [
  '## QA — ' + (r.verdict === 'pass' ? '🟢 pass' : r.verdict === 'fail' ? '🔴 fail' : '🟡 blocked') +
    '  _(attempt ' + r.attempt + ')_',
  '',
  '`' + (r.env?.url ?? 'unknown env') + '`',
  '',
  '**' + (r.tests ?? []).length + ' cases** — ' +
    Object.entries(counts).map(([k, v]) => v + ' ' + k).join(', ') +
    ' · **' + (r.bugs ?? []).length + ' bug' + ((r.bugs ?? []).length === 1 ? '' : 's') + '**',
  '',
  '### Acceptance criteria',
  ...(r.acceptance_rollup ?? []).map((a) =>
    '- ' + (icon[a.status] ?? '⚪') + ' **' + a.id + '** — ' + a.status +
    (a.test_ids?.length ? ' _(' + a.test_ids.join(', ') + ')_' : '')),
];

if (r.bugs?.length) {
  lines.push('', '### Bugs');
  for (const b of r.bugs) {
    lines.push(
      '',
      '#### ' + (sev[b.severity] ?? '') + ' ' + b.id + ' — ' + b.title +
        (b.introduced_by_pr === false ? '  _(pre-existing, does not block)_' : ''),
      '',
      '- **Expected:** ' + b.expected,
      '- **Actual:** ' + b.actual,
      ...(b.suspected_cause ? ['- **Suspected cause:** ' + b.suspected_cause] : []),
      ...(b.reproducible ? ['- **Reproducible:** ' + b.reproducible] : []),
      '',
      '<details><summary>Steps to reproduce</summary>',
      '',
      ...b.repro.map((s, i) => (i + 1) + '. ' + s),
      '',
      '</details>',
    );
  }
}

// Failures first — nobody scrolls past twenty passing rows to find the one that broke.
const failed = (r.tests ?? []).filter((t) => t.status !== 'pass');
if (failed.length) {
  lines.push('', '### Cases that did not pass', '', '| | Case | Type | Result |', '|---|---|---|---|');
  for (const t of failed) {
    lines.push('| ' + (icon[t.status] ?? '') + ' | ' + t.title + ' | ' + t.type + ' | ' +
      (t.actual ?? t.blocked_reason ?? t.status) + ' |');
  }
}

lines.push('', '<details><summary>Full test matrix (' + (r.tests ?? []).length + ')</summary>', '',
  '| | ID | Case | Type | Pri | Source |', '|---|---|---|---|---|---|');
for (const t of r.tests ?? []) {
  lines.push('| ' + (icon[t.status] ?? '') + ' | ' + t.id + ' | ' + t.title + ' | ' + t.type +
    ' | ' + t.priority + ' | ' + t.source + ' |');
}
lines.push('', '</details>');

if (r.coverage_gaps?.length) {
  lines.push('', '### Not covered', ...r.coverage_gaps.map((g) => '- **' + g.area + '** — ' + g.reason));
}
if (r.console_errors?.length) {
  lines.push('', '<details><summary>Console errors (' + r.console_errors.length + ')</summary>', '',
    '```', ...r.console_errors.slice(0, 20), '```', '</details>');
}
if (r.fixtures?.length) {
  const leaked = r.fixtures.filter((f) => f.cleaned_up === false);
  if (leaked.length) lines.push('', '⚠️ **Fixtures not cleaned up:** ' + leaked.map((f) => f.ref).join(', '));
}
lines.push('', '---', '[Evidence, traces and video](' + runUrl + ')',
  '', '```json', JSON.stringify({ next_action: r.next_action, verdict: r.verdict, hint: r.hint }, null, 2), '```');

await commentOn(lines.join('\n'));

// QA is the last agent to see the change, and the only one that has watched it run. If it
// says the route was wrong — most usefully that a change routed without a review should have
// had one — it asks here. Only the Router grants it.
await exec('node', ['.sdlc/bin/route-request.mjs'], {
  env: { ...process.env, ARTIFACT: 'qa-report.json', FROM_STAGE: 'qa', ISSUE: String(issue), PR: String(pr) },
}).then((r) => process.stdout.write(r.stdout))
  .catch((e) => process.stdout.write(`::warning::route request step failed: ${String(e.message).split('\n')[0]}\n`));

// Route on next_action alone — no natural-language parsing in the control flow.
// An unrecognised next_action means the agent invented a route. That is a reason to stop
// automating and ask a person — not a reason to discard a report that is already posted and
// may be entirely correct.
const state = { merge: 'qa-pass', revise: 'qa-fail', escalate: 'needs-human', 'report-only': 'qa-pass' }[r.next_action]
  ?? (process.stdout.write(`::warning::unknown next_action "${r.next_action}" — routing to a human\n`), 'needs-human');
await advance(issue, state, { agent: 'qa' });

// A QA failure re-enters implementation with a REVISED work order — which means it goes to
// root-cause first, not straight back to the implementer.
//
// It used to dispatch the implementer directly, so attempt N+1 was the same agent re-reading
// the same report against an unchanged plan. Three of those exhaust the budget having tried
// one idea. Root-cause's job is the one the implementer cannot do from inside the fix: decide
// whether the original diagnosis was wrong, and rewrite it if it was. It posts the new work
// order, which routes onward to implementation by itself.
//
// The QA run id goes with it: the report says what failed, the trace and video usually say why.
if (audit) {
  // An audit's deliverable is the issues it filed, and that step runs after this one. Say
  // what happened and stop — there is no PR to merge and nobody to send back.
  process.stdout.write(`issue #${issue}: audit complete, ${(r.bugs ?? []).length} finding(s)\n`);
  setOutput('next_action', r.next_action);
  setOutput('bugs', String((r.bugs ?? []).length));
  process.exit(0);
}

if (r.next_action === 'revise') {
  // A 404 here on a fresh install means the workflow is not on the default branch yet.
  const args = ['-f', `issue=${issue}`, '-f', `pr=${pr}`];
  if (process.env.RUN_ID) args.push('-f', `qa_run=${process.env.RUN_ID}`);
  await handOff('sdlc-root-cause.yml', args, { issue, pr, why: 'QA failed and the diagnosis has to be revised before another attempt' });
}
setOutput('next_action', r.next_action);
setOutput('bugs', String((r.bugs ?? []).length));
