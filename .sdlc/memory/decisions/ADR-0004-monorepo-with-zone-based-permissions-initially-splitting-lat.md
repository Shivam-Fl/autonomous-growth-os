# ADR-0004: Monorepo with zone-based permissions initially, splitting later

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
The system starts as a monorepo with zone-based permissions (GREEN autonomous candidate / YELLOW PR only / RED mandatory code-owner review / BLACK inaccessible). The policy_kernel, executor, and infrastructure are split into separate repositories before enabling broad self-modification in production.

## Why
Section 15 of the spec states 'An early MVP may stay a monorepo, with zones' and 'Split Kernel/Infra/Evals physically before enabling broad self-modification in production.' Starting as a monorepo reduces the operational complexity of managing multiple repositories before the architecture is proven. Splitting later enforces the hard security boundary: the agent cannot modify the mechanism that defines what it is allowed to modify.

## Consequences
Makes it easy to start without the operational complexity of multiple repositories, and easy to iterate on the architecture before it is proven. Makes it harder to enforce the hard security boundary between the agent-modifiable code and the policy kernel/executor/infrastructure until the split happens; the zone-based permissions are a soft boundary until the split.
