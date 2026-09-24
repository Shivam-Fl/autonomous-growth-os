#!/usr/bin/env node
// The last thing the pipeline does on its own, and the only irreversible one.
//
// `gates.merge_approval` was written by both config generators and read by nothing: the
// pipeline stopped at qa-pass and a human merged, whatever the config said. A knob that
// changes nothing is worse than no knob, because people configure it and believe it.
//
// Everything before this point is recoverable — a bad plan is replanned, a bad branch is
// rebuilt, a wrong label is corrected. A merge is not. So nothing here is taken on trust from
// a label or from a file on the runner: every claim that justifies merging is re-established
// against the PR as it stands right now, and against what the pipeline itself recorded.
//
// One caller, the judge job of sdlc-qa — `/sdlc approve` dispatches its merge-only run rather
// than running this beside it — and it has no QA report on disk in a form anyone may trust, so
// it reads none. What QA found is on the ledger, written by post-qa-report from the commit
// prepare resolved.

import { gh, ghJson, loadConfig, setOutput, isPipelineAuthor, isTrustedAuthor } from './lib/actions.js';
import { readLedger, updateLedger } from './lib/state-io.js';
import { mergeApproval } from './lib/ledger.js';
import { readWorkOrder } from './lib/work-order.js';
import { classifyRollup, checkName } from './lib/checks.js';
import { missingCriteria } from './lib/qa-consistency.js';
import { dispatchStage } from './lib/route-io.js';
import { resolveStage, retryHint } from './lib/flow-graph.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const pr = process.env.PR;
const issue = process.env.ISSUE;
const repo = process.env.GITHUB_REPOSITORY;
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
 * The comment belongs HERE rather than in the callers, because there were two of them and the
 * one that reported (`/sdlc approve`) was not the one the pipeline actually uses. A crash is
 * the judge's failure step's to report — this function does not run when the process dies.
 */
const stop = async (why, { quiet = false, again = '`/sdlc approve`' } = {}) => {
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
      `${again} to try again.`]).catch(() => {});
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
// The approval is read off the ledger, where run-command records it after parseCommand has
// proved the author may do this, bound to the QA result approved (lib/ledger.js). It was the env
// var HUMAN_APPROVED, which only reached this script when run-command ran it inline — outside
// the merge-<pr> group this step runs in. Every check below still runs: approving the gate says
// a person decided, not that the claims are waived.
const { ledger } = await readLedger(repo, Number(issue)).catch(() => ({ ledger: null }));
const approved = Boolean(mergeApproval(ledger));
if (cfg.gates?.merge_approval !== false && !approved) {
  await stop('gates.merge_approval is on — a human merges this, or approves it with `/sdlc approve`', { quiet: true });
}

// --- 1. the ledger says it passed QA, and nobody has said stop ---------------
// `/sdlc stop`, or a person closing the PR, is the owner's word — and this step is the one
// place that word cannot be taken back afterwards.
//
// The way back is QA again, and the refusal says so. It said `/sdlc approve`, which from a stop
// (needs-human, no resume point) cannot reach a merge: only a QA run may record qa-pass.
if (ledger?.halted) {
  await stop(`halted by @${ledger.halted.by}${ledger.halted.why ? ` — ${ledger.halted.why}` : ''}. ` +
    'Nothing merges until a person resumes it', { again: retryHint('qa') });
}
if (ledger?.state !== 'qa-pass') await stop(`the ledger says "${ledger?.state ?? 'nothing'}", not qa-pass`);

// --- 2. what QA recorded, not a file on this runner --------------------------
// The label is a copy, and so is a report on disk: absent on the approve path, writable by the
// code under test on the QA runner. post-qa-report records the verdict, the bug count and the
// commit it was about, from prepare's own resolution of the head.
const qa = ledger.qa;
if (!qa?.sha) {
  await stop('no QA result is recorded on the ledger — nothing says which commit passed, so this ' +
    'needs a QA run before it can merge');
}
// Only while the config says there is nothing to run: a repo that later gains a surface must
// not merge on a verdict that meant "there was no surface".
const notApplicable = qa.verdict === 'not-applicable' && cfg.env?.mode === 'none';
if (qa.verdict !== 'pass' && !notApplicable) await stop(`QA's recorded verdict is "${qa.verdict}"`);
if (Number(qa.introduced_bugs ?? 0) > 0) await stop(`QA recorded ${qa.introduced_bugs} bug(s) this PR introduced`);

// --- 3. the issue is still wanted, and this PR still builds its current plan ---
const { state: issueState } = await ghJson(['issue', 'view', String(issue), '--json', 'state']);
if (issueState !== 'OPEN') {
  await stop(`issue #${issue} is ${String(issueState).toLowerCase()} — whoever closed it decided this is not wanted`);
}

const wo = ledger.work_order ?? await readWorkOrder(repo, issue, cfg);
if (!wo) await stop('no work order is on record for this issue, so there is nothing to say what this PR was meant to do');
// A replan asked for, or posted, while the old PR was in QA left it merging the old plan.
if (ledger.implemented_version !== wo.version) {
  await stop(`the PR implements work order v${ledger.implemented_version ?? '?'} and the current one is v${wo.version}`);
}
if (ledger.replan_requested_at
    && Date.parse(ledger.replan_requested_at) > (Date.parse(ledger.work_order_posted_at ?? '') || 0)) {
  await stop(`a replan was requested at ${ledger.replan_requested_at}, after work order v${wo.version} — ` +
    'this PR is the plan being replaced');
}
// Every criterion of the plan it builds, not the ones QA happened to roll up.
if (!notApplicable) {
  const untested = missingCriteria(qa.ac_ids, wo);
  if (untested.length) await stop(`QA recorded no verdict on ${untested.join(', ')} of work order v${wo.version}`);
}

// --- 4. the PR is still what QA tested, and a person has not objected --------
const view = await ghJson(['pr', 'view', pr, '--json',
  'state,mergeable,mergeStateStatus,headRefOid,statusCheckRollup,isDraft,author,baseRefName,reviews']);

if (view.state !== 'OPEN') await stop(`the PR is ${view.state}`);
if (view.isDraft) await stop('the PR is a draft');
// A PR the pipeline did not open is somebody's own work, and QA passing it is not their say-so.
if (!approved && !isPipelineAuthor(view.author?.login)) {
  await stop(`the PR was opened by @${view.author?.login}, not by the pipeline — only a person merges someone's own PR`);
}
// A person's "Request changes" outranks the pipeline's own approval. Each reviewer's standing
// is their last review that took a position; a later plain comment does not withdraw it.
const standing = new Map();
for (const rv of [...(view.reviews ?? [])].sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)))) {
  const login = rv.author?.login;
  if (isPipelineAuthor(login) || !isTrustedAuthor({ login, association: rv.authorAssociation }, cfg)) continue;
  if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(rv.state)) standing.set(login, rv.state);
}
const objecting = [...standing].filter(([, s]) => s === 'CHANGES_REQUESTED').map(([l]) => `@${l}`);
if (objecting.length) await stop(`${objecting.join(', ')} requested changes on this PR`);

// Full-length, and fail closed. This compared seven characters of a model-written string, and
// skipped itself when the string was absent. The new head needs QA, not an approval of the old
// one's result, so the refusal names the retry.
if (view.headRefOid !== qa.sha) {
  await stop(`QA tested ${qa.sha.slice(0, 7)} but the PR head is now ${String(view.headRefOid).slice(0, 7)} — ` +
    'that commit has not been through QA', { again: retryHint('qa') });
}

// Branch protection is what makes the pipeline's own merges answer to the checks GitHub
// enforces, and it is the only thing standing between an agent's contents:write token and the
// default branch. A person approving the merge is their own gate; the pipeline alone is not.
if (!approved) {
  const base = await ghJson(['api', `repos/${repo}/branches/${view.baseRefName}`]).catch(() => null);
  if (base?.protected !== true) {
    await stop(`autonomous merge needs a protected base branch, and \`${view.baseRefName}\` is not protected ` +
      '(or could not be read) — run `sdlc doctor`');
  }
}

/**
 * Not yet, rather than no: try again later instead of parking for a person.
 *
 * UNKNOWN mergeability and checks still running are GitHub not having finished, and both used
 * to stop the ticket with "worth one more try in a minute" — which nobody was there to make.
 * The cooldown path (resume-cooled-down, via resolveStage('merge')) re-enters only this step.
 * Bounded, doubling from five minutes, because a check that never finishes is not transient.
 */
const later = async (why) => {
  // An approved merge retries like any other. It told the person to approve again in a few
  // minutes, because the re-entry could not carry an env var; the approval is on the ledger now,
  // bound to this QA result, and the cooldown's merge-only run reads it there.
  const n = Number(ledger.merge_retries ?? 0) + 1;
  if (n > 6) await stop(`${why}, and still so after six retries`);
  const minutes = Math.min(5 * 2 ** (n - 1), 40);
  const when = new Date(Date.now() + minutes * 60_000).toISOString();
  await updateLedger(repo, Number(issue), (l) => (l ? { ...l, retry_after: when, retry_stage: 'merge', merge_retries: n } : null));
  process.stdout.write(`not merging yet: ${why} — trying again at ${when} (retry ${n} of 6)\n`);
  setOutput('merged', 'false');
  setOutput('reason', why);
  process.exit(0);
};

// A conflict is the one refusal with an obvious next step, so it gets one instead of a
// comment. It is also the refusal that is about to become common: an epic split into eight
// issues where the first unblocks four means four branches cut from the same base, and the
// second one to merge meets the first one's package.json.
//
// Refusing here left the issue at `qa-pass` with a green report and nothing that would ever
// touch it again — the pipeline stopped, wearing the face of a pipeline waiting. Resolving a
// conflict is mostly mechanical and the implementer already has the branch; when it is not
// mechanical, it says so and stops, which is the same escalation a human would reach anyway.
const conflict = async (lead, reason) => {
  await gh(['pr', 'comment', String(pr), '--body',
    `## This branch conflicts with \`${cfg.base_branch || view.baseRefName || 'the base branch'}\`\n\n` + lead +
    'Everything about this PR is still good — QA passed it, and the conflict is with the base ' +
    'rather than with the work.\n\n' +
    'Sending it back to the implementer to merge the base in and resolve, on the same ' +
    'branch. The chain re-runs from there, because the head changes and QA\'s verdict is ' +
    'about the commit it tested.\n\nMerge the base branch in and resolve the conflicts. Do ' +
    'not redesign anything and do not take the base\'s side by default — the whole point is ' +
    'that both changes were wanted.']).catch(() => {});
  await dispatchStage({ repo, issue, agent: 'release', why: reason,
    target: resolveStage('implement', { issue, pr, rework: 'merge-conflict' }) });
  setOutput('merged', 'false');
  setOutput('reason', reason);
  process.stdout.write(`issue #${issue}: PR #${pr} ${reason}\n`);
  process.exit(0);
};

// `mergeable` is computed asynchronously, and it is UNKNOWN for a while after anything touches
// the pull request or its base. A short wait settles most of them; what is still UNKNOWN after
// it is deferred, not refused.
for (let i = 0; (view.mergeable === 'UNKNOWN' || view.mergeStateStatus === 'UNKNOWN') && i < 6; i++) {
  await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  const again = await ghJson(['pr', 'view', pr, '--json', 'mergeable,mergeStateStatus'])
    .catch(() => null);
  if (!again) break;
  view.mergeable = again.mergeable;
  view.mergeStateStatus = again.mergeStateStatus;
}

if (view.mergeable === 'CONFLICTING' || view.mergeStateStatus === 'DIRTY') {
  await conflict('Something else merged while this was in flight. ', 'conflicts with the base — sent back to resolve');
}

// --- 5. the commit that merges has passed CI, now -----------------------------
// The same rule the gate uses (lib/checks.js). merge-pr read only red or unfinished checks, so
// an EMPTY rollup was green — and sync-branch's update commit, made with GITHUB_TOKEN, starts
// no workflow, so the head that merged was one no CI had ever seen.
const checks = classifyRollup(view.statusCheckRollup, cfg);
const at = String(view.headRefOid).slice(0, 7);
const named = (cs) => cs.map(checkName).join(', ');
if (checks.failing.length) await stop(`${named(checks.failing)} ${checks.failing.length === 1 ? 'is' : 'are'} red on ${at}`);
if (checks.missing.length) {
  await stop(`${checks.missing.join(', ')} never reported on ${at} — a head no CI has seen does not merge`);
}
if (checks.pending.length) await later(`${named(checks.pending)} ha${checks.pending.length === 1 ? 's' : 've'} not finished on ${at}`);
if (view.mergeable === 'UNKNOWN' || view.mergeStateStatus === 'UNKNOWN') {
  await later('GitHub has not finished computing whether this merges cleanly');
}
// Another PR merged while QA ran. Merging now would ship a combination nothing has tested, so
// QA runs again: it syncs the branch, waits for CI on the combined head and tests that — within
// the same QA attempt budget as everything else.
if (view.mergeStateStatus === 'BEHIND') {
  process.stdout.write(`issue #${issue}: PR #${pr} is behind its base — QA re-tests the combined head\n`);
  await dispatchStage({ repo, issue, agent: 'release', why: 'the base moved after QA passed, so the combined head needs QA',
    target: resolveStage('qa', { issue, pr }) });
  setOutput('merged', 'false');
  setOutput('reason', 'behind the base — sent back to QA');
  process.exit(0);
}
// Not a conflict, and not the implementer's to fix: a required review, a ruleset, a status the
// protection names that this repo's config does not. It used to read as a conflict and send
// the implementer to resolve something that was not there.
if (view.mergeStateStatus === 'BLOCKED') {
  await stop('branch policy blocks this merge — GitHub reports it BLOCKED with every gating check green, so a ' +
    'required review or rule the pipeline cannot satisfy is in the way');
}

// --- 6. it still does not touch what a human reserved -----------------------
// Checked at the gate too. Re-checked here because this is the step that cannot be undone,
// and because anything could have been pushed between the two.
//
// Exit 2 is the guard's verdict. Anything else non-zero is the guard not finishing — and a
// check that could not run must not read as one that found something, or as one that passed,
// so it crashes this step into the failure path. On exit 2 the guard has already commented on
// the PR and the issue and parked it for the implementer, so this refusal is not announced twice.
await exec('node', ['.sdlc/bin/check-diff-forbidden.mjs'], { env: { ...process.env, PR: pr } })
  .catch(async (e) => {
    if (e.code !== 2) throw e;
    const hits = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.split('\n').filter((l) => /^\s{2}\S/.test(l)).map((l) => l.trim());
    await stop(`the diff touches reserved paths — ${hits.join('; ') || 'see the guard\'s output'}`, { quiet: true });
  });

// --- merge ------------------------------------------------------------------
// Bound to the commit QA tested: a push between the checks above and this call is refused by
// GitHub instead of merged.
const method = cfg.release?.merge_method ?? 'squash';
await gh(['pr', 'merge', pr, `--${method}`, '--delete-branch', '--match-head-commit', qa.sha]).catch(async (e) => {
  // The API is the last word on mergeability, and it disagrees with the field often enough to
  // matter — but only a message that says CONFLICT means one. "Not mergeable" is also what a
  // ruleset or a required review says, and sending the implementer to resolve a conflict that
  // does not exist spends an attempt on nothing.
  const why = String(e.stderr || e.message);
  if (!/merge conflict|cannot be cleanly created/i.test(why)) throw e;
  await conflict('GitHub reported it mergeable and then refused the merge as conflicting — mergeability ' +
    'is computed asynchronously, so the field can be stale. ', 'refused by the merge API as conflicting — sent back to resolve');
});
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
