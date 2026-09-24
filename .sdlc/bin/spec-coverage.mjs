#!/usr/bin/env node
// What of the spec has been built: one issue, rewritten in place on every survey.
//
// Nothing answered that. The watchdog reports issues that are stuck, `/sdlc status` shows one
// ledger, and the roadmap is prose the maintainer rebuilds from open issues — so on a project
// run unattended, the last issue could close with a third of the spec never split out and the
// pipeline simply went quiet. This joins the numbered spec, the brief's disposition for each
// section, and every issue's `Covers:` line into a table a person can read in a minute.
//
// Read-only except for its own issue, labelled sdlc:coverage (parked: nothing starts it).

import { existsSync, readFileSync } from 'node:fs';
import { gh, ghJson, isPipelineAuthor, isTrustedAuthor, loadConfig, repo as repoOf } from './lib/actions.js';
import { coversOf } from './lib/split.js';

const repo = repoOf();
const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
const index = read('.sdlc/memory/spec-index.json');
const brief = read('.sdlc/memory/project-brief.json');
if (!index || !brief) {
  process.stdout.write('no spec index or brief on this branch yet — nothing to trace\n');
  process.exit(0);
}

const listing = async (path) => (await ghJson(['api', '--paginate', '--slurp', `repos/${repo}/${path}`])).flat();
const issues = (await listing('issues?state=all&per_page=100')).filter((i) => !i.pull_request);
// The implementer's branch is sdlc/issue-<n>, which is the one link from an issue to its PR that
// does not need a ledger read per issue.
const prs = new Map((await listing('pulls?state=all&per_page=100'))
  .map((p) => [Number(String(p.head?.ref ?? '').match(/^sdlc\/issue-(\d+)$/)?.[1]), p])
  .filter(([n]) => n));

const coverage = new Map((brief.coverage ?? []).map((c) => [c.section, c]));
// Only the pipeline's and a trusted person's `Covers:` lines count. Anyone's did: an outsider's
// self-closed issue covering every requirement showed the unbuilt sections as built, and the
// survey, which looks for the next epic in this table, never saw them again.
const cfg = await loadConfig().catch(() => ({}));
const covering = (ids) => issues.filter((i) => isTrustedAuthor({ login: i.user?.login, association: i.author_association }, cfg)
  && coversOf(i.body).some((id) => ids.includes(id)));

const statusOf = (i) => {
  if (i.state === 'closed') return i.state_reason === 'not_planned' ? 'dropped' : 'built';
  return (i.labels ?? []).some((l) => (l.name ?? l) === 'sdlc:deferred') ? 'deferred' : 'in flight';
};
const cell = (i) => {
  const pr = prs.get(i.number);
  return `#${i.number} ${statusOf(i)}${pr ? ` (#${pr.number}${pr.merged_at ? ' merged' : ''})` : ''}`;
};

const rows = index.sections.map((s) => {
  const c = coverage.get(s.id);
  const refs = c?.refs ?? [];
  const by = covering([s.id, ...refs]);
  const states = by.map(statusOf);
  let status;
  if (!c) status = 'uncovered';
  else if (c.disposition === 'non_goal') status = 'non-goal';
  else if (c.disposition === 'deferred') status = 'deferred';
  else if (!by.length) status = 'not started';
  else if (states.every((x) => x === 'built')) status = 'built';
  else if (states.every((x) => x === 'dropped' || x === 'built') && states.includes('dropped')) status = 'dropped';
  else status = 'in flight';
  return { s, c, refs, by, status };
});

const count = (st) => rows.filter((r) => r.status === st).length;
const esc = (t) => String(t).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const body = [
  '# Spec coverage',
  '<!-- sdlc:coverage -->',
  '',
  'Rebuilt by the maintainer\'s survey from `.sdlc/memory/spec-index.json`, the brief\'s ' +
  '`coverage`, and every issue\'s `Covers:` line. It is rewritten in place — edit those, not this.',
  '',
  `${rows.length} sections: ${['built', 'in flight', 'not started', 'deferred', 'non-goal', 'dropped', 'uncovered']
    .map((st) => `${count(st)} ${st}`).join(', ')}.`,
  '',
  '| Section | Disposition | Carried by | Issues | Status |',
  '|---|---|---|---|---|',
  ...rows.map(({ s, c, refs, by, status }) =>
    `| ${s.id} ${esc(s.title)} | ${c?.disposition ?? '—'} | ${esc(refs.join(', ') || '—')} | ` +
    `${by.map(cell).join(', ') || '—'} | ${status} |`),
].join('\n');

const own = issues.find((i) => i.state === 'open' && isPipelineAuthor(i.user?.login)
  && (i.labels ?? []).some((l) => (l.name ?? l) === 'sdlc:coverage'));
if (own) await gh(['issue', 'edit', String(own.number), '--body', body]);
else await gh(['issue', 'create', '--title', 'Spec coverage', '--label', 'sdlc:coverage', '--body', body]);
process.stdout.write(`spec coverage: ${rows.length} section(s), ${count('built')} built, ${count('uncovered')} uncovered\n`);
