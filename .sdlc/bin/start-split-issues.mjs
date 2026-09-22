#!/usr/bin/env node
// Starts intake on every issue an epic split produced.
//
// An issue created by an agent fires no `issues.opened` event — GitHub refuses to trigger a
// workflow from a GITHUB_TOKEN action. So a split leaves six perfectly good issues that
// nothing ever looks at, and the failure is invisible: the issues exist, they are labelled
// correctly, and they simply sit there.
//
// Deterministic rather than asked of the agent: a step the model might skip is a step that
// will be skipped eventually, and this one fails silently when it is.

import { existsSync, readFileSync } from 'node:fs';
import { gh, ghJson, setOutput } from './lib/actions.js';

const epic = process.env.EPIC;

// Prefer what the agent recorded; fall back to reading the epic's links, so a missing
// breakdown.json does not strand the issues.
let numbers = [];
if (existsSync('breakdown.json')) {
  const created = JSON.parse(readFileSync('breakdown.json', 'utf8')).created ?? [];
  numbers = created.map(Number).filter(Number.isInteger);
}
if (!numbers.length) {
  const all = await ghJson(['issue', 'list', '--state', 'open', '--limit', '60', '--json', 'number,body,labels']);
  numbers = all
    .filter((i) => String(i.number) !== String(epic))
    .filter((i) => (i.labels ?? []).some((l) => l.name === 'sdlc:triage'))
    .filter((i) => new RegExp(`#${epic}\\b`).test(i.body ?? ''))
    .map((i) => i.number);
}

if (!numbers.length) {
  process.stdout.write(`no split issues found for epic #${epic}\n`);
  setOutput('started', '0');
  process.exit(0);
}

let started = 0;
for (const n of numbers) {
  try {
    await gh(['workflow', 'run', 'sdlc-intake.yml', '-f', `issue=${n}`]);
    process.stdout.write(`intake started for #${n}\n`);
    started++;
  } catch (e) {
    process.stdout.write(`could not start intake for #${n}: ${String(e.message).split('\n')[0]}\n`);
  }
}
// The epic itself is now a tracker: its work lives in the issues above, and it must not be
// planned or built. The plan workflow already refuses anything labelled sdlc:epic, but a
// lingering sdlc:planning label says the opposite to every human who reads the board.
await gh(['issue', 'edit', String(epic), '--remove-label', 'sdlc:planning']).catch(() => {});
await gh(['issue', 'comment', String(epic),
  '--body', `Split into ${numbers.length} issues: ${numbers.map((n) => `#${n}`).join(', ')}\n\n` +
  'This epic is now a tracker — it is not planned or implemented itself, and closes when its ' +
  'children do. Each issue above goes through the pipeline on its own.']).catch(() => {});

setOutput('started', String(started));
process.stdout.write(`${started}/${numbers.length} issues handed to intake; epic #${epic} parked as a tracker\n`);
