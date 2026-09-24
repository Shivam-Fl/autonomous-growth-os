# ADR-0008: Deploy nowhere yet

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #14

## Decision
Deploy target is nowhere yet: local compose boot only; the first deployment issue creates Cloud Run plus Cloud SQL previews per PR.

## Why
env.mode is compose with boot npm run sdlc:serve, but no registry, cloud project or preview infrastructure exists, and claiming one would imply a deployment nobody can drive. QA runs against the local compose boot until a deployment issue creates the real path.

## Consequences
Easy: honest previews, no phantom infra tickets. Hard: Temporal Cloud, Cloud SQL and secret management all queue behind the deployment issue, which becomes the critical path to any production autonomy.
