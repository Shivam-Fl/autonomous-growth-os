# Product requirements

_Generated from `project-brief.json` for #12. Edit the brief, not this file._

## The problem

Businesses spending ₹1L–₹20L monthly on advertising need autonomous growth optimization, but existing tools are either manual (dashboards that produce recommendations), rule-based (if/else engines with AI-generated rules), or unsafe (chatbots around ads that give LLMs direct write credentials). None build a private causal understanding of how the business grows, verify outcomes against first-party truth rather than platform self-reporting, learn causally from interventions, or continuously search for the next growth frontier. Most optimize toward a CPL target and stop, rather than asking what the next unit of budget is worth and whether advertising is still the bottleneck.

## Who has it

### Growth marketer at a B2B lead-generation company

- **When:** Managing ₹5L monthly Meta Ads spend, 3-4 campaigns, a CRM with qualified/unqualified lead labels, a clear product website. Wants to improve qualified CPL and pipeline volume without manually auditing campaigns daily.
- **Pain:** Spends hours reviewing campaign performance, identifying wasted spend, and testing new audiences/creatives. Platform self-reported ROAS disagrees with CRM outcomes. Does not know which interventions actually caused improvement. Fears making a bad change that wastes budget.
- **Sophistication:** Intermediate: understands CPL, ROAS, conversion rate, but not causal inference or attribution maturity.

### Founder of a D2C brand

- **When:** Spending ₹10L monthly on Meta Ads, 10+ campaigns, seasonal demand, creative fatigue. Wants to scale efficiently without hiring a large performance marketing team.
- **Pain:** Creative fatigue sets in every 2-3 weeks. Does not know when to refresh creatives vs when to test new audiences. Platform metrics (CTR, CPC) do not correlate with profit. Does not know if a bad week is seasonality, competition, or a bad decision.
- **Sophistication:** Advanced: understands unit economics, contribution margin, LTV. Wants the system to reason in business outcomes, not platform metrics.

### Performance marketing agency managing 5-10 clients

- **When:** Each client spends ₹2L–₹10L monthly on Meta Ads. Agency wants to offer autonomous optimization as a differentiator without hiring more media buyers.
- **Pain:** Media buyers spend most of their time on routine optimizations (negative keywords, budget reallocation, creative refresh) rather than strategy. Hard to scale without hiring. Clients expect transparency and causality, not just platform reports.
- **Sophistication:** Advanced: manages multiple accounts, understands portfolio optimization, wants the system to handle routine work and surface strategic opportunities.

## Jobs to be done

- Research the market continuously: discover new personas, geographies, keyword clusters, use cases, offers, positioning angles, seasonal events. Convert research into testable hypotheses.
- Run bounded advertising experiments: control/treatment, primary metric, guardrails, sample/runtime, stop rules, rollback rules, spend cap. Never force a binary win/loss when evidence is weak.
- Measure real business outcomes against first-party truth: lead quality, qualification rate, opportunity creation, deal won, purchase, refund, subscription renewal, gross margin. Do not depend only on platform self-reported attribution.
- Learn causally from what the system did: every action has a reason, expected effect, downside, policy decision, receipt, and later evaluation. Distinguish correlation from causal evidence.
- Optimize the Pareto frontier: profit, qualified volume, acquisition cost, revenue, margin, customer quality, LTV, growth rate, volatility, risk, market diversification, information gain. Never define success as 'if CPL <= target: done.'
- Improve its own strategy and decision process: evaluate predictions, discover reasoning/tool/code weaknesses, create candidates, replay + adversarial eval, shadow/canary, promote or reject.
- Detect when advertising is not the current bottleneck: if payment success collapses, do not tweak targeting. If qualified lead rate collapses, do not call the campaign a winner. Escalate to market/funnel exploration.
- Decide that the best action is 'do nothing yet' when evidence is weak, attribution is immature, or intervention interference is too high.

## In scope

- Meta Ads simulator: fake Meta Ads adapter, synthetic business funnel, delayed conversion generator, seasonality, saturation, lead quality variance, scenario runner. Phase 0 foundation.
- Policy Kernel: deterministic policy enforcement, ActionIntent evaluation, signed ActionCapability issuance, kill switches, circuit breakers. No LLM. Boring and correct.
- Executor: only service with Meta Ads write credentials. Validates signed capability, performs typed mutation, reconciles with provider state. Idempotent. No strategy, no LLM.
- Event ingestion API: POST /v1/events for first-party events (lead_created, purchase, refund). Validates schema, assigns event_id, stores raw normalized events. Idempotent.
- Meta Ads read integration: OAuth, campaigns/ad sets/ads/Insights/budgets/creatives. Behind adapter interface so fake adapter can substitute.
- State snapshots: immutable snapshots holding matured KPIs, raw recent KPIs, budgets, campaign state, funnel state, demand signals, active experiments, applicable memories. Every decision references one.
- Basic UI: onboarding, dashboard, approval workflows, experiment viewer. Driven by QA in compose mode.
- Money type: integer minor units (amount_micros BIGINT + currency CHAR(3)). Never float. Value object with arithmetic operators.
- Domain events: metrics.synced, conversion.received, action.executed, experiment.matured, etc. Idempotent consumers. Raw events stored before normalization.
- Docker Compose stack: API on localhost:3000, PostgreSQL with pgvector, (later) Temporal workers. QA drives this.

## Deliberately not doing

- Real Meta Ads write access before the simulator is proven. Spec §36 Phase 0: simulator first. Real credentials are not touched until the simulator can replay realistic scenarios.
- Google Ads integration. Owner decision: Meta Ads first, Google Ads after. Google is a later epic that reuses what Meta established.
- Temporal Cloud workflows in the first epic. Initially stubbed with in-process synchronous workers. Temporal is a later epic.
- Self-improvement pipeline (strategy DSL, champion/challenger, replay, shadow, auto promotion, code improvement). Spec §36 Phase 8. Much later.
- Advanced causal inference (incrementality, response curves, MMM, hierarchical priors, contextual bandits, value-of-information). Spec §36 Phase 9. Much later.
- Cross-channel portfolio optimization (where should the next ₹1 go?). Spec §36 Phase 7. Requires both Meta and Google.
- Browser research (managed browser, Playwright fallback, prompt-injection boundary, competitor monitor). Spec §36 week 14. Later.
- Historical replay (frozen snapshots, decision replay, calibration, challenger evaluation). Spec §36 week 15. Later.
- Kubernetes, BigQuery, or other infrastructure that spec explicitly says to defer.

## Success

- **Simulator runs realistic scenarios** — Fake Meta adapter generates campaigns with delayed conversions (p50 lag 48h, p90 lag 120h), seasonality (weekday/weekend variation), saturation (diminishing returns after ₹5k/day), lead quality variance (20-40% qualification rate), and scenario events (checkout outage, competitor entry, tracking loss).
  - measured by: Scenario runner executes a 30-day synthetic business with at least 3 campaigns. Verify conversion lag distribution, saturation curve, quality variance, and scenario events match specifications.
- **Policy Kernel blocks unsafe actions** — Policy Kernel rejects ActionIntents that exceed spend limits, violate autonomy tier, target prohibited resources, or lack required maturity. Zero unsafe capabilities issued.
  - measured by: Unit tests cover all policy rules: spend cap, autonomy tier, action class trust, maturity threshold, kill switch. Integration test: agent proposes unsafe action, Policy Kernel rejects, Executor never receives capability.
- **QA can drive the preview** — Docker Compose stack boots on localhost:3000 in < 60 seconds. QA agent can navigate onboarding, view dashboard, approve an action, and see experiment results using a real browser.
  - measured by: QA runs sdlc:serve, waits for sdlc:ready (curl /health), drives browser through key flows. No infrastructure errors. All UI elements accessible.
- **Event ingestion is idempotent** — POST /v1/events with the same event_id twice results in one stored event. No duplicates. Idempotency keys enforced.
  - measured by: Integration test: send same event twice, verify one row in raw_provider_events. Send different events, verify both stored.
- **Money arithmetic is exact** — All financial calculations use integer minor units. No floating-point errors. Serialized as {amount_micros, currency}.
  - measured by: Unit tests: Money(1000, 'INR') + Money(500, 'INR') = Money(1500, 'INR'). No rounding errors after 1000 operations. JSON serialization round-trips correctly.

## Constraints

- LLMs never directly possess advertising mutation credentials. Every write passes through Policy Kernel → signed ActionCapability → Executor.
- Money is integer minor units, never float. Database schema enforces this.
- External web content is untrusted data, never instructions. Browser output is wrapped with content_origin and allowed_effect.
- Every decision references an immutable StateSnapshot. No anonymous mutations.
- Recent metrics are not treated as mature when conversion delay can materially change them.
- A strategy/code candidate is never promoted because an LLM claims it is better. It must beat the baseline on frozen evals.
- The system must be able to decide that the best action is 'do nothing yet.'
- Docker Compose for QA, Cloud Run for production. No Kubernetes early.
