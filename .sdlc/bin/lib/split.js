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
