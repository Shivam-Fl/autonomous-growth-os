# ADR-0004: SimulatedProvider is the first provider

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
`providers/simulated.ts` implements `ProviderAdapter` with deterministic delayed conversions, saturation curves, quality variance, outages, and external changes. No real ad credentials are loaded until this provider passes an eval suite.

## Why
Spec §36 Phase 0 is explicit. Real credentials before the simulator is trusted is how a project burns money and credibility in the first week.

## Consequences
Phase 0 output is synthetic. The first real-ads issue must demonstrate that the simulator's failure modes match reality before credentials are loaded — a deliberate speed-bump.
