# Roadmap — survey of 2026-09-26 (fourth)

Rebuilt from 9 open issues (#23, #24, #25, #26, #28, #55, #76, #77, #79), 1 open PR (#59) and
30 recently closed. No `untrusted` entries. **No epic is open** — #14 closed today at
08:00:05Z, two seconds after its last slice.

The last survey's standing claims are all overtaken: **#20 landed** (PR #53 merged), so its
`Next` is done; #47, #49, #56, #61, #71, #72 and #74 all closed; #28 is now one epic stale
(it still reports 15 sections as "in flight (#53)" against a merged PR).

## Shipped

- **The Meta slice is end to end.** Every ad write crosses Intent → deterministic Policy
  Kernel → signed capability → Executor validation, and a violation or an active kill switch
  refuses it. Refusals carry stable codes rather than a 409 that says "try again later"
  (#20, #53).
- **The fake Meta provider writes.** Read, draft, budget, status and pause are exercised
  without a credential, and the QA pass drives a genuinely refused approval rather than a
  simulated one (`?meta_error` is forwarded to the write path; `--reset-approvals` seeds
  three pending rows and one lapsed) (#53).
- **Autonomy is earned per action class.** Posture is derived from a stored trust ledger, so
  a low-trust class is not autonomous just because a table says so (#53).
- **A freeze stops every page**, naming its scope, and a lapsed approval row carries no
  control at all (#53).
- **The bug-shape library has its first entry.** `patterns/phone-width-horizontal-overflow.md`
  names the two traps and the five mutations that lock the fix down (#49) — it was empty an
  hour before the last survey.
- **The claims-and-currency round is closed** (#78, 10 review and 2 QA findings), ending
  #61's chain.

## In flight

- **#55 Follow-ups from #51** — at `sdlc:review`, and **PR #59 is open and unmerged**. It is
  the only open PR in the repository, and it was open at the last two surveys.
- **#77 Follow-ups from #71** (7 review, 1 QA) — at `sdlc:plan-review` + `sdlc:needs-human`,
  no PR. Three of its findings are about the guards themselves: a min-width pin that is green
  on `min-width: 12px` (the exact regression it exists to prevent), a card-wrap pin that
  cannot see inside an at-rule, and a min-width parse that counts a CSS comment as a
  declaration.
- **#76 Follow-ups from #20** (9 review) — at `sdlc:needs-human`, unplanned, no PR. It is the
  follow-up to the merge that just closed the epic, and its first finding is the only major
  anywhere in the open set: the executor takes an idempotency claim and never releases it if
  the provider **throws** rather than returns, so the nonce is wedged for good and the
  approval row is permanently unexecutable with no path back but a database reset.
- **#28 Spec coverage** — reports 0 uncovered. Its table is one epic stale; it rebuilds
  itself from every issue's `Covers:` line.
- **#79 Pipeline self-fixes** — all three listed self-fixes are refused. See Blocked.

Every `Depends on #N` in the open set points at a closed issue (#55→#51, #76→#20, #77→#71).
Nothing in the tracker waits on another issue.

## Next

1. **Land PR #59, then work #76's first finding.** Reason: one is the only open PR and has
   been for two survey runs; the other is the only unrecoverable defect in the open set, and
   it sits on the nonce idempotency TR-5 requires. It is filed as finding 1 of a nine-finding
   ticket, which is the slowest possible place for it to live.
2. **Split the Google Ads epic filed by this survey.** Reason: the Meta slice is closed, so
   ADR-0003's precondition ("Meta end to end ships first") is met, and this is the only
   product work in the tracker that is not deferred. It has no undecided architecture in its
   way, so a split lands rather than replans.
3. **Take #77 in the same pass.** Reason: it is the seventh round of one loop over two
   surfaces (currency rendering, and claims the code does not back), and the only open round
   that leaves a *guard* green on the defect it was written to prevent. `limits.max_in_flight`
   is 2, so the loop is also consuming every slot the project has.

## Blocked, and on whom

- **The pipeline cannot repair its own plumbing — on the owner.** All three self-fixes in
  #79 were refused at the same step, for the same reason: the framework's source at
  `Shivam-Fl/automated-ai-sdlc` is private and `SDLC_FRAMEWORK_TOKEN` is not readable. Two of
  the three are defects in the `mode=review` path of `sdlc-plan.yml` — the path this survey's
  own findings keep arriving through. This is the mechanical reason the follow-up loop does
  not shrink: a class of framework defect is currently invisible to the fixer by policy.
- **The self-improvement contract — on the owner.** #25's own stated blocker (frozen replay,
  shadow and calibration history) cleared when #19 and #22 closed. Three architecture
  decisions are still unmade: the strategy DSL's shape, what a promotion gate must prove
  before a candidate beats the champion, and how the improvement pipeline is bounded to the
  protected eval corpus. Until a person decides those, an epic filed against it splits into
  issues that all get replanned.
- **Meta app credentials — on the owner.** Every shipped read and write path runs on the fake
  provider, so nothing is blocked today; this is the first thing a live read needs.
- **A hosted-runtime target — on the owner.** ADR-0008: none exists, and #24 needs a human to
  choose and pay for one. Deferred, not blocking.
- **`sdlc:needs-human` on #76 and #77 — on a human.** No agent may clear the label, and
  neither ticket needs a decision to be worked: each is a reproduction and a fix. Two of the
  three open work tickets sit behind it.
- **`.sdlc/config.yml` is under `forbidden_paths`, so this is noted, not filed.** The
  installer's "Detected stack: unknown" header is still there while `env.boot` is
  `npm run sdlc:serve` and QA has been driving the pages for two days.

## Epics

- **Google Ads as the second platform slice** (filed by this survey) — open, unsplit, waiting
  on nothing. It is next because #14 closed today and ADR-0003's precondition is met.

There is no dependency to record: `epic_links` links two open epics, and this is the only one.

The graph that comes after it — four children of the now-closed #14, none of them epics, so
`epic_links` does not reach them:

- **#25 Self-improving brain** — its blocker cleared; blocked on the three decisions above.
- **#26 Creative generation, fatigue modelling, MMM, geo incrementality, bandits** — waits on
  L1/L2 experiment evidence to earn the advanced causal layers, and on TR-25's could-priority.
- **#24 Hosted runtime** — waits on a human choosing and paying for a target.
- **#23 Google Ads** — superseded by the epic this survey filed. It is the epic's source text
  and should be closed once the split lands, so two tickets do not chase the same work.

## Survey notes

**Filed one epic, and only that.**

Drift for the Librarian, which a ticket cannot fix — no ticket branch may write
`.sdlc/memory/**`, and #74 closed with all of this still true:

- `qa/environment.md:25` still offers `POST /v1/events` as the worked example of an unknown
  `/v1` path returning 404. `src/api/routes.js:304` has mounted that route since #17 and it
  returns 202. This is the half of #74 that survived its close.
- `qa/selectors.md` still omits the region hooks the pages emit: `page-title`, `kpi-band`,
  `maturity-gate`, `journal-drawer`, `journal-filters`, `journal-precision`,
  `journal-false-intervention`, `journal-awaiting`, `journal-calibration-refreshing`,
  `evidence-refs`, `opportunity-row`, `opportunity-score` with `score-components`, and
  `hypothesis-composer`. A QA agent told to "assert these, not class names" is asserting
  against a list that stopped at #30.
- `qa/selectors.md` still says class names are "styling hooks, not assertions", with no
  mention of the one sanctioned exception — the page-title class-to-rule link, which #55 pins
  and whose own finding asks for exactly this note.
- `patterns/phone-width-horizontal-overflow.md` lists five mutations that turn the suite red.
  A media-query override of any of the four card classes is green (#77's third finding), so
  the list is one mutation short of the contract it claims.

Deliberately not filed:

- **#76's nine findings.** Already one ticket on one merge, and the fix for the major one is
  small enough to do inside it. Splitting them across tickets repeats the round-merge cost
  this roadmap keeps naming; the **Next** section says which one to do first instead.
- **The review loop itself.** #49 is its filing and the pattern landed. A second issue about
  the same loop is the noise the label is trained to ignore.
- **#77's "fourth hand-rolled CSS parser" finding.** The reviewer marked it optional and said
  explicitly not to do it in that PR; it is already carried in that ticket's own deferral.
- **A browser-rendering check in CI.** This is the most-repeated structural gap in the
  repository — every layout and cascade defect is caught by a human-driven QA pass and never
  by `node --test`, which is why the repo's standing answer is hand-rolled CSS-source pins
  and why three of #77's findings are about those pins rather than about the product. It is
  still not a ticket: the stack is stdlib-first with no browser dependency, every ticket
  already drives a real browser before merge, and adding a harness is a decision about
  `conventions.md` rather than a gap in the code. It belongs with the person who owns that
  file.
- **An epic for #25.** Its blocker cleared, and the last survey said to re-scope it when #20
  landed — that condition is now met and this survey still does not, because the "next" test
  fails: three architecture decisions are unmade, and an epic split against guesses produces
  issues that all get replanned. It sits in **Blocked, and on whom** instead, where the
  decision is visible.
- **A spec-coverage gap.** #28 reports 0 uncovered, and its only `not started` rows are PRD
  scope and non-goal sections, which are not work.
