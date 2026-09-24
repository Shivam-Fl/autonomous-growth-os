# ADR-0002: Defer everything with a server

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #14

## Decision
Rejected for v1: TypeScript build, Python service, Postgres server, React/Vite SPA, Temporal Cloud, Kubernetes. Each returns as the phase that needs it.

## Why
A TypeScript build step, a Python toolchain, Postgres and Temporal each add a moving part QA would trip over before the first feature exists. The spec itself orders simulator, measurement and shadow before autonomy, and all of those run fine in-process against a file database.

## Consequences
Easy: each deferred piece arrives against a working system with replay data. Hard: the Postgres/pgvector and Temporal migrations are real projects later; the repository and workflow abstractions must be respected or they become expensive.
