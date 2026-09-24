#!/usr/bin/env node
// Add one merged PR's release notes to the single rolling draft release, "Unreleased".
//
// The release agent used to commit CHANGELOG, docs and a version bump straight to main, with
// Bash, Edit and contents: write — no gate, no diff check, and two merges a minute apart racing
// each other's pushes. It writes notes now, and this files them where nothing ships until a
// person publishes the draft and chooses its version.
import { gh, ghJson, die } from './lib/actions.js';

const TAG = 'unreleased';
const pr = process.env.PR;
const notes = String(process.env.NOTES ?? '').trim();
if (!notes) {
  process.stdout.write(`PR #${pr}: the agent wrote no release notes — nothing to add\n`);
  process.exit(0);
}

// A merge recorded twice — the watchdog reconciling one whose follow-up died — dispatches the
// release twice. The marker keeps it to one entry.
const marker = `<!-- sdlc:pr ${pr} -->`;
const entry = `${marker}\n### #${pr}\n\n${notes}`;

/** The draft's body, or null when there is no draft. */
async function read() {
  try {
    return (await ghJson(['release', 'view', TAG, '--json', 'body'])).body ?? '';
  } catch (e) {
    // Only "there is no such release" means create one. Anything else — auth, an outage — would
    // otherwise create a second draft beside the first.
    if (!/release not found|HTTP 404/i.test(String(e.stderr ?? e.message))) throw e;
    return null;
  }
}

// Releases run side by side. They queued in one workflow-level concurrency group, and GitHub
// keeps ONE pending run per group — a third merge's dispatch cancelled the second's, whose notes
// were then never written. But a release body has no compare-and-swap either: two runs that read
// it together each write back their own entry on the same old body, and the later write drops the
// earlier one. So each run writes, waits for a write that read before its own to land, reads back
// and appends again when its entry is gone. A run that re-appends has read the other's entry, so
// both survive.
// ponytail: the wait (2-4s) is what "landed" means; a writer slower than that between its read and
// its write can still drop an entry. A per-PR asset or comment would need no merging at all.
const settle = () => new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));
for (let wrote = 0; ; wrote++) {
  const body = await read();
  if (body?.includes(marker)) {
    process.stdout.write(`PR #${pr}: ${wrote ? 'added to' : 'already in'} the Unreleased draft release\n`);
    process.exit(0);
  }
  if (wrote === 5) die(`PR #${pr}: its notes were written to the Unreleased draft five times and overwritten each time`);
  if (body === null) await gh(['release', 'create', TAG, '--draft', '--title', 'Unreleased', '--notes', entry]);
  else await gh(['release', 'edit', TAG, '--notes', `${body.trimEnd()}\n\n${entry}`]);
  await settle();
}
