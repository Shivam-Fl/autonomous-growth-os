// Is this repo's architecture recorded, or is the file just there?
//
// `.sdlc/memory/project.md` is read by every agent before it decides anything, and on a
// greenfield repo `sdlc install` seeds it from a scan of code that does not exist yet. The
// result is a file that says "_flat repository_" and "_none detected — fill these in_" and
// reads, to everything downstream, exactly like a project whose stack happens to be nothing.
//
// The workaround up to now was a human hand-writing the architecture into the epic's body.
// That works and it is not automation, and it is invisible when nobody does it: the planner
// simply invents a stack per ticket, differently each time.
//
// So the stub says it is a stub, in a marker a script wrote and a script reads. Prose is not
// parsed — an inference about whether a paragraph "looks empty" is the kind of guess that
// becomes a default nobody chose.

import { createHash } from 'node:crypto';

export const STUB_MARKER = '<!-- sdlc:stub -->';

export const STUB_NOTE = `${STUB_MARKER}
<!-- Seeded by a scan that found no project to scan. The project planner replaces this file
     wholesale, once, before the first ticket is planned. Delete this marker by hand only if
     you have written the real thing yourself. -->`;

/**
 * @param {string|null} text  contents of project.md, or null when the file is absent
 * @returns {boolean} true when nothing has recorded what this project is
 */
export function isStub(text) {
  if (text === null || text === undefined) return true;      // absent is the purest stub
  const s = String(text);
  if (!s.trim()) return true;
  if (s.includes(STUB_MARKER)) return true;
  // The framework's own placeholder, which every fresh clone carries until install rewrites
  // it. A repo that never ran install would otherwise inherit an architecture describing
  // this framework rather than itself.
  if (/This is the AI SDLC framework repo itself/.test(s)) return true;
  return false;
}

/** Did the scan actually find a project, or only a directory? */
export function scanFoundNothing(detected = {}, files = []) {
  const commands = Object.values(detected.verify ?? {}).filter(Boolean).length;
  const stack = String(detected.stack ?? '').toLowerCase();
  return files.length < 5 || (commands === 0 && (!stack || stack === 'unknown'));
}

/** Render a project brief as the memory file every other agent reads. */
export function renderProjectMd(brief, { stubbed = new Set() } = {}) {
  const list = (xs, f) => (xs ?? []).map(f).join('\n') || '_none_';
  return `# Project

Written by the project planner and approved by a human, once, before the first ticket was
planned. Every agent reads this before deciding anything — correct it here rather than
arguing with it in a ticket.

## What this is
${brief.product}

## Stack
${brief.stack.choice}

${brief.stack.why}
${brief.stack.rejected?.length ? `\nRejected:\n${list(brief.stack.rejected, (r) => `- **${r.option}** — ${r.because}`)}\n` : ''}
## Architecture
${brief.architecture.shape}

### Modules
${list(brief.architecture.modules, (m) => `- \`${m.path}\` — ${m.holds}`)}

## Invariants
These hold for every ticket, whatever it asks for.

${list(brief.invariants, (i) => `- ${i}`)}

## Requirements
Cited by id wherever work is split — an issue's \`Covers: TR-3\` means this list. The rationale
and the check that proves each one are in \`docs/trd.md\`; what is being built and for whom, and
what deliberately is not, in \`docs/prd.md\`${brief.ui ? '; how every screen looks and behaves, in `docs/ui.md`' : ''}.

${list(brief.trd?.requirements, (r) => `- **${r.id}** ${String(r.requirement).replace(/\s*\n\s*/g, ' ')}`)}

## Commands
${stubbed.size ? 'Nothing here runs yet: the repository has no code, so every verb is a stub in `package.json`, and the command beside it is its TARGET. The first ticket whose code a verb runs makes it real (the reserved-path guard allows exactly that once), and ci-verify fails any branch that has code while `sdlc:verify` is still a stub.\n\n' : ''}${['verify', 'serve', 'seed', 'ready'].filter((v) => brief.commands[v]).map((v) => `- \`sdlc:${v}\` — ${stubbed.has(`sdlc:${v}`) ? 'stub now; target ' : ''}\`${brief.commands[v]}\``).join('\n')}
${brief.commands.stubbed?.length ? `\nStubbed for now:\n${list(brief.commands.stubbed, (s) => `- ${s}`)}\n` : ''}
## Deploy
${brief.deploy}
${brief.open_questions?.length ? `\n## Open questions\n${list(brief.open_questions, (q) => `- ${q}`)}\n` : ''}`;
}

/**
 * conventions.md for the stack the brief chose.
 *
 * Install seeds the file from this framework's own — Node, "no dependencies", `node --test`,
 * `scripts/lib/` — and nothing replaced it after the brief decided a different stack. The
 * implementer follows conventions.md and the reviewer checks drift against it, so a Python
 * product was reviewed against a Node framework's house rules.
 */
export function renderConventions(brief, { issue } = {}) {
  const decided = brief.conventions?.length > 0;
  return `# Conventions

Written from the project brief${issue ? ` for #${issue}` : ''}, so every ticket starts from the same
rules. Reviews add to it as they find patterns; correct it here rather than arguing in a ticket.

## Stack
${brief.stack.choice}

## ${decided ? 'Rules' : 'Invariants'}
${(decided ? brief.conventions : brief.invariants ?? []).map((c) => `- ${c}`).join('\n') || '_none_'}
${decided ? '' : '\nThe brief decided no coding conventions beyond these. The first reviews write them here.\n'}`;
}

/** A QA memory file with nothing recorded for this product yet. */
export function qaStub(title, what) {
  return `# ${title}
${STUB_MARKER}

Nothing recorded for this project yet. ${what}
`;
}

/** What each document the brief writes is for, as index.md's Always block says it. */
const DOC_ENTRIES = {
  'docs/prd.md': 'what is being built, for whom, and what deliberately is not. Read before planning a feature.',
  'docs/trd.md': 'the numbered TR- requirements an issue\'s `Covers:` line cites. Read before planning or reviewing.',
  'docs/ui.md': 'theme tokens, patterns and every screen\'s five states. Read before touching anything a user sees.',
};

/**
 * index.md with the brief's documents in its Always block, everything already there kept.
 *
 * The brief wrote docs/prd.md, trd.md and ui.md and nothing pointed at them: every agent reads
 * index.md and project.md and nothing else first, so the PRD, the TR list and the UI decisions
 * reached no planner, implementer, reviewer or QA run, and twenty tickets each re-invented them.
 *
 * @param {string|null} index  the current index.md, or null when there is none
 * @param {string[]} docs      repo paths of the documents written
 */
export function indexWithDocs(index, docs = []) {
  const lines = String(index ?? '# Memory index\n\n## Always\n').split('\n');
  let at = lines.findIndex((l) => l.trim() === '## Always');
  if (at === -1) { lines.push('', '## Always'); at = lines.length - 1; }
  let end = lines.findIndex((l, i) => i > at && /^#{1,2} /.test(l));
  if (end === -1) end = lines.length;
  while (end > at + 1 && !lines[end - 1].trim()) end--;
  const add = docs.filter((d) => DOC_ENTRIES[d] && !lines.slice(at, end).some((l) => l.includes(`](../../${d})`)))
    .map((d) => `- [${d}](../../${d}) — ${DOC_ENTRIES[d]}`);
  lines.splice(end, 0, ...add);
  return lines.join('\n');
}

// --- the spec, section by section -------------------------------------------
//
// A 44-section spec went into one brief whose lists are capped, and nothing tied a requirement
// back to the section it came from. Whatever did not fit was simply absent, and nothing could
// say so: epics closed on their children, and no view said what of the spec was ever built.
// So the spec is numbered once, by a script, and the brief has to account for every number.

/**
 * A document's `#` and `##` sections, each with a stable fingerprint of its text.
 *
 * Deeper headings stay inside their section: a spec's sub-points are how someone wrote a
 * section down, not separate things to account for. A heading with nothing under it before the
 * next one is a title, not a section. Text before the first heading is a section named after
 * the document, so a spec with no headings at all is one section rather than none.
 */
export function specSections(text, source) {
  const lines = String(text ?? '').split('\n');
  const found = [];
  let fence = null;
  let current = { title: source, line: 1, text: [] };
  const close = () => {
    const body = current.text.join('\n').trim();
    if (body) {
      found.push({ title: current.title, source, line: current.line,
        sha: createHash('sha256').update(`${current.title}\n${body}`).digest('hex').slice(0, 12) });
    }
  };
  lines.forEach((l, i) => {
    const f = l.match(/^\s*(```|~~~)/);
    if (f) fence = fence === f[1] ? null : fence ?? f[1];
    const h = !fence && !f && l.match(/^(#{1,2})\s+(.+?)\s*#*\s*$/);
    if (h) {
      close();
      current = { title: h[2], line: i + 1, text: [] };
    } else current.text.push(l);
  });
  close();
  return found;
}

/** Sections of the index the brief's `coverage` gives no disposition. */
export function uncoveredSections(brief, index) {
  const covered = new Set((brief?.coverage ?? []).map((c) => c.section));
  return (index?.sections ?? []).filter((s) => !covered.has(s.id));
}

/** Render one decision as an ADR, in the format the Librarian already uses. */
export function renderAdr(decision, { number, issue, date }) {
  const id = `ADR-${String(number).padStart(4, '0')}`;
  return `# ${id}: ${decision.title}

**Date:** ${date}
**Status:** accepted
**Forced by:** #${issue}

## Decision
${decision.decision}

## Why
${decision.because}

## Consequences
${decision.consequences ?? '_Not stated. An ADR without consequences is an announcement; add them when they become clear._'}
`;
}

// What is not the product: the framework, the docs, repo metadata. A repository with nothing else
// has no code for any verb to run, so a verb the brief writes as a real command there fails on
// its first call — `pytest` with no tests and no pytest, `docker compose up` with no compose
// file, `python -m scripts.seed` with no scripts — and the ticket that could fix it may not
// change a real verb. So on such a repo every verb starts as a stub, and its command is recorded
// as the target the first ticket installs.
const NOT_PRODUCT = /^(\.sdlc\/|\.github\/|\.claude\/|docs\/|bin\/sdlc$|README|LICENSE|CHANGELOG|CONTRIBUTING|\.gitignore$|\.gitattributes$|\.editorconfig$|package(-lock)?\.json$|[^/]+\.md$)/i;
export const hasProductCode = (files) => files.some((f) => f && !NOT_PRODUCT.test(f));
export const stubVerb = (verb) => `echo "${verb} is a stub until there is code for it to run - its target is in .sdlc/memory/project.md"`;
