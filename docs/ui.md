# UI

_Generated from `project-brief.json` for #14. Every ticket follows this rather
than inventing its own — five screens each inventing their own spacing is how one product
ends up looking like five._

## Theme

| token | value | used for |
|---|---|---|
| `--color-bg` | `#F7F5F0` | Page background. |
| `--color-surface` | `#FFFFFF` | Cards, panels, table headers. |
| `--color-ink` | `#1C1A16` | Primary text. |
| `--color-muted` | `#6B655A` | Secondary text and timestamps. |
| `--color-accent` | `#1D5FBF` | Links, active states, primary buttons. |
| `--color-good` | `#1E7E34` | Healthy metrics, successful evaluations. |
| `--color-warn` | `#B26A00` | Immature data, pending approvals. |
| `--color-bad` | `#B3261E` | Guard freezes, errors, regressions. |
| `--space-1` | `8px` | Base spacing unit; all gaps are multiples. |
| `--radius-1` | `8px` | Cards, inputs, buttons. |
| `--font-body` | `system-ui, sans-serif` | All UI text; tabular numerals for metrics. |

**Typography.** System stack with tabular numerals for every metric; one display size for KPI values, one body size, one caption size.

**Density.** Comfortable density: 8px base spacing, 44px minimum touch targets on decision buttons.

**Motion.** No decorative animation; state changes crossfade under 150ms; skeletons pulse subtly and respect prefers-reduced-motion.

**Dark mode.** No dark mode in v1; light theme only, with tokens structured so a dark inversion maps each --color-* token without touching layouts.

## Patterns

### Forms and approvals

Validate inline on blur, summarize on submit, and never clear user input on error; destructive approvals require typing-free explicit confirm plus reason, with the downside estimate shown beside the button.

### Tables and lists

Every table shows row counts, sorts deterministically, and renders an explicit empty state naming the action that fills it; never a blank panel.

### Async and maturity

Immature or loading data always shows its state: skeleton while loading, maturity bar while awaiting conversions, stale banner past freshness thresholds.

### Errors and incidents

Error panels name what failed, what is still true, and the next action (retry, inspect, escalate); guardian freezes get a persistent banner until explicitly re-enabled.

### Toasts and feedback

Mutations confirm via a toast naming the receipt id; failures persist as panels, never auto-dismissing toasts.

## Screens

### Command dashboard

**Answers.** Is the business efficient, safe, and improving right now?

**Regions.** Header with tenant, spend-guard status, and tracking health; KPI strip (qualified CPL, qualified volume, maturity coverage); decision feed; open experiments; guardian incidents.

- **ideal** — Live KPIs with maturity badges, today's proposed and executed actions, experiment statuses.
- **empty** — No connected account yet: shows the connect-Meta plus install-pixel checklist with expected time per step.
- **loading** — Skeleton KPI cards and feed rows; no layout shift when data arrives.
- **partial** — Stale provider data banner with age; matured metrics render normally, immature ones show maturity bars.
- **error** — Failed provider sync or unhealthy tracking: names the failing check, shows last good data timestamp, offers retry.

**Narrow.** Single column under 900px: guard status first, KPI strip as stacked cards, feed below.

### Decision journal

**Answers.** What did the system decide, why, and was it right?

**Regions.** Filterable decision table (date, action class, expected vs matured impact, status); decision detail drawer with alternatives, evidence refs, and policy id; calibration summary.

- **ideal** — Decisions with matured evaluations, calibration curve, and false-intervention annotations.
- **empty** — Before shadow mode starts: explains what will appear and links to start the first replay.
- **loading** — Skeleton rows; calibration panel shows cached last run with a refreshing indicator.
- **partial** — Unevaluated recent decisions show awaiting-maturity with expected evaluation dates.
- **error** — Replay or evaluation failure names the scenario and preserves prior entries; retry is per-scenario.

**Narrow.** Table collapses to cards; drawer becomes full-screen overlay.

### Opportunities and experiments

**Answers.** Which bets compete for the next unit of spend, and what will settle them?

**Regions.** Ranked opportunity list with score components visible; experiment cards with caps, stop rules, and state; new-hypothesis composer.

- **ideal** — Ranked opportunities with components, live experiments with progress toward maturity.
- **empty** — Empty queue state triggers a research prompt: the strategist explains what it will investigate first.
- **loading** — Skeleton cards.
- **partial** — Some experiment arms await maturity; cards show data-through timestamps.
- **error** — Failed experiment fetch preserves drafts; error names the failed source.

**Narrow.** Score components collapse behind disclosure toggles.

### Approvals

**Answers.** What needs a human yes or no, and what happens on each path?

**Regions.** Pending approval queue with impact, downside, evidence, and expiry; approve/reject with reason field; executed-approval receipts.

- **ideal** — Pending items with full context and one-click decide plus reason.
- **empty** — No pending approvals: shows autonomy posture per action class so emptiness reads as healthy.
- **loading** — Skeleton queue rows.
- **partial** — Expired approvals move to a lapsed section instead of vanishing.
- **error** — Approval action failure keeps the item pending and surfaces the reconciliation state.

**Narrow.** Queue becomes stacked cards with sticky approve/reject bar.

## Accessibility

- Text contrast at least 4.5:1 for body and 3:1 for large text against the --color-bg and --color-surface tokens.
- Every page is fully operable by keyboard: visible focus ring, logical tab order matching the region order, approvals confirmable without a mouse.
- All form inputs carry labels; all async regions announce state changes via aria-live; tables expose headers and row counts.
- QA checks contrast, keyboard-only approval flow, and screen-reader labels on the journal and approvals pages.
