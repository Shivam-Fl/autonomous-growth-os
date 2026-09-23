// Parses privileged `/sdlc ...` commands out of GitHub comments.
//
// SECURITY BOUNDARY. Everything downstream of this file acts on the result: merging,
// overriding gates, resetting budgets. Issue and PR comments are attacker-controlled text on
// any repo that accepts outside contributions, so the rules here are deliberately rigid:
//
//   1. A command is only a command at the START of a line. Text that merely mentions
//      "/sdlc approve" inside a sentence, a quote, or a code block is prose.
//   2. Authority comes from the comment's AUTHOR and their association with the repo —
//      never from the comment's content. No string in a comment body can grant permission.
//   3. Unknown commands are rejected, not ignored. Silence looks like success to a caller.

export const COMMANDS = {
  approve:  { needsAllowlist: true,  description: 'approve the pending work order or merge' },
  reject:   { needsAllowlist: true,  description: 'reject the pending work order' },
  // `merge` is deliberately NOT here. It was declared, never implemented, and fell through to
  // "unhandled command" — an advertised human override that did nothing when someone reached
  // for it. A real one has to recheck every pre-merge invariant against the final commit
  // (ledger at qa-pass, a valid QA report with no PR-introduced bug, checks still green, base
  // unchanged, no reserved path touched), which is its own piece of work. Until then `approve`
  // is the override, and the merge itself is GitHub's button.
  retry:    { needsAllowlist: true,  description: 'retry the current stage (consumes an attempt)' },
  // The lever for a bad route. Without it the only way to change one is to hand-edit a JSON
  // file on an orphan branch, which is not a lever, it is a workaround.
  replan:   { needsAllowlist: true,  description: 're-route this issue, with your note as context' },
  // Its sibling for epics. A split that is too fine is expensive in a way nothing else
  // catches: each extra issue pays a full plan -> implement -> CI -> review -> QA cycle for
  // what could have been one more acceptance criterion.
  'replan-epic': { needsAllowlist: true, description: 're-split this epic, clubbing what should be one issue' },
  // And its sibling for the architecture. A real pivot — new stack, new module boundary —
  // rather than a correction to one ticket.
  'replan-project': { needsAllowlist: true, description: 'decide this repo\'s architecture again, with your note' },
  // The other half of `open_questions`. Agents were asked to name what they could not settle,
  // and nothing could settle it: the questions sat in a comment, the next agent read the issue
  // and found a list of unanswered questions, and the only levers a person had were approve
  // (proceed with them unanswered) or replan (start over). An answer is neither.
  answer:   { needsAllowlist: true,  description: 'answer this issue\'s open questions, and continue' },
  override: { needsAllowlist: true,  description: 'bypass a gate — recorded in the ledger' },
  stop:     { needsAllowlist: true,  description: 'halt this issue and hand it to a human' },
  status:   { needsAllowlist: false, description: 'print the ledger (read-only, harmless)' },
};

// GitHub author_association values that indicate write access to this repo.
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Strip fenced code blocks and quoted replies so their contents can never be parsed. */
function stripNonCommandRegions(body) {
  return body
    .replace(/```[\s\S]*?```/g, '')   // fenced blocks
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/^\s*>.*$/gm, '');       // quoted text — a reply quoting a command is not a command
}

/**
 * @param {{body: string, author: string, association?: string}} comment
 * @param {{allowlist?: string[]}} config
 * @returns {{command: string, args: string[], authorized: boolean, reason?: string} | null}
 *          null when the comment contains no command at all.
 */
export function parseCommand(comment, config = {}) {
  const body = String(comment?.body ?? '');
  const cleaned = stripNonCommandRegions(body);

  // Only at the start of a line, and only the first one — a comment does not get to
  // queue up a sequence of privileged actions.
  const match = cleaned.match(/^[ \t]*\/sdlc[ \t]+(\S+)[ \t]*(.*)$/m);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const args = match[2].trim() ? match[2].trim().split(/\s+/) : [];

  const spec = COMMANDS[command];
  if (!spec) {
    return { command, args, authorized: false, reason: `unknown command "/sdlc ${command}"` };
  }

  if (!spec.needsAllowlist) return { command, args, authorized: true };

  const allowlist = (config.allowlist ?? []).map((u) => u.toLowerCase());
  const author = String(comment?.author ?? '').toLowerCase();
  const association = comment?.association;

  if (!author) {
    return { command, args, authorized: false, reason: 'comment has no author' };
  }
  // An unfinished allowlist and an outsider are the same refusal and completely different
  // problems, and telling them apart is the difference between a repo owner fixing one line and
  // wondering why nothing happens.
  //
  // `sdlc install` cannot know who owns a repository, so it writes REPLACE_ME and says so in the
  // output. Miss that line and every command is read, logged, and silently dropped: the run goes
  // green, the "Act on it" step skips, and the issue sits where it was. It cost two round trips
  // to notice on a fresh repo.
  //
  // `unconfigured` is surfaced to the issue. A genuine outsider is not — on a public repository
  // that is an invitation to probe which names are privileged.
  if (!allowlist.length || allowlist.every((u) => u === 'replace_me')) {
    return {
      command, args, authorized: false, unconfigured: true,
      reason: 'the `allowlist` in .sdlc/config.yml is still the placeholder, so nobody can issue commands',
    };
  }
  if (!allowlist.includes(author)) {
    return { command, args, authorized: false, reason: `@${comment.author} is not on the allowlist` };
  }
  // Belt and braces: allowlisted AND demonstrably associated with the repo. An allowlist
  // entry alone would survive a username being renamed and reclaimed by someone else.
  if (association !== undefined && !TRUSTED_ASSOCIATIONS.has(association)) {
    return {
      command, args, authorized: false,
      reason: `@${comment.author} is allowlisted but has association ${association}`,
    };
  }
  return { command, args, authorized: true };
}
