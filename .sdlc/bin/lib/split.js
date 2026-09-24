// Did the maintainer split an epic, or shred it?
//
// The observed failure, on tabs #8: the epic's spec listed "3. Split equally… 4. Split by
// shares…" as plain numbered bullets, and the split turned each bullet into its own issue,
// in order, each depending on the last. Six sequential issues for a product with maybe three
// or four deliverable slices, and #10 and #11 — "record an expense with an equal split" and
// "…with a shares split" — touched the same four files, one extending the other with a
// second input mode. Those are not two user journeys. That is one feature and one edge case,
// paying two full plan → implement → CI → review → QA cycles.
//
// The shape is specific and recognisable: splitting by the SPEC'S STRUCTURE rather than by
// what can be shipped on its own. The prompt is where that is really fixed; this is the
// tripwire underneath it, because prompt-level judgement is not perfect every time and a
// mechanical check costs nothing.
//
// It FLAGS. It never blocks. The heuristic is crude by design — a leading verb and some
// overlapping nouns — and a crude check that stops work is worse than no check.

import { DECISIONS_HEADING, SPLIT_CRITERIA_HEADING, renderSplitCriteria } from './issue-body.js';
import { gh, ghJson } from './actions.js';
import { dependenciesOf, isEpic } from './deps.js';

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'with', 'for', 'from', 'into', 'onto', 'that', 'this',
  'their', 'them', 'its', 'can', 'able', 'when', 'then', 'each', 'both', 'per', 'via',
  'using', 'about', 'over', 'under', 'between', 'user', 'users', 'members', 'member',
]);

const words = (t) => String(t).toLowerCase().match(/[a-z][a-z-]{1,}/g) ?? [];

/** The first meaningful word of a title — usually the verb the piece is named after. */
export function leadingVerb(title = '') {
  for (const w of words(title)) if (!STOP.has(w)) return w;
  return '';
}

/** Everything meaningful in a title EXCEPT the verb it leads with, which is scored separately. */
const content = (title) => {
  const verb = leadingVerb(title);
  return new Set(words(title).filter((w) => !STOP.has(w) && w.length > 2 && w !== verb));
};

/**
 * 0..1, and 0 unless the two titles name the same action.
 *
 * Both halves are necessary and neither is sufficient, which took two wrong versions to get
 * right. Naming the same action is not enough: "Record an expense" and "Record a payment" are
 * different features. Talking about the same things is not enough either: "Create a group"
 * and "Delete a group" share their only noun and are opposites. The shape being looked for is
 * the same verb applied to the same nouns with one word changed — "an equal split" and "a
 * shares split" — which is what a spec's numbered bullets turn into when each becomes a ticket.
 *
 * The verb is excluded from the noun overlap. Counting it in both halves made a shared verb
 * alone cross the threshold, and then every "Create ..." pair in a backlog looked like a
 * duplicate.
 */
export function titleSimilarity(a = '', b = '') {
  const verb = leadingVerb(a);
  if (!verb || verb !== leadingVerb(b)) return 0;

  const A = content(a);
  const B = content(b);
  const shared = [...A].filter((w) => B.has(w)).length;
  const union = new Set([...A, ...B]).size;
  return 0.4 + (union ? 0.6 * (shared / union) : 0.6);
}

/**
 * Runs of issues where each depends on exactly one predecessor, and that predecessor is the
 * issue immediately before it.
 *
 * "Exactly one" is the signal. A genuine dependency graph branches: three pieces can all
 * depend on the schema piece and none on each other. A perfectly linear chain of N is what
 * you get from numbering the sections of a spec.
 *
 * @param {{number: number, title: string, depends_on: number[]}[]} pieces  in split order
 */
export function linearChains(pieces = []) {
  const chains = [];
  let current = [];

  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const prev = pieces[i - 1];
    const linked = prev && (p.depends_on ?? []).length === 1 && p.depends_on[0] === prev.number;

    if (linked) {
      if (!current.length) current.push(prev);
      current.push(p);
    } else {
      if (current.length > 1) chains.push(current);
      current = [];
    }
  }
  if (current.length > 1) chains.push(current);
  return chains;
}

/**
 * @param {{number: number, title: string, depends_on: number[]}[]} pieces
 * @param {{minChain?: number, similarity?: number}} opts
 * @returns {{flagged: boolean, chains: object[], pairs: object[], summary: string}}
 */
export function overSplit(pieces = [], opts = {}) {
  const minChain = opts.minChain ?? 3;
  const threshold = opts.similarity ?? 0.5;

  const chains = linearChains(pieces).filter((c) => c.length >= minChain);
  const pairs = [];

  for (const chain of chains) {
    for (let i = 0; i < chain.length - 1; i++) {
      const score = titleSimilarity(chain[i].title, chain[i + 1].title);
      if (score >= threshold) {
        pairs.push({ a: chain[i].number, b: chain[i + 1].number, score: Number(score.toFixed(2)),
          titles: [chain[i].title, chain[i + 1].title] });
      }
    }
  }

  const flagged = chains.length > 0 && pairs.length > 0;
  const summary = !flagged
    ? 'the split branches, or its pieces are named differently enough to be different work'
    : `${chains.map((c) => c.map((p) => `#${p.number}`).join(' → ')).join('; ')} is a straight line of ` +
      `${chains[0].length}, and ${pairs.length} adjacent pair(s) read as the same work twice`;

  return { flagged, chains, pairs, summary };
}


// --- turning a breakdown into issues ----------------------------------------
//
// The maintainer used to create the split's issues itself and, optionally, record their
// numbers. Everything downstream then paired piece i with issue i: by `created[i]` when the
// agent remembered to write it, and otherwise by `gh issue list`, which is newest first — so
// "piece 2 depends on piece 1" became "#11 depends on #12", or a loop. The bodies were prose,
// and one model wrote "Depends on the simulator piece" where intake parks only on
// `Depends on #<n>`. A script creating the issues from the breakdown knows every number by
// construction.

/**
 * The order to create pieces in, so each dependency's number exists before the piece naming it.
 *
 * Index order wherever the breakdown allows it, which is almost always: pieces are written in
 * dependency order. An index outside the list, or a piece depending on itself, is dropped and
 * reported rather than turned into a wrong number. A loop is refused outright — nothing in it
 * could ever start, and it is found here before any issue exists rather than after.
 *
 * @param {{depends_on?: number[]}[]} pieces  1-based depends_on, as breakdown.json writes them
 * @returns {{order: number[], deps: number[][], dropped: {piece: number, dep: number}[]}}
 *          0-based indexes; deps[i] are piece i's dependencies as 0-based indexes
 * @throws when the dependencies loop
 */
export function creationOrder(pieces = []) {
  const dropped = [];
  const deps = pieces.map((p, i) => [...new Set(p.depends_on ?? [])].filter((d) => {
    const ok = Number.isInteger(d) && d >= 1 && d <= pieces.length && d - 1 !== i;
    if (!ok) dropped.push({ piece: i + 1, dep: d });
    return ok;
  }).map((d) => d - 1));

  const order = [];
  const placed = new Set();
  while (order.length < pieces.length) {
    const next = pieces.findIndex((_, i) => !placed.has(i) && deps[i].every((d) => placed.has(d)));
    if (next === -1) {
      const stuck = pieces.map((_, i) => i + 1).filter((n) => !placed.has(n - 1));
      throw new Error(`the breakdown's dependencies loop: pieces ${stuck.join(', ')} each wait on another of them`);
    }
    order.push(next);
    placed.add(next);
  }
  return { order, deps, dropped };
}

// The headings of the sections the pipeline writes into an issue body and every reader trusts.
const PIPELINE_HEADINGS = new Set([DECISIONS_HEADING, SPLIT_CRITERIA_HEADING]);

/**
 * Agent prose made safe to write into a body the pipeline authors.
 *
 * An issue the pipeline files is a trusted reporter's, so every reader takes its whole
 * `## Decisions (recorded by the pipeline)` section as a person's decision. The agent's
 * `context` went in verbatim — and it is written by a model that has just read every comment
 * on the epic, which anyone can post. A context carrying that heading and one entry under it
 * became a decision on the child, and upsertDecisions then kept it as one. A heading line is
 * quoted, which no section reader matches; the rest of the text is left as written.
 */
export const agentText = (text) => String(text ?? '').split('\n')
  .map((l) => (PIPELINE_HEADINGS.has(l.trim()) ? `> ${l}` : l)).join('\n');

/**
 * The body of one split issue, entirely from the breakdown and the numbers already created.
 *
 * `acceptance` is verbatim and numbered, because the planner is checked against what the epic
 * asked of this piece, not against its own paraphrase. The epic link and every dependency are
 * written in the one form the parsers read.
 */
export function splitIssueBody(piece, { epic, dependsOn = [] }) {
  const parts = [agentText(piece.why)];
  if (piece.context) parts.push(agentText(piece.context));
  if (piece.risk) parts.push(`**Risk.** ${agentText(piece.risk)}`);
  if (piece.out_of_scope?.length) parts.push(`**Out of scope**\n${piece.out_of_scope.map((o) => `- ${agentText(o)}`).join('\n')}`);
  parts.push([
    ...(piece.covers?.length ? [`Covers: ${piece.covers.join(', ')}`] : []),
    `Part of #${epic}.`, ...dependsOn.map((n) => `Depends on #${n}.`),
  ].join('\n'));
  parts.push(`${SPLIT_CRITERIA_HEADING}\n${renderSplitCriteria(piece.acceptance)}`);
  return `${parts.join('\n\n')}\n`;
}

/**
 * Adds `Depends on #<depends_on>.` to each linked epic, for the links the maintainer wrote.
 *
 * The agent was told to add these itself, and it edited other epics' bodies with a token that
 * could edit any issue in the repository. It runs read-only now and writes the links down; this
 * makes each one, and only between two different open epics — a link naming anything else is
 * reported and skipped rather than written into an issue nobody asked about.
 *
 * @param {{epic: number, depends_on: number}[]} links
 */
export async function linkEpics(links = []) {
  const view = (n) => ghJson(['issue', 'view', String(n), '--json', 'state,labels,body']).catch(() => null);
  const openEpic = (v) => v?.state === 'OPEN' && isEpic(v);
  for (const { epic, depends_on: dep } of links) {
    const [waits, on] = [await view(epic), await view(dep)];
    if (epic === dep || !openEpic(waits) || !openEpic(on)) {
      process.stdout.write(`::warning::epic link #${epic} -> #${dep} skipped: both must be open epics, and different\n`);
      continue;
    }
    if (dependenciesOf(waits.body).includes(dep)) continue;
    await gh(['issue', 'edit', String(epic), '--body', `${String(waits.body ?? '').trimEnd()}\n\nDepends on #${dep}.\n`]);
    process.stdout.write(`#${epic} now depends on #${dep}\n`);
  }
}

// --- what an epic owes ---------------------------------------------------------

/** The requirement and section ids a body says it covers: `Covers: TR-1, TR-7, S-3`. */
export function coversOf(body = '') {
  const text = String(body ?? '').replace(/```[\s\S]*?```/g, '').replace(/\*\*|__|`/g, '');
  return [...new Set([...text.matchAll(/^\s*covers\s*:\s*(.+)$/gim)]
    .flatMap((m) => m[1].match(/\b[A-Za-z]+-\d+\b/g) ?? []))];
}

/**
 * What an epic says it covers, or split out, that no completed piece delivered and no deferral
 * accounts for.
 *
 * An epic closed when its children did, and nothing asked whether they covered what it was for:
 * a piece whose issue was never created, or a requirement the epic promised and the split
 * forgot, closed with the epic as if built.
 *
 * @param {string} epicBody
 * @param {{pieces?: {covers?: string[], issue?: number|null}[], deferred?: {covers?: string[]}[]}|null} breakdown
 * @param {(n: number) => {state: string, stateReason?: string|null}|undefined} issueOf
 * @param {{state: string, stateReason?: string|null, body?: string}[]} linked  other issues
 *        filed as "Part of" the epic since, whose own `Covers:` lines count once completed
 * @returns {string[]}
 */
export function coverageGap(epicBody, breakdown, issueOf, linked = []) {
  const pieces = breakdown?.pieces ?? [];
  const completed = (i) => i?.state === 'closed' && String(i.stateReason ?? '').toUpperCase() !== 'NOT_PLANNED';
  const done = new Set([
    ...pieces.filter((p) => p.issue && completed(issueOf(p.issue))).flatMap((p) => p.covers ?? []),
    ...linked.filter(completed).flatMap((i) => coversOf(i.body)),
  ]);
  const deferred = new Set((breakdown?.deferred ?? []).flatMap((d) => d.covers ?? []));
  const owed = new Set([...coversOf(epicBody), ...pieces.flatMap((p) => p.covers ?? [])]);
  return [...owed].filter((id) => !done.has(id) && !deferred.has(id));
}
