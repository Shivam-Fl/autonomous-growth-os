# ADR-0007: Anthropic Claude as primary LLM with ModelRouter abstraction

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
Anthropic Claude API is the primary LLM provider, with a ModelRouter abstraction supporting multiple providers. The ModelRouter routes by task type: extraction (fast/cheap), strategy (high-reasoning), risk critique (independent strong pass), coding (sandbox agent). Every decision versions provider, model, prompt, tool catalog, and reasoning mode.

## Why
The spec's agent topology requires high-reasoning models for strategy and independent models for risk critique. Section 17 explicitly states 'do not use one expensive frontier model for everything' and requires a ModelRouter. Section 17.2: 'For high-impact actions use an independent model/provider to reduce correlated reasoning failure.' Anthropic Claude is chosen as primary because it is the model the spec was written against, but the ModelRouter abstraction prevents vendor lock-in per invariant 0.1.12.

## Consequences
Makes it easy to use the right model for each task (cheap for extraction, strong for strategy, independent for risk critique), and easy to switch providers without rewriting business logic. Makes it harder to avoid the cost of using multiple models; the System Auditor must track cost per task type and identify waste. Requires maintaining the ModelRouter abstraction and provider adapters.
