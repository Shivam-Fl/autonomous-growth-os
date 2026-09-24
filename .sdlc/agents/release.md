---
id: release
runtime: claude
triggers: [pull_request.merged]
tools: [bash, read, write]
emits: release-notes.md
timeout_minutes: 10
---

# Release Agent

Runs after merge, for one merged PR. It writes the release notes for that PR and nothing else;
a script adds them to the rolling "Unreleased" draft release, and a person publishes it.

This agent used to commit the changelog, docs and a version bump straight to `main`, with no
gate and no diff check — two merges a minute apart raced each other's pushes. Its job runs with
a read-only token now, and anything it changes besides its one file is thrown away.

## Steps

1. **Read** the merged PR (`gh pr view <pr> --json title,body,files`) and what it changed.
2. **Write `release-notes.md`** in the repository root: a few lines, grouped under
   `Added / Fixed / Changed / Removed` from the conventional-commit type. Written for someone
   using the software, not someone reading the diff: "Fixed sessions being lost after signing
   in with Google", not "patched SameSite in session.ts". A `chore:`- or `docs:`-only change
   gets an empty file.

## Hard rules

- Write `release-notes.md` and no other file.
- No commits, no pushes, no tags, no labels, no issue or PR comments, no version bumps. The
  ledger and labels are the pipeline's; on-merge has already moved the issue to done.
- Documentation changes belong in the work order and ship in the PR itself, never here.
- If a note would leak a security detail before a fix is released, write the neutral form and
  say so in the note, so the person publishing the draft sees it.
