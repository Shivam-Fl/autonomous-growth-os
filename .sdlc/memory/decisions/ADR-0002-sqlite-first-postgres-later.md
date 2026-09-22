# ADR-0002: SQLite first, Postgres later

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
Phase 0 and Phase 1 persist to SQLite via `better-sqlite3`. The `memory/` module owns all SQL; no other module imports sqlite directly.

## Why
Phase 0 is a simulator with one fake account. Postgres adds a second process, a migration tool, connection auth, and pgvector before any of it is needed. The swap is contained in `memory/` because the boundary is enforced by module ownership.

## Consequences
Zero-config dev, instant CI, trivial seeding. Loses concurrent writers, vector search, and cross-account priors until the Postgres migration issue lands. That issue is cheaper than building against Postgres from day one.
