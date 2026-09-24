#!/usr/bin/env node
// Brings a PR's branch up to date with its base before anything reads the diff.
//
// A review reads `base...head`. If base has moved since the branch was cut, that diff contains
// every change base gained — as deletions and reversions, attributed to this branch.
//
// That is not hypothetical. The framework was updated on `main` while an agent's PR was open,
// and the next review found "~900 lines of pipeline infrastructure change including a policy
// flip, hidden inside a feature PR" and blocked on scope. The finding was exactly right about
// what the diff showed, and the branch had not touched any of those files. The implementer was
// then dispatched to answer a finding it could only have satisfied by deleting work someone
// else had done.
//
// Cheap to prevent, expensive to diagnose: a stale base makes an honest reviewer produce a
// confident false blocker, and the agent answering it has no way to tell.
//
// And the update is a NEW HEAD. It is committed with GITHUB_TOKEN, which starts no workflow,
// so the commit review read and QA tested — and merge-pr then merged — was one no CI had ever
// run on; merge-pr read an empty rollup as green. So an updated head is not handed on until CI
// has passed on it: this starts ci-verify for it and waits, inside the job, rather than sending
// review or QA back through the gate on every move of the base. A branch already current is held
// to the same rule (waitForCi): the head a previous run updated may never have finished CI.
//
// Outputs: updated (true | false | conflict), sha (the head the stage should use), stop (true
// when the stage must end here — the branch went back to the implementer, or its red CI to the
// self-heal path), issue.
import { gh, ghJson, setOutput, loadConfig, die } from './lib/actions.js';
import { classifyRollup, expectsCi, checkName } from './lib/checks.js';
import { dispatchStage } from './lib/route-io.js';
import { resolveStage } from './lib/flow-graph.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pr = process.env.PR;
if (!pr) { setOutput('updated', 'false'); setOutput('stop', 'false'); process.exit(0); }
const repo = process.env.GITHUB_REPOSITORY;
const cfg = await loadConfig();

const done = (updated, sha, stop = false) => {
  setOutput('updated', updated);
  setOutput('sha', sha ?? '');
  setOutput('stop', String(stop));
  process.exit(0);
};

// A check that could not run must not look like a check that passed.
//
// These bails used to be quiet — `updated=unknown` and the stage carried on against a base
// that might have moved, which is the exact failure this exists to prevent. Once more, then
// the failure path: a stage has nothing honest to run on until someone knows.
const twice = async (what, fn) => {
  try { return await fn(); } catch (e) {
    process.stdout.write(`::warning::${what} failed: ${String(e.message).split('\n')[0]} — trying once more\n`);
  }
  await sleep(5000);
  return fn().catch((e) => die(`${what} failed twice: ${String(e.message).split('\n')[0]} — whether this branch is ` +
    'current with its base is unknown, and nothing should read or test a head nobody checked'));
};

const info = await twice(`reading PR #${pr}`,
  () => ghJson(['pr', 'view', pr, '--json', 'headRefName,baseRefName,state,headRefOid,body']));
// Said before anything below can fail: this runs before the stage resolves its issue, so it is
// the only step that can name the issue a failure from here has to be reported on.
const issue = process.env.ISSUE || (info.body ?? '').match(/(?:closes|fixes|resolves)\s+#(\d+)/i)?.[1];
setOutput('issue', issue ?? '');
if (info.state !== 'OPEN') {
  process.stdout.write(`PR #${pr} is ${info.state}, not open — nothing to update\n`);
  done('false', info.headRefOid);
}

// The branch goes back to the implementer, and the stage that called this ends here.
const sendBack = async (updated, sha, rework, why) => {
  if (!issue) die(`${why}, and PR #${pr} names no issue to send it back on`);
  process.stdout.write(`${why} — back to the implementer (${rework})\n`);
  await dispatchStage({ repo, issue, agent: 'sync', why, target: resolveStage('implement', { issue, pr, rework }) });
  done(updated, sha, true);
};

// A red head is the gate's failure whichever stage found it, so it goes where the gate's does:
// dispatch-fix records it, keeps the failure packet on the ledger bound to this branch head, and
// hands it on — the triage, root-cause on a repeat, a person at the bound. Sent straight to the
// implementer as `fix:ci-red`, it arrived with no packet, told to fix CI with nothing to read.
const redCi = async (updated, sha, failing, why) => {
  if (!issue) die(`${why}, and PR #${pr} names no issue to send it back on`);
  process.stdout.write(`${why} — handed to the self-heal path\n`);
  await exec('node', ['.sdlc/bin/dispatch-fix.mjs'], {
    env: { ...process.env, STAGE: 'ci', PR: String(pr), ISSUE: String(issue), FAILED_CHECKS: failing.join(',') },
  }).then((r) => process.stdout.write(r.stdout))
    .catch((e) => die(`${why}, and the failure could not be handed on: ${String(e.stderr || e.message).trim().split('\n').pop()}`));
  done(updated, sha, true);
};

const ensureCi = (head) => exec('node', ['.sdlc/bin/ensure-ci.mjs'], { env: { ...process.env, PR: pr } })
  .then((r) => process.stdout.write(r.stdout))
  .catch((e) => die(`could not start CI on ${head.slice(0, 7)}: ${String(e.stderr || e.message).trim().split('\n').pop()}`));

/**
 * Hand `head` on once CI has passed on it; send it back when CI is red; wait in between, and
 * start CI when nothing gating has reported (`started` says it already was).
 */
async function waitForCi(head, updated, { started = false } = {}) {
  const at = `${head.slice(0, 7)}${updated === 'true' ? ', the head the base update made' : ''}`;
  const minutes = Number(cfg.verify?.wait_minutes ?? 30);
  const deadline = Date.now() + minutes * 60_000;
  let last = '';
  for (;;) {
    const now = await ghJson(['pr', 'view', pr, '--json', 'headRefOid,statusCheckRollup']).catch(() => null);
    if (now && now.headRefOid !== head) {
      // Somebody pushed while this waited. Their push has its own chain; this stage's is over.
      process.stdout.write(`the head moved again (${now.headRefOid.slice(0, 7)}) while CI ran on ${head.slice(0, 7)} — ` +
        'whatever pushed it owns what runs next\n');
      done(updated, now.headRefOid, true);
    }
    if (now) {
      const c = classifyRollup(now.statusCheckRollup, cfg);
      if (c.failing.length) await redCi(updated, head, c.failing.map(checkName), `CI is red on ${at}: ${c.failing.map(checkName).join(', ')}`);
      if (!c.missing.length && !c.pending.length) {
        process.stdout.write(`CI passed on ${head.slice(0, 7)}: ${c.passing.map(checkName).join(', ')}\n`);
        done(updated, head);
      }
      if (c.missing.length && !started) { started = true; await ensureCi(head); }
      const summary = [...c.missing, ...c.pending.map(checkName)].join(', ');
      if (summary !== last) { process.stdout.write(`waiting on ${summary}\n`); last = summary; }
    }
    if (Date.now() >= deadline) break;
    await sleep(15_000);
  }
  die(`CI did not finish on ${at} within ${minutes} minutes` +
    (cfg.verify?.mode === 'existing'
      ? ' — verify.mode is "existing", and this repo\'s own CI is not started by a commit GitHub\'s token made'
      : ''));
}

const cmp = await twice(`comparing ${info.baseRefName}...${info.headRefName}`,
  () => ghJson(['api', `repos/${repo}/compare/${info.baseRefName}...${info.headRefName}`]));
if (!cmp.behind_by) {
  process.stdout.write(`PR #${pr} is up to date with ${info.baseRefName}\n`);
  // Current is not verified. A review retried after the last run's CI wait ran out found the
  // branch current and handed on a head whose CI never finished — or went red afterwards, which
  // nothing reported, because ci-verify dispatches nothing. So a current head is held to the
  // same rule as an updated one: red goes back, missing is started, pending is waited on.
  if (!expectsCi(cfg)) done('false', info.headRefOid);
  await waitForCi(info.headRefOid, 'false');
}

process.stdout.write(`PR #${pr} is ${cmp.behind_by} commit(s) behind ${info.baseRefName} — updating\n`);
let failure = null;
for (let i = 0; i < 2; i++) {
  failure = await gh(['api', `repos/${repo}/pulls/${pr}/update-branch`, '-X', 'PUT']).then(() => null, (e) => e);
  if (!failure || /conflict/i.test(String(failure.stderr || failure.message))) break;
  await sleep(5000);
}
if (failure) {
  const detail = String(failure.stderr || failure.message).split('\n')[0];
  // A conflict is a real finding and belongs to the implementer, not to a reviewer reading a
  // diff that cannot be trusted, nor to a QA run paid for on a branch that cannot merge. It
  // used to be announced in a comment and then read by nothing.
  if (/conflict/i.test(detail)) {
    await gh(['pr', 'comment', pr, '--body',
      `This branch is ${cmp.behind_by} commit(s) behind \`${info.baseRefName}\` and cannot be ` +
      'updated automatically — it conflicts.\n\nWhatever read this diff next would see every change ' +
      'the base gained as a deletion on this branch, so nothing reads it: it goes back to the ' +
      'implementer to merge the base in and resolve.']).catch(() => {});
    await sendBack('conflict', info.headRefOid, 'merge-conflict', `PR #${pr} conflicts with ${info.baseRefName}`);
  }
  die(`could not update PR #${pr} from ${info.baseRefName}: ${detail}`);
}

// update-branch answers 202 and merges in the background: the new head appears a moment later.
let head = info.headRefOid;
for (let i = 0; head === info.headRefOid && i < 24; i++) {
  if (i) await sleep(5000);
  head = await ghJson(['pr', 'view', pr, '--json', 'headRefOid']).then((v) => v.headRefOid, () => head);
}
if (head === info.headRefOid) die(`GitHub accepted the update of PR #${pr} and the head never moved from ${head.slice(0, 7)}`);
// The checkout happened before this step, so a working tree is still at the pre-update head.
// Server-side reads — `gh pr diff`, the PR's file list — are current; files on disk are one
// merge behind. Said out loud rather than reset: a hard reset here would fight whatever ref the
// workflow chose to check out, and every agent that judges a diff reads it from `gh pr diff`.
process.stdout.write(`branch updated to ${head.slice(0, 7)}\n` +
  '::notice::the local checkout predates this update — read the diff with `gh pr diff`, which is ' +
  'server-side and current\n');

if (!expectsCi(cfg)) {
  process.stdout.write('verify.mode is "none" and nothing is required — no CI to wait for\n');
  done('true', head);
}

// A GITHUB_TOKEN commit starts no workflow, so nothing has started CI on this head yet.
await ensureCi(head);
await waitForCi(head, 'true', { started: true });
