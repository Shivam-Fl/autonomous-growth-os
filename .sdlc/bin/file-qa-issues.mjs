#!/usr/bin/env node
// Opens issues for bugs QA found outside this PR's scope.
//
// On the first live run QA found a stored XSS and a double-submit race, correctly scoped both
// out of the PR that did not cause them, and wrote them into a report comment. Which is where
// they would have stayed. A critical finding recorded in prose nobody actions is a finding
// that was not made.
//
// Scoped out of a PR is not the same as unimportant: it means "not this PR's job", and the
// correct destination is its own ticket.

import { readFileSync } from 'node:fs';
import { gh, ghJson, loadConfig, setOutput, die, repo as repoOf } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { fileIssue } from './lib/file-issue.js';
import { keepFollowUps, alike, bugSection, SEV_LABEL } from './lib/follow-ups.js';

const cfg = await loadConfig();
if (cfg.gates?.qa_files_issues === false) {
  process.stdout.write('gates.qa_files_issues is off — not filing\n');
  setOutput('filed', '0');
  process.exit(0);
}

const report = JSON.parse(readFileSync(process.env.REPORT ?? 'qa-report.json', 'utf8'));
const pr = process.env.PR || '';
const sourceIssue = process.env.ISSUE;

// An audit is the route where filing is not a side effect — it is the whole deliverable.
// There is no PR, so every finding is pre-existing by construction, and the issue that asked
// for the sweep closes when the sweep has been turned into tickets.
const audit = String(process.env.AUDIT ?? '') === 'true' || !pr;
// ...and only once the sweep has actually run. A blocked audit — it could not log in, or reach
// the app — writes `report-only`, the one action an audit has, and was closed here as "Audit
// complete — nothing found": a sweep that never ran, closed as a clean one. post-qa-report
// leaves anything but a pass at needs-human with QA as the resume point; what it did find is
// still filed. BLOCKED_REASON is post-qa-report's override: the page sent data to a host nobody
// allowed, and the report on disk still says what the agent concluded.
const verdict = process.env.BLOCKED_REASON ? 'blocked' : report.verdict;
const finished = verdict === 'pass';

// Only pre-existing bugs. A bug this PR introduced belongs in the fix loop, not a new ticket —
// filing it separately lets the broken PR merge.
const outOfScope = (report.bugs ?? []).filter((b) => b.introduced_by_pr === false);
if (!outOfScope.length) {
  process.stdout.write('no out-of-scope bugs to file\n');
  setOutput('filed', '0');
  if (audit && !finished) process.stdout.write(`the audit's verdict is "${verdict}" — not closing #${sourceIssue}\n`);
  if (audit && finished) {
    // A clean audit is a result, and a result with no comment reads as a run that did nothing.
    await gh(['issue', 'comment', sourceIssue, '--body',
      'Audit complete — nothing found worth filing. The report above says what was covered; ' +
      '`coverage_gaps` says what could not be reached.']).catch(() => {});
    await advance(sourceIssue, 'done', { agent: 'qa' }).catch(() => {});
    await gh(['issue', 'close', sourceIssue, '--reason', 'completed']).catch(() => {});
  }
  process.exit(0);
}

// On a PR, kept rather than filed: what QA found outside the PR's scope is filed together with the
// review's leftover findings, as one ticket, when the PR merges (lib/follow-ups.js, from
// on-merge). Filing here opened a ticket per QA run, beside the review's, for one issue. The
// latest run's list replaces the earlier one's. An audit has no PR and nothing to merge: filing
// is its whole deliverable, below.
if (!audit) {
  await keepFollowUps(repoOf(), sourceIssue, 'qa', outOfScope, { pr });
  await gh(['pr', 'comment', pr, '--body',
    `QA found ${outOfScope.length} pre-existing issue(s) outside this PR's scope. They do not block it — it ` +
    "did not cause them — and they are filed with the review's follow-ups, as one ticket, when this merges."]).catch(() => {});
  process.stdout.write(`kept ${outOfScope.length} pre-existing bug(s) for the follow-up filed at merge\n`);
  setOutput('filed', '0');
  process.exit(0);
}

// Open issues are what a bug can be a duplicate of. This listed every state, so a bug that came
// back after its fix merged matched its own CLOSED ticket and was dropped as "(already open)" —
// a regression reported as tracked, by a ticket nobody would ever look at again. A closed match
// is filed anyway, saying what it may be a regression of.
const listed = (state) => ghJson(['issue', 'list', '--state', state, '--limit', '200', '--json', 'number,title']);
const existing = await listed('open');
const closed = await listed('closed');

let filed = 0;
const links = [];

// ONE ticket for the lot, not one per bug.
//
// QA finding four pre-existing bugs in a PR used to open four issues, and each of those is a
// full plan, implement, gate, CI, review and QA cycle of its own. A review doing the same
// produced ten tickets from one pull request — more work created than the pipeline could
// work through, and every cycle is an agent session against a token that has a limit.
//
// Grouping does not lose anything: the bugs are written out in full, and whoever plans the
// ticket can split it if they turn out to be unrelated. That is a judgement made once, by
// something that has read them, instead of assumed n times by something that has not.
const fresh = [];
for (const bug of outOfScope) {
  // Dedupe on title overlap. QA runs on every PR, and the same pre-existing bug will be
  // found again and again — a fresh duplicate each time trains people to ignore these.
  const dupe = existing.find((o) => alike(bug, o));
  if (dupe) {
    process.stdout.write(`skipping "${bug.title}" — looks like #${dupe.number}\n`);
    links.push(`#${dupe.number} (already open)`);
    continue;
  }
  const was = closed.find((o) => alike(bug, o));
  fresh.push(was ? { ...bug, regression_of: was.number } : bug);
}

// QA's words are quoted line by line in the ticket (lib/follow-ups.js bugSection): the Router obeys
// a Decisions section on an issue the pipeline opened, and a bug's text could carry one.

if (fresh.length) {
  const section = bugSection;

  const body = [
    audit
      ? `Found by the QA agent during the audit asked for in #${sourceIssue}.`
      : `Found by the QA agent while testing PR #${pr} (for #${sourceIssue}).`,
    '',
    audit
      ? 'Nothing was being changed when these were found — the audit tests what is already ' +
        'deployed, so this is existing behaviour rather than a regression.'
      : `**These are pre-existing.** PR #${pr} did not introduce them, which is why they were ` +
        'scoped out of that review rather than blocking it.',
    '',
    ...fresh.map(section),
    '',
    '---',
    '',
    ...(report.env?.url ? [`**Environment:** \`${report.env.url}\` @ \`${(report.env.commit ?? '').slice(0, 8)}\``, ''] : []),
    'Filed together because one ticket per bug is more work than anyone can get through. ' +
    'Split this if they turn out to be unrelated — that is a call worth making once, having ' +
    'read them.',
    '',
    '**Check each still reproduces before planning it.**',
  ].join('\n');

  const title = fresh.length === 1
    ? fresh[0].title.replace(/\s+/g, ' ').trim()
    : `${fresh.length} pre-existing bugs found while testing ${audit ? `#${sourceIssue}` : `#${pr}`}`;

  const worst = ['critical', 'major', 'minor', 'trivial'].find((sv) => fresh.some((b) => b.severity === sv));
  // Queued, not started: `sdlc:blocked` and no dispatch, as route-review files its follow-ups, so
  // wake-dependents offers it a slot under limits.max_in_flight like any other ticket. It was
  // filed `sdlc:triage` and intake dispatched at once, with no cap check — on a split project
  // every QA run could add work in flight beyond the cap, and outside the split's dependency
  // order: the "pre-existing" bug is often the page a still-blocked sibling is there to build.
  const labels = ['bug', 'sdlc:blocked', ...(SEV_LABEL[worst] ? [SEV_LABEL[worst]] : [])];

  const made = await fileIssue({ title, body, labels, start: false });
  if (made) {
    links.push(`#${made.number}`);
    filed = fresh.length;
    process.stdout.write(`filed #${made.number} with ${fresh.length} bug(s)` +
      `${made.labelled ? '' : ' (without labels)'} — queued for a slot\n`);
  } else {
    process.stdout.write('::warning::could not file the QA findings — they are only in the report\n');
  }
}

if (links.length) {
  if (audit && !finished) {
    await gh(['issue', 'comment', sourceIssue, '--body',
      `The audit filed ${links.length} finding(s): ${links.join(', ')}\n\n` +
      `It did not finish — its verdict is "${verdict}" — so this issue stays open for a ` +
      'person. `/sdlc approve` runs the audit again once that is settled.']);
  } else if (audit) {
    await gh(['issue', 'comment', sourceIssue, '--body',
      `Audit complete — ${links.length} finding(s) filed: ${links.join(', ')}\n\n` +
      'Each one is now its own ticket and routes on its own. This issue closes here: the ' +
      'sweep was the work, and the tickets are the result.']);
    await advance(sourceIssue, 'done', { agent: 'qa' }).catch((e) =>
      process.stdout.write(`::warning::could not close out the audit on the ledger: ${e.message}\n`));
    await gh(['issue', 'close', sourceIssue, '--reason', 'completed']).catch(() => {});
  } else {
    await gh(['pr', 'comment', pr, '--body',
      `QA found ${links.length} pre-existing issue(s) outside this PR's scope: ${links.join(', ')}\n\n` +
      'These do not block this PR — it did not cause them — but they are now tracked rather than ' +
      'noted in a report.']);
  }
}
setOutput('filed', String(filed));
