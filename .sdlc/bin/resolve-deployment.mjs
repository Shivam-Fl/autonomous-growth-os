#!/usr/bin/env node
// Works out what QA should test.
//
// QA is started by the route only: a dispatched run naming the PR, or, for an audit, the issue.
// It also used to start on every `deployment_status`, outside the route — a preview finishing
// its deploy ran QA on a PR review had not approved yet, and a pass there went on to merge.
//
// Emits: pr, issue, url, sha, branch, mode, audit, skip, not_applicable, open_bugs, previous_output

import { readFileSync, writeFileSync } from 'node:fs';
import { gh, ghJson, setOutput, loadConfig, die } from './lib/actions.js';
import { readLedger } from './lib/state-io.js';
import { advance } from './lib/advance.js';
import { markResume } from './lib/route-io.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The report the judge rejected since the last recorded result, handed back with why. validate
// kept it on the ledger and nothing read it, so the rerun started from nothing and a second
// identical rejection went to root-cause, to revise a work order over a formatting mistake.
// Uploaded with the work order (sdlc-qa's prepare job) — on an audit, which has none, on its own.
function handBackRejected(ledger) {
  const rejected = ledger?.rejected_artifacts?.['qa-report'];
  const back = Boolean(rejected && String(rejected.at ?? '') > String(ledger?.qa?.at ?? ''));
  if (back) {
    writeFileSync('previous-output.json', JSON.stringify({ failed_validation_with: rejected.errors ?? [], output: rejected.text }, null, 2));
    process.stdout.write('the last QA report was rejected — handing it back as previous-output.json\n');
  }
  setOutput('previous_output', String(back));
}

const ev = process.env.GITHUB_EVENT_PATH
  ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  : {};
const cfg = await loadConfig();
const mode = cfg.env?.mode ?? 'preview';
const repo = process.env.GITHUB_REPOSITORY;

// workflow_dispatch inputs arrive in the EVENT PAYLOAD, not as INPUT_* env vars — those are
// only set for composite actions. Reading the env alone silently ignored `-f pr=2`, and the
// resolver then failed with "could not resolve a PR" while the answer was sitting in the
// payload. Env is still honoured so a step can override explicitly.
const pr = process.env.INPUT_PR || ev.inputs?.pr || null;
let url = process.env.INPUT_URL || ev.inputs?.url || null;

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
  const base = cfg.base_branch
    || (await ghJson(['api', `repos/${repo}`]).then((r) => r.default_branch).catch(() => 'main'));
  const head = await ghJson(['api', `repos/${repo}/commits/${base}`]).then((c) => c.sha).catch(() => null);
  const target = mode === 'none' ? null
    : url || (mode === 'compose' ? (cfg.env?.base_url ?? 'http://localhost:3000') : cfg.env?.audit_url);

  // Said on the issue and handed to a person. This printed the reason into a log and skipped,
  // so the audit sat in QA with nothing running and nothing saying why.
  if (!target) {
    const why = mode === 'none'
      ? 'env.mode is "none": this repository has no runnable surface, so there is nothing for a ' +
        'browser audit to drive.'
      : 'This issue is routed as an audit, which tests what is already deployed rather than a ' +
        'pull request — and env.mode is "' + mode + '", so there is no preview of the default ' +
        'branch to drive.\n\n' +
        'Set `env.audit_url` in .sdlc/config.yml to the environment an audit should run against. ' +
        'It is not inferred, because the obvious inference is production and that is the one ' +
        'place QA must never go.';
    process.stdout.write(`${why}\n`);
    await gh(['issue', 'comment', String(auditIssue), '--body',
      `## QA could not run this audit\n\n${why}\n\nComment \`/sdlc approve\` to run it once that is settled.`]);
    await markResume(repo, auditIssue, 'qa', 'retry');
    await advance(auditIssue, 'needs-human', { agent: 'qa' });
    setOutput('skip', 'true');
    setOutput('pr', '');
    process.exit(0);
  }
  if (!head) die(`could not resolve the head commit of ${base} — an audit has to say what it tested`);
  handBackRejected((await readLedger(repo, Number(auditIssue)).catch(() => ({ ledger: null }))).ledger);

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

if (!pr) die('QA was started with neither a PR nor an issue — there is nothing to attribute results to');

const detail = await ghJson(['pr', 'view', String(pr), '--json', 'body,number,headRefOid,headRefName']);
// The checkout ref comes from here. An empty one silently means "default branch": exactly the
// bug that made QA judge the wrong commit.
const sha = detail.headRefOid || die(`could not determine the head commit of PR #${pr}`);
const issue = (detail.body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1];
if (!issue) {
  // NOT an error. A dispatch can name any PR in the repo — a human one, dependabot's, the PR
  // that installed this framework. A PR with no work order is simply not the pipeline's
  // business, and failing here would put a red X on everyone else's work.
  process.stdout.write(
    `PR #${pr} closes no issue, so it has no work order and was not produced by this ` +
    'pipeline. Skipping — this is not a failure.\n');
  setOutput('skip', 'true');
  setOutput('pr', '');
  process.exit(0);
}

// env.mode none: nothing to drive, and still a QA slot to finish. Skipping it left a routed
// ticket in QA forever, with nothing able to record a verdict; prepare records it for what it
// is (post-qa-report NOT_APPLICABLE), and the merge still re-checks everything else.
const notApplicable = mode === 'none';
// A merge-only re-entry tests nothing either, so neither has a target to wait for.
const mergeOnly = (process.env.MERGE_ONLY || ev.inputs?.merge_only) === 'true';
if (!url && !mergeOnly && !notApplicable) url = mode === 'compose' ? (cfg.env?.base_url ?? 'http://localhost:3000') : await previewOf(sha);

// The bugs the last round filed as introduced by this PR. QA has no memory by design, so a bug
// it filed and the implementer "fixed" was simply never mentioned again, which reads as fixed.
// It is told which, and its report is refused without a retest entry for each one.
const { ledger } = await readLedger(repo, Number(issue));
setOutput('open_bugs', (ledger?.qa_open_bugs ?? []).map((b) => `${b.id} (${b.title})`).join('; '));

handBackRejected(ledger);

setOutput('pr', String(pr));
setOutput('issue', issue);
setOutput('url', url ?? '');
setOutput('sha', sha);
setOutput('branch', detail.headRefName ?? '');
setOutput('mode', mode);
setOutput('audit', 'false');
setOutput('not_applicable', String(notApplicable));
setOutput('skip', 'false');

/**
 * The preview of THIS commit, from the deployments GitHub records for it.
 *
 * The URL used to come only from the deployment_status event, and a routed run is a dispatch
 * that carries none — so preview-mode QA was handed the string "null" to drive. The deployer
 * records a deployment per commit; the newest non-production one whose latest status is a
 * success is the preview of exactly this head. It may still be building when QA starts, so
 * this waits for it, bounded, and a head with no preview fails the step by name.
 */
async function previewOf(head) {
  const minutes = Number(cfg.env?.deploy_wait_minutes ?? 20);
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    // Newest first, as the API lists them.
    for (const d of await ghJson(['api', `repos/${repo}/deployments?sha=${head}&per_page=30`])) {
      // Never production, whatever the deployer calls it: QA places orders and probes permissions.
      if (d.production_environment || /^prod(uction)?$/i.test(d.environment ?? '')) continue;
      const [latest] = await ghJson(['api', `repos/${repo}/deployments/${d.id}/statuses?per_page=1`]);
      const at = latest?.state === 'success' && (latest.environment_url || latest.target_url);
      if (at) {
        process.stdout.write(`preview of ${head.slice(0, 7)}: ${at} (deployment ${d.id}, ${d.environment})\n`);
        return at;
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(30_000);
  }
  return die(`no successful non-production deployment of ${head.slice(0, 7)} within ${minutes} minutes — ` +
    'env.mode is "preview", so QA drives the deployment of the commit under test and there is none. ' +
    'Check the deployer ran for this commit, or raise env.deploy_wait_minutes');
}
