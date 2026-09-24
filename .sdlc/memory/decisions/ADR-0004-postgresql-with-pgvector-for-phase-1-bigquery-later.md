# ADR-0004: PostgreSQL with pgvector for Phase 1, BigQuery later

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #12

## Decision
Phase 1 uses PostgreSQL 16 with pgvector for all operational state: configuration, current resource model, research, memory, actions, experiments, modest event volume, embeddings, audit references. BigQuery is added in Phase 2 when event volume grows (operational state in Postgres, high-volume event history in BigQuery, assets in GCS).

## Why
Spec §21 Phase 1: 'PostgreSQL is enough (Cloud SQL supports pgvector): configuration, current resource model, research, memory, actions, experiments, modest event volume, embeddings, audit references. Partition where needed.' Phase 2 adds BigQuery for high-volume event history and large-scale replay/analytics. Starting with both adds cost and complexity without benefit at alpha scale.

## Consequences
Easy: One database to operate, backup, and query. pgvector handles semantic memory without a separate vector database. Hard: Event volume may hit Postgres limits sooner than expected; partitioning strategy needed early. Analytical queries on large event tables may be slow; materialized views or read replicas may be needed.
