# Conventions

## Code
- ES modules, Node 22, no transpiler. `.js` for libraries, `.mjs` for executable scripts.
- Pure logic in `scripts/lib/`, IO at the edges. Anything worth testing must be importable
  without a network.
- No dependencies unless a few lines genuinely cannot do it. The only runtime dep is
  `js-yaml`, added because hand-rolling YAML parsing is the kind of clever that breaks at 3am.
- Shell out to `gh` rather than adding an API SDK.

## Guards fail closed
Every validator, allowlist and parser refuses on input it does not understand. A guard that
silently ignores the unrecognised case reports success for something it never checked — worse
than having no guard, because it is trusted.

## Comments
Explain **why**, never what. A comment restating the code is noise; a comment naming the
failure mode a line prevents is the reason the line survives the next refactor.

## Tests
`node --test`, no framework. Test the failure, not the happy path — the interesting assertions
are the ones that fail when a guard regresses.

## PRs
Conventional commit subject. Body says what changed and why, lists the acceptance criteria,
and names anything deliberately left out of scope.
