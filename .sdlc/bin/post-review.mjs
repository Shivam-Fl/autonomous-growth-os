#!/usr/bin/env node
// Posts only the findings that survived two independent readings.
import { readFileSync, existsSync } from 'node:fs';
import { gh, setOutput } from './lib/actions.js';
import { mergeReviewFindings } from './lib/routing.js';

const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {});
const pr = process.env.PR;
const merged = mergeReviewFindings(read('review/correctness.json'), read('review/design.json'));

const icon = { blocking: '🔴', major: '🟠', minor: '⚪' };
const lines = [`## Review — ${merged.verdict === 'approve' ? 'no blocking findings' : `${merged.blocking_count} blocking`}`, ''];

if (!merged.findings.length) {
  lines.push('Two reviewers read this independently and neither found anything blocking.');
} else {
  lines.push('Each finding below was raised by one reviewer and independently checked by the other.', '');
  for (const f of merged.findings) {
    const where = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
    lines.push(`${icon[f.severity] ?? '·'} **${f.severity}** ${where} — ${f.claim}`);
    if (f.evidence) lines.push(`  - evidence: ${f.evidence}`);
    if (f.fix) lines.push(`  - fix: ${f.fix}`);
    if (f.note) lines.push(`  - _second reviewer considered this overstated: ${f.note}_`);
    if (f.verified === false) lines.push('  - _not independently verified — the second reviewer did not reach it_');
  }
}

if (merged.dropped.length) {
  lines.push('', `<details><summary>${merged.dropped.length} finding(s) dropped on verification</summary>`, '');
  for (const d of merged.dropped) lines.push(`- ~~${d.claim}~~ — ${d.dropped_because}`);
  lines.push('', 'These were raised by one reviewer and disproved by the other. Recorded rather than',
    'posted as fact: a review that is wrong about something checkable spends its credibility.', '', '</details>');
}

lines.push('', '---',
  '_Two reviewers, each verifying the other. This comment is the reasoning; the formal review',
  'is submitted separately from the merged verdict, so what the PR shows and what the pipeline',
  'recorded are the same thing._');

await gh(['pr', 'comment', pr, '--body', lines.join('\n')]);
setOutput('verdict', merged.verdict);
setOutput('blocking', String(merged.blocking_count));
process.stdout.write(`${merged.findings.length} posted, ${merged.dropped.length} dropped, verdict ${merged.verdict}\n`);
