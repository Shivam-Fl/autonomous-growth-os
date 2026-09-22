# ADR-0001: TypeScript for the core platform, Python for ML/statistics

**Date:** 2026-09-22
**Status:** accepted
**Forced by:** #1

## Decision
The core platform (API/BFF, Policy Kernel, Executor, Temporal workers, event ingestion, admin UI) is written in TypeScript 5.6+ on Node.js 22 LTS. Python 3.12+ is used for statistical/ML services (anomaly detection, forecasting, maturity modeling, response curves, causal inference, calibration).

## Why
The spec describes most entities in TypeScript types, the Policy Kernel and Executor are deterministic systems where type safety prevents expensive mutations, and Temporal has a mature TypeScript SDK. Python's ecosystem (NumPy, SciPy, pandas, scikit-learn, PyMC, causal inference libraries) is unmatched for the quantitative modeling this system requires. Using one language for everything would either sacrifice type safety in the kernel (if Python) or lose the ML ecosystem (if TypeScript).

## Consequences
Makes it easy to enforce type safety in the Policy Kernel and Executor where mutations are expensive, and easy to use the Python ML ecosystem for quantitative modeling. Makes it harder to share code between TypeScript and Python services; they must communicate via typed interfaces (API calls, Temporal activities, Pub/Sub messages). Requires maintaining two language ecosystems, but the boundary is clear: TypeScript for the platform, Python for ML.
