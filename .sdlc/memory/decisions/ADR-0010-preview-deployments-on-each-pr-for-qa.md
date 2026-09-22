# ADR-0010: Preview deployments on each PR for QA

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
Each PR gets a temporary Cloud Run service URL for QA to drive. The URL is destroyed on PR merge/close. QA drives the preview in compose mode, using the sdlc:serve command.

## Why
The SDLC pipeline requires QA to drive a real browser against a real preview. Section 20 of the spec describes Cloud Run services that scale to zero, making it cost-effective to spin up temporary instances for each PR. The preview URL is the target QA drives; without it, QA has nothing to test.

## Consequences
Makes it easy for QA to test each PR in isolation, and easy to destroy the preview on merge/close to avoid cost. Makes it harder to avoid the cost of temporary Cloud Run instances for each PR; the cost is usage-based and should be low if PRs are short-lived. Requires automating the preview deployment in CI/CD.
