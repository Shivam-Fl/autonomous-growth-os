# ADR-0007: Money is integer minor units, never float

**Date:** 2026-09-24
**Status:** accepted
**Forced by:** #12

## Decision
All monetary values are stored as BIGINT amount_micros + CHAR(3) currency. Serialized as {amount_micros: int, currency: str} in JSON. Python code uses a Money value object with integer arithmetic. No floating-point for financial calculations anywhere in the stack.

## Why
Spec §33: 'Money: never use float. amount_micros BIGINT + currency CHAR(3), or exact NUMERIC.' Floating-point arithmetic introduces rounding errors that compound across calculations. Financial systems must be exact. This is a domain invariant that, if violated, causes subtle bugs in billing, reporting, and optimization.

## Consequences
Easy: Exact arithmetic. No rounding errors. Audit-friendly. Hard: More verbose than float. Every financial calculation must use Money type. API consumers must handle the {amount_micros, currency} structure. Conversion to/from display values (₹) requires care.
