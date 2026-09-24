#!/usr/bin/env node
// Files what the maintainer's survey found worth filing, from survey.json.
//
// The survey agent filed its findings itself, with its job's token — which could file, edit,
// label and close any issue as github-actions[bot], whose issues intake trusts and the loop
// starts — after reading every open issue and comment, which anyone can write on a public
// repository. It runs read-only now and writes what it found down; this files each entry from a
// job that never ran it, and does nothing an entry does not ask for.
//
// Nothing is started from here. A finding carries no state label — intake is what gives an
// issue one, and a label placed by whoever filed it counted as in flight for an issue nothing
// ever started — so the watchdog's top-up starts it, up to max_in_flight. An epic is not
// started at all: it is split when it is next, against the architecture that exists by then.

import { existsSync } from 'node:fs';
import { gh, ghJson, die, repo as repoOf } from './lib/actions.js';
import { loadArtifact } from './lib/artifact.js';
import { agentText, linkEpics } from './lib/split.js';

const repo = repoOf();
if (!existsSync('survey.json')) {
  process.stdout.write('the survey wrote no survey.json — nothing to file\n');
  process.exit(0);
}
const art = loadArtifact('survey', 'survey.json');
if (!art.ok) die(`survey.json cannot be filed:\n${art.errors.map((e) => `- ${e}`).join('\n')}`);

// A re-run of this job files the same list again. An open issue with the same title is that
// finding, filed by this run or the one before it.
const open = new Set((await ghJson(['api', '--paginate', '--slurp', `repos/${repo}/issues?state=open&per_page=100`]))
  .flat().map((i) => String(i.title).trim().toLowerCase()));

for (const f of art.data.issues) {
  const key = f.title.trim().toLowerCase();
  if (open.has(key)) {
    process.stdout.write(`already open, not filed again: ${f.title}\n`);
    continue;
  }
  const url = await gh(['issue', 'create', '--title', f.title, '--body', agentText(f.body),
    ...(f.epic ? ['--label', 'sdlc:epic'] : [])]);
  open.add(key);
  process.stdout.write(`${url}: ${f.title}${f.epic ? ' (epic)' : ''}\n`);
}

await linkEpics(art.data.epic_links ?? []);
