#!/usr/bin/env node
// Is this work order already implemented on its branch?
//
// The first real ticket on tabs wrote a complete vertical slice, pushed the branch, and then
// failed at the last step because Actions could not open a pull request. Re-dispatching
// re-ran the agent from scratch — redoing twenty minutes of work to recover from a
// permissions setting, and producing a *different* implementation of the same plan than the
// one already reviewed.
//
// A branch ahead of base, for the same work order version, is finished work.

import { ghJson, setOutput } from './lib/actions.js';

const issue = process.env.ISSUE;
const branch = process.env.BRANCH ?? `sdlc/issue-${issue}`;
const base = process.env.BASE_BRANCH || 'main';
const repo = process.env.GITHUB_REPOSITORY;

const done = (why) => { setOutput('done', 'true'); process.stdout.write(why + '\n'); process.exit(0); };
const notDone = (why) => { setOutput('done', 'false'); process.stdout.write(why + '\n'); process.exit(0); };

// A rework is the one case where an existing branch is NOT finished work — it is precisely
// the work that was rejected. Without this, routing a rejected PR back to the implementer
// skips the agent entirely and re-opens the same PR unchanged: the pipeline would look busy
// and change nothing. Same for a QA failure, which also re-enters implementation.
const rework = (process.env.REWORK ?? '').trim();
if (rework) notDone(`rework requested (${rework}) — the branch is what was rejected, not the answer to it`);

const cmp = await ghJson(['api', `repos/${repo}/compare/${base}...${branch}`]).catch(() => null);
if (!cmp?.files?.length) notDone('branch has no changes yet — implementing');

// A revised work order means the plan changed, so the existing work is answering the wrong
// question and must be redone. Version is the signal, not the file count.
const { ledger } = await import('./lib/state-io.js').then((m) => m.readLedger(repo, Number(issue))).catch(() => ({ ledger: null }));
const implemented = ledger?.implemented_version;

let current = null;
const data = await ghJson(['issue', 'view', issue, '--json', 'comments']).catch(() => null);
for (const c of (data?.comments ?? []).slice().reverse()) {
  const m = c.body?.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) continue;
  try {
    const wo = JSON.parse(m[1]);
    if (wo.files) { current = wo.version ?? 1; break; }
  } catch { /* not a work order */ }
}

if (implemented && current && implemented !== current) {
  notDone(`branch implements work order v${implemented}, but v${current} is current — reimplementing`);
}
done(`branch ${branch} is already ${cmp.files.length} file(s) ahead of ${base} — skipping the agent and opening the PR`);
