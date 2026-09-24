// The open issues, as the sweeps need them: number, labels, and who filed it.
//
// The watchdog, the collisions check and reconcile-merged each walked listLedgers() with one
// contents GET per ledger — done and merged ones included, which are never removed. That is
// about 3N calls a sweep against GITHUB_TOKEN's 1,000 requests an hour, shared with every stage,
// so a big project spent its budget re-reading finished work and every stage's `gh` then
// failed. One paginated listing, a hundred to a page, says which ledgers can still matter.
import { ghJson } from './actions.js';

/** @returns {Promise<{number: number, labels: string[], author: string, association: string|null}[]>} */
export async function openIssues(repo) {
  const pages = await ghJson(['api', '--paginate', '--slurp', `repos/${repo}/issues?state=open&per_page=100`]);
  return pages.flat()
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      labels: (i.labels ?? []).map((l) => l.name ?? l),
      author: i.user?.login ?? '',
      association: i.author_association ?? null,
    }));
}
