# Memory index

One line per entry, describing **when it applies** — an agent reads this before deciding
whether to open the entry itself.

## Always
- [project.md](project.md) — stack, layout, commands. Read before any planning.
- [conventions.md](conventions.md) — naming, errors, tests, PR style. Read before writing code.
- [docs/prd.md](../../docs/prd.md) — what is being built, for whom, and what deliberately is not. Read before planning a feature.
- [docs/trd.md](../../docs/trd.md) — the numbered TR- requirements an issue's `Covers:` line cites. Read before planning or reviewing.

## Situational
- [qa/environment.md](qa/environment.md) — env quirks and login recipes. Read before browser QA.
- [qa/selectors.md](qa/selectors.md) — selectors known to be stable.
- [patterns/](patterns/) — bug shapes this repo has produced before. Grep by symptom.
- [decisions/](decisions/) — why things are as they are. Read before proposing a rewrite.
