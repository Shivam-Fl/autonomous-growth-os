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
import { gh, ghJson, loadConfig, setOutput, die } from './lib/actions.js';
import { advance } from './lib/advance.js';
import { fileIssue } from './lib/file-issue.js';

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

// Only pre-existing bugs. A bug this PR introduced belongs in the fix loop, not a new ticket —
// filing it separately lets the broken PR merge.
const outOfScope = (report.bugs ?? []).filter((b) => b.introduced_by_pr === false);
if (!outOfScope.length) {
  process.stdout.write('no out-of-scope bugs to file\n');
  setOutput('filed', '0');
  if (audit) {
    // A clean audit is a result, and a result with no comment reads as a run that did nothing.
    await gh(['issue', 'comment', sourceIssue, '--body',
      'Audit complete — nothing found worth filing. The report above says what was covered; ' +
      '`coverage_gaps` says what could not be reached.']).catch(() => {});
    await advance(sourceIssue, 'done', { agent: 'qa' }).catch(() => {});
    await gh(['issue', 'close', sourceIssue, '--reason', 'completed']).catch(() => {});
  }
  process.exit(0);
}

const existing = await ghJson(['issue', 'list', '--state', 'all', '--limit', '100', '--json', 'number,title']);
const SEV_LABEL = { critical: 'p0', major: 'p1', minor: 'p2', trivial: 'p3' };

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
  const words = new Set(bug.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const dupe = existing.find((o) => {
    const other = new Set(o.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const shared = [...words].filter((w) => other.has(w)).length;
    return words.size > 2 && shared / words.size > 0.6;
  });
  if (dupe) {
    process.stdout.write(`skipping "${bug.title}" — looks like #${dupe.number}\n`);
    links.push(`#${dupe.number} (already open)`);
    continue;
  }
  fresh.push(bug);
}

if (fresh.length) {
  const section = (bug) => [
    `### ${bug.title}`,
    '',
    `**Severity** ${bug.severity} (as judged by QA — reassess before planning).`,
    '',
    '**Expected.** ' + bug.expected,
    '',
    '**Actual.** ' + bug.actual,
    '',
    '**Steps to reproduce**',
    ...bug.repro.map((st, i) => `${i + 1}. ${st}`),
    ...(bug.suspected_cause ? ['', '**Suspected cause.** ' + bug.suspected_cause] : []),
    ...(bug.reproducible ? ['', `**Reproducible:** ${bug.reproducible}`] : []),
  ].join('\n');

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
    ? fresh[0].title
    : `${fresh.length} pre-existing bugs found while testing ${audit ? `#${sourceIssue}` : `#${pr}`}`;

  const worst = ['critical', 'major', 'minor', 'trivial'].find((sv) => fresh.some((b) => b.severity === sv));
  const labels = ['bug', 'sdlc:triage', ...(SEV_LABEL[worst] ? [SEV_LABEL[worst]] : [])];

  const made = await fileIssue({ title, body, labels });
  if (made) {
    links.push(`#${made.number}`);
    filed = fresh.length;
    process.stdout.write(`filed #${made.number} with ${fresh.length} bug(s)` +
      `${made.labelled ? '' : ' (without labels)'}${made.started ? '' : ' — NOT started'}\n`);
  } else {
    process.stdout.write('::warning::could not file the QA findings — they are only in the report\n');
  }
}

if (links.length) {
  if (audit) {
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
