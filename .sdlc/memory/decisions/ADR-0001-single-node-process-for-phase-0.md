# ADR-0001: Single Node process for Phase 0

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
One `node` process serves Fastify API and the Vite-built UI on port 3000. No separate frontend server, no reverse proxy in dev.

## Why
The pipeline boots one command (`npm run sdlc:serve`) and polls one URL. Every extra process is a thing QA must wait for and an agent must reason about. Phase 0 has one simulated business; there is no load case for splitting.

## Consequences
Easy to run, easy to debug, easy for agents. Hard ceiling: cannot scale API and UI independently. The moment there is a real load case, split into two deployables — the module boundary is already drawn at `server/` vs `ui/`.
