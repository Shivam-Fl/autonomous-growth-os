# ADR-0006: Built-in test runner

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #14

## Decision
Tests run on the built-in node:test plus node:assert/strict; no test framework dependency.

## Why
node:test is stable since Node 20, ships with the runtime, and needs no install on the clean runner, which makes sdlc:verify hermetic apart from the app's own dependencies. Vitest is the 2026 default for Vite/TS projects, which this is not.

## Consequences
Easy: fast, zero-config unit and integration tests. Hard: no snapshot UI or coverage dashboards; if the suite outgrows node:test, migrating to Vitest is a small, contained change.
