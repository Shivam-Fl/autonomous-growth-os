# Conventions

Written from the project brief for #14, so every ticket starts from the same
rules. Reviews add to it as they find patterns; correct it here rather than arguing in a ticket.

## Stack
Node.js 22 LTS, Express 5, node:sqlite (built-in DatabaseSync), server-rendered HTML with vanilla JS, node:test. No TypeScript, no frontend build, no external services in v1.

## Rules
- ES modules, plain JavaScript, no TypeScript build step; files mirror their directory: src/domain/money.js is tested by test/domain/money.test.js.
- Errors cross module boundaries as {code, message, details} objects with stable string codes; never throw raw provider payloads.
- Stdlib first: no new runtime dependency without a one-line justification in the PR, and no dependency that requires native compilation on the clean CI runner.
- Repositories own all SQL and live behind interfaces defined by the domain; domain modules never import node:sqlite or any driver.
- Provider specifics stay inside src/integrations/<provider>/; the Graph API version appears exactly once as a pinned constant.
- Tests run with node:test and node:assert/strict only; integration tests boot the app against a temp SQLite file and the fake providers.
- Money, timestamps and identifiers follow the invariants: micros, UTC ISO-8601, prefixed ids (evt_, dec_, cap_, exp_).
