# ADR-0001: Boring Node monolith

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #14

## Decision
Node.js 22 LTS, Express 5, node:sqlite (built-in DatabaseSync), server-rendered HTML with vanilla JS and no build step.

## Why
The pipeline drives a real browser against npm run sdlc:serve on a clean runner with only node/npm and python3. A single Node process with zero native dependencies boots in seconds, needs no external services, and serves QA-drivable pages immediately; every heavier option defers the first verifiable slice.

## Consequences
Easy: instant boot, trivial CI, every ticket verifiable end to end. Hard: CPU-heavy later work (MMM, bandits, large replay) will need worker extraction or a second runtime; SQLite caps ingest scale until the Postgres move.
