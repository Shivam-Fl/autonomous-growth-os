#!/usr/bin/env node
// A pull request that merged while its ledger still says the work is in progress.
//
// merge-pr merges with GITHUB_TOKEN, which fires no event, so it runs on-merge itself. When
// that follow-up was cancelled or crashed, nothing else would ever record the merge: the ledger
// stayed at qa-pass, the issue stayed open, and everything that depends on it stayed blocked.
// The watchdog runs this every sweep; on-merge is safe to run again, because it reconciles.
import { ghJson, loadConfig, isTrustedAuthor, repo as repoOf } from './lib/actions.js';
import { readLedger } from './lib/state-io.js';
import { openIssues } from './lib/open-issues.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const repo = repoOf();
const cfg = await loadConfig().catch(() => ({}));

// The open issues a merge can still be missing from, by label — one listing, not a read of every
// ledger ever created. A PR can merge once it is past the gate, and `merged` itself: a follow-up
// that died after writing it left the issue open with nothing that would ever retry it.
//
// And a parked issue, when it is ours or a trusted person's: a PR a person merged by hand while
// the issue was stopped, or the architecture brief merged while `sdlc halt` had disabled the loop
// that hears merges. An outsider's parked issue has no PR of the pipeline's to find.
const MERGEABLE = new Set(['ci-green', 'review', 'qa', 'qa-pass', 'merged'].map((s) => `sdlc:${s}`));
const candidates = (await openIssues(repo)).filter((i) => i.labels.some((l) => MERGEABLE.has(l))
  || (i.labels.includes('sdlc:needs-human') && isTrustedAuthor({ login: i.author, association: i.association }, cfg)));

const merged = async (pr) => pr && (await ghJson(['pr', 'view', String(pr), '--json', 'state']).catch(() => ({}))).state === 'MERGED';
const record = (pr) => exec('node', ['.sdlc/bin/on-merge.mjs'], { env: { ...process.env, PR: String(pr) } })
  .then((r) => process.stdout.write(r.stdout))
  .catch((e) => process.stdout.write(`::error::could not record the merge of PR #${pr}: ${String(e.stderr || e.message).trim().split('\n').pop()}\n`));

for (const { number: issue } of candidates) {
  const { ledger } = await readLedger(repo, issue).catch(() => ({ ledger: null }));
  if (!ledger) continue;
  if (ledger.state !== 'done' && await merged(ledger.pr)) {
    process.stdout.write(`issue #${issue}: PR #${ledger.pr} merged while the ledger said ${ledger.state} — recording it\n`);
    await record(ledger.pr);
  } else if (ledger.stopped_at === 'project' && await merged(ledger.brief_pr)) {
    // The brief's merge continues the issue rather than closing it, and on-merge's hand-off
    // clears stopped_at, so a brief already continued is not continued twice.
    process.stdout.write(`issue #${issue}: the brief PR #${ledger.brief_pr} merged and nothing continued it — continuing\n`);
    await record(ledger.brief_pr);
  }
}
