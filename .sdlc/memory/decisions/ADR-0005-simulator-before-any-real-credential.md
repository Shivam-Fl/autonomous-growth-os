# ADR-0005: Simulator before any real credential

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
Phase 0 is the simulator: fake Google Ads adapter, fake Meta Ads adapter, synthetic business with delayed conversions, seasonality, campaign saturation, lead-quality variation, manual external changes, API failures, tracking outages. No real credential is used until the simulator is working and the system can make sensible decisions in simulated scenarios.

## Why
Section 36 Phase 0 is explicit: 'A fake advertising universe with delayed conversions, saturation, quality variance, outages and external changes comes before any real credential.' Engineering rule 16: 'Build a fake provider before enabling real writes.' You cannot safely build autonomous logic against real spend before having a replay/simulation environment.

## Consequences
Makes it safe to build autonomous logic without risking real money, and easy to test scenarios (checkout breaks, competitor enters, conversion delay increases) that are hard to reproduce in production. Makes it harder to test against real platform behavior (API quirks, rate limits, schema changes) until Phase 1; the simulator must be realistic enough to catch logic errors but cannot catch platform-specific issues.
