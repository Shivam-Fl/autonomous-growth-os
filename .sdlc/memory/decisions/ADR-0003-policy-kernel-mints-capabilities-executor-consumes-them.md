# ADR-0003: Policy Kernel mints capabilities; Executor consumes them

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
All ad mutations flow: agent request → kernel/ validates against policy → kernel/ mints a signed, scoped, expiring capability → executor/ consumes the capability against the provider. Credentials live only in executor/'s process memory at call time.

## Why
Spec §0.1 and §14 require structural authority separation. Implementing it as a typed boundary from day one is cheap; retrofitting it after four features call the provider directly is not.

## Consequences
Every mutation is one audit-receipt longer. Every new provider action requires a kernel rule and an executor function. This is the intended friction — it makes unauthorized writes structurally impossible, not just policy-violating.
