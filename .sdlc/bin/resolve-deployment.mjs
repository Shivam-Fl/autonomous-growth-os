#!/usr/bin/env node
// Works out what QA should test, from whichever event triggered it.
//
// Three shapes reach this:
//   deployment_status  — preview mode. A real deployment finished and carries its own URL.
//   workflow_run       — compose mode. CI went green; there is no deployment, so QA boots
//                        the app itself and drives the URL from config.
//   workflow_dispatch  — manual, url optional.
//
// Emits: pr, issue, url, sha, mode

import { readFileSync } from 'node:fs';
import { ghJson, setOutput, loadConfig, die } from './lib/actions.js';

const ev = process.env.GITHUB_EVENT_PATH
  ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  : {};
const eventName = process.env.GITHUB_EVENT_NAME ?? '';
const cfg = await loadConfig();
const mode = cfg.env?.mode ?? 'preview';

// A library has nothing to drive. Skipping is the correct outcome, not a failure.
// A deployment_status fires for every PR in the repo, including ones no agent ever touched.
// In compose mode there is nothing to do with a deployment at all.
if (eventName === 'deployment_status' && mode === 'compose') {
  process.stdout.write('env.mode is "compose" — a deployment is not what QA tests here. Skipping.\n');
  setOutput('skip', 'true');
  setOutput('pr', '');
  process.exit(0);
}

if (mode === 'none') {
  process.stdout.write('env.mode is "none" — this repo has no runnable surface, so browser QA does not apply.\n');
  setOutput('skip', 'true');
  setOutput('pr', '');
  process.exit(0);
}

// workflow_dispatch inputs arrive in the EVENT PAYLOAD, not as INPUT_* env vars — those are
// only set for composite actions. Reading the env alone silently ignored `-f pr=2`, and the
// resolver then failed with "could not resolve a PR" while the answer was sitting in the
// payload. Env is still honoured so a step can override explicitly.
let pr = process.env.INPUT_PR || ev.inputs?.pr || null;
let url = process.env.INPUT_URL || ev.inputs?.url || null;
let sha = null;

// --- the audit: a QA run with no PR ------------------------------------------
//
// "Scan the checkout flow, file what you find, fix nothing" used to buy a planner, an
// implementer and a pull request nobody asked for, because the chain was the code. Routed as
// `["qa"]` there is no PR at all: QA drives what is already deployed and every finding becomes
// its own issue.
//
// The target has to be stated, never inferred. In compose mode it is the app booted from the
// default branch, which is unambiguous. In preview mode there is no preview of main, and the
// obvious guess — production — is the one place QA must never go, so config has to name it
// and the allowlist still has the last word.
const auditIssue = process.env.INPUT_ISSUE || ev.inputs?.issue || null;
if (!pr && auditIssue) {
  const repo = process.env.GITHUB_REPOSITORY;
  const base = cfg.base_branch
    || (await ghJson(['api', `repos/${repo}`]).then((r) => r.default_branch).catch(() => 'main'));
  const head = await ghJson(['api', `repos/${repo}/commits/${base}`]).then((c) => c.sha).catch(() => null);
  const target = url || (mode === 'compose' ? (cfg.env?.base_url ?? 'http://localhost:3000') : cfg.env?.audit_url);

  if (!target) {
    process.stdout.write(
      'This issue is routed as an audit, which tests what is already deployed rather than a ' +
      'pull request — and env.mode is "' + mode + '", so there is no preview of the default ' +
      'branch to drive.\n' +
      'Set `env.audit_url` in .sdlc/config.yml to the environment an audit should run against. ' +
      'It is not inferred, because the obvious inference is production and that is the one ' +
      'place QA must never go.\n');
    setOutput('skip', 'true');
    setOutput('pr', '');
    process.exit(0);
  }
  if (!head) die(`could not resolve the head commit of ${base} — an audit has to say what it tested`);

  setOutput('pr', '');
  setOutput('issue', String(auditIssue));
  setOutput('url', target);
  setOutput('sha', head);
  setOutput('branch', base);
  setOutput('mode', mode);
  setOutput('audit', 'true');
  setOutput('skip', 'false');
  process.stdout.write(`audit: issue #${auditIssue} against ${target} @ ${head.slice(0, 8)} (${base})\n`);
  process.exit(0);
}

if (eventName === 'deployment_status') {
  url = ev.deployment_status?.environment_url || ev.deployment_status?.target_url;
  sha = ev.deployment?.sha;
  // Skip, not fail. Deployments fire for every environment in a repo, including ones this
  // pipeline knows nothing about; a red QA run on somebody else's deployment is noise that
  // teaches people to ignore red runs.
  if (!url) {
    process.stdout.write('deployment carried no environment_url — nothing for QA to drive, skipping\n');
    setOutput('skip', 'true');
    process.exit(0);
  }
} else if (eventName === 'workflow_run') {
  sha = ev.workflow_run?.head_sha;
  pr = pr ?? ev.workflow_run?.pull_requests?.[0]?.number;
  // In compose mode the app has not booted yet; the URL is whatever config says we will serve on.
  if (mode !== 'compose') {
    process.stdout.write('env.mode is "' + mode + '" but this was a workflow_run — ' +
      'QA waits for a deployment in preview mode. Nothing to do.\n');
    setOutput('skip', 'true');
    process.exit(0);
  }
}

if (mode === 'compose' && !url) {
  url = cfg.env?.base_url ?? 'http://localhost:3000';
}

// `workflow_run` does not always populate pull_requests (notably for forks), so fall back
// to resolving the PR from the commit.
if (!pr && sha) {
  const prs = await ghJson(['api', `repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}/pulls`]);
  pr = prs[0]?.number;
}
if (!pr) die('could not resolve a PR for this event — QA has nothing to attribute results to');

const detail = await ghJson(['pr', 'view', String(pr), '--json', 'body,number,headRefOid,headRefName']);

// A workflow_dispatch carries no head sha — there is no workflow_run or deployment to read
// one from — so resolve it from the PR itself. Without this the checkout ref is empty, which
// silently means "default branch": exactly the bug that made QA judge the wrong commit.
if (!sha) sha = detail.headRefOid;
if (!sha) die(`could not determine the head commit of PR #${pr}`);
const issue = (detail.body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1];
if (!issue) {
  // NOT an error. Deployments and CI fire for every PR in the repo — human ones, dependabot
  // ones, the PR that installed this framework. A PR with no work order is simply not the
  // pipeline's business, and failing here would put a red X on everyone else's work.
  process.stdout.write(
    `PR #${pr} closes no issue, so it has no work order and was not produced by this ` +
    'pipeline. Skipping — this is not a failure.\n');
  setOutput('skip', 'true');
  setOutput('pr', '');
  process.exit(0);
}

setOutput('pr', String(pr));
setOutput('issue', issue);
setOutput('url', url);
setOutput('sha', sha);
setOutput('branch', detail.headRefName ?? '');
setOutput('mode', mode);
setOutput('audit', 'false');
setOutput('skip', 'false');
