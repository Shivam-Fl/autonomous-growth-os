# Project

Written by the project planner and approved by a human, once, before the first ticket was
planned. Every agent reads this before deciding anything — correct it here rather than
arguing with it in a ticket.

## What this is
The Autonomous Growth OS is a continuously running growth intelligence system that connects ad spend to downstream business outcomes, researches new demand, runs causal experiments, and executes bounded optimizations through a deterministic safety kernel. It starts as a local-first, single-operator web app whose first platform slice is Meta Ads end to end (read, measure, shadow, then guarded write), with Google Ads, cross-channel allocation, and self-improvement arriving as later epics on the same kernel, measurement, and memory foundations.

## Stack
Node.js 22 LTS, Express 5, node:sqlite (built-in DatabaseSync), server-rendered HTML with vanilla JS, node:test. No TypeScript, no frontend build, no external services in v1.

The pipeline boots npm run sdlc:serve on a clean runner and drives a real browser against localhost:3000 with no login, so v1 must boot in seconds with zero external services and servable pages. Node 22 LTS (supported through April 2027) with Express 5 and the built-in node:sqlite gives exactly that: one runtime, one install, one process, no native compilation, no build step. SQLite persists through repository interfaces that Postgres plus pgvector will implement in Phase 2, and the in-process scheduler implements the workflow abstraction Temporal Cloud will later replace. Everything rejected returns with the phase that needs it.

Rejected:
- **TypeScript with a build and typecheck gate** — Adds a build step and typecheck to every ticket's verify path for a codebase whose first value is runtime behavior QA drives in a browser; revisit if contributors or domain size demand it.
- **Python/FastAPI service** — A second toolchain on a runner where npm is the pipeline's only guaranteed indirection; the Meta ecosystem and SSR needs are equally served in JS.
- **Postgres server in v1** — Needs a server process in compose and CI before event volume justifies it; the repository abstraction makes this a later swap, not a rewrite.
- **React/Vite SPA** — Build tooling, router, and client-state complexity before the first slice exists; server-rendered pages cover dashboard, journal, and approvals with nothing to compile.
- **Temporal Cloud in v1** — An external SaaS with credentials and network dependency before the first durable workflow exists; the in-process scheduler proves the abstraction first.
- **facebook-nodejs-business-sdk** — SDK version lag plus an extra abstraction over endpoints the read-first slice touches with plain fetch; pinned-version fetch keeps one constant and trivial fakes.

## Architecture
A single boring Node monolith: Express serves server-rendered pages and a versioned JSON API from one process on $PORT (default 3000). Pure domain logic sits in src/domain with no IO; src/data repositories abstract persistence (SQLite now, Postgres plus pgvector later) so the domain never imports a driver. All ad mutations cross one hard boundary — strategy code proposes ActionIntents, the deterministic Policy Kernel issues signed capabilities, and only the Executor holds mutation credentials. Platform APIs hide behind versioned adapters with fake implementations for tests. Background loops run through a workflow abstraction with an in-process scheduler; Temporal Cloud replaces the scheduler without touching strategy code.

### Modules
- `src/index.js` — Process entrypoint: loads config, opens the database, mounts API and pages, listens on $PORT or 3000.
- `src/web/` — Server-rendered pages and static assets (CSS, tiny vanilla JS); no build step, no SPA framework.
- `src/api/` — Versioned REST surface: events ingest, decisions, opportunities, experiments, actions, approvals, health.
- `src/domain/` — Pure domain logic with no IO: money, objectives/utility, evidence tiers, experiments, opportunity scoring.
- `src/policy/` — Deterministic Policy Kernel: evaluates ActionIntents against guardrails and issues signed capabilities.
- `src/executor/` — The only holder of ad mutation credentials: validates capabilities and executes typed provider mutations.
- `src/integrations/meta_ads/` — Versioned Meta Marketing API adapter (pinned Graph version) plus a fake Meta provider for tests and simulation.
- `src/measurement/` — First-party event ingest, journey linkage, downstream quality funnel, attribution maturity and lag models.
- `src/memory/` — Evidence-backed learnings with scopes, contradiction and staleness handling, and retrieval assistance.
- `src/research/` — Research Mesh pipeline: planner, source adapters (search/fetch/browser), claim extraction and evidence scoring.
- `src/strategy/` — Director, analysts, hypothesis generator, guardian loops and portfolio optimizer as deterministic services plus scoped model calls.
- `src/workflows/` — Durable-workflow abstraction (timers, waits, sagas) with an in-process scheduler now and Temporal later.
- `src/data/` — SQLite bootstrap, migrations, and repository implementations behind interfaces the domain depends on.
- `test/` — node:test suites mirroring src/, fixtures, fake providers and frozen replay scenarios.
- `scripts/` — Seed, readiness-probe and maintenance scripts invoked through the sdlc: verbs.

## Invariants
These hold for every ticket, whatever it asks for.

- Money is integer minor units (amount_micros BIGINT plus ISO currency); floats never touch money.
- Every record carries tenant_id; every mutation carries the actor and the capability id; there are no anonymous writes.
- Timestamps are stored UTC ISO-8601; rendering converts to the viewer's zone.
- Raw source payloads are immutable and never overwritten by normalized or derived values.
- No metric is acted on as mature until its maturity score passes the policy band for that action class.
- Strategy and research code never hold ad mutation credentials; writes cross Policy Kernel to Executor on signed capabilities only.
- External web content is untrusted data wrapped with origin metadata; it never alters instructions, tools, or policy.

## Requirements
Cited by id wherever work is split — an issue's `Covers: TR-3` means this list. The rationale
and the check that proves each one are in `docs/trd.md`; what is being built and for whom, and
what deliberately is not, in `docs/prd.md`; how every screen looks and behaves, in `docs/ui.md`.

- **TR-1** All money is integer minor units (amount_micros) with ISO currency; no float enters storage, APIs, or the utility function.
- **TR-2** Strategy, research, and model-called code never possess ad mutation credentials; only the Executor service identity can call platform mutation endpoints.
- **TR-3** Every external mutation flows Intent to deterministic Policy Kernel to signed capability (tenant, resource, action, constraints, expiry, nonce, policy version) to Executor validation; violations and active kill switches reject.
- **TR-4** Kill switches exist at global, tenant, provider, and campaign levels outside agent authority; the Guardian loop may trigger them and only a human or deterministic recovery policy re-enables after severe incidents.
- **TR-5** All mutations are idempotent on capability nonce and reconciled against provider-reported state; manual, platform-rule, and third-party drift is detected and recorded.
- **TR-6** Every consequential decision references an immutable StateSnapshot and records alternatives including do-nothing, expected effect distributions, downside, and evidence plus memory refs.
- **TR-7** Every reported metric carries a maturity score 0..1 with lag distribution; policy bands gate action classes (<0.35 emergency only, 0.35-0.70 protective, 0.70-0.90 moderate, >0.90 strategic) and bands become account-specific over time.
- **TR-8** Targets are constraints and milestones in a versioned, inspectable utility function; the system keeps proposing frontier moves and records valid do-nothing decisions after targets are met.
- **TR-9** Optimization objectives graduate from raw CPL to qualified CPL to expected CAC, contribution profit, and LTV/spend using the downstream quality funnel; measurement disagreement lowers decision confidence instead of cherry-picking.
- **TR-10** Durable event history is the truth store; embeddings assist retrieval only; every learning carries evidence refs, evidence type, applicability scope, and a status lifecycle with expiry and contradiction handling.
- **TR-11** External content is wrapped with origin metadata as untrusted data, never instructions; research tools are isolated from the Executor and cannot reach policy private endpoints.
- **TR-12** All model access goes through a router abstraction (no model names in business logic); every decision records provider, model, prompt, and tool-catalog versions; high-impact actions get an independent critic, optionally on a second provider.
- **TR-13** A versioned Meta adapter behind a typed interface ships read (campaigns, ad sets, ads, insights) first, then drafts, budgets, statuses, and supported experiments; a fake Meta provider implements the same interface for tests and simulation.
- **TR-14** First-party measurement ships a client event path and POST /v1/events for lead, qualification, opportunity, order, refund, and margin events with a privacy-aware journey graph from click to customer.
- **TR-15** Before any autonomous execution, the system runs a decision journal plus shadow mode: it records what it would do with predicted impact, evaluates at maturity, and reports decision precision, false-intervention rate, and calibration.
- **TR-16** No strategy or code candidate is promoted on model claims; promotion requires beating the champion on frozen replay plus adversarial evals, and candidates cannot modify the protected eval corpus or BLACK-zone authority code.
- **TR-17** Research runs a layered mesh (first-party truth, official structured sources, search abstraction, fetch/extraction, browser last) with evidence tiers, claim states, contradiction tracking, source-independence scoring, and caching of slow-changing data.
- **TR-18** Opportunities carry stored score components (value, success probability, fit, information value, reversibility, cost, downside, delay); experiments carry caps, stop rules, and a first-class inconclusive state, starting at native A/B plus Bayesian levels.
- **TR-19** Trust is tracked per action class from calibrated success minus false-intervention and downside penalties; low-risk classes go autonomous under micro-limits while rare or high-risk classes stay in shadow or approval.
- **TR-20** Audit events are append-only and immutable; raw, normalized, and derived data are stored separately; money uses micros and timestamps are UTC.
- **TR-21** The app serves dashboard, decision journal, opportunities, experiments, and approvals as server-rendered pages plus the JSON API on $PORT (default 3000) with GET /health; all five UI states are defined per screen and QA drives them with no login.
- **TR-22** All event consumers are idempotent on event_id; multi-step mutations run as sagas with compensating actions through the workflow abstraction; the in-process scheduler implements it now and Temporal replaces it later.
- **TR-23** Every prediction is evaluated against matured outcomes with calibration tracking; every model, browser, and research call records tenant, tokens, latency, cost, and usefulness for the auditor.
- **TR-24** The system fails closed on unsafe writes and open on read-only research; every material failure becomes a memory entry, a regression test, an improvement candidate, or an alert.
- **TR-25** Creative assets carry semantic features (hook, angle, pain, persona, proof, offer, CTA, format); fatigue is estimated from performance decay plus saturation, never raw frequency; generated creative is experimental by default.
- **TR-26** Tenant isolation holds on every query path; cross-account learning flows only as de-identified aggregates with minimum cohort sizes, and customer evidence always overrides weaker priors.

## Commands
Real since #27 (foundation) landed; the verbs below are what CI and QA run.

- `sdlc:verify` — `npm ci --no-audit --no-fund && node --test`
- `sdlc:serve` — `node src/index.js`
- `sdlc:seed` — `node scripts/seed.js` (idempotent: fixed ids deduplicated on `(tenant_id, event_id)`; writes through the repository layer, never direct SQL)
- `sdlc:ready` — `curl -fsS http://localhost:${PORT:-3000}/health`

Config comes from the environment: `PORT` (default 3000), `DB_PATH` (default `./data/app.db`). `sdlc:ready` honors `PORT`; probing a non-default port needs `PORT` set in the probing shell too.

## Deploy
Nowhere yet. v1 boots locally via compose (npm run sdlc:serve on $PORT, default 3000) and QA drives that local instance; there is no staging or production environment and no per-PR cloud preview. The first deployment issue, filed after this brief lands, creates the Cloud Run plus Cloud SQL path with per-PR previews; until then any ticket assuming hosted infrastructure is out of scope.
