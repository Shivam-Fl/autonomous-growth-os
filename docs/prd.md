# Product requirements

_Generated from `project-brief.json` for #14. Edit the brief, not this file._

## The problem

Paid acquisition is managed by hand or by narrow optimizers that chase platform-reported CPL, stop at targets, and never learn what actually became revenue. Businesses need a system that verifies its own measurement, researches demand, experiments causally, and keeps moving the efficient-growth frontier without a marketer watching every account.

## Who has it

### Growth lead at a B2B/lead-gen business

- **When:** Runs ₹1L–₹20L monthly spend through lead funnels with a CRM or at least qualified/unqualified labels.
- **Pain:** Reports say CPL is fine while sales complains about junk leads; nobody connects spend to qualified pipeline.
- **Sophistication:** Knows their funnel numbers; does not want to babysit bids.

### Founder approving automation authority

- **When:** Owns the number, approves spend changes, absorbs the downside of a bad automated decision.
- **Pain:** Autonomy without auditability is unbuyable; a black box that cannot show its receipts never gets authority.
- **Sophistication:** Reads dashboards, not code; decides on evidence and downside estimates.

## Jobs to be done

- Connect ad spend to downstream revenue so budget follows profit, not form-fill CPL.
- Keep researching where the next profitable demand is instead of defending a local optimum.
- Run controlled experiments and wait for mature evidence before calling a winner.
- Stay safe by default: freeze, roll back, or do nothing when measurement or confidence breaks.
- Keep improving the decision process itself from its own prediction errors.

## In scope

- Meta-first vertical slices: read, measure, shadow, then guarded write, per owner decision.
- First-party measurement truth layer: event ingest, journey linkage, quality funnel, maturity gating.
- Decision journal, shadow mode, calibration, and approvals UI on the local app.
- Local-first single-operator app serving pages and API on :3000 with /health.
- Autonomous growth OS for paid acquisition spanning research, measurement, experimentation, and bounded execution.

## Deliberately not doing

- Google Ads integration now: a later epic reusing the Meta slice, per owner decision.
- Temporal Cloud, Kubernetes, managed Postgres, or any hosted dependency in v1.
- Multi-user auth, SSO, or cross-tenant features in v1.
- Media mix modeling, geo incrementality, and contextual bandits before L1/L2 experiments earn them.
- Self-modifying production code before replay, shadow, and protected evals exist.
- A React/Vite SPA or any frontend build step before server-rendered pages stop sufficing.

## Success

- **Shadow decision precision** — At least 70% of shadow decisions directionally match matured outcomes by the end of the shadow epic.
  - measured by: Shadow evaluations on frozen replay scenarios in CI.
- **Simulator episode quality** — Agent holds qualified CPL within 15% of the known-good policy while pausing spend during tracking-outage scenarios.
  - measured by: Synthetic business scenarios with known saturation and breakage points.
- **Every-merge verifiability** — 100% of merged PRs pass sdlc:verify and a QA browser smoke of dashboard, journal, and approvals.
  - measured by: CI run of sdlc:verify plus QA browser pass on the compose boot.
- **Maturity-gated actions** — Zero consequential actions executed on metrics below their action-class maturity band.
  - measured by: Maturity audit query over the decision log each release.

## Constraints

- Clean CI runner has only node/npm and python3; verify installs its own toolchain.
- QA drives a real browser against compose boot on localhost:3000 with no login.
- No cloud project, registry, or secret store exists; nothing may assume hosted infrastructure.
- Owner capacity is the bottleneck: Meta app credentials arrive from the owner before real-read tickets.
