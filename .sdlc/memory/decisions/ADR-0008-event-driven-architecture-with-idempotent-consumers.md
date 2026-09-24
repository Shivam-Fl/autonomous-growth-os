# ADR-0008: Event-driven architecture with idempotent consumers

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #12

## Decision
Services emit domain events (metrics.synced, conversion.received, action.executed, experiment.matured, etc.) to an event bus (Pub/Sub in production, in-process bus initially). Consumers are idempotent on event_id. Raw events are stored before normalization. Multi-step mutations use saga/compensating actions in durable workflows, not long-running functions.

## Why
Spec §22: 'Event-driven architecture. Consumers must be idempotent. Multi-step mutations (create budget → campaign → ad group → ads → experiment) need saga/compensating actions in a durable workflow, not a long Python function.' Events provide loose coupling, audit trail, and replay capability. Idempotency prevents duplicate processing on retries.

## Consequences
Easy: Services are loosely coupled. Events can be replayed for debugging or backfill. Audit trail is built-in. Hard: Eventual consistency is harder to reason about than synchronous calls. Idempotency keys must be managed. Event schema evolution requires care. Debugging requires tracing across events.
