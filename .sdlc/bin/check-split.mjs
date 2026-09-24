#!/usr/bin/env node
// The tripwire under the maintainer's clubbing test. Runs right after a split is posted.
//
// The prompt is where over-splitting is really fixed — the maintainer has to answer three
// questions about every adjacent pair and show its working. Prompt-level judgement is not
// perfect every time, so this is a mechanical check that costs nothing and looks for the one
// shape that has actually happened: a straight line of issues, each depending on exactly the
// one before it, with titles that read as the same work twice.
//
// It FLAGS and asks. It does not block, and it does not re-split anything. The heuristic is
// crude on purpose, and a crude check that stops work is worse than no check at all.

import { existsSync, readFileSync } from 'node:fs';
import { gh, ghJson, setOutput, loadConfig, die } from './lib/actions.js';
import { overSplit } from './lib/split.js';
import { dependenciesOf, epicOf } from './lib/deps.js';

const epic = process.env.EPIC ?? die('EPIC is required');
const cfg = await loadConfig();

// Prefer what the maintainer recorded; fall back to reading the epic's children, so a missing
// breakdown.json does not silently turn the check off. Same reasoning as start-split-issues:
// a step that quietly does nothing is worse than one that fails.
let pieces = [];

if (existsSync('breakdown.json')) {
  const bd = JSON.parse(readFileSync('breakdown.json', 'utf8'));
  const created = bd.created ?? [];
  pieces = (bd.pieces ?? []).map((p, i) => ({
    number: created[i] ?? i + 1,
    title: p.title,
    // breakdown.json's depends_on is 1-BASED INDEXES INTO pieces[], not issue numbers.
    depends_on: (p.depends_on ?? []).map((idx) => created[idx - 1] ?? idx),
  }));
}

if (!pieces.length) {
  const all = await ghJson(['issue', 'list', '--state', 'all', '--limit', '100', '--json', 'number,title,body']);
  pieces = all
    .filter((i) => epicOf(i.body) === Number(epic))
    .sort((a, b) => a.number - b.number)
    .map((i) => ({ number: i.number, title: i.title, depends_on: dependenciesOf(i.body) }));
}

if (pieces.length < 3) {
  process.stdout.write(`epic #${epic} has ${pieces.length} piece(s) — nothing to flag\n`);
  setOutput('flagged', 'false');
  process.exit(0);
}

const result = overSplit(pieces, {
  minChain: Number(cfg.maintainer?.flag_chain_of ?? 3),
  similarity: Number(cfg.maintainer?.flag_similarity ?? 0.5),
});

setOutput('flagged', String(result.flagged));
process.stdout.write(`epic #${epic}: ${result.summary}\n`);

if (!result.flagged) process.exit(0);

const body = [
  '## This split may be too fine',
  '',
  `${result.summary}.`,
  '',
  'The pairs that look like one piece rather than two:',
  '',
  ...result.pairs.map((p) =>
    `- **#${p.a}** and **#${p.b}** — _“${p.titles[0]}”_ / _“${p.titles[1]}”_ (similarity ${p.score})`),
  '',
  'This is a heuristic, and it is wrong sometimes — it only looks at titles and at the shape ' +
  'of the dependency chain. It fires on one specific mistake: splitting by the **structure of ' +
  'the spec** (each numbered bullet becomes an issue, in order) rather than by what can be ' +
  'shipped on its own. The cost of getting that wrong is real: each extra issue pays a full ' +
  'plan → implement → CI → review → QA cycle for what could have been another acceptance ' +
  'criterion on the issue before it.',
  '',
  'Three questions decide it, and the maintainer was asked to answer them above:',
  '',
  '1. Would the second piece touch substantially the same files as the first, or is it new surface?',
  '2. Is the second piece demoable on its own, or is it "the same feature, one more input mode"?',
  '3. Would both together still fit in one work order and one PR a human would review as a unit?',
  '',
  `Leave it as is if the split is right. \`/sdlc replan-epic\` re-splits with this in mind.`,
].join('\n');

await gh(['issue', 'comment', String(epic), '--body', body]).catch((e) =>
  process.stdout.write(`::warning::could not post the split warning: ${String(e.message).split('\n')[0]}\n`));
