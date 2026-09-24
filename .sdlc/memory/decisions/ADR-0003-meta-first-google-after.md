# ADR-0003: Meta first, Google after

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #14

## Decision
Meta Ads is the first platform epic; Google Ads is a later epic reusing the Meta slice. S-25 and S-39 are deferred, not dropped.

## Why
Issue #14 carries a recorded owner answer (2026-09-24): the Meta Ads integration end to end ships first and Google Ads reuses it. A human decision about the product outranks the spec, including the S-39 Google-first argument.

## Consequences
Easy: one platform adapter proves the kernel/executor/measurement pattern. Hard: Google-specific primitives (keyword planning, ChangeEvent, native experiments) cannot shape v1 interfaces; the Google epic must generalize, not fork, the Meta adapter shape.
