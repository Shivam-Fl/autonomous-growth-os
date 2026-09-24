# Research

_What was learned outside this repository before the architecture was decided, and where_
_it came from. Generated from `project-brief.json` for #14._

## Questions

- Which Node LTS line should v1 pin given September 2026 timing?
- Which SQLite access path is boring and safe on a clean CI runner: better-sqlite3 or node:sqlite?
- Is Express 5 stable and suitable as the v1 web framework?
- What is the current Meta Marketing API version and is the Node SDK Meta-maintained?
- Which test runner fits a no-build-step Node service: Vitest or node:test?

## Findings

### Node 22 is the safe Active LTS target in September 2026, supported through April 2027.

**What the source says.** Release schedule: v20 EOL 2026-04-30, v22 EOL 2027-04-30; Node 22 described as the current LTS and safe default for new services; Node 26 enters LTS 2026-10-28.

**Source.** https://nodejs.org/en/about/previous-releases (via web search, Sep 2026)

**Confidence.** 85

**Changed.** Stack runtime pin and engines field.

### Express 5 is stable and current; v5 adds async error forwarding and drops pre-v18 Node support.

**What the source says.** Express v5.0.0 officially released after years of development; focuses on simplified codebase, security, dropped old-Node support; 2026 stack guides list Express 5 with async errors auto-forward.

**Source.** https://github.com/expressjs/express/releases (via web search, Sep 2026)

**Confidence.** 85

**Changed.** Stack web framework choice.

### node:sqlite (DatabaseSync) ships in Node 22.5+, needs no flag from 22.13+/24, is Release Candidate Stability 1.2 (not final stable), and mirrors the better-sqlite3 sync API with zero install.

**What the source says.** node:sqlite included with Node 22.5.0+; v22.13.0+ experimental without flag; v24.15.0+/v25.7.0+ Release Candidate Stability 1.2; API modeled on better-sqlite3; 2026 migration trend drops better-sqlite3 as the only native dep.

**Source.** https://nodejs.org/api/sqlite.html (via web search, Sep 2026)

**Confidence.** 75

**Changed.** SQLite driver decision: node:sqlite over better-sqlite3.

### better-sqlite3 is still actively maintained but carries a native-prebuild chain with an open deprecation and a Node 26 gap.

**What the source says.** Described as mature and actively maintained with Node 22+ prebuilds; npm still warns deprecated prebuild-install@7.1.3 with replacement PR #1446 open; 11.x ships no Node 26 prebuilt and its C++ no longer compiles against that V8.

**Source.** https://github.com/WiseLibs/better-sqlite3/pull/1446 (via web search, Sep 2026)

**Confidence.** 75

**Changed.** SQLite driver decision: node:sqlite over better-sqlite3.

### Meta Marketing API v26.0 is current as of June 2026 with roughly four-monthly releases; a Meta-maintained Node SDK exists but direct versioned fetch is viable.

**What the source says.** Current version of the Marketing API is v26.0 (updated Jun 24, 2026); versions released approximately every four months with at least 90 days support for the previous version; facebook/facebook-nodejs-business-sdk listed as official Meta-maintained.

**Source.** https://developers.facebook.com/docs/marketing-api/ (version via search excerpts only; direct fetch returned truncated content — re-check at implementation)

**Confidence.** 70

**Changed.** Meta adapter shape and version pin.

### node:test is stable since Node 20 and sufficient for non-Vite Node services; Vitest is the 2026 default for Vite/TS projects, which this is not.

**What the source says.** node:test stable since 20.0, mature in 22, but lacking watch mode/snapshots/coverage UI; 2026 rule of thumb: libraries/CLIs use node:test, Vite apps use Vitest; greenfield default recommendation is Vitest.

**Source.** https://nodejs.org/api/test.html plus 2026 ecosystem guides (via web search, Sep 2026)

**Confidence.** 80

**Changed.** Test runner decision: node:test over Vitest.

## Sources not trusted

- Direct fetch of the Meta Marketing API docs returned truncated content with no version details; version claim rests on search excerpts and must be re-checked by the first Meta ticket.

## Assumptions this rests on

### One operator runs one local instance; there is no multi-user auth in v1.

**Believed because.** qa_auth.mode is none and env.allowlist is localhost-only; the spec's tenancy model arrives with real deployment.

**If wrong.** Single-operator pages leak tenant data across users; retrofit is an auth layer plus tenant scoping on every repository.

**Cheapest check.** Owner confirms no second operator or hosted demo is needed before the deployment issue.

### The owner can provide Meta app credentials with ads_management/ads_read when the Meta slice needs real reads.

**Believed because.** Spec S-26 requires an app plus advertising permissions; nothing in the repo provides them.

**If wrong.** Meta tickets run against the fake provider only and real-read verification slips a full epic.

**Cheapest check.** Ask the owner for a test ad account and app id before the first Meta ticket is planned.

### SQLite on a local file handles v1 event volume; Postgres plus BigQuery arrive in Phase 2.

**Believed because.** Spec S-21 names PostgreSQL as sufficient for Phase 1; SQLite shares its relational shape at v1 scale.

**If wrong.** Ingest falls over and the repository abstraction earns its keep early by moving to Postgres sooner.

**Cheapest check.** Seed script inserts 100k synthetic events and measures ingest p95 on a clean runner.

### Meta Graph API v26.0 (June 2026) remains current and stable through the first Meta epic.

**Believed because.** Web-search excerpts of Meta docs, June 2026; direct docs fetch failed so this is the weakest load-bearing fact.

**If wrong.** The version pin in the adapter changes by one constant, but field-level drift needs adapter rework.

**Cheapest check.** First Meta ticket re-checks https://developers.facebook.com/docs/marketing-api/ and records the live version.
