# Product requirements

_Generated from `project-brief.json` for #1. Edit the brief, not this file._

## The problem

Businesses spending ₹1L–₹20L monthly on Google Ads lack an autonomous system that continuously researches markets, manages advertising experiments, measures real business outcomes against first-party truth (not platform self-reporting), learns causally from its actions, and improves its own strategy—while never holding the credentials that would let it spend money unchecked. Existing tools (Madgicx, Optmyzr, Triple Whale, Northbeam, Smartly) are strong individual pieces but do not provide a unified autonomous growth intelligence system that builds a private causal understanding of how a specific business grows, continuously researches new demand, independently verifies business outcomes, experiments to move the efficient-growth frontier, and improves its own decision process over time. The differentiated product is an autonomous growth scientist + performance marketer + research analyst + measurement platform + experimentation platform + bounded self-improving software system.

## Who has it

### Business owner or marketing leader at a company spending ₹1L–₹20L monthly on Google Ads

- **When:** Has a lead funnel (form fills, demo bookings, opportunities), a CRM or at least qualified/unqualified labels, a clear product website, and cares about lead quality (not just form-fill CPL). Currently manages Google Ads manually or with basic automation, and lacks the time or expertise to continuously research new demand, run controlled experiments, and measure real business outcomes.
- **Pain:** Cannot determine which leads actually become business (raw CPL vs qualified CPL); cannot determine whether advertising is the bottleneck or whether the funnel (landing page, checkout, sales) is the problem; cannot determine whether to scale proven campaigns or explore new markets/personas/offers; cannot determine whether the system's own reasoning is causing missed opportunities; spends time on manual optimization that could be automated.

### Performance marketer managing multiple client accounts

- **When:** Manages 5–20 Google Ads accounts for different clients, each with different products, personas, geographies, and budgets. Currently uses a combination of manual optimization, rules-based automation, and platform recommendations, but lacks a unified system that continuously researches new demand, runs controlled experiments, and measures real business outcomes across all accounts.
- **Pain:** Cannot efficiently manage multiple accounts without spending excessive time on manual optimization; cannot determine which accounts need attention and which are performing well; cannot determine whether platform recommendations are actually improving business outcomes; lacks a systematic way to test new strategies and learn from results.

## Jobs to be done

- Continuously research new demand: discover new personas, geographies, keyword clusters, use cases, offers, positioning, channels, creative angles, seasonal events.
- Continuously manage advertising experiments: form falsifiable hypotheses, design controlled experiments, execute through bounded capabilities, wait for mature evidence, measure downstream business impact, update beliefs.
- Continuously measure real business outcomes: track first-party conversion events (lead_created, lead_qualified, demo_booked, opportunity_created, deal_won, purchase, refund, subscription_renewed, churned, gross_margin_finalized), model downstream quality (raw lead → valid → qualified → meeting → opportunity → customer → revenue → gross profit), triangulate attribution (platform attribution, fir...
- Continuously learn causally from actions: maintain an epistemic operating memory with evidence-backed learnings, distinguish correlation from causal evidence, detect contradictions and stale claims, apply applicable learnings to new decisions.
- Continuously improve its own strategy: evaluate its own decisions (prediction calibration, false intervention analysis, missed opportunity rate), detect systematic weaknesses, create improvement candidates, prove them in replay and shadow mode, promote only proven improvements.
- Continuously search for the next growth frontier: recognize when local optimization is exhausted, escalate to market/funnel exploration, determine whether advertising is still the largest bottleneck, identify the highest-value uncertainty to resolve.
- Safely execute low-risk actions without human approval: auto-execute low-risk action classes (negative keywords, small budget scale, pause obvious waste) under micro limits, with kill switches and circuit breakers.
- Provide transparent decision-making: every decision has a reason, expected effect distribution, downside estimate, policy decision, receipt, and later evaluation; every learning points to evidence; every action has a receipt and reconciliation.
- Detect and respond to problems: detect spend anomalies, tracking health issues, landing-page outages, checkout failures, API permission revocations, unexpected manual mutations, duplicated actions, campaign launched in wrong geography, unauthorized changes; freeze automation if data integrity is compromised.

## In scope

- Phase 0: Simulator (fake Google Ads, fake Meta Ads, synthetic business with delayed conversions, seasonality, campaign saturation, lead-quality variation, manual external changes, API failures, tracking outages).
- Phase 1: Read-only Google Ads integration (OAuth, account sync, GAQL reporting, ChangeEvent, search terms, keyword planning, first-party conversion import, basic Growth Pixel, state snapshots, research, recommendation UI). No writes.
- Phase 2: Decision journal + shadow mode (daily: decide what it would do, mutate nothing, store predicted impact, evaluate later, produce decision precision, false-intervention analysis, calibration).
- Phase 3: Human-approved executor (Policy Kernel, capability token, executor, approval UI, typed actions, reconciliation, rollback). Start with: add a negative keyword, small budget change, pause obvious waste, create a draft/experiment.
- Phase 4: Guarded autopilot (auto-execute low-risk action classes under micro limits).
- Phase 5: Research-driven autonomy (agent finds new demand, keyword clusters, offers, geographies, and creates experiments automatically).
- Admin UI: dashboards for decisions, experiments, research, memory, actions, audit; approval UI for high-risk actions.
- First-party measurement: event API (POST /v1/events) for lead_created, lead_qualified, demo_booked, opportunity_created, deal_won, purchase, refund, subscription_renewed, churned, gross_margin_finalized.
- Research Mesh: search/fetch provider abstraction, research docs, keyword ideas, product crawler, evidence levels.
- Memory: learning schema, scopes, pgvector, hybrid retrieval, contradiction/staleness.
- Analysis: KPI decomposition, anomaly detection, funnel diagnosis, state snapshots.
- Experiments: registry, Google experiment adapter, evaluator, maturity.
- Guardian: spend anomaly, tracking health, landing-page health, freeze automation.

## Deliberately not doing

- Phase 6: Meta Ads integration (read/measurement, creative testing, guarded write). Deliberately not in the first release because Google Ads is the first full production adapter per the spec (query intent interpretable, reporting strong, experiments native, keyword planning primitives exist, downs...
- Phase 7: Cross-channel portfolio optimization (the question 'where should the next ₹1 go?'). Deliberately not in the first release because it requires both Google and Meta integrations to be working, and the system must prove single-channel optimization before attempting cross-channel allocation.
- Phase 8: Self-improving brain (strategy DSL, champion/challenger, replay, shadow, auto promotion, code improvement pipeline). Deliberately not in the first release because the system must prove it can make good decisions before it can improve its own decision-making. Phase 2 (decision journal + s...
- Phase 9: Advanced causal / world model (incrementality, response curves, MMM, hierarchical priors, contextual bandits, value-of-information). Deliberately not in the first release because it requires a mature experiment history and a proven decision-making layer. The system must earn its way towa...
- Browser research (Phase 14 in the spec's 16-week plan). Deliberately not in the first release because the system must prove it can make good decisions with structured data (Google Ads API, keyword planning, first-party events) before adding the complexity and security risk of browser research.
- Historical replay (Phase 15 in the spec's 16-week plan). Deliberately not in the first release because it requires a mature decision history to replay against. Phase 2 (decision journal + shadow mode) builds the decision history; historical replay evaluates it.
- Self-improvement beta (Phase 16 in the spec's 16-week plan). Deliberately not in the first release because the system must prove it can make good decisions and evaluate them before it can improve its own decision-making code.
- Multi-tenant support. Deliberately not in the first release because the system must prove it can manage one account safely before attempting to manage multiple accounts with tenant isolation. The first release is single-tenant.
- Production deployment with real ad spend. Deliberately not in the first release because the system must prove it can make good decisions in simulation (Phase 0) and shadow mode (Phase 2) before executing real mutations. Phase 3 (human-approved executor) is the first step toward production.
- Advanced ML models (Bayesian response curves, hierarchical priors, MMM, contextual bandits, value-of-information). Deliberately not in the first release because the system must prove it can make good decisions with simpler models (rolling baselines, account-specific lag models, marginal spend cur...

## Success

- **Simulator realism: the agent makes sensible decisions in simulated scenarios** — The agent correctly identifies campaign A (cheap low-quality leads) as worse than campaign B (expensive high-quality leads), detects campaign C saturation after ₹5k/day, responds to checkout break ...
  - measured by: Run the example scenario from Phase 0 (campaign A cheap low-quality, B expensive high-quality, C initial winner that saturates, checkout breaks day 10, competitor enters day 15, conversion delay increases day 20) and evaluate the agent's decisions against the expected behavior.
- **Shadow mode decision quality: the system produces good recommendations without executing them** — Of decisions predicted 60–70% likely to succeed, at least 50% actually succeed (calibration). False intervention rate < 20% (the system does not recommend changes that would have made things worse)...
  - measured by: Run the system in shadow mode against a real Google Ads account for 30 days, store predicted impact for each decision, evaluate later against actual matured outcomes. Compute calibration, false intervention rate, missed opportunity rate.
- **Read-only Google Ads integration: the system correctly syncs and reports account data** — 100% of campaigns, ad groups, ads, keywords, search terms, audiences, bidding configuration, budgets, conversions, conversion value, quality/performance metrics, recommendations, change history are...
  - measured by: Compare the synced data against the Google Ads UI and API responses. Verify that ChangeEvent is pulled and reconciled. Verify that keyword planning results are cached.
- **First-party measurement: the system correctly ingests and models conversion events** — 100% of first-party conversion events (lead_created, lead_qualified, demo_booked, opportunity_created, deal_won, purchase, refund, subscription_renewed, churned, gross_margin_finalized) are ingeste...
  - measured by: Send test events to the event API and verify they are ingested correctly. Verify that downstream quality is modeled. Verify that attribution maturity is estimated.
- **Research Mesh: the system correctly researches and produces structured observations** — The system produces at least 10 structured observations per day from keyword planning, search/fetch providers, and product crawling. Observations are scored by evidence level (Tier A–E) and freshne...
  - measured by: Run the research mesh for 7 days and count the number of structured observations produced. Verify that observations are scored by evidence level and freshness. Verify that contradictions are detected and tracked.
- **Memory: the system correctly stores and retrieves learnings** — 100% of learnings are stored with evidence refs, evidence type, scope, confidence, applicability score, status. Memory retrieval checks scope and evidence before use. Vector embeddings index the cl...
  - measured by: Verify that learnings are stored with all required fields. Verify that memory retrieval checks scope and evidence. Verify that contradictions and stale claims are detected.
- **Admin UI: the system provides transparent dashboards for decisions, experiments, research, memory, actions, audit** — The admin UI displays: all decisions with their reasoning, expected outcomes, risk, evidence, memory refs, policy decision, model versions, prompt versions; all experiments with their hypotheses, a...
  - measured by: Manually inspect the admin UI and verify that all required information is displayed.

## Constraints

- The model never holds advertising write credentials (invariant 0.1.1).
- All external mutations pass through one deterministic Policy Kernel and one isolated Executor (invariant 0.1.2).
- The agent cannot modify the mechanism that defines what the agent is allowed to modify (invariant 0.1.3).
- Money is integer minor units, never a float (invariant 0.1.3, engineering rule 3).
- Recent metrics are never treated as mature when conversion delay can materially change them (invariant 0.1.9, engineering rule 7).
- Postgres/event history is truth; vector memory is retrieval assistance only (invariant 0.1.6).
- Every action has a reason, expected effect distribution, downside estimate, policy decision, receipt, and later evaluation (invariant 0.1.7).
- Every durable learning points to evidence (invariant 0.1.8).
- A strategy/code candidate is never promoted because an LLM claims it is better; it must beat the baseline on evals (invariant 0.1.10).
- External web content is untrusted data, never instructions (invariant 0.1.11).
- No single model/vendor is a hard dependency (invariant 0.1.12).
- The system must be able to decide that the best action is 'do nothing yet' (invariant 0.1.13).
