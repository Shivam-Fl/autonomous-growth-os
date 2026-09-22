#!/usr/bin/env node
// The last thing the pipeline does on its own, and the only irreversible one.
//
// `gates.merge_approval` was written by both config generators and read by nothing: the
// pipeline stopped at qa-pass and a human merged, whatever the config said. A knob that
// changes nothing is worse than no knob, because people configure it and believe it.
//
// Everything before this point is recoverable — a bad plan is replanned, a bad branch is
// rebuilt, a wrong label is corrected. A merge is not. So nothing here is taken on trust from
// the ledger or from a label: every claim that justifies merging is re-established against the
// PR as it stands right now.

import { readFileSync, existsSync } from 'node:fs';
import { gh, ghJson, loadConfig, setOutput } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const pr = process.env.PR;
const issue = process.env.ISSUE;
const cfg = await loadConfig();

/**
 * Refuse, and make sure somebody can see that it happened.
 *
 * A refusal is an outcome rather than a crash, so this exits 0 — and on the AUTO-MERGE path
 * that made it invisible. `sdlc-qa`'s merge step just runs this script; nothing reads its
 * outputs, so a refusal failed no step, wrote no comment, and left an issue sitting at
 * `qa-pass` beside a green QA report with nothing anywhere saying why the PR was not merged.
 * That is the shape this whole framework keeps being bitten by: not a wrong answer, an answer
 * nobody is told.
 *
 * The comment belongs HERE rather than in the callers, because there are two of them today
 * and the one that reported (`/sdlc approve`) was not the one the pipeline actually uses. A
 * crash is still the caller's to report — this function does not run when the process dies.
 */
const stop = async (why, { quiet = false } = {}) => {
  process.stdout.write(`not merging: ${why}\n`);
  setOutput('merged', 'false');
  setOutput('reason', why);
  // `quiet` is for a GATE rather than a refusal. Holding for a human is the configured,
  // expected outcome on every single QA pass in that repo, and announcing it as "not merged"
  // would put a failure-shaped comment under every green report until people stopped reading
  // them — which is the same thing as not reporting at all.
  if (issue && !quiet) {
    await gh(['issue', 'comment', String(issue), '--body',
      `## Not merged\n\nEvery claim that justifies merging is re-established against the PR as ` +
      `it stands right now, and this one did not hold:\n\n> ${why}\n\n` +
      `PR #${pr} is untouched and nothing was lost. Address the above, then comment ` +
      '`/sdlc approve` to try again.']).catch(() => {});
  }
  process.exit(0);          // a refusal is an outcome, not a crash
};

// `merge_approval: true` means a PERSON decides, not that the pipeline may never merge.
//
// The distinction had no expression before: the gate stopped here and the only way past it
// was GitHub's own button, so `/sdlc approve` at qa-pass did something else entirely — it
// re-dispatched the implementer on code QA had just passed. An approval that does the wrong
// thing is worse than one that does nothing.
//
// HUMAN_APPROVED is set by run-command.mjs and nowhere else, after parseCommand has proved
// the author may do this. Every check below still runs: approving the gate says a person
// decided, not that the claims are waived.
const approved = process.env.HUMAN_APPROVED === 'true';
if (cfg.gates?.merge_approval !== false && !approved) {
  await stop('gates.merge_approval is on — a human merges this, or approves it with `/sdlc approve`', { quiet: true });
}

// --- 1. the ledger says it passed QA ----------------------------------------
const { ledger } = await import('./lib/state-io.js')
  .then((m) => m.readLedger(process.env.GITHUB_REPOSITORY, Number(issue)))
  .catch(() => ({ ledger: null }));
if (ledger?.state !== 'qa-pass') await stop(`the ledger says "${ledger?.state ?? 'nothing'}", not qa-pass`);

// --- 2. the QA report itself, not the label derived from it ------------------
// The label is a copy. The report is the claim, and it is what said the code was fit to ship.
const report = existsSync('qa-report.json') ? JSON.parse(readFileSync('qa-report.json', 'utf8')) : null;
if (report) {
  if (report.verdict !== 'pass') await stop(`the QA report's verdict is "${report.verdict}"`);
  const introduced = (report.bugs ?? []).filter((b) => b.introduced_by_pr !== false);
  if (introduced.length) await stop(`QA recorded ${introduced.length} bug(s) this PR introduced`);
}

// --- 3. the PR is still what QA tested, and still mergeable ------------------
const view = await ghJson(['pr', 'view', pr, '--json',
  'state,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,isDraft']);

if (view.state !== 'OPEN') await stop(`the PR is ${view.state}`);
if (view.isDraft) await stop('the PR is a draft');
// A conflict is the one refusal with an obvious next step, so it gets one instead of a
// comment. It is also the refusal that is about to become common: an epic split into eight
// issues where the first unblocks four means four branches cut from the same base, and the
// second one to merge meets the first one's package.json.
//
// Refusing here left the issue at `qa-pass` with a green report and nothing that would ever
// touch it again — the pipeline stopped, wearing the face of a pipeline waiting. Resolving a
// conflict is mostly mechanical and the implementer already has the branch; when it is not
// mechanical, it says so and stops, which is the same escalation a human would reach anyway.
if (view.mergeable === 'CONFLICTING') {
  await gh(['pr', 'comment', String(pr), '--body',
    `## This branch conflicts with \`${cfg.base_branch || 'the base branch'}\`\n\n` +
    'Something else merged while this was in flight. Everything about this PR is still ' +
    'good — QA passed it, and the conflict is with the base rather than with the work.\n\n' +
    'Sending it back to the implementer to merge the base in and resolve, on the same ' +
    'branch. The chain re-runs from there, because the head changes and QA\'s verdict is ' +
    'about the commit it tested.\n\nMerge the base branch in and resolve the conflicts. Do ' +
    'not redesign anything and do not take the base\'s side by default — the whole point is ' +
    'that both changes were wanted.']).catch(() => {});
  await advance(issue, 'implementing', { agent: 'release' }).catch(() => {});
  await exec('node', ['.sdlc/bin/dispatch.mjs', 'sdlc-implement.yml',
    '-f', `issue=${issue}`, '-f', 'rework=merge-conflict']);
  setOutput('merged', 'false');
  setOutput('reason', 'conflicts with the base — sent back to resolve');
  process.stdout.write(`issue #${issue}: PR #${pr} conflicts -> implementer to resolve\n`);
  process.exit(0);
}

const tested = ledger?.artifacts?.qa_sha ?? report?.env?.commit;
if (tested && !String(view.headRefOid).startsWith(String(tested).slice(0, 7))) {
  await stop(`QA tested ${String(tested).slice(0, 7)} but the PR head is now ${view.headRefOid.slice(0, 7)}`);
}

// --- 4. the checks are green NOW, not when the gate looked ------------------
const failing = (view.statusCheckRollup ?? []).filter((c) => {
  const s = String(c.conclusion ?? c.state ?? '').toUpperCase();
  return ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ERROR', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s);
});
if (failing.length) await stop(`${failing.length} check(s) are red: ${failing.map((c) => c.name ?? c.context).join(', ')}`);

const unfinished = (view.statusCheckRollup ?? []).filter((c) => {
  const done = c.status !== undefined
    ? c.status === 'COMPLETED' && c.conclusion != null
    : ['SUCCESS', 'FAILURE', 'ERROR'].includes(String(c.state ?? '').toUpperCase());
  return !done;
});
if (unfinished.length) await stop(`${unfinished.length} check(s) have not finished`);

// --- 5. it still does not touch what a human reserved -----------------------
// Checked at the gate too. Re-checked here because this is the step that cannot be undone,
// and because anything could have been pushed between the two.
await exec('node', ['.sdlc/bin/check-diff-forbidden.mjs'], { env: { ...process.env, PR: pr } })
  .catch(async (e) => await stop(`the diff touches reserved paths — ${String(e.stdout || e.message).split('\n')[1] ?? ''}`));

// --- merge ------------------------------------------------------------------
const method = cfg.release?.merge_method ?? 'squash';
await gh(['pr', 'merge', pr, `--${method}`, '--delete-branch']);
setOutput('merged', 'true');
process.stdout.write(`merged PR #${pr} (${method})${approved ? ', approved by a human,' : ''} — ` +
  `every pre-merge claim re-established against ${view.headRefOid.slice(0, 7)}\n`);

// --- everything that follows a merge ----------------------------------------
//
// `sdlc-loop` has a `merged` job on `pull_request: [closed]` that advances the ledger, writes
// release notes and wakes whatever was blocked on this issue. It fires when a PERSON merges.
// It does not fire here: this merge is made with GITHUB_TOKEN, and GitHub does not trigger a
// workflow from an event its own token caused. That is the rule this whole framework is built
// around, and the one place it was forgotten is the step that cannot be undone.
//
// With `gates.merge_approval: false` — the pipeline merging its own work, which is the entire
// point of that setting — the PR merged and then nothing happened. The ledger never reached
// `merged`, no release notes were written, and every issue depending on this one stayed
// `sdlc:blocked` forever. On a project split into eight issues where the first unblocks four,
// that is the whole project stopping after one ticket, looking exactly like a project still
// being worked on.
//
// So it is called directly, in this process, on this runner. No event required.
await exec('node', ['.sdlc/bin/on-merge.mjs'], { env: { ...process.env, PR: String(pr) } })
  .then((r) => process.stdout.write(r.stdout))
  .catch(async (e) => {
    // The merge already happened and cannot be taken back, so this is not a failure of the
    // merge — it is work left undone, and it has to be visible rather than swallowed.
    process.stdout.write(`::warning::merged, but the follow-up failed: ${String(e.stdout || e.message).slice(-800)}\n`);
    await gh(['issue', 'comment', String(issue), '--body',
      `PR #${pr} merged, but the work that follows a merge did not finish.\n\n` +
      'The ledger may not say `merged`, the release notes may be missing, and anything ' +
      'depending on this issue may still be blocked — a blocked issue looks exactly like an ' +
      'open one, so this needs a look.\n\n' +
      'Re-run `.sdlc/bin/on-merge.mjs` with `PR=' + pr + '`, or comment `/sdlc approve` on each ' +
      'blocked issue to start it by hand.']).catch(() => {});
  });
