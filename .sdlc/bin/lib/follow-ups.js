// One follow-up issue per issue, filed when its PR merges.
//
// Review filed "Follow-ups from the review of #N" whenever it approved with findings left over,
// and QA filed "N pre-existing bugs found while testing #N" on every run that found any — so one
// ticket produced two or three more, each a full plan-implement-review-QA cycle, and each of
// THOSE produced its own (growth-os: #43 -> #44 and #47, #45 -> #46 and #48, #39 -> #40). Worse,
// review filed on every approval, including rounds whose findings a later round fixed, and a
// PR that never merged still left tickets about code that never landed.
//
// Now both keep what they found on the issue's ledger — review its final approval's leftovers,
// QA its latest run's pre-existing bugs, each replacing its own earlier list — and the lot is
// filed once, as one ticket, when the PR merges: on-merge files it after every merge, the
// pipeline's or a person's, just before it wakes what depends on the issue — so the follow-up,
// blocked on it, is offered a slot at once. The ledger records it, so it is never filed twice.
import { gh, ghJson } from './actions.js';
import { fileIssue } from './file-issue.js';
import { readLedger, updateLedger } from './state-io.js';

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// Every line quoted: the Router obeys a Decisions section on an issue the pipeline opened, and a
// finding carrying that heading would be a decision taken by whoever wrote the diff it was about.
const quote = (s) => String(s ?? '').split('\n').map((l) => `> ${l}`).join('\n');
export const SEV_LABEL = { critical: 'p0', major: 'p1', minor: 'p2', trivial: 'p3' };

const titleWords = (t) => new Set(String(t).toLowerCase().split(/\W+/).filter((w) => w.length > 3));
/** Two titles about the same bug: most of the longer words shared. */
export function alike(bug, other) {
  const words = titleWords(bug.title);
  const theirs = titleWords(other.title);
  return words.size > 2 && [...words].filter((w) => theirs.has(w)).length / words.size > 0.6;
}

/** A QA bug as a section of a ticket. */
export function bugSection(bug) {
  return [
    `### ${one(bug.title)}`,
    '',
    `**Severity** ${bug.severity} (as judged by QA — reassess before planning).`,
    '',
    ...(bug.regression_of ? [`**Possible regression of #${bug.regression_of}**, which is closed — check ` +
      'whether that fix was undone before treating this as new.', ''] : []),
    '**Expected.**', quote(bug.expected),
    '',
    '**Actual.**', quote(bug.actual),
    '',
    '**Steps to reproduce**',
    ...(bug.repro ?? []).map((st, i) => `${i + 1}. ${one(st)}`),
    ...(bug.suspected_cause ? ['', '**Suspected cause.**', quote(bug.suspected_cause)] : []),
    ...(bug.reproducible ? ['', `**Reproducible:** ${one(bug.reproducible)}`] : []),
  ].join('\n');
}

/**
 * Keep what one source found, replacing that source's earlier list. `items` are review findings
 * ({ title, detail }) or QA bugs; an empty list clears the source.
 */
export async function keepFollowUps(repo, issue, source, items, { pr } = {}) {
  await updateLedger(repo, Number(issue), (l) => {
    if (!l || l.follow_ups?.filed) return null;
    return { ...l, follow_ups: { ...(l.follow_ups ?? {}), [source]: items, ...(pr ? { pr: String(pr) } : {}) } };
  });
}

/**
 * File what the issue's review and QA left, as one ticket, once. Returns the issue number filed,
 * the one filed before, or null when there was nothing to file.
 */
export async function fileFollowUps(repo, issue, pr) {
  const { ledger } = await readLedger(repo, Number(issue));
  const kept = ledger?.follow_ups;
  if (!kept) return null;
  if (kept.filed) return kept.filed === 'none' ? null : kept.filed;
  const review = kept.review ?? [];
  const found = kept.qa ?? [];
  if (!review.length && !found.length) return null;

  // QA runs on every PR and finds the same pre-existing bug again and again: an open ticket for
  // it is where it already lives, and a closed one is a possible regression, said so.
  const [open, closed] = found.length
    ? await Promise.all(['open', 'closed'].map((state) => ghJson(['issue', 'list', '--state', state, '--limit', '200', '--json', 'number,title']).catch(() => [])))
    : [[], []];
  const already = [];
  const qa = [];
  for (const bug of found) {
    const dupe = open.find((o) => alike(bug, o));
    if (dupe) { already.push(`#${dupe.number}`); continue; }
    const was = closed.find((o) => alike(bug, o));
    qa.push(was ? { ...bug, regression_of: was.number } : bug);
  }
  const pull = pr ?? kept.pr ?? '';
  const body = [
    `What the review and QA of PR #${pull} (for #${issue}) found and did not fix there — filed as it merged, ` +
    'one ticket for the lot.',
    ...(review.length ? ['', '## From the review', '',
      'Non-blocking findings the reviewer approved despite: a statement about severity, not a judgement ' +
      'that they are wrong.', '',
      ...review.map((f) => `### ${one(f.title)}\n\n${quote(f.detail)}\n`)] : []),
    ...(qa.length ? ['', '## Found by QA — pre-existing', '',
      `PR #${pull} did not introduce these, which is why they did not block it.`, '',
      ...qa.map((b) => `${bugSection(b)}\n`)] : []),
    ...(already.length ? ['', `QA also found what is already tracked in ${already.join(', ')}.`] : []),
    '',
    '---',
    '',
    '**Check each one still reproduces before planning it.** They were written against the PR as it ' +
    'stood, and a later round can have fixed one. Some may not hold up: say so and drop them rather than ' +
    'implementing something that was never wrong. Split this if they turn out to be unrelated.',
    '',
    `Depends on #${issue}.`,
  ].join('\n');

  if (!review.length && !qa.length) {
    await updateLedger(repo, Number(issue), (l) => (l ? { ...l, follow_ups: { ...l.follow_ups, filed: 'none' } } : null)).catch(() => {});
    return null;
  }
  const worst = ['critical', 'major', 'minor', 'trivial'].find((sv) => qa.some((b) => b.severity === sv));
  const parts = [review.length && `${review.length} from the review`, qa.length && `${qa.length} from QA`].filter(Boolean);
  // Queued, not started: wake-dependents offers it a slot once #issue is done, under
  // limits.max_in_flight like any other ticket.
  const made = await fileIssue({
    title: `Follow-ups from #${issue}: ${parts.join(', ')}`,
    body,
    labels: ['sdlc:blocked', ...(qa.length ? ['bug'] : []), ...(SEV_LABEL[worst] ? [SEV_LABEL[worst]] : [])],
    start: false,
  });
  if (!made) {
    process.stdout.write('::warning::could not file the follow-ups — they are still on the ledger, under follow_ups\n');
    return null;
  }
  await updateLedger(repo, Number(issue), (l) => (l ? { ...l, follow_ups: { ...l.follow_ups, filed: made.number } } : null))
    .catch((e) => process.stdout.write(`::warning::filed #${made.number} but could not record it: ${e.message}\n`));
  if (pull) {
    await gh(['pr', 'comment', String(pull), '--body',
      `The follow-ups from this PR's review and QA are one ticket: #${made.number} (${parts.join(', ')}). ` +
      `It starts once #${issue} is done.`]).catch(() => {});
  }
  process.stdout.write(`filed #${made.number}: ${parts.join(', ')}\n`);
  return made.number;
}
