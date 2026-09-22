# ADR-0006: Phase 0 scope is the simulator plus observability

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
First shippable slice is the fake ads universe and a UI that lets a human watch the system reason over it. No real ad credentials, no multi-business tenancy, no vector retrieval, no self-modification, no causal inference.

## Why
Spec describes nine phases over months. Pretending otherwise produces a brief that is a wishlist, not a work order. The simulator is the foundation every later phase depends on.

## Consequences
Phase 0 delivers no user-visible business value by itself. It delivers the testable, credential-free surface every later phase writes against. That is the honest scope.
