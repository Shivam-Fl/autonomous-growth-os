# ADR-0005: Eval suite is separately permissioned and promotion-gating

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
`eval/` holds the only code that judges whether a strategy or code candidate beats its baseline. Promotion flows require eval pass; LLM assertions are stored as evidence, not decisions.

## Why
Spec §0.1 item 10 and §14. A system that promotes on LLM self-report is a system that drifts silently.

## Consequences
Every candidate needs a measurable baseline and a defined eval. Slows early iteration deliberately — the alternative is a system that 'improves' in ways nobody can audit.
