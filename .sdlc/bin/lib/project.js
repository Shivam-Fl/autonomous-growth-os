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
export function renderProjectMd(brief) {
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

## Commands
- \`sdlc:verify\` — \`${brief.commands.verify}\`
- \`sdlc:serve\` — \`${brief.commands.serve}\`
${brief.commands.seed ? `- \`sdlc:seed\` — \`${brief.commands.seed}\`\n` : ''}${brief.commands.ready ? `- \`sdlc:ready\` — \`${brief.commands.ready}\`\n` : ''}${brief.commands.stubbed?.length ? `\nStubbed for now:\n${list(brief.commands.stubbed, (s) => `- ${s}`)}\n` : ''}
## Deploy
${brief.deploy}
${brief.open_questions?.length ? `\n## Open questions\n${list(brief.open_questions, (q) => `- ${q}`)}\n` : ''}`;
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
