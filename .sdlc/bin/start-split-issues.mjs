#!/usr/bin/env node
// Creates the issues an epic's breakdown describes, and records the split on the ledger.
//
// The maintainer agent used to create them itself and, if it remembered, list their numbers
// in breakdown.json. This script then paired pieces with issues by position — by `created[i]`,
// or failing that by `gh issue list`, newest first — so "piece 2 depends on piece 1" was
// written as #11 depending on #12, or as a loop. breakdown.json was never validated, its
// `deferred` parts were read by nothing, each body was model prose, and a split that died half
// way left some issues created and nothing to say which. So the agent now writes the breakdown
// and nothing else, and every issue is made here, from it, with its number known by
// construction.
//
// It does not start them. An issue created with the pipeline's token fires no event, and
// dispatching intake for every child at once ignored `max_in_flight`; the wake that runs next
// starts whichever pieces have no open dependency, up to the cap, and the rest are started as
// their dependencies close.
//
// A split is recorded before anything is created, and each issue as it is made. A rerun after
// a failure finishes THAT split rather than starting a second set.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gh, ghJson, setOutput, die, repo as repoOf } from './lib/actions.js';
import { loadArtifact } from './lib/artifact.js';
import { readLedger, updateLedger } from './lib/state-io.js';
import { newLedger } from './lib/ledger.js';
import { decisionsOf, upsertDecisions } from './lib/issue-body.js';
import { agentText, creationOrder, linkEpics, splitIssueBody } from './lib/split.js';

const repo = repoOf();
const epic = Number(process.env.EPIC) || die('EPIC is required');
const resplit = process.env.RESPLIT === 'true';

const issueNumber = (url) => Number(String(url).trim().match(/\/issues\/(\d+)$/)?.[1]) || null;

/** breakdown.json repaired and validated, or the run stops before anything is made. */
function loadBreakdown() {
  // `deferred` was a list of strings until each part had to be filed; a string is still what a
  // model writes first, and it can only mean the part deferred.
  if (existsSync('breakdown.json')) {
    try {
      const raw = JSON.parse(readFileSync('breakdown.json', 'utf8'));
      if (Array.isArray(raw?.deferred) && raw.deferred.some((d) => typeof d === 'string')) {
        raw.deferred = raw.deferred.map((d) => (typeof d === 'string' ? { what: d } : d));
        writeFileSync('breakdown.json', `${JSON.stringify(raw, null, 2)}\n`);
      }
    } catch { /* not JSON: loadArtifact says so */ }
  }
  const art = loadArtifact('breakdown', 'breakdown.json');
  if (!art.ok) die(`breakdown.json cannot be split into issues:\n${art.errors.map((e) => `- ${e}`).join('\n')}`);
  try { creationOrder(art.data.pieces); } catch (e) { die(e.message); }
  const { created: _ignored, ...data } = art.data;
  return data;
}

const { ledger } = await readLedger(repo, epic);
let bd = ledger?.breakdown ?? null;
// A re-split's view of each issue the epic was split into, as it is now.
const kids = new Map();
if (resplit) {
  // A re-split changes the issues the split made: keeps and rewrites them, absorbs one into
  // another, and adds only the pieces its breakdown names no issue for. The agent used to make
  // those edits itself, with a token that could edit or close any issue in the repository; it
  // now writes the whole split as it should be, and this makes it — to the issues this epic's
  // ledger says it was split into, and no others.
  const recorded = ledger?.children ?? [];
  if (!recorded.length) {
    process.stdout.write(`::warning::epic #${epic} has no split recorded on its ledger, so there is nothing to ` +
      're-split — and creating one here would be the second set a re-split exists to avoid\n');
    setOutput('created', '0');
    process.exit(0);
  }
  const data = loadBreakdown();
  for (const n of recorded) kids.set(n, await ghJson(['issue', 'view', String(n), '--json', 'state,body']));
  const named = data.pieces.flatMap((p) => [p.issue, ...(p.absorbs ?? [])]).filter(Boolean);
  const problems = [
    ...named.filter((n) => !kids.has(n)).map((n) => `#${n} is not one of this epic's issues (${recorded.map((k) => `#${k}`).join(', ')})`),
    ...named.filter((n, i) => named.indexOf(n) !== i).map((n) => `#${n} is named more than once`),
    ...recorded.filter((n) => kids.get(n).state === 'OPEN' && !named.includes(n))
      .map((n) => `#${n} is open and neither kept (a piece's \`issue\`) nor absorbed`),
  ];
  if (problems.length) die(`breakdown.json cannot re-split #${epic}:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  bd = {
    ...data, epic,
    pieces: data.pieces.map((p) => ({ ...p, issue: p.issue ?? null })),
    // What an earlier split deferred is filed already; only what this one leaves out is new.
    deferred: [...(bd?.deferred ?? []), ...(data.deferred ?? []).map((d) => ({ ...d, issue: null }))],
  };
} else if (bd?.pieces?.some((p) => p.issue) || bd?.deferred?.some((d) => d.issue)) {
  process.stdout.write(`epic #${epic} is already part way through a split — finishing that one; ` +
    'this run\'s breakdown.json is not used\n');
} else {
  const data = loadBreakdown();
  bd = {
    ...data, epic,
    // `issue` and `absorbs` are a re-split's: a first split has no issue to keep or fold in.
    pieces: data.pieces.map(({ absorbs: _absorbs, ...p }) => ({ ...p, issue: null })),
    deferred: (data.deferred ?? []).map((d) => ({ ...d, issue: null })),
  };
}

const { order, deps, dropped } = creationOrder(bd.pieces);
for (const { piece, dep } of dropped) {
  process.stdout.write(`::warning::piece ${piece} depends on "${dep}", which is not another piece — dropped\n`);
}

// Written whole each time, from here: this run is the only writer of an epic's breakdown (the
// workflow's concurrency group is per epic), and a partial write would be a split nobody can
// finish.
const record = (extra = {}) => updateLedger(repo, epic, (l) => ({
  ...(l ?? newLedger(epic)),
  breakdown: bd,
  children: bd.pieces.map((p) => p.issue).filter(Boolean),
  ...extra,
}));
await record();

// The epic's decisions reach every child. A person's answer on the epic — "Meta first, Google
// after" — reached the maintainer once, as whatever prose it chose to write, and no planner of
// any piece ever read it.
const epicBody = await ghJson(['issue', 'view', String(epic), '--json', 'body']).then((d) => d.body ?? '');
const decisions = decisionsOf(epicBody);

for (const i of order) {
  const piece = bd.pieces[i];
  if (piece.issue) continue;
  const dependsOn = deps[i].map((d) => bd.pieces[d].issue);
  let body = splitIssueBody(piece, { epic, dependsOn });
  if (decisions.length) body = upsertDecisions(body, decisions);
  // No state label. Intake is what gives an issue one, and a label placed here — sdlc:triage,
  // as the agent used to — counts as in flight for an issue nothing ever started.
  const n = issueNumber(await gh(['issue', 'create', '--title', piece.title, '--body', body]));
  if (!n) die(`gh issue create returned no issue for piece ${i + 1}`);
  piece.issue = n;
  await record();
  // Its own ledger, knowing its epic. One with a dependency still open is parked, so the
  // watchdog does not report a piece that is correctly waiting as stalled.
  await updateLedger(repo, n, (l) => ({
    ...(l ?? { ...newLedger(n), state: dependsOn.length ? 'blocked' : 'triage' }), epic,
  }));
  process.stdout.write(`#${n}: ${piece.title}${dependsOn.length ? ` (after ${dependsOn.map((d) => `#${d}`).join(', ')})` : ''}\n`);
}

// A re-split's kept issues say what the new split says of them, dependencies renumbered — once
// every piece has a number. A closed one is finished work and is left as it is; decisions a
// person recorded on it, or on the epic, are carried over.
for (const i of order) {
  const piece = bd.pieces[i];
  if (kids.get(piece.issue)?.state !== 'OPEN') continue;
  const body = upsertDecisions(splitIssueBody(piece, { epic, dependsOn: deps[i].map((d) => bd.pieces[d].issue) }),
    [...decisionsOf(kids.get(piece.issue).body), ...decisions]);
  await gh(['issue', 'edit', String(piece.issue), '--title', piece.title, '--body', body]);
  process.stdout.write(`#${piece.issue}: rewritten as "${piece.title}"\n`);
}
// Closed as not planned, so nothing counts it as built. Only this epic's issues are renumbered
// above: an issue elsewhere that depended on an absorbed one keeps the link and parks on it,
// which is a person's to re-point.
for (const piece of bd.pieces) {
  for (const m of piece.absorbs ?? []) {
    if (kids.get(m)?.state !== 'OPEN') continue;
    await gh(['issue', 'comment', String(m), '--body',
      `Absorbed into #${piece.issue} when #${epic} was re-split: its acceptance criteria are that issue's now, ` +
      `and the reasons are on #${epic}.`]);
    await gh(['issue', 'close', String(m), '--reason', 'not planned']);
    process.stdout.write(`#${m}: absorbed into #${piece.issue}\n`);
  }
}

// What the split deliberately left out, filed where it cannot be forgotten. Parked by its label,
// so nothing starts it until a person or a later split decides it is next.
for (const d of bd.deferred) {
  if (d.issue) continue;
  const title = d.what.split('\n')[0].slice(0, 120);
  const body = `${agentText(d.what)}\n\n${d.why ? `**Why not now.** ${agentText(d.why)}\n\n` : ''}` +
    `${d.covers?.length ? `Covers: ${d.covers.join(', ')}\n` : ''}Deferred when #${epic} was split. Part of #${epic}.\n`;
  d.issue = issueNumber(await gh(['issue', 'create', '--title', title, '--label', 'sdlc:deferred', '--body', body]));
  if (!d.issue) die('gh issue create returned no issue for a deferred part');
  await record();
}

// The epic is now a tracker: its work lives in the issues above, it is never planned or built
// itself, and it closes when they are done. Every stage label comes off — it carried
// sdlc:plan-review, sdlc:needs-human and sdlc:epic at once after one split, and the needs-human
// kept it on the watchdog's stall list for as long as it existed — and sdlc:epic goes on, because
// an epic routed to the maintainer without it was re-woken as an ordinary issue once stripped.
const children = bd.pieces.map((p) => p.issue);
await record({ tracker: true, blocked_on: children });
for (const label of ['sdlc:planning', 'sdlc:plan-review', 'sdlc:needs-human', 'sdlc:triage']) {
  await gh(['issue', 'edit', String(epic), '--remove-label', label]).catch(() => {});
}
await gh(['issue', 'edit', String(epic), '--add-label', 'sdlc:epic']).catch((e) =>
  process.stdout.write(`::warning::could not label #${epic} sdlc:epic: ${String(e.message).split('\n')[0]}\n`));

// The agent's understanding goes out under the pipeline's name, so quoted: the readers of the
// pipeline's own comments trust a marker or a fenced block in one, and the agent wrote this after
// reading comments anyone can post.
const deferred = bd.deferred.map((d) => `#${d.issue}`);
const absorbed = bd.pieces.flatMap((p) => (p.absorbs ?? []).map((m) => `#${m} into #${p.issue}`));
await gh(['issue', 'comment', String(epic), '--body',
  `${resplit ? 'Re-split' : 'Split'} into ${children.length} issues: ${children.map((n) => `#${n}`).join(', ')}\n\n` +
  (absorbed.length ? `Absorbed, and closed: ${absorbed.join(', ')}\n\n` : '') +
  (deferred.length ? `Deferred, and filed so it is not forgotten: ${deferred.join(', ')}\n\n` : '') +
  (bd.understanding ? `${bd.understanding.split('\n').map((l) => `> ${l}`).join('\n')}\n\n` : '') +
  'This epic is now a tracker — it is not planned or implemented itself, and closes when its ' +
  'children do. Each issue above goes through the pipeline on its own, as soon as what it ' +
  'depends on has closed and a slot is free.']).catch(() => {});

// Which other epics this one waits on, or which wait on it — the agent's to judge, and this
// run's to write.
await linkEpics(bd.epic_links ?? []);

// The split as made, for check-split and for the copy the workflow keeps — the recorded one when
// this run finished an earlier split, not whatever the agent wrote this time.
writeFileSync('breakdown.json', `${JSON.stringify({ ...bd, created: children }, null, 2)}\n`);
setOutput('created', String(children.length));
process.stdout.write(`epic #${epic}: ${children.length} issue(s), ${deferred.length} deferred; parked as a tracker\n`);
