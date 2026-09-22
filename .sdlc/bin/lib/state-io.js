// Reads and writes the per-issue ledger on the orphan branch `sdlc-state`.
//
// Orphan branch, not main: state churn never conflicts with a feature branch and never
// triggers CI. All IO goes through `gh api`, so there is no git checkout dance in the
// workflow and no extra dependency here.
//
// Writes are compare-and-swap on the blob SHA. Two workflows racing on the same issue is
// normal (a push and a comment can land in the same second) — the loser retries against
// fresh state rather than clobbering it.

// One `gh` implementation for the whole pipeline. This module used to carry its own copy —
// the one that already knew stdin exists — and the shared one kept passing documents through
// argv until that hit E2BIG. Two copies means the next fix lands in one of them.
import { gh } from './actions.js';

export const STATE_BRANCH = 'sdlc-state';
const pathFor = (issue) => `state/${issue}.json`;

const BRANCH_README = `# sdlc-state

Per-issue ledgers for the Automated AI SDLC, one JSON file per issue under \`state/\`.

This is an **orphan branch**: it shares no history with \`main\`. State churns constantly, and
keeping it here means those writes never conflict with a feature branch and never trigger CI.

Written by workflows via compare-and-swap. Do not merge this branch into anything, and do not
hand-edit a ledger while an agent holds its lock.
`;

/** Create the orphan branch if this is the first run. Idempotent. */
export async function ensureStateBranch(repo) {
  try {
    await gh(['api', `repos/${repo}/branches/${STATE_BRANCH}`]);
    return { created: false };
  } catch {
    // Orphan branch: a commit with NO parents, so it shares no history with main.
    // Seeded with a README because a bare branch that appears in the UI with no explanation
    // is the kind of thing someone deletes six months later.
    const post = (path, body) =>
      gh(['api', `repos/${repo}/${path}`, '-X', 'POST', '--input', '-'], {
        input: JSON.stringify(body),
      });

    const blob = JSON.parse(await post('git/blobs', { content: BRANCH_README, encoding: 'utf-8' }));
    const tree = JSON.parse(
      await post('git/trees', {
        tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blob.sha }],
      }),
    );
    const commit = JSON.parse(
      await post('git/commits', { message: `init ${STATE_BRANCH}`, tree: tree.sha, parents: [] }),
    );
    await post('git/refs', { ref: `refs/heads/${STATE_BRANCH}`, sha: commit.sha });
    return { created: true };
  }
}

/** @returns {{ledger: object|null, sha: string|null}} sha is required to write it back. */
export async function readLedger(repo, issue) {
  try {
    const raw = await gh([
      'api', `repos/${repo}/contents/${pathFor(issue)}?ref=${STATE_BRANCH}`,
    ]);
    const file = JSON.parse(raw);
    return { ledger: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')), sha: file.sha };
  } catch (e) {
    if (/404|Not Found/.test(String(e.stderr ?? e.message))) return { ledger: null, sha: null };
    throw e;
  }
}

/**
 * Compare-and-swap write. Pass the sha from readLedger; a mismatch means someone else wrote
 * first and this call throws rather than overwriting their update.
 */
export async function writeLedger(repo, issue, ledger, sha, message) {
  const content = Buffer.from(JSON.stringify(ledger, null, 2) + '\n').toString('base64');
  const args = [
    'api', `repos/${repo}/contents/${pathFor(issue)}`, '-X', 'PUT',
    '-f', `message=${message ?? `ledger: issue #${issue} -> ${ledger.state}`}`,
    '-f', `content=${content}`,
    '-f', `branch=${STATE_BRANCH}`,
  ];
  if (sha) args.push('-f', `sha=${sha}`);
  return JSON.parse(await gh(args));
}

/**
 * Read, mutate, write — retrying on a lost race. `mutate` must be pure and safe to re-run,
 * because it will be called again with fresh state if someone else wrote in between.
 */
/**
 * @param {{attempts?: number}} opts
 *
 * Eight attempts with JITTERED backoff, not four with fixed.
 *
 * Every issue writes its own `state/<n>.json`, so the contention is not over the file — it is
 * the branch head, which every write commits to. That is invisible until something makes the
 * writes simultaneous, and a fan-out does exactly that by construction: one maintainer split
 * created four issues, four intakes started within a second, and one of them exhausted four
 * retries in about three seconds and failed with
 * "is at 89053c80 but expected 4cd98611 (HTTP 409)".
 *
 * Fixed backoff is the deeper half of that bug. Four writers that collide once retry after
 * the same 200ms, collide again, wait the same 400ms, and stay in lockstep all the way to the
 * cap — the delays grow but the collisions never thin out. Jitter is what decorrelates them,
 * and it matters more here than the extra attempts do.
 */
export async function updateLedger(repo, issue, mutate, { attempts = 8 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    const { ledger, sha } = await readLedger(repo, issue);
    const next = await mutate(ledger);
    if (next === null || next === undefined) return { skipped: true, ledger };
    try {
      await writeLedger(repo, issue, next, sha);
      return { skipped: false, ledger: next };
    } catch (e) {
      lastError = e;
      if (!/409|conflict|does not match/i.test(String(e.stderr ?? e.message))) throw e;
      // Full jitter: a random point in the whole window rather than the window's edge.
      const ceiling = Math.min(200 * 2 ** i, 8000);
      await new Promise((r) => setTimeout(r, Math.random() * ceiling));
    }
  }
  throw new Error(`ledger write for issue #${issue} lost ${attempts} races: ${lastError?.message}`);
}

export async function listLedgers(repo) {
  try {
    const raw = await gh(['api', `repos/${repo}/contents/state?ref=${STATE_BRANCH}`]);
    return JSON.parse(raw)
      .filter((f) => f.name.endsWith('.json'))
      .map((f) => Number(f.name.replace('.json', '')))
      .filter(Number.isInteger);
  } catch {
    return [];
  }
}

export const _internals = { gh, pathFor };
