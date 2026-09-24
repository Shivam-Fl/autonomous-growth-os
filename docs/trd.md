# Technical requirements

_Generated from `project-brief.json` for #14. Edit the brief, not this file._

## Requirements

### TR-1 — All money is integer minor units (amount_micros) with ISO currency; no float enters storage, APIs, or the utility function.

**Why.** Float rounding on spend and value compounds into wrong marginal decisions; the spec bans float three times.

**Priority.** must

**Proved by.** Unit tests on the money module plus a review check that rejects float money types in diffs.

### TR-2 — Strategy, research, and model-called code never possess ad mutation credentials; only the Executor service identity can call platform mutation endpoints.

**Why.** A compromised reasoner with credentials is an unbounded spender; isolation is the load-bearing safety property.

**Priority.** must

**Proved by.** Integration test asserting credential absence outside the executor module plus a static import-boundary check in verify.

### TR-3 — Every external mutation flows Intent to deterministic Policy Kernel to signed capability (tenant, resource, action, constraints, expiry, nonce, policy version) to Executor validation; violations and active kill switches reject.

**Why.** The Policy Kernel plus signed capability is the one choke point that holds even when the agent is compromised.

**Priority.** must

**Proved by.** Policy regression suite: expired, replayed, over-scope, and kill-switched capabilities all reject in tests.

### TR-4 — Kill switches exist at global, tenant, provider, and campaign levels outside agent authority; the Guardian loop may trigger them and only a human or deterministic recovery policy re-enables after severe incidents.

**Why.** Money protection must work faster than any optimizer loop and outside agent authority.

**Priority.** must

**Proved by.** Guardian scenario tests: spend spike and tracking-loss fixtures freeze automation and require explicit re-enable.

### TR-5 — All mutations are idempotent on capability nonce and reconciled against provider-reported state; manual, platform-rule, and third-party drift is detected and recorded.

**Why.** Retries, schedulers, and humans all duplicate writes; without idempotency plus reconciliation the system evaluates experiments against states it no longer controls.

**Priority.** must

**Proved by.** Duplicate-delivery tests against the fake Meta provider plus a drift-detection scenario test.

### TR-6 — Every consequential decision references an immutable StateSnapshot and records alternatives including do-nothing, expected effect distributions, downside, and evidence plus memory refs.

**Why.** Replay, audit, and self-improvement are impossible if decisions do not name the world they were made in.

**Priority.** must

**Proved by.** Schema test: decision writes without snapshot id or do-nothing alternative are rejected.

### TR-7 — Every reported metric carries a maturity score 0..1 with lag distribution; policy bands gate action classes (<0.35 emergency only, 0.35-0.70 protective, 0.70-0.90 moderate, >0.90 strategic) and bands become account-specific over time.

**Why.** Acting on immature conversions is the canonical paid-media failure mode; lag differs per product, channel, and geography.

**Priority.** must

**Proved by.** Maturity unit tests plus scenario tests where an apparent winner inside the lag window is not acted on.

### TR-8 — Targets are constraints and milestones in a versioned, inspectable utility function; the system keeps proposing frontier moves and records valid do-nothing decisions after targets are met.

**Why.** Targets-as-finish-lines is the exact failure the prime directive forbids; the utility function must keep searching.

**Priority.** must

**Proved by.** Simulator episode: hitting the CPL target does not stop proposals; do-nothing appears in the journal with reasons.

### TR-9 — Optimization objectives graduate from raw CPL to qualified CPL to expected CAC, contribution profit, and LTV/spend using the downstream quality funnel; measurement disagreement lowers decision confidence instead of cherry-picking.

**Why.** Platform-reported ROAS routinely exceeds incrementality and CRM truth; optimizing it buys junk leads.

**Priority.** must

**Proved by.** Scenario test with cheap low-quality versus expensive high-quality campaigns selects the profitable one.

### TR-10 — Durable event history is the truth store; embeddings assist retrieval only; every learning carries evidence refs, evidence type, applicability scope, and a status lifecycle with expiry and contradiction handling.

**Why.** Vector retrieval without structured verification is how a US ecommerce learning ends up steering India B2B lead-gen.

**Priority.** must

**Proved by.** Retrieval tests: out-of-scope and stale learnings are rejected by scope and evidence checks before use.

### TR-11 — External content is wrapped with origin metadata as untrusted data, never instructions; research tools are isolated from the Executor and cannot reach policy private endpoints.

**Why.** Research ingests hostile text by design; one confused-deputy read can become a spend action.

**Priority.** must

**Proved by.** Prompt-injection fixtures: pages demanding credential upload or instruction override are classified malicious and cause no tool call.

### TR-12 — All model access goes through a router abstraction (no model names in business logic); every decision records provider, model, prompt, and tool-catalog versions; high-impact actions get an independent critic, optionally on a second provider.

**Why.** Single-vendor dependence turns an outage or price change into a system outage; model names in logic freeze routing evolution.

**Priority.** should

**Proved by.** Router tests swap providers behind the interface; decision records assert version fields present.

### TR-13 — A versioned Meta adapter behind a typed interface ships read (campaigns, ad sets, ads, insights) first, then drafts, budgets, statuses, and supported experiments; a fake Meta provider implements the same interface for tests and simulation.

**Why.** Owner decision: Meta end to end is the first platform slice, and it must prove the kernel/executor/measurement pattern Google later reuses.

**Priority.** must

**Proved by.** Adapter contract tests run identically against fake and (credential-gated) live Meta; version pin asserted in one constant.

### TR-14 — First-party measurement ships a client event path and POST /v1/events for lead, qualification, opportunity, order, refund, and margin events with a privacy-aware journey graph from click to customer.

**Why.** Without owned conversion truth the system is a chatbot around platform attribution.

**Priority.** must

**Proved by.** End-to-end ingest test: synthetic click-to-revenue journey resolves to the correct qualified-CPL figure.

### TR-15 — Before any autonomous execution, the system runs a decision journal plus shadow mode: it records what it would do with predicted impact, evaluates at maturity, and reports decision precision, false-intervention rate, and calibration.

**Why.** Shadow mode is the Phase 2 gate between read-only analysis and any autonomous spend; calibration data is its output.

**Priority.** must

**Proved by.** Frozen replay scenarios produce a calibration report in CI with zero mutations executed.

### TR-16 — No strategy or code candidate is promoted on model claims; promotion requires beating the champion on frozen replay plus adversarial evals, and candidates cannot modify the protected eval corpus or BLACK-zone authority code.

**Why.** Self-graded homework is how strategy evolution silently corrupts; the exam must be unreadable to the candidate.

**Priority.** must

**Proved by.** Zone classifier test plus a red-team test where a candidate attempts eval modification and is blocked.

### TR-17 — Research runs a layered mesh (first-party truth, official structured sources, search abstraction, fetch/extraction, browser last) with evidence tiers, claim states, contradiction tracking, source-independence scoring, and caching of slow-changing data.

**Why.** Single-vendor research and eternal-truth memory are how echo chambers become strategy.

**Priority.** should

**Proved by.** Research pipeline tests: vendor swap behind the search interface; contradiction fixtures yield CONTRADICTORY state, not silent overwrite.

### TR-18 — Opportunities carry stored score components (value, success probability, fit, information value, reversibility, cost, downside, delay); experiments carry caps, stop rules, and a first-class inconclusive state, starting at native A/B plus Bayesian levels.

**Why.** Scattered bets without opportunity cost or information value are just spend; inconclusive handling prevents false certainty.

**Priority.** should

**Proved by.** Opportunity ranking test with known-value fixtures; experiment evaluator marks underpowered results inconclusive, never forced win/loss.

### TR-19 — Trust is tracked per action class from calibrated success minus false-intervention and downside penalties; low-risk classes go autonomous under micro-limits while rare or high-risk classes stay in shadow or approval.

**Why.** One account-level autonomy switch grants new-geography authority on the evidence of negative-keyword precision.

**Priority.** should

**Proved by.** Trust ledger tests: repeated safe outcomes raise limits, one bad outcome collapses them for that class only.

### TR-20 — Audit events are append-only and immutable; raw, normalized, and derived data are stored separately; money uses micros and timestamps are UTC.

**Why.** Audit and replay die if raw truth is overwritten or history is mutable.

**Priority.** must

**Proved by.** Storage tests: update/delete paths on raw and audit tables do not exist; replay rebuilds derived metrics from raw.

### TR-21 — The app serves dashboard, decision journal, opportunities, experiments, and approvals as server-rendered pages plus the JSON API on $PORT (default 3000) with GET /health; all five UI states are defined per screen and QA drives them with no login.

**Why.** The pipeline verifies through a browser against compose boot; an API without drivable pages fails QA by construction.

**Priority.** must

**Proved by.** QA browser smoke on the compose boot covering each page's ideal, empty, loading, and error states.

### TR-22 — All event consumers are idempotent on event_id; multi-step mutations run as sagas with compensating actions through the workflow abstraction; the in-process scheduler implements it now and Temporal replaces it later.

**Why.** Schedulers and message buses deliver at-least-once; multi-day workflows must survive crashes without a giant cron script.

**Priority.** must

**Proved by.** Crash-recovery test: killing a mid-saga worker resumes to exactly-once effects on restart.

### TR-23 — Every prediction is evaluated against matured outcomes with calibration tracking; every model, browser, and research call records tenant, tokens, latency, cost, and usefulness for the auditor.

**Why.** Unevaluated predictions compound into confident wrongness; cost blindness turns research into a burn rate.

**Priority.** should

**Proved by.** Calibration dashboard data test: a batch of known overconfident predictions shows miscalibration numerically.

### TR-24 — The system fails closed on unsafe writes and open on read-only research; every material failure becomes a memory entry, a regression test, an improvement candidate, or an alert.

**Why.** Unsafe writes must default to refusal while reads stay available; incidents that leave no artifact repeat.

**Priority.** should

**Proved by.** Kill-switch and tracking-outage scenarios freeze writes while research pages keep serving; each leaves a regression fixture.

### TR-25 — Creative assets carry semantic features (hook, angle, pain, persona, proof, offer, CTA, format); fatigue is estimated from performance decay plus saturation, never raw frequency; generated creative is experimental by default.

**Why.** Meta delivery optimizes the auction; the system's edge is creative concepts and fatigue detection, not bid micromanagement.

**Priority.** could

**Proved by.** Fatigue model test: high-frequency but non-decayed creative is not flagged while decayed creative is.

### TR-26 — Tenant isolation holds on every query path; cross-account learning flows only as de-identified aggregates with minimum cohort sizes, and customer evidence always overrides weaker priors.

**Why.** Cross-tenant leakage destroys the multi-tenant future; priors must help without exposing customer data.

**Priority.** should

**Proved by.** Isolation tests with two tenants plus a leakage test asserting no customer rows cross the aggregate boundary.

## Data model

### tenant

Single-operator scope anchor; every record carries tenant_id from day one.

### money

amount_micros BIGINT plus currency CHAR(3); never float, never bare number.

### event

Immutable raw source payload with provider, account, source and ingestion timestamps, API version, payload hash, replay key.

### state_snapshot

Immutable matured plus raw KPIs, budgets, funnel state, experiments, health, applicable memories; referenced by every decision.

### decision

Alternatives including do-nothing, expected distributions, downside, evidence and memory refs, critic result, policy decision id.

### capability

Signed ActionCapability: tenant, provider, resource, action, constraints, expiry, nonce, policy version.

### action_record

Intent, risk review, policy decision, receipts, reconciliation, rollback, and matured evaluation.

### learning

Claim plus scope, evidence refs, evidence type, effect interval, confidence, status lifecycle.

### experiment

Arms, exposures, metrics, caps, stop rules, evaluations with a first-class inconclusive state.

## Interfaces

### POST /v1/events

```
JSON growth event {event_id, event_name, occurred_at, user/session/order references, value, currency, properties}; 202 plus receipt, never partial application.
```

**On failure.** 4xx with stable error codes for validation/policy denial; capability denials name the violated constraint, never internals.

**Idempotency.** Client-supplied idempotency keys; retries never duplicate: ingest dedupes on event_id, mutations dedupe on capability nonce plus provider reconciliation.

### Decisions and approvals (API plus pages)

```
Decision record with alternatives, expected outcomes, risk, evidence refs; approvals transition authorized or rejected with actor and reason.
```

**On failure.** Unknown snapshot id is a 422; nothing executes without a referenced snapshot.

**Idempotency.** Decisions are append-only records; re-proposing the same intent returns the existing decision id.

### Meta adapter (integrations/meta_ads)

```
Typed reads (campaigns, ad sets, ads, insights) and typed writes (drafts, budgets, statuses) against a pinned Graph version; fake provider implements the same interface.
```

**On failure.** Provider errors surface as typed integration failures with retry advice; quota exhaustion backs off with jitter.

**Idempotency.** Mutations carry capability nonce; executor reconciles provider state after every write.

## Non-functional

- Local pages respond p95 under 400ms on a clean runner with seed data; ingest sustains 100 events/sec without queue growth.
- sdlc:verify completes in under 5 minutes on a clean runner including npm install.
- Zero consequential actions on metrics below their maturity band, audited per release.
- Risk violations against protected invariants remain zero across all replay scenarios.
