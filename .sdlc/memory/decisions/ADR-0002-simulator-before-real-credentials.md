# ADR-0002: Simulator before real credentials

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #12

## Decision
Phase 0 builds a fake Meta Ads adapter, synthetic business funnel, delayed conversion generator, seasonality, saturation, lead quality variance, and scenario runner before any real Meta Ads integration. Real credentials are not touched until the simulator can replay realistic scenarios.

## Why
Spec §36 Phase 0: 'A fake advertising universe: fake Google Ads adapter, fake business funnel, delayed conversion generator, seasonality, campaign saturation, lead-quality variation, manual external changes, API failures, tracking outages. You cannot safely build autonomous logic against real spend before having a replay/simulation environment.' Example scenario: campaign A cheap low-quality leads; B expensive high-quality; C an initial winner that saturates after ₹5k/day; checkout breaks on day 10; a competitor enters on day 15; conversion delay increases on day 20. The agent should make sensible decisions.

## Consequences
Easy: Autonomous logic can be tested adversarially without risking real money. Scenarios can reproduce failures (double writes, attribution impatience, memory poisoning) as regression tests. Hard: The simulator must be realistic enough that lessons transfer to real platforms; building a good fake is non-trivial. Delay before first real integration.
