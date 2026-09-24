# sdlc-state

Per-issue ledgers for the Automated AI SDLC, one JSON file per issue under `state/`.

This is an **orphan branch**: it shares no history with `main`. State churns constantly, and
keeping it here means those writes never conflict with a feature branch and never trigger CI.

Written by workflows via compare-and-swap. Do not merge this branch into anything, and do not
hand-edit a ledger while an agent holds its lock.
