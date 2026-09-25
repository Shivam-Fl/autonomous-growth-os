# Roadmap — survey of 2026-09-25 (second)

Rebuilt from 12 open issues (#14, #20, #23–#28, #40, #44, #46–#48), 1 open PR (#43) and 19
recently closed. No `untrusted` entries. The previous roadmap described a repository with no
code in it; six of the seven slices it listed as in flight have since landed.

## Shipped

- **The app boots.** A local-first Node monolith on $PORT serving five server-rendered screens
  and a versioned JSON API, with health, money as integer micros, append-only audit, and an
  in-process workflow scheduler with sagas.
- **First-party measurement.** Events ingest idempotently; a click-to-customer journey graph, a
  downstream quality funnel, maturity scores with lag, and a maturity-gated qualified CPL.
- **Meta read.** A versioned adapter with a fake provider, campaign regions on the dashboard,
  last-good data and a named failure when the provider errors.
- **A shadow decision journal.** Alternatives including do-nothing, expected effect
  distributions, downside, evidence and memory refs, matured evaluation, and a calibration
  report — computed live and against a frozen replay corpus.
- **A research mesh.** Layered source adapters, claim extraction with evidence tiers, and
  evidence-scoped learnings with staleness and contradiction handling.
- **Opportunities and experiments.** Eight stored score components, ranked bets, experiments with
  caps and stop rules, and a first-class inconclusive state.
- **Money is honest on the wire.** Opportunity money stored and returned as integer micros, and
  the tenant's currency threaded through every renderer that draws an amount.
- **Every page opens with a heading.** One `h1` per document across all five routes and five
  states, added today (#42).

## In flight

- **#20 Policy capabilities, approvals, guardian freezes** — the last Meta slice, in
  `sdlc:planning` with an owner `replan` note. Nothing else in the project can start until it
  lands.
- **#40 Follow-ups from the review of #39** — has the only open PR (#43). Carries
  `sdlc:needs-human`; #44 is parked behind it.
- **#44 Follow-ups from the review of #43** — `sdlc:blocked` on #40. Two of its eight findings
  are the same two defects #47 filed 17 minutes later.
- **#46 Follow-ups from the review of #45** — in `sdlc:planning`; #45 is already merged.
- **#47 and #48** — pre-existing bugs QA found while testing #43 and #45 and correctly scoped out
  of those PRs. Unlabelled and unplanned; #48 (pages overflow at 375px) is the one that matters.
- **#28 Spec coverage** — stale. Its table was rebuilt at 06:01, before #16–#22 closed, so it
  still reads "in flight" against six closed issues. This survey's rebuild is what corrects it.
- **#14 the epic** — stays open while #20 is open.

## Next

1. **Land #20.** Reason: it is the last slice of the Meta-first direction the owner chose, and it
   is the single chokepoint — all four deferred items (#23, #24, #25, #26) wait on it. Nothing
   else in the project is unblocked.
2. **Close the follow-up tail as one unit rather than round by round.** Reason: #40 → #44 → #46
   is a chain in which each fix PR generated the next issue, and #44 and #47 describe the same two
   defects. Fixing both as filed will do the same work twice and will generate a seventh round.
3. **Decide whether #25 becomes the next epic — after #20 lands, not before.** Reason: its stated
   reason for deferral ("promotion gates need frozen replay, shadow and calibration history")
   became false today, when #19 closed and the replay corpus landed. It is the only deferred item
   whose blocker has cleared, and it is four separate architectural decisions inside one issue. It
   is not an epic this week: it has no architecture to split against until #20 fixes the BLACK-zone
   boundary TR-16 names, and splitting it now would produce issues that all get replanned.

## Blocked, and on whom

- **#20's plan, on the owner.** The recorded `replan` (2026-09-25T15:07) says to read a triage
  comment on the work-order issue and replan. That comment is not in `maintainer/`, and this
  survey cannot read it. This is the only open human dependency in the project.
- **Meta app credentials, on the owner** — still required before any live read. Every read path
  shipped so far runs on the fake provider, so nothing is blocked today.
- **Hosted infrastructure, on the owner** — none exists (ADR-0008) and #24 needs a human to
  choose and pay for a target. Deferred, not blocking.
- **`.sdlc/config.yml` is under `forbidden_paths`, so this is noted, not filed.** The installer's
  "Detected stack: unknown — could not work out how to start this app" comment is stale:
  `env.boot` is `npm run sdlc:serve` and QA has been driving the pages all day. Only a human can
  edit that file, and nothing is wrong.

## Epics

One open epic, and it waits on nothing:

- **#14 Decide the architecture for the Autonomous Growth OS** — in flight. 6 of 7 slices closed,
  #20 open, 4 deferred children open.

The four deferred children are not epics, but they are the graph that comes after #14, and
**every one of them waits on #20**:

- **#25 Self-improving brain** — blocker cleared (#19 closed, replay corpus landed); waits on #20
  for the protected BLACK-zone boundary.
- **#23 Google Ads** — waits on #20; it reuses the kernel, executor and measurement pattern the
  Meta slice establishes.
- **#26 Creative, MMM, geo incrementality, bandits** — waits on #20, and on L1/L2 experiment
  evidence that must earn the advanced causal layers.
- **#24 Hosted runtime** — waits on #20, and on a human choosing a target.

No `epic_links` were written: there is one open epic and it has no upstream dependency, and
dependencies between non-epic issues are carried by the `Depends on #N` lines already in their
bodies.

## Survey notes

Filed one issue: the recurring "a comment or contract states a stronger guarantee than the code
enforces" shape, found in three consecutive review rounds and a QA pass, is still not written
down in `.sdlc/memory/patterns/` — which is what that file exists to stop.

Deliberately not filed: the two-of-eight money-readability asymmetry (already filed twice, as
#44 and #47 findings, with the same one-line fix proposed in both); the stale `docs/ui.md` and the
missing page title (already #46); the 375px overflow (already #48); the empty
`.sdlc/memory/patterns/` README's other half (the instances belong to the issues that found
them); and any epic — the only work that is next is #20, and it already exists as an issue.
