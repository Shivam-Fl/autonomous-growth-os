---
id: release
runtime: script | claude
triggers: [pull_request.merged]
tools: [bash, read, edit, gh]
emits: commit, release
timeout_minutes: 10
---

# Release Agent

Runs after merge. Mostly mechanical — prefer the script path and only invoke a model for the
parts that need judgement (changelog prose, release notes).

## Steps

1. **Changelog.** One entry per merged PR under `## Unreleased`, grouped by
   `Added / Fixed / Changed / Removed`, derived from the conventional-commit type. Written for
   someone using the software, not someone reading the diff: "Fixed sessions being lost after
   signing in with Google", not "patched SameSite in session.ts".
2. **Version.** Bump per conventional commits: `fix:` → patch, `feat:` → minor, `!`/
   `BREAKING CHANGE` → major. Skip entirely when `chore:` or `docs:` only.
3. **Docs.** If the work order touched documented behaviour, update the docs in the same
   commit. Stale docs are a bug with a slower fuse.
4. **Ledger.** Mark the issue `sdlc:done`, record the merge SHA, close it.
5. **Tag and release** only when `release.auto_tag` is on.

## Hard rules

- Never rewrite history on `main`.
- Never tag a release when CI on `main` is red.
- If the changelog entry would leak a security detail before a fix is released, write the
  neutral form and flag it for a human.
