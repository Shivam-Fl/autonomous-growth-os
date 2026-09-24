# Conventions

Written from the project brief for #12, so every ticket starts from the same
rules. Reviews add to it as they find patterns; correct it here rather than arguing in a ticket.

## Stack
Python 3.12+ with FastAPI for the API/BFF, PostgreSQL 16 with pgvector for operational state and semantic memory, Temporal Cloud for durable workflow orchestration (stubbed initially with in-process workers), Docker Compose for local QA environment, Meta Marketing API as the first ad platform integration. Package.json provides the four sdlc: npm scripts that delegate to Python tooling (pytest, uvicorn, scripts).

## Rules
- Python code uses type hints everywhere, dataclasses or Pydantic models for structured data, async/await for I/O. Tests live alongside code in tests/ directories, run with pytest. Formatting: ruff. Linting: ruff. Type checking: mypy strict.
- Every external mutation is idempotent and reconciled. Idempotency keys are UUIDs stored in idempotency_keys table. Provider reconciliation compares our executed action with provider-reported state to detect manual changes, failed mutations, or third-party changes (spec §23, §35 #4).
- Every decision references an immutable StateSnapshot. State snapshots hold matured KPIs, raw recent KPIs, budgets, campaign state, funnel state, demand signals, research deltas, active experiments, system health, applicable memories. Every decision record points to one snapshot_id (spec §12, §21.2).
- Domain events are immutable and carry event_id, event_type, occurred_at, tenant_id, correlation_id, causation_id, schema_version, payload. Consumers must be idempotent. Events are stored in raw_provider_events before normalization (spec §22, §21.1).
- Provider-specific APIs stay behind adapters. integrations/meta_ads/ exposes a MetaAdsClient interface. services/simulator/ provides a FakeMetaAdsClient implementing the same interface. Business logic depends on the interface, not the implementation (spec §35 #14).
- Every material architecture change requires an ADR. ADRs live in docs/adr/ and are numbered sequentially. An ADR without consequences is an announcement: every ADR states what was decided, why, and what it makes easy/hard (spec §35 #15).
- Money values are serialized as {amount_micros: int, currency: str} in JSON. API responses never use floating-point for financial values. Database columns use BIGINT for amount_micros and CHAR(3) for currency (spec §33).
