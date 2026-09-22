# ADR-0002: PostgreSQL + pgvector as the primary data store from day one

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
PostgreSQL 16+ with pgvector 0.8+ (Cloud SQL) is the primary data store for configuration, resource model, research, memory, actions, experiments, embeddings, and audit. BigQuery is added later only when event volume grows.

## Why
Section 21 of the spec explicitly states 'Phase 1 — PostgreSQL is enough' and to add BigQuery only when event volume grows. PostgreSQL + pgvector handles operational state + vector embeddings in one database, avoiding the complexity of maintaining two data stores before the system has proven its architecture. Cloud SQL supports pgvector natively.

## Consequences
Makes it easy to start without the operational complexity of BigQuery, and easy to query operational state + vector embeddings in one database. Makes it harder to scale to very high event volumes (millions of events per day) without adding BigQuery later; the spec acknowledges this and describes the Phase 2 migration path.
