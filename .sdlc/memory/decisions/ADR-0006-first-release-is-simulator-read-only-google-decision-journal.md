# ADR-0006: First release is simulator + read-only Google + decision journal + shadow mode

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
The first release (Phase 0 + partial Phase 1 + Phase 2) is: the simulator, read-only Google Ads integration (OAuth, account sync, GAQL reporting, ChangeEvent, search terms, keyword planning, first-party conversion import, basic Growth Pixel, state snapshots, research, recommendation UI), decision journal + shadow mode (daily: decide what it would do, mutate nothing, store predicted impact, evaluate later, produce decision precision, false-intervention analysis, calibration). No writes.

## Why
The spec describes nine phases over months. The first shippable slice must prove the architecture before any real credential touches the system. Phase 0 (simulator) is required by engineering rule 16. Phase 1 (read-only Google) proves the integration layer without risk. Phase 2 (decision journal + shadow mode) proves the decision-making layer without risk. Engineering rule 17: 'Shadow mode must exist before guarded autonomy.'

## Consequences
Makes it safe to ship the first release without risking real money, and easy to evaluate decision quality before any write capability exists. Makes it harder to demonstrate real business value in the first release; the system produces recommendations and shadow decisions, but does not execute them. Real business value requires Phase 3 (human-approved executor) or later.
