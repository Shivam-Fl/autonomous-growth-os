// Move an issue to a state — on the ledger AND on its labels, in one call.
//
// These were two separate lines at every call site, and one of them forgot the ledger half.
// The auto-approve plan path set the `sdlc:implementing` label and dispatched the implementer
// without transitioning, so the ledger sat at `planning` from the first auto-approved issue
// onward. Everything downstream then tried an illegal transition out of `planning`, and every
// one of those was written as `.catch(() => {})` — so the PR went green, QA-passed and the
// ledger still said the plan was being written. Budgets and locks are keyed off that object.
//
// Two facts, one function, no call site that can remember half of it.

import { gh } from './actions.js';
import { STATES } from './ledger.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const LABEL = (s) => `sdlc:${s}`;

// States that RECORD A RESULT rather than announce an arrival.
//
// The soft behaviour below — warn, keep going, fix the labels anyway — is right for a stage
// saying "I am running now": the stage is ground truth and a stale ledger should not kill it.
// It is wrong for these. A failed write of `qa-pass` that still moves the label produces an
// issue that reads "QA passed" while the ledger says otherwise, and merge eligibility, budgets
// and the watchdog all key off the ledger. The label would be advertising a result nothing
// recorded.
const OUTCOMES = new Set(['qa-pass', 'qa-fail', 'merged', 'done', 'budget-exceeded', 'needs-human']);

/**
 * @param {string|number} issue
 * @param {string} state   one of ledger STATES
 * @param {{agent?: string, alsoRemove?: string[]}} opts
 * @returns {Promise<boolean>} whether the ledger actually moved
 * @throws when an OUTCOME state could not be written — the label is left alone on purpose
 */
export async function advance(issue, state, { agent = 'system', alsoRemove = [] } = {}) {
  if (!STATES.includes(state)) throw new Error(`advance: "${state}" is not a state`);

  let moved = true;
  await exec('node', ['.sdlc/bin/sdlc-ctl.mjs', 'transition',
    '--issue', String(issue), '--to', state, '--agent', agent])
    .catch((e) => {
      moved = false;
      // Loud, because this is the failure that used to be invisible. Not fatal: the label is
      // what a human reads, and refusing to update it as well would hide the drift further.
      process.stdout.write(
        `::warning::issue #${issue}: ledger did not move to ${state} — ` +
        `${String(e.stderr || e.message).trim().split('\n').pop()}\n`);

      // An outcome that could not be recorded has not happened. Stop before the label says it
      // did: a green label over a ledger that never moved is worse than a failed step, because
      // the failed step is visible and the label is believed.
      if (OUTCOMES.has(state)) {
        throw new Error(
          `could not record "${state}" on the ledger for issue #${issue}: ` +
          `${String(e.stderr || e.message).trim().split('\n').pop()}\n` +
          'This is a result, not a stage announcement — the label is deliberately left alone ' +
          'rather than claiming something the ledger does not hold.');
      }
    });

  // Labels are the human-readable copy of that state, so exactly one of them should be on the
  // issue. Leaving a stale one is worse than having none: people act on labels.
  //
  // The read used to be `.catch(() => [])`. That is this pipeline's signature bug wearing a
  // different hat: a failed read became "the issue has no labels", so nothing stale was
  // removed and the new label was simply added beside the old one. tabs #14 was created
  // `sdlc:triage` and stopped at `sdlc:needs-human`, and carried BOTH, with no transition
  // record explaining either — one state label, one writer, and it still managed two.
  //
  // So: the read retries, a read that never succeeds says so instead of pretending, and the
  // result is VERIFIED afterwards rather than assumed. A label write is one `gh` call away
  // from being wrong and nobody re-reads it.
  const readLabels = async () => {
    let lastError;
    for (let i = 0; i < 3; i++) {
      try {
        const out = await gh(['issue', 'view', String(issue), '--json', 'labels', '--jq', '.labels[].name']);
        return out.split('\n').map((s) => s.trim()).filter(Boolean);
      } catch (e) {
        lastError = e;
        await new Promise((r) => setTimeout(r, 300 * 2 ** i));
      }
    }
    process.stdout.write(
      `::warning::issue #${issue}: could not read its labels — ` +
      `${String(lastError?.stderr || lastError?.message).trim().split('\n').pop()}\n`);
    return null;
  };

  const removable = new Set([...STATES.map(LABEL), ...alsoRemove]);
  removable.delete(LABEL(state));

  const current = await readLabels();
  // A read that failed is not an empty label set. With no idea what is on the issue, try to
  // remove every other state label rather than none — `gh` is tolerant of labels the issue
  // does not carry when the edit also does something it can do.
  const stale = current === null
    ? [...removable]
    : [...removable].filter((l) => current.includes(l));

  const args = ['issue', 'edit', String(issue)];
  for (const l of stale) args.push('--remove-label', l);
  if (!current?.includes(LABEL(state))) args.push('--add-label', LABEL(state));
  if (args.length > 3) {
    await gh(args).catch(async (e) => {
      // One batched edit failing takes every removal with it, and the issue keeps both
      // labels. Fall back to one call per label so a single bad name cannot do that.
      process.stdout.write(`::warning::issue #${issue}: batched label edit failed, retrying one at a time\n`);
      for (const l of stale) await gh(['issue', 'edit', String(issue), '--remove-label', l]).catch(() => {});
      await gh(['issue', 'edit', String(issue), '--add-label', LABEL(state)]).catch(() => {});
    });
  }

  // Verify. Two state labels is a claim about where the issue is that contradicts itself, and
  // nothing else in the system would ever notice.
  const after = await readLabels();
  if (after) {
    const extra = after.filter((l) => removable.has(l));
    for (const l of extra) {
      process.stdout.write(`::warning::issue #${issue}: "${l}" survived the move to ${state} — removing it\n`);
      await gh(['issue', 'edit', String(issue), '--remove-label', l]).catch(() => {});
    }
    if (!after.includes(LABEL(state))) {
      process.stdout.write(`::warning::issue #${issue}: ${LABEL(state)} was not applied — retrying\n`);
      await gh(['issue', 'edit', String(issue), '--add-label', LABEL(state)]).catch(() => {});
    }
  }

  process.stdout.write(`issue #${issue} -> ${state}${moved ? '' : ' (label only)'}\n`);

  // An issue that stops running has just freed a slot, and something is probably queued
  // behind it.
  //
  // `max_in_flight` is counted from labels, so the moment this one parks the count drops —
  // but nothing looks. The queue was re-offered only by a merge at first, and then only by
  // the watchdog's timer, and GitHub throttles a `*/15` cron hard on a quiet private repo:
  // two consecutive sweeps landed 5h40m apart. So a ticket stopping at a human gate could
  // leave the next one waiting most of a day for a clock that was not really ticking.
  //
  // The watchdog is still the owner — it has the permissions and the top-up logic. This just
  // tells it to look now. Fire and forget: a repo whose workflow cannot dispatch (no
  // `actions: write`) still parks correctly, it simply waits for the timer.
  //
  // `blocked` is deliberately absent. An issue moving TO blocked is being parked on a
  // dependency by intake, which happens in bursts during a fan-out, and each one would
  // dispatch a sweep that finds the same thing.
  if (['needs-human', 'budget-exceeded', 'done', 'merged'].includes(state)) {
    await exec('gh', ['workflow', 'run', 'sdlc-watchdog.yml'])
      .then(() => process.stdout.write(`a slot freed at #${issue} — asked the watchdog to look\n`))
      .catch(() => { /* no actions: write here, or no such workflow; the timer still covers it */ });
  }

  return moved;
}
