# ADR-0003: Temporal Cloud for orchestration, stubbed initially

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #12

## Decision
Temporal Cloud is the durable workflow engine for multi-day processes (experiment lifecycle, research pipeline, self-improvement). Initially stubbed with in-process synchronous Python workers so the first epic can run without Temporal Cloud provisioning. The workflow abstraction is defined early so stubs can be replaced with real Temporal workflows later.

## Why
Spec §19: 'Do not use a giant cron script. These are durable multi-day workflows: create experiment → wait 7 days → conversion events arrive → wait until maturity → evaluate → promote or rollback.' Temporal provides durable workflow state, retries, timers, long waits, signals, history, crash recovery. Cloud Run worker pools are intended for continuous non-request background work (Temporal workers). The cost-sensible alpha uses managed Temporal Cloud rather than self-hosted.

## Consequences
Easy: Multi-day workflows are resumable across crashes. Timers and signals are first-class. History provides audit trail. Hard: Temporal Cloud costs money (usage-based). Learning curve for workflow/activity patterns. Initial stubs do not provide durability; switching to real Temporal requires care to preserve workflow semantics.
