#!/usr/bin/env node
// The last day's self-fixes, said once a day where a person looks.
//
// A self-fix merges without anyone watching, which is the point, and is also why it must never
// be quiet: every one lands in this digest — merged, raised on the framework, refused, or still
// running — as a comment on one tracking issue (sdlc:self-fix, parked: nothing starts it).
// Nothing is posted on a day with none.
import { gh, ghJson, repo as repoOf, isPipelineAuthor } from './lib/actions.js';
import { readLedger } from './lib/state-io.js';

const repo = repoOf();
const since = Date.now() - 24 * 3600_000;
const { ledger } = await readLedger(repo, 'self-fix').catch(() => ({ ledger: null }));
const day = (ledger?.fixes ?? []).filter((f) => Date.parse(f.updated_at ?? f.at) >= since);
if (!day.length) {
  process.stdout.write('no self-fixes in the last 24 hours\n');
  process.exit(0);
}

const first = (s) => String(s ?? '').split('\n').find(Boolean) ?? '';
const upstream = (f) => (f.upstream?.url ? `framework PR ${f.upstream.url}` : `not raised on the framework (${f.upstream?.why ?? 'no token'}) — \`sdlc contribute ${repo} ${f.run}\``);
const outcome = (f) => ({
  landed: `**merged** ${f.local?.pr ?? ''}; ${upstream(f)}`,
  raised: `**proven, not merged here** — ${first(f.why)}; ${upstream(f)}`,
  refused: `**refused**, stopped for a person — ${first(f.why)}`,
  dispatched: '**still running**, or its run died — the stage runs again on its own after four hours',
}[f.status] ?? `**${f.status}**`);

const body = [
  `## Self-fixes in the last 24 hours — ${day.length}`,
  '',
  ...day.map((f) => `- #${f.issue} \`${f.stage}\` · \`${f.file}\` — ${f.what}\n  ${outcome(f)}`),
  '',
  '_Each was held to lib/self-fix.js: plumbing only — no rule, no prompt — a regression test that ' +
  'fails without the fix, the framework\'s whole suite, and the maintainer\'s consent._',
].join('\n');

const open = (await ghJson(['api', `repos/${repo}/issues?state=open&labels=sdlc:self-fix&per_page=100`]))
  .find((i) => !i.pull_request && isPipelineAuthor(i.user?.login));
if (open) await gh(['issue', 'comment', String(open.number), '--body', body]);
else {
  await gh(['issue', 'create', '--title', 'Pipeline self-fixes', '--label', 'sdlc:self-fix', '--body',
    'The pipeline fixes defects in its own plumbing (see the README, "The pipeline fixes its own bugs"). ' +
    'Each day that has any, they are listed here.\n\n' + body]);
}
process.stdout.write(`posted the digest of ${day.length} self-fix(es)\n`);
