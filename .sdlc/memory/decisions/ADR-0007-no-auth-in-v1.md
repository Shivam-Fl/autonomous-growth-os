# ADR-0007: No auth in v1

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #14

## Decision
No authentication or multi-tenancy in v1; all records still carry tenant_id from day one so scoping is a constraint, not a migration.

## Why
qa_auth.mode is none and the API allowlist is localhost-only: v1 is a single-operator local tool, and any login screen would be untestable ceremony QA cannot drive. The spec's organizations, memberships and RLS arrive with real deployment.

## Consequences
Easy: every page is immediately drivable by QA with no fixture accounts. Hard: the first hosted or multi-user deployment must add auth plus tenant scoping first, before any other feature on that epic.
