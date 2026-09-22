# ADR-0003: Temporal Cloud for durable workflow orchestration

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
Temporal Cloud is used for durable multi-day workflows (experiments, research, evaluation, self-improvement) with workers in Cloud Run worker pools. The alternative (Google Cloud Workflows) was rejected.

## Why
The spec describes durable multi-day workflows (create experiment → wait 7 days → conversions arrive → wait until maturity → evaluate), crash recovery over long durations, and Temporal's TypeScript SDK is mature. Google Cloud Workflows is less suited to Python-heavy strategy logic with dynamic branching. Temporal provides: durable workflow state, retries, timers, long waits, signals, history, crash recovery; workflows resume across crashes and infrastructure failure over very long durations.

## Consequences
Makes it easy to implement durable multi-day workflows with crash recovery, and easy to use Python for strategy logic within Temporal activities. Makes it harder to avoid the operational complexity of managing a Temporal Cloud account and the cost of Temporal Cloud (usage-based pricing). Requires architecting a workflow abstraction either way per the spec.
