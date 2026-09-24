# ADR-0004: Direct fetch Meta adapter

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #14

## Decision
Meta access goes through a versioned adapter using direct HTTPS against a pinned Graph API version (v26.0 at brief time), no Business SDK; a fake Meta provider ships with it for tests and simulation.

## Why
Meta maintains an official Node SDK, but a pinned-version fetch client has no dependency to lag the API, no native code, and exactly one place where the version lives. The first slice is read-heavy, where fetch needs nothing the SDK adds.

## Consequences
Easy: version bumps are a one-constant change; fakes are trivial. Hard: pagination, rate-limit backoff and batching are hand-rolled inside the adapter and must be tested as first-class behavior.
