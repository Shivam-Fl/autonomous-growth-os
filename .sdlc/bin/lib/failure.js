// What to do when something broke — for ANY stage, not just QA.
//
// A QA failure has been diagnosed properly since root-cause was wired: an agent reads the
// trace, decides whether the original diagnosis was wrong, and rewrites the work order. A CI
// failure got a regex digest thrown back at the implementer with no reasoning attached, and
// nothing at all if the digest step did not run — the gate recorded `ci-red` and dispatched
// nobody, so a red build was a dead end that looked like a pipeline still working.
//
// That asymmetry is why the same class of mistake repeats. The fix is not a better digest.
// It is to treat a mechanical failure the way a QA failure is already treated: hand the agent
// the RAW error and its own full work order, and keep a record so the second identical
// failure is answered differently from the first.
//
// Pure functions, except parkForCooldown at the bottom. The decision this file makes is the
// one that bounds an unattended retry loop, so it is testable without a network.

import { createHash } from 'node:crypto';
import { gh } from './actions.js';
import { updateLedger } from './state-io.js';
import { markResume } from './route-io.js';
import { advance } from './advance.js';
import { resolveStage, retryHint } from './flow-graph.js';

/**
 * Strip everything that changes between two runs of the SAME mistake.
 *
 * Line and column numbers go deliberately. A fixer that edits the file shifts every line
 * below it, so keeping them would make an unchanged error look new every time — and the
 * whole point is to notice that the error did not change. The file, the error code and the
 * message stay, because those are what "the same mistake" means.
 */
export function normalize(text = '') {
  return String(text)
    .replace(/\x1b\[[0-9;]*m/g, '')                         // ANSI colour
    .replace(/^\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*/gm, '')    // runner timestamps
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<sha>')               // commit shas
    .replace(/(?:\/[\w.@-]+)*\/(?=[\w.@-]+\.[a-z]+\b)/gi, '') // absolute path prefixes
    .replace(/\((\d+),\s*(\d+)\)/g, '')                     // tsc (44,12)
    .replace(/:(\d+):(\d+)\b/g, '')                         // file:44:12
    .replace(/\b(?:line|at line)\s+\d+/gi, '')
    .replace(/\b\d{3,}\b/g, '<n>')                          // run ids, ports, durations
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Stable id for "this exact mistake", whatever run produced it. */
export function signatureOf(text = '') {
  return createHash('sha256').update(normalize(text)).digest('hex').slice(0, 16);
}

const TYPES = [
  [/\berror\s+ts\d+|type\s+'.*?'\s+is not assignable|\bts\d{4}\b/i, 'type'],
  [/syntaxerror|unexpected token|unexpected identifier|parse error|cannot parse/i, 'syntax'],
  [/referenceerror|typeerror|rangeerror|is not a function|is not defined|cannot read propert/i, 'exception'],
  [/\bnot ok \d|tests? failed|assertion|expect\(/i, 'test-fail'],
  [/schema validation failed|missing required property|is not one of|invalid json/i, 'schema-invalid'],
  [/\beslint\b|problems? \(\d+ error|no-unused-vars|prettier/i, 'lint'],
  [/build failed|failed to compile|rollup|esbuild|webpack|vite build/i, 'build'],
  [/timed out|timeout|etimedout|deadline exceeded/i, 'timeout'],
  [/command not found|enoent|permission denied|exit code 127|npm err/i, 'tool-error'],
  // A GitHub Action refusing its own inputs. Distinct from anything the project's code did,
  // and the fix is always configuration rather than a diff — so it is worth naming rather
  // than landing in "unknown" and reading as a mystery.
  [/environment variable validation failed|is required when using|secret .* is not set|input required and not supplied/i, 'tool-error'],
  // The model run itself failing. Distinct from anything the project's code did — there is no
  // diff to fix — and it is what a token's rate or quota limit looks like from inside a job.
  [/claude execution failed|result is_error|is_error:\s*true|reported subtype success with is_error/i, 'agent-runtime'],
];

/** Best-effort bucket for the error. Drives nothing on its own — it is what a human reads. */
export function classify(text = '') {
  for (const [re, type] of TYPES) if (re.test(String(text))) return type;
  return 'unknown';
}

/**
 * How many times in a row this exact failure has just happened.
 *
 * Consecutive, not total. Two different mistakes alternating are two problems being worked
 * on, and each deserves its own attempt; the same one twice in a row means the approach is
 * wrong, not the typing.
 */
export function consecutive(history = [], signature) {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.error_signature !== signature) break;
    n++;
  }
  return n;
}

/**
 * The whole decision, in one place.
 *
 * @param {object[]} history   failure_history INCLUDING the failure being decided on
 * @param {string} signature
 * @param {{repeatEscalate?: number, attempts?: number, maxAttempts?: number,
 *          canRootCause?: boolean}} opts
 * @returns {{action: 'fix'|'root-cause'|'escalate', reason: string, occurrences: number}}
 */
export function decide(history = [], signature, opts = {}) {
  const repeatEscalate = opts.repeatEscalate ?? 2;
  const maxAttempts = opts.maxAttempts ?? 10;
  const attempts = opts.attempts ?? 0;
  const occurrences = consecutive(history, signature);

  // The budget is the outer bound and it wins over everything below: a stage that has already
  // been dispatched to its cap does not get another try just because this error looks new.
  if (attempts >= maxAttempts) {
    return {
      action: 'escalate',
      occurrences,
      reason: `this stage has already been dispatched ${attempts} times against a cap of ${maxAttempts}`,
    };
  }

  if (occurrences < repeatEscalate) {
    return {
      action: 'fix',
      occurrences,
      reason: occurrences <= 1
        ? 'first time this exact failure has happened — the agent gets the raw error and its own ' +
          'work order, and fixes only this'
        : `seen ${occurrences} times in a row, still under the ${repeatEscalate} that means the plan is wrong`,
    };
  }

  if (occurrences === repeatEscalate) {
    // The same error twice means the work order's approach is wrong, not the typing. That is
    // root-cause's question — "was the original diagnosis wrong?" — and asking it before a
    // third blind retry is the difference between an attempt and a re-roll.
    if (!opts.canRootCause) {
      return {
        action: 'escalate',
        occurrences,
        reason: `the same failure ${occurrences} times, and there is no work order to revise — ` +
                'nothing an agent can do differently without a person deciding something',
      };
    }
    return {
      action: 'root-cause',
      occurrences,
      reason: `the same failure ${occurrences} times in a row — the approach is wrong, not the typing, ` +
              'so the diagnosis goes on trial before anything else is written',
    };
  }

  return {
    action: 'escalate',
    occurrences,
    reason: `the same failure ${occurrences} times, including after the diagnosis was already revised`,
  };
}

/** Append one failure to a ledger's history, newest last, bounded. */
export function recordFailure(ledger, entry, { limit = 50 } = {}) {
  return {
    ...ledger,
    failure_history: [...(ledger.failure_history ?? []), entry].slice(-limit),
  };
}

const trailing = (list = [], pred) => {
  let n = 0;
  for (let i = list.length - 1; i >= 0 && pred(list[i] ?? {}); i--) n++;
  return n;
};

/**
 * How many times in a row this stage's model run has just failed before producing anything.
 *
 * Counted off failure_history rather than kept as a `runtime_retries` counter, because that
 * counter was only ever incremented: an outage last week spent this week's cooldowns. Any other
 * failure of this stage, or a failure of another stage (which means this one got past it),
 * ends the run of them.
 */
export function runtimeTries(history = [], stage) {
  return trailing(history, (h) => h.stage === stage && h.error_type === 'agent-runtime');
}

/** How many times in a row the triage has answered this stage's failure with "wait". */
export function waitTries(triageHistory = [], stage) {
  return trailing(triageHistory, (h) => h.stage === stage && h.verdict === 'wait');
}

/**
 * The stage a failure of `stage` waits on, stops at, or re-enters: `merge` when QA passed on the
 * PR's current head and only the merge after it failed, and `stage` otherwise.
 *
 * Re-entering QA re-runs a twenty-to-seventy-minute browser session on a head it has already
 * passed, and a flaky finding the second time turns a passed PR into a root-cause. Waiting or
 * stopping at needs-human was the same thing slower: from there qa-pass is reachable only through
 * a QA run. The verdict is on the ledger, bound to the commit it tested; while the head is still
 * that commit, only the merge is at stake.
 */
export async function mergeOnlyStage(ledger, stage, pr) {
  if (stage !== 'qa' || !pr || ledger?.state !== 'qa-pass' || !ledger?.qa?.sha) return stage;
  const head = await gh(['pr', 'view', String(pr), '--json', 'headRefOid', '--jq', '.headRefOid']).catch(() => '');
  return head === ledger.qa.sha ? 'merge' : stage;
}

/**
 * Park a stage to wait out an outage, and have the watchdog start it again afterwards.
 *
 * An outage is a WAIT, not a stop. Retrying at once proves the limit is still there and burns
 * an attempt; stopping for a person means that at 2am the pipeline is finished for the night
 * over something that clears itself in twenty minutes. Backing off each round, because a limit
 * that is still there after one cooldown will not have moved in another twenty minutes.
 *
 * One function for the three places that see an outage — the failure handler (the model run
 * died), the triage verdict `wait`, and the triage agent itself not running — so a cooldown
 * means the same thing whoever noticed it.
 *
 * @param {number} tries  cooldowns this stage has already waited through in this outage
 * @returns {Promise<{minutes: number, at: Date}|{halted: true}|null>} null when the cooldowns are
 *          used up, or the wait could not be recorded; the caller then stops for a person instead.
 *          `halted` when a person stopped the issue: nothing was parked, and nothing is to be done
 */
export async function parkForCooldown(repo, issue, stage, tries, { maxRetries = 4, agent = 'self-heal', why } = {}) {
  if (tries >= maxRetries) return null;
  const minutes = Math.min(20 * 2 ** tries, 120);
  const at = new Date(Date.now() + minutes * 60_000);

  // Not `.catch(() => {})`. A cooldown that was announced and never written is an issue parked
  // at needs-human with nothing to wake it — it reads as scheduled and is abandoned.
  //
  // And not over a stop. A person who ran `/sdlc stop`, or closed the issue, while a triage was
  // reading the log was told "the watchdog starts review again after …" — a restart the sweep
  // would then refuse, announced on an issue someone had just stopped.
  let halted = null;
  try {
    await updateLedger(repo, Number(issue), (l) => {
      halted = l?.halted ?? null;
      return l && !halted ? {
        ...l, retry_after: at.toISOString(), retry_stage: stage, parked_at: new Date().toISOString(),
      } : null;
    });
  } catch (e) {
    process.stdout.write(`::warning::issue #${issue}: could not record the cooldown: ${e.message}\n`);
    return null;
  }
  if (halted) {
    process.stdout.write(`issue #${issue}: halted by @${halted.by} — not parking \`${stage}\` for a cooldown\n`);
    return { halted: true };
  }

  // needs-human frees the in-flight slot, which is what lets everything else keep moving while
  // this one waits. The watchdog is what brings it back. Not a merge (mergeOnlyStage): it waits
  // at qa-pass, as merge-pr's own "not yet" does, because needs-human leads back to qa-pass only
  // through another QA run. resume-cooled-down re-enters a merge from there.
  if (stage !== 'merge') {
    await markResume(repo, issue, resolveStage(stage, { issue })?.stage ?? stage, 'retry');
    await advance(issue, 'needs-human', { agent });
  }
  await gh(['issue', 'comment', String(issue), '--body',
    `Parked for ${minutes} minutes: ${why}.\n\n` +
    `The watchdog starts \`${stage}\` again after ${at.toISOString()} — cooldown ${tries + 1} of ` +
    `${maxRetries}. ${stage === 'merge' ? 'QA\'s pass stands; the issue stays at `qa-pass`.'
      : 'Nothing is lost; the slot is free for other issues meanwhile.'} ` +
    `${retryHint(stage)} starts it sooner.`]).catch(() => {});
  process.stdout.write(`issue #${issue}: parked ${minutes}m before \`${stage}\` runs again\n`);
  return { minutes, at };
}
