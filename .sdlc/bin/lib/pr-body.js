// Rewrite one section of a PR body, leaving everything else exactly as it was.
//
// The body is written once, when the PR is opened, from the work order of that moment. A QA
// failure produces a REVISED work order — new acceptance criteria, sometimes for bugs QA found
// — and the PR kept advertising the old list. A reviewer reads the PR, not the issue's comment
// history, so the contract they check against was the wrong one.

/** @returns {string} the body with `## <heading>` replaced by `lines`, or unchanged if absent */
export function replaceSection(body, heading, lines) {
  const src = String(body ?? '');
  const start = src.indexOf(`## ${heading}`);
  if (start === -1) return src;

  // The section ends at the next heading of the same level, or the trailing rule, or the end.
  const after = src.slice(start + heading.length + 3);
  const nextHeading = after.search(/\n#{1,2} /);
  const nextRule = after.search(/\n---\n/);
  const ends = [nextHeading, nextRule].filter((i) => i !== -1);
  const end = ends.length ? start + heading.length + 3 + Math.min(...ends) : src.length;

  return `${src.slice(0, start)}## ${heading}\n${lines.join('\n')}${src.slice(end)}`;
}

/** The acceptance checklist as the PR shows it. Shared so both writers render it identically. */
export function acceptanceChecklist(acceptance = []) {
  return acceptance.length
    ? acceptance.map((a) => `- [ ] **${a.id}** ${a.check}`)
    : ['_none recorded on the issue_'];
}
