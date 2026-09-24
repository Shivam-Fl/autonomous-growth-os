// Sections of an issue BODY that the pipeline maintains, and the only human decisions agents obey.
//
// Decisions used to live in comment headings — "## Answered", "## Route note from @owner" — and
// the packs told agents to obey them. Anyone can post a comment with that heading on a public
// repository, so anyone could answer the owner's question or re-route the issue. The body is
// written here by run-command after it has checked who issued the command, and an outsider
// cannot edit an issue body they did not write.
//
// They CAN write this heading into an issue they filed themselves. So this file only parses and
// renders: a reader deciding whether to obey a section on an outsider's issue has to check it
// against what run-command recorded on the ledger, not take the body's word for it.
//
// The split's acceptance lines live here too, numbered, so a planner is checked against what
// the epic actually asked of this piece rather than against its own paraphrase of it.

export const DECISIONS_HEADING = '## Decisions (recorded by the pipeline)';
export const SPLIT_CRITERIA_HEADING = '## Acceptance (from the split)';

/** The lines of a `## ` section: [start, end) of the lines array, heading line included. */
function section(body, heading) {
  const lines = String(body ?? '').split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return { lines, start: -1, end: -1 };
  const next = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  return { lines, start, end: next === -1 ? lines.length : next };
}

// A header line is unindented and every text line is indented two spaces, so no text — however
// it is worded — can end a section or forge another entry.
const ENTRY = /^- \*\*(.+?)\*\* by @(\S+) \((.+?)\):$/;

const renderDecision = ({ kind, by, at, text }) => [
  `- **${String(kind).replace(/[*\n]/g, '')}** by @${String(by).replace(/\s/g, '')} (${String(at).replace(/[()\s]/g, '')}):`,
  ...String(text ?? '').split('\n').map((l) => `  ${l}`),
];

/** @returns {{kind: string, by: string, at: string, text: string}[]} oldest first */
export function decisionsOf(body) {
  const { lines, start, end } = section(body, DECISIONS_HEADING);
  if (start === -1) return [];
  const out = [];
  for (const line of lines.slice(start + 1, end)) {
    const m = line.match(ENTRY);
    if (m) { out.push({ kind: m[1], by: m[2], at: m[3], text: [] }); continue; }
    if (out.length && (line.startsWith('  ') || !line.trim())) out.at(-1).text.push(line.startsWith('  ') ? line.slice(2) : '');
  }
  return out.map((d) => ({ ...d, text: d.text.join('\n').replace(/\s+$/, '') }));
}

/** The body with the decisions section rewritten: existing entries kept, new ones appended. */
export function upsertDecisions(body, entries = []) {
  const all = decisionsOf(body);
  const seen = new Set(all.map((d) => `${d.at}\u0000${d.by}`));
  for (const e of entries) {
    const key = `${e.at}\u0000${e.by}`;
    if (!seen.has(key)) { seen.add(key); all.push(e); }
  }
  const rendered = [DECISIONS_HEADING, '', ...all.flatMap(renderDecision), ''];
  const { lines, start, end } = section(body, DECISIONS_HEADING);
  if (start === -1) {
    const text = String(body ?? '').trimEnd();
    return `${text}${text ? '\n\n' : ''}${rendered.join('\n')}`;
  }
  return [...lines.slice(0, start), ...rendered, ...lines.slice(end)].join('\n');
}

/** The split's acceptance lines, numbered IAC-1.. — one line each, the text as written. */
export function renderSplitCriteria(list = []) {
  return list.map((t, i) => `- **IAC-${i + 1}** ${String(t).replace(/\s*\n\s*/g, ' ').trim()}`).join('\n');
}

/** @returns {{id: string, text: string}[]} */
export function splitCriteriaOf(body) {
  const { lines, start, end } = section(body, SPLIT_CRITERIA_HEADING);
  if (start === -1) return [];
  return lines.slice(start + 1, end)
    .map((l) => l.match(/^- \*\*(IAC-\d+)\*\* (.*)$/))
    .filter(Boolean)
    .map((m) => ({ id: m[1], text: m[2].trim() }));
}

/** A work order's "IAC-n: reason" entries in out_of_scope, id -> reason. */
export function deferredSplitCriteria(wo) {
  return new Map((wo?.out_of_scope ?? [])
    .map((o) => String(o).match(/^\s*(IAC-\d+)\s*:\s*(\S[\s\S]*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
}

/**
 * The split's criteria a work order neither sources nor defers, by id; and the refusal to give.
 *
 * One function, because the check runs in two places: the plan gate, before the plan is kept on
 * the ledger, and post-work-order, which every producer posts through. It ran only in the second,
 * after the plan had been stashed as validated and as approved, and died there before anything
 * cleared either stash — so every retry restored the same plan, re-posted it and died again.
 */
export function unansweredSplitCriteria(wo, issueBody) {
  const sourced = new Set((wo?.acceptance ?? []).map((a) => a.source).filter(Boolean));
  const deferred = deferredSplitCriteria(wo);
  const ids = splitCriteriaOf(issueBody).filter((c) => !sourced.has(c.id) && !deferred.has(c.id)).map((c) => c.id);
  return {
    ids,
    message: ids.length ? `the work order neither answers nor defers ${ids.join(', ')} from the issue's ` +
      `"${SPLIT_CRITERIA_HEADING}": give each a criterion with \`source\` set to its id, or put ` +
      '"IAC-n: why it is not in this change" in out_of_scope' : '',
  };
}
