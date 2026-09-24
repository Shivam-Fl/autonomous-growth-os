#!/usr/bin/env node
// Posts only the findings that survived two independent readings.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gh, setOutput, die } from './lib/actions.js';
import { loadArtifact } from './lib/artifact.js';
import { mergeReviewFindings } from './lib/routing.js';

const pr = process.env.PR;

// Loaded, repaired and validated, never trusted as written.
//
// A missing file used to read as `{}`: a reviewer that ended its turn without writing, or wrote
// correctness.json at the repo root, produced "Two reviewers read this independently and
// neither found anything blocking", an approval, and a merge of code nobody had checked. And
// the strings were exact-matched unvalidated, so severity "Blocking" was not blocking and
// status "Confirmed" read as disproved — a confirmed blocker dropped, and the PR approved. An
// empty review is not a clean one; this stops instead, and the failure path reruns the review.
const load = (schema, file) => {
  const a = loadArtifact(schema, file);
  if (!a.ok) die(`${file} cannot be acted on as a review: ${a.errors.join('; ')}`);
  return a.data;
};
const correctness = load('review-correctness', 'review/correctness.json');
const design = load('review-design', 'review/design.json');

// A 1-based index, or one past the end, applies reviewer B's verdict to the wrong finding — or
// to none, leaving the one it disproved standing as verified.
const stray = design.verification_of_a.filter((v) => v.index >= correctness.findings.length);
if (stray.length) {
  die(`review/design.json verifies finding(s) ${stray.map((v) => v.index).join(', ')}, and ` +
    `review/correctness.json has ${correctness.findings.length} (indexes are 0-based)`);
}

const merged = mergeReviewFindings(correctness, design);

// Every string the reviewers wrote goes on ONE line of a line this script started.
//
// They were rendered as written, into a comment posted under the pipeline's name — and what the
// pipeline posts is trusted: a failure packet is a json block in a pipeline comment, and
// fetch-failure-packet takes one off the PR. A claim that carried a fenced packet was that
// packet. With no line break of their own, the reviewers' words can open no line, so they can
// neither close a fence nor start a heading or a marker.
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const icon = { blocking: '🔴', major: '🟠', minor: '⚪' };
const lines = [`## Review — ${merged.verdict === 'approve' ? 'no blocking findings' : `${merged.blocking_count} blocking`}`, ''];

if (!merged.findings.length) {
  lines.push('Two reviewers read this independently and neither found anything blocking.');
} else {
  lines.push('Each finding below was raised by one reviewer and independently checked by the other.', '');
  for (const f of merged.findings) {
    const where = f.file ? `\`${one(f.file)}${f.line ? `:${one(f.line)}` : ''}\`` : '';
    lines.push(`${icon[f.severity] ?? '·'} **${f.severity}** ${where} — ${one(f.claim)}`);
    if (f.evidence) lines.push(`  - evidence: ${one(f.evidence)}`);
    if (f.fix) lines.push(`  - fix: ${one(f.fix)}`);
    if (f.note) lines.push(`  - _second reviewer considered this overstated: ${one(f.note)}_`);
    if (f.verified === false) lines.push('  - _not independently verified — the second reviewer did not reach it_');
  }
}

if (merged.dropped.length) {
  lines.push('', `<details><summary>${merged.dropped.length} finding(s) dropped on verification</summary>`, '');
  for (const d of merged.dropped) lines.push(`- ~~${one(d.claim)}~~ — ${one(d.dropped_because)}`);
  lines.push('', 'These were raised by one reviewer and disproved by the other. Recorded rather than',
    'posted as fact: a review that is wrong about something checkable spends its credibility.', '', '</details>');
}

lines.push('', '---',
  '_Two reviewers, each verifying the other. This comment is the reasoning; the formal review',
  'is submitted separately from the merged verdict, so what the PR shows and what the pipeline',
  'recorded are the same thing._');

await gh(['pr', 'comment', pr, '--body', lines.join('\n')]);

// The council posts a comment, never a review, so route-review cannot read what it decided off
// the PR. It reads this: the verdict, what the blocking findings were about, and the findings
// left unfixed.
const out = resolve('review/merged.json');
writeFileSync(out, `${JSON.stringify({
  verdict: merged.verdict, blocking_criteria: merged.blocking_criteria, unresolved: merged.unresolved,
}, null, 2)}\n`);
setOutput('merged', out);
setOutput('verdict', merged.verdict);
setOutput('blocking', String(merged.blocking_count));
process.stdout.write(`${merged.findings.length} posted, ${merged.dropped.length} dropped, verdict ${merged.verdict}\n`);
