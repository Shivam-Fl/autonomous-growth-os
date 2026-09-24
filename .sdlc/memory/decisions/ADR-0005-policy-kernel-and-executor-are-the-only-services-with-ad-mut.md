# ADR-0005: Policy Kernel and Executor are the only services with ad mutation secrets

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #12

## Decision
Policy Kernel holds the capability-signing key (via KMS). Executor holds Meta Ads OAuth tokens. No other service (agents, research, UI) reaches these secrets. Agents propose ActionIntents; Policy Kernel evaluates and signs ActionCapabilities; Executor validates and executes. Service isolation enforced by IAM and network policies.

## Why
Spec §0.1 #1-3: 'LLMs never directly possess advertising mutation credentials. All external mutations pass through one deterministic Policy Kernel and one isolated Executor. The agent cannot modify the mechanism that defines what the agent is allowed to modify.' Spec §32: 'Separate service identities: api-read, research-worker, strategy-worker, policy-kernel, executor-google, executor-meta, event-ingest, self-improvement-observer, deploy-controller. Only executor accounts reach platform mutation secrets; only the Policy Kernel reaches the capability-signing key; the Self-Improvement Agent reaches neither.'

## Consequences
Easy: Even if an agent is compromised (prompt injection, memory poisoning), it cannot spend money. Hard boundary. Hard: More services to operate, more IAM policies, more network rules. Debugging requires tracing across service boundaries. Latency of capability issuance.
