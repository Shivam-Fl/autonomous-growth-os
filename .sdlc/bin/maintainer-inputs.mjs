#!/usr/bin/env node
// Everything of GitHub the maintainer agent reads, fetched before it runs, into maintainer/.
//
// The survey told the agent to `gh issue list` every open issue, and the split to read the epic's
// thread, with Bash and a read token — on a public repository, text anyone can write. The job
// could write nothing by then, but what the agent writes is still acted on as the pipeline's own:
// a survey.json entry is filed as github-actions[bot], which intake trusts and the watchdog
// starts, and from there it can be split, built and merged with nobody looking. One outsider's
// issue steering an open-weight survey was one trusted, unattended ticket.
//
// So this reads GitHub instead, in the same read-only job, and keeps only what the project's own
// people and the pipeline wrote. Anyone else's open issue is its number and nothing more: enough
// to count, nothing to obey. The agent has no shell (claude-args), so nothing else reaches it.
//
//   issues.json   every open issue: {number, title, labels, createdAt, body} by a trusted author,
//                 {number, untrusted: true} otherwise
//   pulls.json    open PRs from this repository's own branches (a fork's are anyone's)
//   closed.json   the last 30 closed issues a trusted author filed
//   roadmap.md    the last survey's roadmap, from sdlc-state (absent on the first)
//   epic.json     for a split: the epic, the decisions recorded on it, its trusted comments, the
//                 last breakdown and each child the ledger lists, with its body
import { mkdirSync, writeFileSync } from 'node:fs';
import { gh, ghJson, loadConfig, isTrustedAuthor, trustedComments, repo as repoOf } from './lib/actions.js';
import { readLedger, STATE_BRANCH } from './lib/state-io.js';
import { recordedDecisions } from './lib/route.js';

const cfg = await loadConfig();
const repo = repoOf();
mkdirSync('maintainer', { recursive: true });
const write = (file, data) => writeFileSync(`maintainer/${file}`,
  typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`);

// The REST issue shape, because it carries author_association: an allowlisted name is trusted
// only while that account can also write here.
const trusted = (i) => isTrustedAuthor({ login: i.user?.login, association: i.author_association }, cfg);
const shown = (i) => ({ number: i.number, title: i.title, labels: (i.labels ?? []).map((l) => l.name ?? l),
  createdAt: i.created_at, body: i.body ?? '' });
// The issues endpoint lists pull requests too.
const issues = (list) => list.flat().filter((i) => !i.pull_request);

const open = issues(await ghJson(['api', '--paginate', '--slurp', `repos/${repo}/issues?state=open&per_page=100`]));
write('issues.json', open.map((i) => (trusted(i) ? shown(i) : { number: i.number, untrusted: true })));

const pulls = await ghJson(['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,headRefName,isDraft,isCrossRepository']);
write('pulls.json', pulls.filter((p) => p.isCrossRepository === false)
  .map(({ number, title, headRefName, isDraft }) => ({ number, title, headRefName, isDraft })));

// One page, newest first, is plenty: the roadmap's "Shipped" wants what closed lately.
const closed = issues(await ghJson(['api', `repos/${repo}/issues?state=closed&sort=updated&direction=desc&per_page=100`]));
write('closed.json', closed.filter(trusted).sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)))
  .slice(0, 30).map((i) => ({ number: i.number, title: i.title, closedAt: i.closed_at })));

const roadmap = await gh(['api', `repos/${repo}/contents/roadmap.md?ref=${STATE_BRANCH}`, '-H', 'Accept: application/vnd.github.raw'])
  .catch((e) => {
    if (/404|Not Found/.test(String(e.stderr ?? e.message))) return null;
    throw e;
  });
if (roadmap !== null) write('roadmap.md', `${roadmap}\n`);

const epic = process.env.EPIC;
if (epic) {
  const { ledger } = await readLedger(repo, epic);
  const issue = await ghJson(['api', `repos/${repo}/issues/${epic}`]);
  const children = [];
  for (const n of ledger?.children ?? []) {
    const c = await ghJson(['api', `repos/${repo}/issues/${n}`]);
    children.push({ ...shown(c), state: c.state });
  }
  write('epic.json', {
    ...shown(issue),
    // Its Decisions section as the pipeline recorded it: on an outsider's epic, only the entries
    // the ledger also holds. The agent cannot read the ledger to check the body itself.
    decisions: recordedDecisions(issue.body, { reporterTrusted: trusted(issue), ledger }),
    comments: (await trustedComments('issue', epic, cfg)).map(({ login, createdAt, body }) => ({ author: login, createdAt, body })),
    breakdown: ledger?.breakdown ?? null,
    children,
  });
}
process.stdout.write(`maintainer/: ${open.length} open issue(s), ${open.filter((i) => !trusted(i)).length} by someone else, ` +
  `${pulls.length} open PR(s)${epic ? `, epic #${epic}` : ''}\n`);
