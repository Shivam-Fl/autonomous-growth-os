#!/usr/bin/env node
// One path out of every mechanical failure, whichever stage produced it.
//
// Before this, a QA failure was diagnosed by an agent that read the trace and put the
// original diagnosis on trial, while a CI failure got a regex digest and — if the gate was
// the thing that noticed — nothing at all. `gate-outcome.mjs` recorded `ci-red` and
// dispatched nobody. A red build was a dead end that looked exactly like a pipeline still
// working, which is this repo's signature failure: you find out by noticing that nothing
// happened.
//
// What this does, in order:
//   1. collect the RAW error, not a summary of it
//   2. reduce it to a signature that survives a fixer editing the file underneath it
//   3. record it on the ledger, so the second identical failure is answerable
//   4. decide: fix it, put the diagnosis on trial, or stop and ask a person
//   5. dispatch that, and say so where someone is looking
//
// The decision itself lives in lib/failure.js and is pure, because it is the thing that
// bounds an unattended retry loop.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { gh, ghJson, setOutput, loadConfig, die, ERROR_LOG } from './lib/actions.js';
import { handOff } from './lib/handoff.js';
import { markResume } from './lib/route-io.js';
import { advance } from './lib/advance.js';
import { digest } from './lib/digest.js';
import { signatureOf, classify, decide, recordFailure, consecutive } from './lib/failure.js';
import { validate, formatErrors } from './lib/validate.js';
import { readLedger, updateLedger } from './lib/state-io.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = process.env.GITHUB_REPOSITORY ?? die('GITHUB_REPOSITORY is not set');
const stage = process.env.STAGE ?? die('STAGE is required (plan|implement|ci|review|qa|root-cause|gate|maintainer)');
const runUrl = process.env.RUN_URL ?? '';
// The tail of the log, because the failure is always at the end of it. Capped low enough
// that the packet can be posted IN FULL as a fenced block — a re-dispatched stage reads the
// packet back off the timeline, so a comment that redacts the excerpt for readability hands
// the fixer a packet with the one field it needed stripped out.
const MAX_EXCERPT = 6000;

// The steps that run a model. A failure here is the agent RUNTIME, not the project's code.
const AGENT_STEP = /^(plan|implement|review|council|debug|test it|decide the|diagnose|split|release notes|route|triage)/i;
let agentRuntimeFailed = false;

// Which workflow answers a failure in this stage, and which attempt counter it spends.
//
// `ci` and `implement` share both: a red build is answered by the implementer, on the same
// branch, and it costs a `ci` attempt — the counter that existed from the first commit and
// that nothing had ever incremented, because nothing ever re-dispatched on a red build.
const STAGE = {
  plan:         { workflow: 'sdlc-plan.yml',        counter: 'plan',   rework: null },
  implement:    { workflow: 'sdlc-implement.yml',   counter: 'ci',     rework: 'fix:implement-failed' },
  ci:           { workflow: 'sdlc-implement.yml',   counter: 'ci',     rework: 'fix:ci-red' },
  gate:         { workflow: 'sdlc-implement.yml',   counter: 'ci',     rework: 'fix:gate-failed' },
  review:       { workflow: 'sdlc-review.yml',      counter: 'review', rework: null },
  qa:           { workflow: 'sdlc-qa.yml',          counter: 'qa',     rework: null },
  'root-cause': { workflow: 'sdlc-root-cause.yml',  counter: 'plan',   rework: null },
  maintainer:   { workflow: 'sdlc-maintainer.yml',  counter: null,     rework: null },
};
const route = STAGE[stage] ?? die(`unknown stage "${stage}"`);

// --- who is this about -------------------------------------------------------
let pr = process.env.PR ? Number(process.env.PR) : null;
let issue = process.env.ISSUE ? Number(process.env.ISSUE) : null;

if (!issue && pr) {
  const body = await ghJson(['pr', 'view', String(pr), '--json', 'body']).then((d) => d.body ?? '').catch(() => '');
  const m = body.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  if (m) issue = Number(m[1]);
}
if (!issue) {
  // A PR with no work order is not the pipeline's business, and a failure with no issue has
  // nothing to record against. Say so and stop cleanly rather than inventing a target.
  process.stdout.write('no issue to attach this failure to — nothing recorded, nothing dispatched\n');
  setOutput('action', 'none');
  process.exit(0);
}

/**
 * The part of a job log that says what went wrong.
 *
 * A blind tail is the obvious choice and is wrong for an Actions log: the last forty lines
 * are the action's own cleanup steps, and the error sits well above them. So the window is
 * cut around `##[error]`, which is the one marker the runner writes for every failure
 * whatever produced it.
 *
 * Also strips the `job<TAB>step<TAB>timestamp` prefix `gh` prepends and the runner's ANSI, so
 * what reaches the agent reads like the tool's own output rather than like a transcript.
 */
function focusOnError(log) {
  const lines = String(log)
    .split(/\r?\n/)
    .map((l) => l
      .replace(/^[^\t]*\t[^\t]*\t/, '')
      .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, ''));

  const marks = lines.reduce((acc, l, i) => (/##\[error\]/.test(l) ? [...acc, i] : acc), []);
  if (!marks.length) return lines.join('\n').slice(-MAX_EXCERPT);

  const from = Math.max(0, marks[0] - 60);
  const to = Math.min(lines.length, marks[marks.length - 1] + 15);
  return lines.slice(from, to).join('\n').slice(-MAX_EXCERPT);
}

// --- the raw error -----------------------------------------------------------
// A summary is what failed to be enough last time. The agent that has to fix this gets the
// output the tool actually produced.
async function collectRaw() {
  if (process.env.RAW_TEXT) return process.env.RAW_TEXT;
  if (process.env.LOG_FILE && existsSync(process.env.LOG_FILE)) {
    return readFileSync(process.env.LOG_FILE, 'utf8');
  }

  const parts = [];

  // What the dying script itself said, picked up off disk rather than out of the API.
  //
  // This handler runs in the SAME job as the step that failed, while that job is still in
  // progress, and GitHub serves no logs for a run that has not finished. Every script here
  // exits through `die()`, so this one file is every script-originated failure in every
  // stage — and it is the only source that is not a network call that can come back empty.
  if (existsSync(ERROR_LOG)) {
    const note = readFileSync(ERROR_LOG, 'utf8').trim();
    if (note) parts.push(note);
  }

  // The failing checks on the PR, whoever ran them — ours or the repo's own. This is what
  // makes the loop work on a repo with existing CI, which is most of them.
  if (pr) {
    const rollup = await ghJson(['pr', 'view', String(pr), '--json', 'statusCheckRollup'])
      .then((d) => d.statusCheckRollup ?? []).catch(() => []);
    const failedRuns = new Set();
    for (const c of rollup) {
      const bad = /^(FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE)$/i
        .test(String(c.conclusion ?? c.state ?? ''));
      if (!bad) continue;
      const id = String(c.detailsUrl ?? c.targetUrl ?? '').match(/\/actions\/runs\/(\d+)/)?.[1];
      if (id) failedRuns.add(id);
      else parts.push(`check "${c.name}" reported ${c.conclusion ?? c.state} and has no Actions log to read`);
    }
    for (const id of failedRuns) {
      const log = await gh(['run', 'view', id, '--log-failed']).catch(() => '');
      if (log) parts.push(log.slice(-MAX_EXCERPT));
    }
  }

  // Which STEP failed, from the jobs API — the one source that answers while the job is
  // still running.
  //
  // Annotations turned out not to be: they are posted when the JOB completes, so from inside
  // an `if: failure()` step they are as absent as the job log. The only agent-step failure
  // this framework can see from where it stands is the step's own name and conclusion.
  //
  // That is thin and it is not nothing. "The agent runtime failed" is a different problem
  // from "the compiler rejected your diff", and telling them apart is the difference between
  // sending a fixer and telling someone their token is rate-limited.
  if (!parts.length && (process.env.RUN_ID || process.env.GITHUB_RUN_ID)) {
    const runId = process.env.RUN_ID || process.env.GITHUB_RUN_ID;
    const jobs = await ghJson(['api', `repos/${repo}/actions/runs/${runId}/jobs`])
      .then((d) => d.jobs ?? []).catch(() => []);
    for (const j of jobs) {
      const bad = (j.steps ?? []).filter((st) => st.conclusion === 'failure');
      for (const st of bad) {
        parts.push(`step "${st.name}" failed in job "${j.name}" (conclusion: ${st.conclusion})`);
        if (AGENT_STEP.test(st.name)) agentRuntimeFailed = true;
      }
    }

    // Several agent steps dying inside the same minute, across different stages, is one
    // shared thing giving out rather than several unrelated faults — a token's rate or
    // concurrency limit is the usual one. Worth saying out loud, because the alternative is
    // a person opening ten identical failures one at a time.
    if (agentRuntimeFailed) {
      const since = Date.now() - 10 * 60_000;
      const recent = await ghJson(['run', 'list', '--limit', '30', '--json', 'conclusion,updatedAt,name'])
        .then((rs) => rs.filter((r) => r.conclusion === 'failure' && Date.parse(r.updatedAt) > since))
        .catch(() => []);
      if (recent.length >= 3) {
        parts.push(`\n${recent.length} runs failed in the last ten minutes ` +
          `(${[...new Set(recent.map((r) => r.name))].join(', ')}). Agent steps failing together ` +
          'across different stages is one shared limit, not several faults.');
      }
    }
  }

  // The runner's own annotations for this job. Posted live as each `::error::` is emitted,
  // so unlike the job log they exist WHILE the job is running — which is when this handler
  // reads them. Thinner than a log and enough to name the failure: a step that ends with
  // `Process completed with exit code 1` and nothing else is a step whose real message went
  // to stdout, which is what ERROR_LOG above is for.
  //
  // The jobs API's `id` is the check-run id; `check_run_url` ends in the same number.
  if (!parts.length && (process.env.RUN_ID || process.env.GITHUB_RUN_ID)) {
    const runId = process.env.RUN_ID || process.env.GITHUB_RUN_ID;
    const jobs = await ghJson(['api', `repos/${repo}/actions/runs/${runId}/jobs`])
      .then((d) => d.jobs ?? []).catch(() => []);
    const lines = [];
    for (const j of jobs.slice(0, 3)) {
      const anns = await ghJson(['api', `repos/${repo}/check-runs/${j.id}/annotations`]).catch(() => []);
      for (const a of anns) {
        if (a?.annotation_level !== 'failure') continue;       // warnings are noise here
        lines.push(`${a.title ? a.title + ': ' : ''}${a.message ?? ''}`.trim());
      }
    }
    if (lines.length) parts.push(`--- annotations ---\n${lines.join('\n')}`);
  }

  // A crashed agent stage, which has no check run at all — so the log has to come from the
  // run itself. And it cannot come from `gh run view --log-failed`.
  //
  // This handler runs INSIDE the run it is reporting on, in an `if: failure()` step, so that
  // run is still in progress. Run-level logs do not exist until a run completes, and the
  // first live test of this loop duly produced "no log, no digest and no failing-check detail
  // could be retrieved" and escalated to a human — correct behaviour on empty input, and the
  // whole self-heal loop dead for every agent-stage crash.
  //
  // JOB logs stream while the job is running. So: ask for this run's jobs, prefer any that
  // have already failed, fall back to the one still executing (this one).
  if (!parts.length && (process.env.RUN_ID || process.env.GITHUB_RUN_ID)) {
    const runId = process.env.RUN_ID || process.env.GITHUB_RUN_ID;
    const attempt = Number(process.env.GITHUB_RUN_ATTEMPT || 1);
    const jobs = await ghJson(['api', `repos/${repo}/actions/runs/${runId}/jobs`])
      .then((d) => (d.jobs ?? []).filter((j) => (j.run_attempt ?? 1) === attempt))
      .catch(() => []);

    const failed = jobs.filter((j) => j.conclusion === 'failure');
    const running = jobs.filter((j) => j.status === 'in_progress');
    for (const j of (failed.length ? failed : running).slice(0, 3)) {
      // --allow-escape-sequences or `gh` prints nothing at all and exits 0: a runner log is
      // full of ANSI, and `gh` refuses to emit it by default. That silent-empty is how this
      // fetch would have looked exactly like "there is no log".
      const log = await gh(['api', '--allow-escape-sequences',
        `repos/${repo}/actions/jobs/${j.id}/logs`]).catch(() => '');
      if (log) parts.push(`--- job: ${j.name} ---\n${focusOnError(log)}`);
    }
  }

  // Last resort: our own CI already posted a digest to the PR. Weaker than the raw log, and
  // still far better than the check names alone.
  if (!parts.length && pr) {
    const comments = await ghJson(['pr', 'view', String(pr), '--json', 'comments'])
      .then((d) => d.comments ?? []).catch(() => []);
    const ciComment = comments.slice().reverse().find((c) => /^##\s+CI failed/m.test(c.body ?? ''));
    if (ciComment) parts.push(ciComment.body);
  }

  return parts.join('\n\n');
}

const raw = (await collectRaw()).trim();
if (!raw) {
  // Nothing readable is not nothing wrong. The loop cannot help an agent it cannot tell what
  // broke, so this is a person's problem — and saying that is the honest outcome.
  await gh(['issue', 'comment', String(issue), '--body',
    `## The ${stage} stage failed, and nothing readable came back\n\n` +
    `No log, no digest and no failing-check detail could be retrieved${runUrl ? `, so the run is the only record: ${runUrl}` : '.'}\n\n` +
    'The self-heal loop hands an agent the exact error it has to fix. With no error text there ' +
    'is nothing to hand it, and retrying blind is how a budget is spent learning nothing. ' +
    'Handing this to a human.']).catch(() => {});
  // Recorded even though there is nothing to describe. `failure_history` is what a person
  // reads to see a pattern, and a failure missing from it under-reports the issue's life —
  // this one showed as "0 failures" on a ledger whose history plainly said needs-human.
  //
  // The signature is deliberately UNIQUE rather than empty. Two failures nobody could
  // describe are not evidence of the same failure twice, and sharing one signature would let
  // them escalate each other on evidence nobody has.
  await updateLedger(repo, issue, (l) => (l ? recordFailure(l, {
    stage,
    error_signature: signatureOf(`indescribable:${stage}:${process.env.RUN_ID ?? Date.now()}`),
    error_type: 'unknown',
    attempt: (l.attempts?.[route.counter] ?? 0) + 1,
    at: new Date().toISOString(),
    digest: `the ${stage} stage failed and no log could be retrieved`,
  }) : null)).catch(() => {});

  await markResume(repo, issue, stage === 'ci' || stage === 'gate' ? 'implement' : stage, 'retry')
    .catch(() => {});
  await advance(issue, 'needs-human', { agent: 'self-heal' }).catch(() => {});
  setOutput('action', 'escalate');
  process.exit(0);
}

const excerpt = raw.length > MAX_EXCERPT ? raw.slice(-MAX_EXCERPT) : raw;
const signature = signatureOf(excerpt);
const errorType = process.env.ERROR_TYPE || classify(excerpt);
const d = digest(excerpt);
const summary = d.findings.length
  ? d.summary
  : `The ${stage} stage failed and no known error pattern matched. The raw output is below.`;

// --- what has already been tried --------------------------------------------
const cfg = await loadConfig();
const before = await readLedger(repo, issue).then((r) => r.ledger).catch(() => null);
if (!pr && before?.pr) pr = before.pr;

const entry = {
  stage,
  error_signature: signature,
  error_type: errorType,
  attempt: (before?.attempts?.[route.counter] ?? 0) + 1,
  at: new Date().toISOString(),
  digest: summary.slice(0, 300),
};

// Recorded BEFORE the decision, because the decision is about how many times this has now
// happened — including this time.
let history = [...(before?.failure_history ?? []), entry];
await updateLedger(repo, issue, (l) => {
  if (!l) return null;
  const next = recordFailure(l, entry);
  history = next.failure_history;
  return next;
}).catch((e) => process.stdout.write(`::warning::could not record the failure on the ledger: ${e.message}\n`));

// Is there a work order to put on trial? Root-cause revises a diagnosis; with no diagnosis
// written down yet there is nothing for it to do, and the honest answer is a person.
const workOrder = await exec('node', ['.sdlc/bin/fetch-work-order.mjs'], { env: { ...process.env, ISSUE: String(issue) } })
  .then((r) => JSON.parse(r.stdout)).catch(() => null);

// Is there an attempt left to act on a verdict? A diagnosis nothing can execute is a
// diagnosis worth having on the issue but not worth a model run to produce.
const budgetGone = (before?.attempts?.[route.counter] ?? 0) >= Number(cfg.limits?.attempts ?? 10);

const decision = agentRuntimeFailed && !d.findings.length
  // The MODEL RUN failed, not the project's code. There is no diff to fix and no diagnosis
  // to revise — handing this to a fixer spends an attempt proving the runtime is still down.
  //
  // Ten of these arrived inside one minute on the first fan-out, across plan, review and
  // implement at once, which is what a token's rate or concurrency limit looks like from
  // here. Retrying would have turned one outage into ten burnt attempts and a budget
  // exceeded on work that was never wrong.
  ? {
      action: 'escalate',
      occurrences: consecutive(history, signature),
      reason: 'the agent runtime failed before it produced anything — no diff to fix and no ' +
              'diagnosis to revise. Usually a rate or quota limit on the token, not the code',
    }
  : budgetGone
    // No attempt left to spend on any verdict, so there is nothing for an agent to decide.
    ? {
        action: 'escalate',
        occurrences: consecutive(history, signature),
        reason: `the ${route.counter} budget is spent — a diagnosis now has no attempt to act on`,
      }
    // Everything else goes to an AGENT, which is the whole point of this being a hand-off
    // and not a decision.
    //
    // This script cannot see the log. It runs inside the failing run, where the log does not
    // exist yet and the annotations API returns nothing — so its evidence was the name of the
    // step that went red, and its rule for an unrecognised first failure was to re-run the
    // stage. That re-ran a three-agent council, thirty-three minutes and three models, to
    // repair one `gh` call that had failed AFTER the plan was approved. A regex table cannot
    // tell a failed post from a crashed planner, and nothing else was looking.
    //
    // Dispatched afterwards, an agent reads the whole log, the code that threw, and what
    // survived — and answers the question a pattern match cannot: does re-running this make
    // the next attempt different?
    : {
        action: 'triage',
        occurrences: consecutive(history, signature),
        reason: 'an agent reads the failed run\'s full log and decides what happens next — ' +
                'this script cannot see that log from inside the run that produced it',
      };

// --- the packet --------------------------------------------------------------
const packet = {
  issue,
  ...(pr ? { pr } : {}),
  stage,
  attempt: entry.attempt,
  occurrences: Math.max(1, decision.occurrences),
  error_type: errorType,
  error_signature: signature,
  raw_excerpt: excerpt,
  digest: summary.slice(0, 2000),
  decision: decision.action,
  decision_reason: decision.reason.slice(0, 1000),
  context: {
    ...(workOrder?.version ? { work_order_version: Number(workOrder.version) } : {}),
    ...(process.env.DIFF_REF ? { diff_ref: process.env.DIFF_REF.slice(0, 200) } : {}),
    ...(process.env.FAILED_CHECKS
      ? { failed_checks: process.env.FAILED_CHECKS.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30) }
      : {}),
    ...(runUrl ? { run_url: runUrl.slice(0, 500) } : {}),
    prior_signatures: history.slice(-20).map((h) => `${h.stage}:${h.error_type}:${h.error_signature}`),
  },
};

const schema = JSON.parse(readFileSync('.sdlc/schemas/failure-packet.json', 'utf8'));
const shape = validate(schema, packet);
if (!shape.ok) {
  // This packet is built by a script, so an invalid one is a bug in this file, not an agent
  // misbehaving. Say which field and keep going — refusing to route a real failure because
  // the paperwork is wrong is how a pipeline stops with nothing running.
  process.stdout.write(`::warning::the failure packet does not match its own schema:\n${formatErrors(shape.errors)}\n`);
}
writeFileSync('failure-packet.json', `${JSON.stringify(packet, null, 2)}\n`);

// --- say it where someone is looking -----------------------------------------
const heading = {
  fix: `## ${stage} failed — sending it back with the error attached`,
  triage: `## ${stage} failed — an agent is reading the log`,
  'root-cause': `## ${stage} failed the same way twice — the diagnosis goes on trial`,
  escalate: `## ${stage} failed — stopping`,
}[decision.action];

const body = [
  heading,
  '',
  `**${errorType}** · signature \`${signature}\` · ${decision.occurrences === 1 ? 'first occurrence' : `${decision.occurrences} in a row`}` +
    (route.counter ? ` · ${route.counter} attempt ${entry.attempt}` : ''),
  '',
  summary,
  '',
  `_${decision.reason}_`,
  '',
  '<details><summary>Raw output the fixer is given (not a summary)</summary>',
  '',
  '```',
  excerpt,
  '```',
  '',
  '</details>',
  '',
  '<details><summary>Failure packet</summary>',
  '',
  '```json',
  JSON.stringify(packet, null, 2),
  '```',
  '',
  '</details>',
  runUrl ? `\n[Run log](${runUrl})` : '',
].filter((l) => l !== null).join('\n');

const target = pr ?? issue;
await gh([pr ? 'pr' : 'issue', 'comment', String(target), '--body', body]).catch((e) =>
  process.stdout.write(`::warning::could not post the failure packet: ${String(e.message).split('\n')[0]}\n`));

setOutput('action', decision.action);
setOutput('signature', signature);
setOutput('error_type', errorType);

// --- route -------------------------------------------------------------------
// A provider outage is a WAIT, not a stop.
//
// `agent-runtime` means the model run failed before producing anything, which is almost always
// a rate or quota limit — the code was never wrong. Retrying at once proves the limit is still
// there and burns an attempt; stopping for a person means that at 2am the pipeline is finished
// for the night over something that clears itself in twenty minutes.
//
// So it parks with a time, and the watchdog starts it again when that time passes. Backing off
// each round, because a limit that is still there after one cooldown will not have moved in
// another twenty minutes.
if (decision.action === 'escalate' && errorType === 'agent-runtime') {
  const tries = Number(before?.runtime_retries ?? 0);
  const maxRetries = Number(cfg.limits?.runtime_retries ?? 4);
  if (tries < maxRetries) {
    const minutes = Math.min(20 * 2 ** tries, 120);
    const at = new Date(Date.now() + minutes * 60_000);
    await updateLedger(repo, issue, (l) => {
      l.retry_after = at.toISOString();
      l.retry_stage = stage;
      l.parked_at = new Date().toISOString();
    }).catch(() => {});
    await markResume(repo, issue, stage === 'ci' || stage === 'gate' ? 'implement' : stage, 'retry')
      .catch(() => {});
    // needs-human frees the in-flight slot, which is what lets everything else keep moving
    // while this one waits. The watchdog is what brings it back.
    await advance(issue, 'needs-human', { agent: 'self-heal' });
    await gh(['issue', 'comment', String(issue), '--body',
      `Parked for ${minutes} minutes: the agent runtime failed before it produced anything, ` +
      'which is usually a rate or quota limit on the token rather than a problem with the ' +
      `code.\n\nThe watchdog starts \`${stage}\` again after ${at.toISOString()} — ` +
      `cooldown ${tries + 1} of ${maxRetries}. Nothing is lost; the slot is free for other ` +
      'issues meanwhile. `/sdlc retry ' + stage + '` starts it sooner.']).catch(() => {});
    process.stdout.write(`issue #${issue}: parked ${minutes}m waiting for the runtime\n`);
    setOutput('action', 'cooldown');
    process.exit(0);
  }
}

if (decision.action === 'escalate') {
  // Which stage to re-run when a person unblocks this. A crash resumes by running the SAME
  // stage again — nothing after it can start, because the thing before it never finished.
  // Without this, approving resumed from wherever the last GATE was, which on an issue whose
  // very first stage crashed is a stage that has never run.
  await markResume(repo, issue, stage === 'ci' || stage === 'gate' ? 'implement' : stage, 'retry');
  await advance(issue, 'needs-human', { agent: 'self-heal' });
  await gh(['issue', 'comment', String(issue), '--body',
    `Stopped at \`${stage}\`: ${decision.reason}.\n\n` +
    'Everything up to this point stands. `/sdlc retry implementing` clears the attempt ' +
    'counters and starts again; `/sdlc approve` after changing something by hand does the same ' +
    'without clearing them.']).catch(() => {});
  process.stdout.write(`issue #${issue}: escalated — ${decision.reason}\n`);
  process.exit(0);
}

// An agent decides what this failure means. Dispatched rather than decided here, because the
// log that answers it only exists once this run has finished.
if (decision.action === 'triage') {
  await handOff('sdlc-triage.yml', [
    '-f', `issue=${issue}`,
    ...(pr ? ['-f', `pr=${pr}`] : []),
    '-f', `stage=${stage}`,
    '-f', `failed_run=${process.env.RUN_ID ?? ''}`,
  ], { issue, pr, why: 'a stage failed and an agent has to read the log before anything acts' });
  process.stdout.write(`issue #${issue}: ${stage} failed (${errorType}) -> triage\n`);
  process.exit(0);
}

if (decision.action === 'root-cause') {
  await advance(issue, 'planning', { agent: 'self-heal' });
  const args = ['-f', `issue=${issue}`];
  if (pr) args.push('-f', `pr=${pr}`);
  args.push('-f', 'from=failure');
  await handOff('sdlc-root-cause.yml', args, {
    issue, pr, why: 'the same failure twice means the plan is wrong, not the code',
  });
  process.exit(0);
}

// fix: the same role that failed gets another go, with the raw error and its own work order.
// The attempt is consumed BEFORE the agent runs, so a stage that crashes on startup still
// burns budget and the loop terminates.
if (route.counter) {
  const spent = await exec('node', ['.sdlc/bin/sdlc-ctl.mjs', 'attempt',
    '--issue', String(issue), '--stage', route.counter, '--agent', 'self-heal'])
    .then(() => true)
    .catch((e) => {
      process.stdout.write(`${String(e.stdout || e.stderr || e.message).trim()}\n`);
      return false;
    });
  if (!spent) {
    // `attempt` exits non-zero exactly when the budget is gone, and it has already moved the
    // issue to budget-exceeded and said so. Nothing more to dispatch.
    setOutput('action', 'escalate');
    process.exit(0);
  }
}

const args = [];
if (route.workflow === 'sdlc-implement.yml') {
  await advance(issue, 'implementing', { agent: 'self-heal' });
  args.push('-f', `issue=${issue}`, '-f', `rework=${route.rework}`);
} else if (route.workflow === 'sdlc-review.yml' || route.workflow === 'sdlc-qa.yml') {
  args.push('-f', `pr=${pr}`);
} else {
  args.push('-f', `issue=${issue}`);
}

await handOff(route.workflow, args, {
  issue, pr, why: `the ${stage} stage failed and the fix loop is answering it`,
});
process.stdout.write(`issue #${issue}: ${stage} failed (${errorType}) -> ${decision.action} via ${route.workflow}\n`);
