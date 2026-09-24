# Technical requirements

_Generated from `project-brief.json` for #12. Edit the brief, not this file._

## Requirements

### TR-1 — The simulator provides a FakeMetaAdsClient implementing the same interface as the real MetaAdsClient, generating synthetic campaigns, ad sets, ads, Insights, budgets, and conversions with realistic lag, seasonality, saturation, and quality variance.

**Why.** Spec §36 Phase 0: simulator first. Autonomous logic cannot be safely built against real spend without a replay environment. The fake adapter allows development and testing without real credentials.

**Priority.** must

**Proved by.** Integration test: FakeMetaAdsClient runs a 30-day, 3-campaign scenario with p50/p90 lag 48h/120h, weekday/weekend seasonality, saturation past ₹5k/day, 20-40% qualification variance, plus checkout-outage, competitor-entry, and tracking-loss events.

### TR-2 — The Policy Kernel evaluates every ActionIntent against autonomy tier, spend limits, action class trust, maturity thresholds, kill switches, and circuit breakers. It issues signed ActionCapabilities with TTL, nonce, and constraints. The Policy Kernel contains no LLM.

**Why.** Spec §0.1 #1-3, §14: LLMs never possess ad mutation credentials. All mutations pass through one deterministic Policy Kernel. Signed capabilities enforce hard security boundary even if agent is compromised.

**Priority.** must

**Proved by.** Unit tests cover spend cap, autonomy tier, action-class trust, maturity threshold, kill switch, and circuit breaker. Integration test: agent proposes ActionIntent; Policy Kernel signs a capability or rejects with reason.

### TR-3 — The Executor is the only service with Meta Ads write credentials. It validates signed ActionCapabilities (signature, nonce, TTL, resource, constraints), performs typed mutations via Meta Marketing API, and reconciles with provider state. The Executor is idempotent on capability_id. The Executor contains no strategy logic and no LLM.

**Why.** Spec §0.1 #1-3, §14.1, §35 #4: Only Executor reaches ad write secrets. Validates signature + nonce + TTL + resource + constraints. Idempotent and reconciled. No strategy, no LLM.

**Priority.** must

**Proved by.** Integration test: Executor receives signed capability, validates signature, performs mutation via FakeMetaAdsClient, stores receipt, reconciles with provider state. Test replayed nonce is rejected. Test expired capability is rejected. Test wrong resource is rejected.

### TR-4 — The event ingestion API (POST /v1/events) receives first-party events (lead_created, lead_qualified, purchase, refund, etc.), validates schema, assigns event_id, and stores raw normalized events. The API is idempotent on event_id.

**Why.** Spec §7.2, §21.1, §22: First-party measurement is the growth truth layer. Raw events are never discarded prematurely. Idempotency prevents duplicate processing.

**Priority.** must

**Proved by.** Integration test: POST /v1/events with event_id 'evt_123' stores one row in raw_provider_events. POST same event_id again returns 200 OK but does not create a duplicate. POST different event_id stores a second row.

### TR-5 — The Meta Ads read integration (MetaAdsClient) authenticates via OAuth, reads campaigns, ad sets, ads, Insights, budgets, and creatives. The client is behind an adapter interface so FakeMetaAdsClient can substitute.

**Why.** Spec §24: Use official Marketing API behind a versioned adapter. Adapter interface allows fake adapter to substitute for testing.

**Priority.** must

**Proved by.** Integration test: MetaAdsClient authenticates with OAuth token, fetches campaigns list, fetches Insights for a campaign. FakeMetaAdsClient implements the same interface and returns synthetic data.

### TR-6 — State snapshots are immutable records holding matured KPIs, raw recent KPIs, budgets, campaign state, funnel state, demand signals, active experiments, system health, and applicable memories. Every decision references a snapshot_id.

**Why.** Spec §12, §21.2: Every decision references an immutable StateSnapshot. Essential for replay and evaluation.

**Priority.** must

**Proved by.** Unit test: StateSnapshot is created with all required fields. Decision record references snapshot_id. Attempt to modify a snapshot raises an error.

### TR-7 — Money values are stored as BIGINT amount_micros + CHAR(3) currency in the database. Money arithmetic uses integer operations. JSON serialization uses {amount_micros: int, currency: str}. No floating-point for financial calculations.

**Why.** Spec §33, §35 #3: Money is integer minor units, never float. Floating-point introduces rounding errors.

**Priority.** must

**Proved by.** Unit test: Money(1000, 'INR') + Money(500, 'INR') = Money(1500, 'INR'). Database column type is BIGINT for amount_micros and CHAR(3) for currency. JSON serialization round-trips correctly. No float in any financial calculation.

### TR-8 — Domain events (metrics.synced, conversion.received, action.executed, experiment.matured, etc.) are emitted to an event bus. Consumers are idempotent on event_id. Events are stored in raw_provider_events before normalization.

**Why.** Spec §22: Event-driven architecture. Consumers must be idempotent. Raw events stored before normalization.

**Priority.** must

**Proved by.** Integration test: service emits event, event bus receives it, consumer processes it idempotently. Replay same event, consumer does not duplicate work.

### TR-9 — The API application (FastAPI) runs on port 3000, exposes /health endpoint, and serves OpenAPI docs at /docs. The API contains no ad write credentials.

**Why.** Config.yml: env.base_url='http://localhost:3000', env.ready='/'. Spec §32: API/BFF is a Cloud Run service. API should not reach ad mutation secrets.

**Priority.** must

**Proved by.** Integration test: boot API via Docker Compose, curl /health returns 200 OK, curl /docs returns OpenAPI spec. Grep codebase for ad credentials in apps/api; none found.

### TR-10 — Docker Compose stack boots the API, PostgreSQL with pgvector, and (later) Temporal workers. The stack is ready in < 60 seconds. QA can drive the preview with a real browser.

**Why.** Config.yml: env.mode=compose, env.boot='npm run sdlc:serve'. QA drives a real browser against a real preview.

**Priority.** must

**Proved by.** Run sdlc:serve, wait for sdlc:ready (curl /health). Verify boot time < 60 seconds. QA agent navigates onboarding, dashboard, approval workflow, experiment viewer.

### TR-11 — The basic UI provides onboarding (connect Meta Ads account or use simulator), dashboard (campaign overview, KPIs, recent actions), approval workflow (review and approve/reject proposed actions), and experiment viewer (control/treatment, metrics, status).

**Why.** Spec §36 Phase 3: approval UI. Spec §41: acceptance criteria include UI for onboarding, dashboard, approvals.

**Priority.** should

**Proved by.** QA drives browser through onboarding, views dashboard, approves an action, views experiment results. All UI elements are accessible and functional.

### TR-12 — The Meta Ads adapter interface defines methods for reading campaigns, ad sets, ads, Insights, budgets, and creatives. Both MetaAdsClient (real) and FakeMetaAdsClient (simulator) implement this interface.

**Why.** Spec §35 #14: Provider-specific APIs stay behind adapters. Adapter interface allows fake adapter to substitute.

**Priority.** must

**Proved by.** Unit test: code depends on MetaAdsInterface, not concrete implementation. Swap MetaAdsClient and FakeMetaAdsClient, same code works.

### TR-13 — Idempotency keys are UUIDs stored in idempotency_keys table. Every external mutation checks the idempotency key before executing. Duplicate keys return the original result.

**Why.** Spec §35 #4: Every external mutation is idempotent and reconciled.

**Priority.** must

**Proved by.** Integration test: execute mutation with idempotency key 'key_123', store result. Execute same mutation with same key, return original result without re-executing.

### TR-14 — Raw provider events are stored with provider, account, resource, source timestamp, ingestion timestamp, API version, payload hash, normalized payload, and replay key. Raw events are never overwritten with normalized calculations.

**Why.** Spec §21.1, §33: Raw vs derived separation. Never overwrite raw source truth with normalized calculations.

**Priority.** must

**Proved by.** Unit test: raw event stored with all required fields. Normalized event stored separately. Raw event is immutable.

### TR-15 — The attribution maturity model evaluates p50/p90 lag hours per product/campaign/channel. Metrics with maturity < 0.70 are not eligible for strategic conclusions. Policy bands: < 0.35 emergency-only, 0.35-0.70 observation + low-risk, 0.70-0.90 moderate optimization, > 0.90 strategic conclusions.

**Why.** Spec §9, §0.1 #9: Recent metrics are not treated as mature when conversion delay can materially change them.

**Priority.** should

**Proved by.** Unit test: maturity model calculates p50/p90 lag hours. Policy band logic enforces action restrictions based on maturity.

## Data model

### tenants

Organization, users, memberships, products, business units. Tenant isolation enforced.

**Keys.** id (UUID), organization_id, created_at

Multi-tenant. RLS considered for later.

### provider_connections

OAuth tokens (encrypted), provider (meta_ads), account_id, status, permissions. Only Executor reads write tokens.

**Keys.** id, tenant_id, provider, account_id

Encrypted at rest. Access audit logged.

### campaigns

Campaign metadata: name, status, budget, objective, targeting, provider_resource_id, last_synced_at.

**Keys.** id, tenant_id, provider_connection_id, provider_resource_id

Synced from provider. Provider-specific fields in JSONB.

### action_intents

Proposed action: action_type, resource, parameters, expected_outcome, risk, evidence_refs, memory_refs, proposed_by_agent.

**Keys.** id, tenant_id, state_snapshot_id

Proposed by agents, evaluated by Policy Kernel.

### policy_decisions

Policy Kernel evaluation: action_intent_id, decision (approved/rejected), reason, constraints, capability_id, policy_version.

**Keys.** id, action_intent_id

Deterministic. No LLM.

### action_capabilities

Signed capability: capability_id, tenant_id, provider, resource, action, constraints, expires_at, nonce, signature, policy_version.

**Keys.** capability_id, nonce

Signed by Policy Kernel. Validated by Executor.

### executed_actions

Executed mutation: capability_id, action_type, resource, parameters, provider_receipt_id, executed_at, reconciled.

**Keys.** id, capability_id, provider_receipt_id

Idempotent on capability_id.

### raw_provider_events

Raw event from provider: provider, account, resource, source_timestamp, ingestion_timestamp, api_version, payload_hash, payload, replay_key.

**Keys.** id, replay_key

Immutable. Never overwritten.

### state_snapshots

Immutable snapshot: matured_kpis, raw_recent_kpis, budgets, campaign_state, funnel_state, demand_signals, active_experiments, system_health, applicable_memories.

**Keys.** id, tenant_id, created_at

Immutable. Every decision references one.

### experiments

Experiment: name, hypothesis, control_arm, treatment_arms, primary_metric, guardrails, sample_size, runtime, status, started_at, matured_at.

**Keys.** id, tenant_id, state_snapshot_id

Control/treatment. Native platform experiments preferred.

### learnings

Durable learning: claim, scope, evidence_refs, evidence_type, effect, confidence, applicability_score, status (candidate/accepted/contradicted/stale/rejected), valid_from, stale_after.

**Keys.** id, tenant_id, status

Every learning points to evidence. Vector embeddings index claim for retrieval.

### idempotency_keys

Idempotency key: key, resource, result, created_at, expires_at.

**Keys.** key

Prevents duplicate mutations.

## Interfaces

### POST /v1/events

```
Accepts first-party events (lead_created, purchase, refund, etc.). Request: {event_id, event_name, occurred_at, user_reference, session_reference, order_reference, value, currency, properties}. Response: 200 OK with {event_id, status}. Idempotent on event_id.
```

**On failure.** 400 Bad Request (invalid schema), 409 Conflict (duplicate event_id with different payload), 500 Internal Server Error

**Idempotency.** Idempotent on event_id. Duplicate event_id with same payload returns 200 OK without creating duplicate.

### GET /health

```
Health check endpoint. Response: 200 OK with {status: 'healthy', timestamp, version}. Used by sdlc:ready command.
```

**On failure.** 503 Service Unavailable (database connection failed, critical service down)

### GET /docs

```
OpenAPI specification. Auto-generated by FastAPI. Response: 200 OK with OpenAPI JSON.
```

**On failure.** None

### MetaAdsInterface.read_campaigns

```
Reads campaigns from Meta Ads. Parameters: tenant_id, account_id, filters (optional). Returns: List[Campaign].
```

**On failure.** AuthenticationError (invalid OAuth token), RateLimitError (API rate limit exceeded), ProviderError (Meta API error)

### MetaAdsInterface.read_insights

```
Reads Insights (metrics) for a campaign or ad set. Parameters: tenant_id, account_id, resource_id, date range, fields. Returns: List[Insight] with spend, impressions, clicks, platform-reported conversions.
```

**On failure.** AuthenticationError (invalid OAuth token), RateLimitError (API rate limit exceeded), ProviderError (Meta API error)

### PolicyKernel.evaluate

```
Evaluates an ActionIntent against autonomy tier, spend limits, action-class trust, maturity bands, kill switches, and circuit breakers, using the referenced StateSnapshot. Returns: approved with a signed ActionCapability, or rejected with reason and policy_version.
```

**On failure.** PolicyDenied (rule + reason), StaleSnapshot (snapshot superseded), KillSwitchEngaged (all writes frozen)

### Executor.execute

```
Validates a signed ActionCapability (signature, nonce, TTL, resource, constraints) and performs one typed mutation via the Meta Marketing API, then stores the provider receipt and reconciles. Parameters: capability, idempotency key.
```

**On failure.** InvalidCapability (bad signature, replayed nonce, expired TTL, or resource mismatch), ProviderError, ReconciliationMismatch

**Idempotency.** Idempotent on capability_id; a replayed capability returns the original receipt without re-executing.

### EventBus.publish

```
Publishes domain events (metrics.synced, conversion.received, action.executed, experiment.matured). Envelope: event_id, event_type, occurred_at, tenant_id, correlation_id, schema_version, payload.
```

**On failure.** SchemaViolation (unknown event_type or schema_version)

**Idempotency.** Consumers are idempotent on event_id; redelivery never duplicates effects.

## Non-functional

_none stated_
