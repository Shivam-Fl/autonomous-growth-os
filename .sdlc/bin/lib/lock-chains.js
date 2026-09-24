// How long the per-issue lock can be held, read from the workflows themselves.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from './js-yaml.mjs';

/**
 * For every workflow that takes the per-issue lock: how many minutes of jobs can run while it is
 * held — the longest needs-chain from the job running `sdlc-ctl lock` to the job running
 * `sdlc-ctl unlock`, summing each job's timeout-minutes (GitHub's default of 360 when unset).
 */
export function lockChains(root) {
  // No root is a caller bug, not "no workflows": [] would pass every TTL, which is how it hid.
  if (!root) throw new Error("lockChains needs the repository root");
  const out = [];
  let files = [];
  try { files = readdirSync(join(root, '.github/workflows')).filter((f) => f.endsWith('.yml')); } catch { return out; }
  for (const f of files) {
    let wf;
    try { wf = parseYaml(readFileSync(join(root, '.github/workflows', f), 'utf8')); } catch { continue; }
    const jobs = wf?.jobs ?? {};
    const holder = (re) => Object.entries(jobs).find(([, j]) => (j.steps ?? []).some((s) => re.test(String(s.run ?? ''))))?.[0];
    const from = holder(/sdlc-ctl\.mjs\s+lock\b/);
    const to = holder(/sdlc-ctl\.mjs\s+unlock\b/);
    if (!from || !to) continue;
    const needs = (j) => [jobs[j]?.needs ?? []].flat();
    const reaches = (j, seen = new Set()) => j === from || (!seen.has(j) && (seen.add(j), needs(j).some((n) => reaches(n, seen))));
    const longest = (j) => (Number(jobs[j]?.['timeout-minutes']) || 360)
      + Math.max(0, ...needs(j).filter((n) => reaches(n)).map(longest));
    if (reaches(to)) out.push({ f: `${f} ${from}→${to}`, n: longest(to) });
  }
  return out;
}
