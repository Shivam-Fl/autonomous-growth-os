# Roadmap — survey of 2026-09-26 (third)

Rebuilt from 14 open issues (#14, #20, #23–#26, #28, #47, #49, #55, #56, #61, #71, #72), 4 open
PRs (#53, #59, #62, #73) and 30 recently closed. No `untrusted` entries. The previous
roadmap's two standing claims are corrected below: **#28 is no longer stale** — its table was
rebuilt and correctly shows #20 in flight — and **#20 is no longer blocked on its plan**; it
has a work order and a PR.

## Shipped

New since the last survey:

- **A currency that names nothing reads as unknown, not as rupees.** A spend row whose
  currency is not the tenant's is rejected on ingest (#64), and a stored code that names no
  currency renders as unknown instead of a rupee figure, on every surface that draws money
  (#58, #68).
- **The pages fit a phone.** The dashboard, journal and approvals screens no longer scroll
  sideways at 375px; one wide table no longer sizes the whole grid column (#48).
- **A long opportunity name stays inside its card** instead of stretching it (#67).

Standing, from the slices before that: the app boots locally with five server-rendered screens
and a versioned JSON API; events ingest idempotently and drive a maturity-gated qualified CPL;
a versioned Meta adapter with a fake provider feeds the dashboard; the decision journal records
alternatives, expected effect and calibration against a frozen replay corpus; the research mesh
extracts claims with evidence tiers into evidence-scoped learnings; opportunities rank with
eight stored score components and experiments settle with caps, stop rules and an inconclusive
state.

## In flight

- **#20 Gate every write behind policy capabilities, approvals and guardian freezes** — the last
  Meta slice, implemented and in review: **PR #53 is open and unmerged**. It is the only PR on
  the roadmap's chokepoint.
- **#55 Follow-ups from #51** (6 review, 2 QA) — PR #59 open.
- **#61 Follow-ups from #52** (3 review) — PR #62 open.
- **#71 Follow-ups from #67** (5 review, 2 QA) — PR #73 open.
- **#72 Follow-ups from #68** (6 review) — no PR, unplanned. Its `Depends on #68` is closed, so
  it is unblocked; it is the newest and the largest of the round.
- **#56 Follow-ups from #40** (6 review, 1 QA) — at `sdlc:plan-review`, no PR. `Depends on #40`
  is closed, so it is unblocked too.
- **#47 Three pre-existing bugs QA found while testing #43** — two on the opportunity
  component contract (a missing key vanishes from the wire; a float money amount crosses the API
  in the same body that reports the contribution as null) and one on the seed's unreadable-record
  guard. Unplanned, no PR, no dependent issue.
- **#49 The "guarantee the code does not keep" pattern** — a memory write into
  `.sdlc/memory/patterns/`, which is still empty. No code, no PR; it has been open since the last
  survey.

Every `Depends on #N` in the open set now points at a closed issue. Nothing in the tracker is
waiting on another issue; what is waiting is a human (below).

## Next

1. **Land #20.** Reason: it is the last open slice of the epic, and all four deferred children
   (#23, #24, #25, #26) are written against the policy-kernel → executor → trust-ledger boundary
   it fixes. Until it lands, every piece of product work in the repository is either this or
   behind it.
2. **Merge #59, #62 and #73 together and take #72 and #56 in the same pass.** Reason: five of
   the open issues are rounds of one loop over two surfaces — currency rendering, and claims in
   comments and tests that the code does not back. Each round files the next (#40 → #44 → #46 →
   #51 → #52 → #58 → #64 → #67 → #68 → #71/#72), and the review stage finds more each time
   because each round widens the surface it touches. `limits.max_in_flight` is 2, so the loop is
   also consuming every slot the roadmap has.
3. **Do #49.** Reason: it is a memory write with no code and no PR, it costs one work order, and
   it is the only thing on the list that reduces the *next* round's findings rather than adding
   to this one. Five of the six open follow-up issues are the shape it documents.

## Blocked, and on whom

- **PR #53, on a human.** It holds the only product work in flight and it is not merged. The
  open question attached to it: the owner's recorded `replan` on #20 (2026-09-25T15:07) asks for
  triage's comment on the work-order issue to be read before replanning. A work order and a PR
  now exist, so the replan appears to have happened — but a survey cannot read comments, and the
  changeless PR body is the only record here. Somebody should confirm triage's comment was
  addressed before this merges, because the alternative is merging a plan the owner asked to have
  revisited.
- **Eight open issues carry `sdlc:needs-human`** — #20, #47, #49, #55, #56, #61, #71, #72. No
  agent may clear that label, and nothing here needs a decision to be worked: each is a
  reproduction, a fix, or a memory write. This is where the project's real rate is set.
- **Meta app credentials, on the owner** — still required before any live read. Every read path
  shipped so far runs on the fake provider, so nothing is blocked today.
- **A hosted-runtime target, on the owner** — none exists (ADR-0008) and #24 needs a human to
  choose and pay for one. Deferred, not blocking.
- **`.sdlc/config.yml` is under `forbidden_paths`, so this is noted, not filed.** The installer's
  "Detected stack: unknown" header is still there; `env.boot` is `npm run sdlc:serve` and QA has
  been driving the pages for two days. Only a human can edit that file, and nothing is wrong.

## Epics

One open epic. It waits on nothing upstream, so there is no dependency to record:

- **#14 Decide the architecture for the Autonomous Growth OS** — in flight. 6 of 7 slices
  closed, #20 in review, 4 deferred children open.

The four deferred children are the graph that comes after #14, and **every one of them waits on
#20** — a child of #14, not an epic, so `epic_links` (which links epics only) does not apply:

- **#25 Self-improving brain** — waits on #20 for the BLACK-zone boundary TR-16 names. Its own
  stated reason for deferral ("promotion gates need frozen replay, shadow and calibration
  history") became false when #19 closed, so it is the only deferred item whose own blocker has
  cleared — but it is four architectural decisions inside one issue, and it should be re-scoped
  into an epic when #20 lands, not before.
- **#23 Google Ads** — waits on #20; it copies the adapter, kernel and measurement pattern the
  Meta slice establishes. The owner's recorded answer holds: Meta first, Google after.
- **#26 Creative, MMM, geo incrementality, bandits** — waits on #20, and on L1/L2 experiment
  evidence that has to earn the advanced causal layers.
- **#24 Hosted runtime** — waits on #20, and on a human choosing a target.

## Survey notes

**Filed one issue.** The two files every QA run is told to read before it opens a browser —
`.sdlc/memory/qa/environment.md` and `.sdlc/memory/qa/selectors.md` — describe the product as it
was after #30. `environment.md` names `POST /v1/events` as the worked example of an unknown
`/v1` path returning 404, and that endpoint has existed and returned 202 since #17. `selectors.md`
lists the chrome and the Meta regions but none of the region hooks that #19, #21 and #22 added:
the journal drawer, filters and calibration panels, the opportunity row and score components, the
experiment card with its caps, stop rules and state, evidence refs, the hypothesis composer. A QA
agent told to "assert these, not class names" is asserting against a list that has stopped
existing.

**Deliberately not filed:**

- **The review loop itself.** #49 is the filing for it, and the chain is already visible in
  `Next`; a second issue about the same loop is the noise the label is trained to ignore.
- **The currency-leniency hole in `computeFunnel`.** Real, and it is already finding #72 as
  review finding 2 with a fix. Filing it again splits the work across two tickets.
- **The duplicated `validatedEnvelope` test helper.** #72's finding 6 calls it a two-line
  judgement call and explicitly says not to do it inside that PR; three lines saved is not a
  ticket.
- **A spec-coverage gap.** #28 rebuilds itself from every issue's `Covers:` line and currently
  reports 0 uncovered. The only `not started` sections are PRD scope and non-goal sections, which
  are not work.
- **An epic for #25.** It is the right next epic and it is not this week: it has no architecture
  to split against until #20 fixes the boundary TR-16 names, and it already exists as a deferred
  issue. Filing an epic for work that already has a ticket would duplicate it, and splitting it
  now would produce issues that all get replanned.
