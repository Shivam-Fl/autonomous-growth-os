# ADR-0005: SQLite now, Postgres later

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #14

## Decision
Persist through repository interfaces backed by node:sqlite now; move to Cloud SQL Postgres plus pgvector in Phase 2 without touching domain code.

## Why
node:sqlite is compiled into Node itself, maintained by the Node core team, mirrors the better-sqlite3 sync API, and installs nothing — ideal for a clean CI runner. better-sqlite3 remains mature but carries a native prebuild chain with an open 2026 deprecation and a Node 26 compilation gap. A repository interface keeps the choice reversible.

## Consequences
Easy: zero-dependency persistence, temp-file test databases. Hard: node:sqlite is Stability 1.2 (release candidate); minor API churn is possible and pgvector has no local equivalent, so vector search starts as keyword plus embedding-column scaffolding.
