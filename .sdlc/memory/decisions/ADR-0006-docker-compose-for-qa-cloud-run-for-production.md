# ADR-0006: Docker Compose for QA, Cloud Run for production

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #12

## Decision
Local development and QA use Docker Compose (env.mode=compose in config.yml). Pull request previews are the same compose stack on GitHub Actions runner. Production deployment is Google Cloud Run services, worker pools, Cloud SQL, Secret Manager, KMS, Pub/Sub. GitHub Actions deploys via OIDC.

## Why
Config.yml specifies env.mode=compose and env.boot='npm run sdlc:serve' which runs docker compose. QA drives a real browser against a real preview; compose provides that. Spec §20 recommends Google Cloud + Temporal Cloud + GitHub for production. Spec §32 shows the production topology with Cloud Run. GitHub Actions uses OIDC to authenticate to GCP (no long-lived service-account keys).

## Consequences
Easy: QA can drive the same stack locally and in CI. No environment drift. Compose is simple to understand. Hard: Compose does not scale to production traffic; Cloud Run requires Terraform and IAM setup. Two deployment targets to maintain (compose vs Cloud Run). Cloud Run cold starts may affect latency.
