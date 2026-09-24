#!/usr/bin/env node
// Renders the QA report as a PR comment, records what QA found on the ledger, and routes the
// state machine on next_action.
//
// Runs in the judge job of sdlc-qa, from a framework checkout that never ran the PR's code, on
// the report and the work order handed over as artifacts.
import { readFileSync, existsSync } from 'node:fs';
import { gh, setOutput, die, loadConfig, repo as repoOf } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { markResume, dispatchStage } from './lib/route-io.js';
import { resolveStage } from './lib/flow-graph.js';
import { readLedger, updateLedger } from './lib/state-io.js';
import { checkQaConsistency, checkAcCoverage } from './lib/qa-consistency.js';
import { requestIn } from './lib/route-request.js';
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
const repo = repoOf();

// WHICH COMMIT QA TESTED, as prepare resolved it — never the report's own `env.commit`.
//
// merge-pr's "still the commit QA tested" guard read `ledger.artifacts.qa_sha`, which nothing
// ever wrote, and fell back to env.commit, an optional string the model writes. Left out, the
// guard skipped itself; on the `/sdlc approve` path there was no report on disk at all. So
// the head, the verdict and the bug count are recorded here, from the script, and merge-pr
// judges that record on either path.
const sha = process.env.TESTED_SHA || die('TESTED_SHA is not set — a QA result has to say which commit it is about');
const workOrder = existsSync('work-order.json') ? JSON.parse(readFileSync('work-order.json', 'utf8')) : null;

// Throws rather than warns: a result that could not be recorded has not happened, and a
// merge judged on the previous round's record is the thing this exists to stop.
const record = (qa, openBugs) => updateLedger(repo, Number(issue), (l) => {
  if (!l) throw new Error(`issue #${issue} has no ledger to record the QA result on`);
  const next = {
    ...l,
    qa: { ...qa, sha, run_id: process.env.RUN_ID ?? null, work_order_version: workOrder?.version ?? null,
      at: new Date().toISOString() },
    qa_open_bugs: openBugs,
  };
  delete next.merge_retries;          // a new result is judged afresh, with a fresh merge budget
  return next;
});

// env.mode none: nothing to drive, and still a QA slot to finish.
//
// resolve-deployment skipped these, so a routed ticket in a repo with no runnable surface sat
// in QA forever — nothing could ever record its verdict. It is recorded for what it is, and
// the merge still re-establishes everything else; merge-pr accepts this verdict only while
// the config says there is nothing to run.
if (process.env.NOT_APPLICABLE === 'true') {
  await record({ verdict: 'not-applicable', introduced_bugs: 0, ac_ids: [] }, []);
  await commentOn('## QA — not applicable\n\n`env.mode` is `none`: this repository has no runnable ' +
    `surface, so there is no browser to drive. Recorded against \`${sha.slice(0, 7)}\`; the merge ` +
    'still re-checks CI, the head, the reserved paths and everything else.');
  await advance(issue, 'qa-pass', { agent: 'qa' });
  setOutput('routed', 'merge');
  process.exit(0);
}

const r = JSON.parse(readFileSync('qa-report.json', 'utf8'));
r.env = { ...(r.env ?? {}), commit: sha };

// What the schema validator cannot check, because it needs what the report is judged against:
// the work order QA was handed, and the bugs the last round left open. Dying sends the run to
// the failure path, so QA runs again — a rerun is the answer to a report that skipped work.
const { ledger } = await readLedger(repo, Number(issue));
const problems = [...(checkQaConsistency(r, { openBugs: ledger?.qa_open_bugs ?? [] }).errors ?? [])];
if (!audit) {
  if (!workOrder) die('work-order.json is missing — a PR\'s QA cannot be judged against criteria nobody handed it');
  problems.push(...(checkAcCoverage(r, workOrder).errors ?? []));
}
// A page that sent data to a host outside env.api_allowlist (check-evidence read it from the
// HAR). That died in the test job whatever QA concluded: the report was never posted, triage ran
// QA again at the same host, and the second identical failure sent it to root-cause to revise a
// work order over an environment. It is recorded as blocked and handed to a person — never
// merged, never revised, never re-asked — and a report that also does not hold up is not died
// over either, for the same reason.
const blockedBy = process.env.BLOCKED_REASON || '';
if (problems.length && !blockedBy) {
  die(`the QA report does not hold up against what QA was handed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
}
const allowed = blockedBy ? ((await loadConfig()).env?.api_allowlist ?? []) : [];
if (blockedBy) Object.assign(r, { verdict: 'blocked', next_action: 'escalate' });

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
  ...(blockedBy ? [
    `**Stopped for a person: ${blockedBy}.** \`env.api_allowlist\` allows ` +
      (allowed.length ? allowed.map((h) => `\`${h}\``).join(', ') : 'nothing') + '. Recorded as blocked whatever ' +
      'the report concluded: nothing merges and nothing is sent back, because another round drives the ' +
      'same page at the same host. Point the app at an allowed host, or allow this one, then `/sdlc approve`.',
    ...(problems.length ? ['', 'The report also did not hold up:', ...problems.map((p) => `- ${p}`)] : []),
    '',
  ] : []),
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

if (r.retest?.length) {
  lines.push('', '### Bugs from the last round', ...r.retest.map((x) =>
    '- **' + x.bug_id + '** — ' + x.status.replace('_', ' ') + (x.test_id ? ' _(' + x.test_id + ')_' : '') +
    (x.note ? ': ' + x.note : '')));
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

// Bugs this PR introduced stay open until a later round says what happened to each: the next
// QA run is handed this list and its report is refused without a retest entry for every one.
// A pass cannot carry one, so a pass clears it.
const introduced = (r.bugs ?? []).filter((b) => b.introduced_by_pr !== false);
await record({
  verdict: r.verdict,
  introduced_bugs: introduced.length,
  ac_ids: (r.acceptance_rollup ?? []).map((a) => a.id),
}, introduced.map((b) => ({ id: b.id, title: b.title })));

setOutput('next_action', r.next_action);
setOutput('bugs', String((r.bugs ?? []).length));

// QA is the last agent to see the change, and the only one that has watched it run. If it
// says the route was wrong — most usefully that a change routed without a review should have
// had one — it asks here. Only the Router grants it. A review goes in before QA and starts
// now (redirected), and QA runs again after it: nothing may follow QA, so that request was
// always refused, and the PR merged in the run QA said it needed a reviewer.
//
// And what the Router decided is READ, not only printed. An escalated request moved the issue
// to needs-human, and this then advanced it to the verdict state anyway — needs-human ->
// qa-pass was legal — and the merge step merged the PR a person had just been asked about.
const asked = blockedBy ? '' : await exec('node', ['.sdlc/bin/route-request.mjs'], {
  env: { ...process.env, ARTIFACT: 'qa-report.json', FROM_STAGE: 'qa', ISSUE: String(issue), PR: String(pr) },
}).then((x) => x.stdout)
  .catch((e) => {
    process.stdout.write(`::warning::route request step failed: ${String(e.message).split('\n')[0]}\n`);
    return String(e.stdout ?? '');
  });
process.stdout.write(asked);
if (/^(escalated|redirected)=true$/m.test(asked)) {
  process.stdout.write(`issue #${issue}: the route request took this issue elsewhere — ` +
    `not recording "${r.next_action}" over it\n`);
  setOutput('routed', 'stop');
  process.exit(0);
}

// Route on next_action alone — no natural-language parsing in the control flow.
// An unrecognised next_action means the agent invented a route. That is a reason to stop
// automating and ask a person — not a reason to discard a report that is already posted and
// may be entirely correct.
//
// `report-only` is the AUDIT's action, and its findings are filed as their own issues. On a PR
// run it used to mean qa-pass for any verdict: a QA that could not log in wrote "blocked" +
// report-only, left out `pr` so the consistency check could not tell, and the ledger recorded a
// pass. A PR run passes only on a passing verdict with merge; report-only there is QA not doing
// its job, and it runs again. An audit passes only on a passing verdict too: report-only is the
// one action it has, so a blocked audit went to qa-pass and file-qa-issues closed the issue as
// "nothing found" — a sweep that never ran, reading as a clean one.
const state = r.next_action === 'report-only'
  ? (audit && r.verdict === 'pass' ? 'qa-pass' : 'needs-human')
  : r.next_action === 'merge'
    ? (r.verdict === 'pass' ? 'qa-pass' : 'needs-human')
    : ({ revise: 'qa-fail', escalate: 'needs-human' }[r.next_action]
      ?? (process.stdout.write(`::warning::unknown next_action "${r.next_action}" — routing to a human\n`), 'needs-human'));
if (!audit && r.next_action === 'report-only') {
  await commentOn('## QA returned "report-only" on a pull request\n\nThat is the audit route\'s ' +
    'action; a PR\'s QA run ends in `merge`, `revise` or `escalate`. Nothing was recorded as a pass. ' +
    '`/sdlc approve` runs QA again.');
}
// Every stop for a person here is a stop IN QA, and records it. The dispatch into QA cleared
// resume_at and stopped_at, and only report-only set them again: after an escalate, a merge on a
// verdict that is not a pass, or a blocked audit, `/sdlc approve` said nothing was recorded and
// pointed at `/sdlc retry planning` — a replan of a PR whose only problem was the environment —
// and `/sdlc answer` re-ran nothing.
if (state === 'needs-human') await markResume(repo, issue, 'qa', 'retry');
await advance(issue, state, { agent: 'qa' });

// QA asked for a different route and did not get it — refused without escalating (a stage
// already run, one the ledger cannot move back to, no reason given), or the step deciding it
// failed. That is the last agent to see the change saying the route was wrong, and merging in
// the same run treated the request as if it had never been made. The pass is recorded; the
// merge waits at qa-pass for a person, where `/sdlc approve` merges it.
const unanswered = !audit && requestIn(r) && !/^granted=true$/m.test(asked);
if (state === 'qa-pass' && unanswered) {
  const q = requestIn(r);
  await commentOn(`## QA passed, and the merge waits for a person\n\nQA asked for **${q.type}** ` +
    `\`${q.stage}\` and it was not granted, so this run does not merge a PR its own QA said the route ` +
    'was wrong for. `/sdlc approve` merges it as it stands; `/sdlc retry <stage>` runs the stage QA asked for.');
}
setOutput('routed', state === 'qa-pass' && !audit && !unanswered ? 'merge' : 'stop');

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
  process.exit(0);
}

if (r.next_action === 'revise') {
  // Through dispatchStage, so ledger.pending keeps the QA run: a re-entered root-cause (a retry,
  // a resume after an outage) has no inputs of its own and reads them from there. A 404 here on
  // a fresh install means the workflow is not on the default branch yet.
  await dispatchStage({ repo, issue, target: resolveStage('root-cause', { issue, pr }), agent: 'qa',
    why: 'QA failed and the diagnosis has to be revised before another attempt',
    extra: { qa_run: process.env.RUN_ID || null, from: 'qa' } });
}
