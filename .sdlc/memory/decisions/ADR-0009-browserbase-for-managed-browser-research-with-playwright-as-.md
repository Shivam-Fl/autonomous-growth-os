# ADR-0009: Browserbase for managed browser research with Playwright as fallback

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
Browserbase is used for managed production browsers for research (search, read, click public pages, interact with research filters). Playwright is the deterministic fallback for extraction that does not require managed browsers. The browser is for research and allowed business workflows—not the default path for ad mutations.

## Why
Section 5.1 Layer 4 of the spec: 'real browser only when the page is JS-heavy, information is behind interaction, tabs/filters need navigation, dynamic pricing must be read, screenshots matter, or a public workflow cannot be extracted reliably.' Section 18: 'Browserbase + Stagehand for managed production browsers; Playwright in an isolated job as the deterministic fallback.' Advertising mutation uses official APIs, never a browser (engineering rule 16, section 18).

## Consequences
Makes it easy to do browser research without managing browser infrastructure, and easy to fall back to Playwright for deterministic extraction. Makes it harder to avoid the cost of Browserbase (usage-based pricing) and the security risk of browser research (prompt injection, untrusted content); the Browser Security Gateway and prompt-injection boundary are critical.
