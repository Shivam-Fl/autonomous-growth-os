# Roadmap — survey of 2026-09-25

First survey (no prior roadmap on file). Rebuilt from 11 open issues (#14, #16–#26), 1 open PR (#27), and 9 recently closed (#1, #4–#12). No `untrusted` entries.

## Shipped

Nothing a user can do yet: there is no code — `src/`, `test/` and `scripts/` do not exist and all four `sdlc:` verbs are still stubs. What shipped is the plan: architecture decided and recorded (`project.md`, ADRs, TR-1–TR-26, UI spec), the product split into seven ordered slices (#16–#22) under epic #14, and the pre-architecture prototype issues (#4–#10) plus duplicate architecture issues (#1, #12) closed out of the way.

Binding owner decision (recorded on #14, copied to every slice): Meta Ads end-to-end ships first; Google Ads is a later epic reusing the Meta slice. Spec §37 argues Google-first and is stale on that point.

## In flight

- #16 Boot local app (dashboard shell, health, money, audit) — in QA, with the only open PR (#27 from `sdlc/issue-16`). Opened 2026-09-24; not stalled.
- #17 Measure click-to-revenue truth — open, parked on #16.
- #18 Meta read + dashboard — open, parked on #16.
- #19 Shadow journal + calibration — open, parked on #17 and #18.
- #21 Research mesh + memory — open, parked on #17.
- #20 Policy capabilities + approvals + guardian — open, parked on #19.
- #22 Opportunity ranking + experiments — open, parked on #19 and #21.

## Next

1. Land #16 (merge #27). Reason: it defines the app, database, money, audit and workflow contracts every later slice builds on; nothing else can start until it does.
2. #17 and #18, in either order. Reason: they depend only on #16, are independent of each other, and together supply the owned-truth funnel and the platform data that the journal (#19) and research (#21) slices consume.
3. #19 shadow journal. Reason: it is the gate between read-only analysis and any autonomous spend, and its decision-record contract is what the safety slice (#20) later executes against.

## Blocked, and on whom

Nothing waits on a human decision: the one owner question (Meta-first) is answered and recorded. Two constraints to watch, neither blocking today:

- Meta app credentials arrive from the owner before real-read tickets (prd.md constraint) — #18 stays buildable without them via the fake provider; only the live path is credential-gated.
- No staging or production exists and v1 assumes none — anything needing hosted infra waits for the hosted-runtime epic (#24, still deferred).

## Epics

- #14 Decide the architecture for the Autonomous Growth OS — in flight (architecture decided and split; 0 of 7 slices closed). No dependencies; it is the only open epic.
- Not yet epics (deferred issues under #14; file as epics only when next): #23 Google Ads slice — waits on the Meta pattern (#18/#20); #24 hosted runtime — waits on local slices proving the pattern; #25 self-improving brain — waits on frozen replay + shadow + calibration history; #26 creative/MMM/geo/bandits — waits on L1/L2 experiments earning them.

## Survey notes

Filed nothing this run: every TR-1–TR-26 is covered by a slice or a deferred item, the backlog is one day old with no stalled work, and the codebase is empty so there is no drift, recurrence, or dead code to report. The hosted-runtime issue project.md anticipates already exists as deferred #24; filing it as an epic now would violate the next-not-eventual rule.
