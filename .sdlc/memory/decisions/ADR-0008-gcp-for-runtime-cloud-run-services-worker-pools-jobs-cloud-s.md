# ADR-0008: GCP for runtime: Cloud Run services/worker pools/jobs, Cloud SQL, Pub/Sub, KMS

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
GCP is the runtime platform: Cloud Run services (API/BFF, Policy Kernel, Executor, event ingestion, webhook receiver), Cloud Run worker pools (Temporal workers), Cloud Run jobs (historical replay, batch research, data backfill), Cloud SQL PostgreSQL + pgvector, Pub/Sub, Secret Manager, KMS, Cloud Storage, Cloud Logging/Monitoring, Artifact Registry. No Kubernetes early.

## Why
The spec explicitly recommends GCP in section 20: Cloud Run services/worker pools/jobs, Cloud SQL PostgreSQL with pgvector, Pub/Sub, Scheduler, Secret Manager, KMS, Storage, Logging/Monitoring, Artifact Registry. The spec also describes OIDC from GitHub Actions to GCP. Cloud Run worker pools are intended for continuous non-request background work—a good fit for Temporal workers. Cloud Run services scale to zero when idle, reducing cost. The spec explicitly states 'do not deploy Kubernetes early.'

## Consequences
Makes it easy to use the services the spec designs around, and easy to authenticate from GitHub Actions via OIDC without long-lived service-account keys. Makes it harder to avoid GCP-specific vendor lock-in; migrating to AWS or Azure would require rewriting the deployment topology. Requires maintaining Terraform for GCP infrastructure.
