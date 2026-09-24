# ADR-0001: Meta Ads first, Google Ads after

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #12

## Decision
The first ad-platform epic is the Meta Ads integration end to end (simulator, read, shadow, write). Google Ads is a later epic that reuses what the Meta slice established (adapter interface, Policy Kernel, Executor, event ingestion, measurement).

## Why
Issue #12 owner decision explicitly states: 'Meta Ads first, Google Ads after. The first ad-platform epic is the Meta Ads integration end to end; Google Ads is a later epic that reuses what the Meta slice established. This overrides the Google-first argument in spec §37.' The spec's §37 argument for Google-first (query intent interpretable, reporting API strong, experiments native) is sound but has been considered and overruled by the human.

## Consequences
Easy: Meta's creative-focused optimization (broad automated delivery, creative portfolio, audience hypotheses) forces early attention to creative intelligence and customer-language mining, which are core differentiators. Hard: Meta's API requires app review for ads_management permission, which takes time; Google's API is more straightforward for read-only access. Meta's attribution is less interpretable than Google's keyword-level intent.
