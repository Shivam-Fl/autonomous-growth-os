# UI

_Generated from `project-brief.json` for #1. Every ticket follows this rather
than inventing its own — five screens each inventing their own spacing is how one product
ends up looking like five._

## Theme

| token | value | used for |
|---|---|---|
| `--color-primary` | `#0066CC` | Primary action color (buttons, links, active states) |
| `--color-primary-hover` | `#0052A3` | Primary action hover state |
| `--color-secondary` | `#6C757D` | Secondary action color (secondary buttons, less important links) |
| `--color-success` | `#28A745` | Success state (positive metrics, successful actions) |
| `--color-warning` | `#FFC107` | Warning state (caution, moderate risk) |
| `--color-danger` | `#DC3545` | Danger state (errors, high risk, destructive actions) |
| `--color-background` | `#FFFFFF` | Page background |
| `--color-surface` | `#F8F9FA` | Card/panel background |
| `--color-text-primary` | `#212529` | Primary text color |
| `--color-text-secondary` | `#6C757D` | Secondary text color (labels, descriptions) |
| `--color-border` | `#DEE2E6` | Border color |
| `--spacing-xs` | `4px` | Extra small spacing (tight layouts) |
| `--spacing-sm` | `8px` | Small spacing (compact layouts) |
| `--spacing-md` | `16px` | Medium spacing (default spacing) |
| `--spacing-lg` | `24px` | Large spacing (section spacing) |
| `--spacing-xl` | `32px` | Extra large spacing (page margins) |
| `--font-family` | `Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif` | Default font family |
| `--font-size-sm` | `14px` | Small text (labels, captions) |
| `--font-size-md` | `16px` | Default text size |
| `--font-size-lg` | `18px` | Large text (section headers) |
| `--font-size-xl` | `24px` | Extra large text (page headers) |
| `--border-radius-sm` | `4px` | Small border radius (buttons, inputs) |
| `--border-radius-md` | `8px` | Medium border radius (cards, panels) |
| `--shadow-sm` | `0 1px 2px 0 rgba(0, 0, 0, 0.05)` | Small shadow (cards, panels) |
| `--shadow-md` | `0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)` | Medium shadow (modals, dropdowns) |

**Typography.** Font family: Inter (sans-serif). Font sizes: sm (14px), md (16px), lg (18px), xl (24px). Line height: 1.5 for body text, 1.2 for headers. Font weight: 400 (regular) for body text, 600 (semibold) for headers and emphasis.

**Density.** Medium density. Spacing: xs (4px), sm (8px), md (16px), lg (24px), xl (32px). Cards and panels use md spacing internally and lg spacing between them. Forms use sm spacing between fields.

**Motion.** Minimal motion. Transitions: 200ms ease-in-out for hover states, 300ms ease-in-out for modals and dropdowns. No complex animations in the first release.

**Dark mode.** Not supported in the first release. Dark mode can be added in a later release by inverting the color tokens (background becomes dark, text becomes light).

## Patterns

### Form validation

Inline validation on blur (not on every keystroke). Error messages appear below the field in danger color. Required fields are marked with an asterisk. Submit button is disabled until all required fields are valid.

_Example._ Email field: 'Please enter a valid email address' in danger color below the field.

### Empty state

When a list/table has no items, display a centered message with a brief explanation and a call-to-action (if applicable). Use secondary text color for the message, primary color for the call-to-action.

_Example._ No experiments yet: 'You have not created any experiments yet. Create your first experiment to start testing hypotheses.' with a 'Create Experiment' button.

### Loading state

Display a spinner or skeleton loader while data is loading. Use secondary text color for the spinner. Do not display partial data while loading.

_Example._ Spinner centered in the card while campaign data is loading.

### Error state

Display an error message in danger color with a brief explanation and a call-to-action (retry, contact support). Do not display partial data on error.

_Example._ Error loading campaigns: 'Failed to load campaigns. Please try again or contact support.' with a 'Retry' button.

### Destructive action confirmation

Destructive actions (delete, pause, revert) require a confirmation dialog. The dialog displays the action and its consequences, with 'Cancel' and 'Confirm' buttons. The 'Confirm' button is in danger color.

_Example._ Pause campaign: 'Are you sure you want to pause campaign X? This will stop all ads in this campaign.' with 'Cancel' and 'Pause Campaign' buttons.

### Toast notifications

Toast notifications appear in the bottom-right corner. Success toasts are in success color, error toasts are in danger color, warning toasts are in warning color. Toasts auto-dismiss after 5 seconds (success, warning) or require manual dismissal (error).

_Example._ Success toast: 'Campaign paused successfully.' in success color, auto-dismisses after 5 seconds.

### Metric display

Metrics are displayed with their maturity score as a visual indicator (green for >0.9, yellow for 0.7–0.9, orange for 0.35–0.7, red for <0.35). Money is displayed in the account's currency with thousand separators. Percentages are displayed with one decimal place.

_Example._ CPL: ₹570 (maturity: 0.95) displayed as '₹570' with a green indicator.

### Decision display

Decisions are displayed with their reasoning, expected outcomes, risk, evidence, memory refs, policy decision, model versions, prompt versions. The selected alternative is highlighted. Alternatives are sorted by expected utility.

_Example._ Decision: 'Scale campaign A by 8%' with expected outcomes (qualified leads delta: +7%, qualified CPL delta: +2%), risk (expected downside: 3%), evidence refs, memory refs, policy decision, model versions, prompt versions.

### Experiment display

Experiments are displayed with their hypothesis, arms (control, treatment), exposures, metrics, evaluations. The status is displayed as a badge (draft, running, completed, inconclusive). Metrics are displayed with confidence intervals.

_Example._ Experiment: 'Test system-design pain hook vs feature-led hook' with arms (control: feature-led hook, treatment: system-design pain hook), metrics (qualified landing-page conversion: +10% [5%, 15%]), status: running.

### Research observation display

Research observations are displayed with their source, evidence level (Tier A–E), freshness, contradictions. Evidence level is displayed as a badge (A: green, B: blue, C: yellow, D: orange, E: red). Contradictions are highlighted in danger color.

_Example._ Observation: 'Experienced backend engineers respond strongly to system-design interview positioning' with source: 'forum_cluster_283', evidence level: B (blue badge), freshness: 30 days, contradictions: none.

### Learning display

Learnings are displayed with their claim, scope, evidence refs, evidence type, confidence, applicability score, status. Status is displayed as a badge (candidate: gray, accepted: green, contradicted: red, stale: yellow, rejected: gray). Confidence is displayed as a percentage.

_Example._ Learning: 'Budget increases > 10% under condition X repeatedly caused efficiency collapse' with scope: {tenant: all, platform: google_ads}, evidence type: observational, confidence: 85%, status: accepted (green badge).

## Screens

### Dashboard

**Answers.** Provide an overview of the system's current state: active experiments, recent decisions, key metrics, guardian incidents.

**Regions.** Header (logo, navigation, user menu), sidebar (navigation: dashboard, decisions, experiments, research, memory, actions, audit), main content (cards for active experiments, recent decisions, key metrics, guardian incidents).

- **ideal** — Cards display active experiments, recent decisions, key metrics, guardian incidents with data.
- **empty** — Cards display empty states: 'No active experiments', 'No recent decisions', 'No key metrics', 'No guardian incidents'.
- **loading** — Cards display skeleton loaders while data is loading.
- **partial** — Cards display data for available sections, skeleton loaders for loading sections.
- **error** — Cards display error messages for failed sections, data for successful sections.

**Narrow.** Sidebar collapses to a hamburger menu on mobile. Cards stack vertically on mobile.

### Decisions

**Answers.** Display all decisions with their reasoning, expected outcomes, risk, evidence, memory refs, policy decision, model versions, prompt versions.

**Regions.** Header (logo, navigation, user menu), sidebar (navigation), main content (table of decisions with columns: timestamp, diagnosis, selected alternative, expected outcomes, risk, status).

- **ideal** — Table displays all decisions with data.
- **empty** — Table displays empty state: 'No decisions yet'.
- **loading** — Table displays skeleton loader while data is loading.
- **partial** — Table displays data for loaded rows, skeleton loader for loading rows.
- **error** — Table displays error message: 'Failed to load decisions. Please try again or contact support.' with a 'Retry' button.

**Narrow.** Table scrolls horizontally on mobile. Columns are hidden on mobile except timestamp and diagnosis.

### Experiments

**Answers.** Display all experiments with their hypothesis, arms, exposures, metrics, evaluations.

**Regions.** Header (logo, navigation, user menu), sidebar (navigation), main content (table of experiments with columns: hypothesis, status, arms, metrics, evaluation).

- **ideal** — Table displays all experiments with data.
- **empty** — Table displays empty state: 'No experiments yet. Create your first experiment to start testing hypotheses.' with a 'Create Experiment' button.
- **loading** — Table displays skeleton loader while data is loading.
- **partial** — Table displays data for loaded rows, skeleton loader for loading rows.
- **error** — Table displays error message: 'Failed to load experiments. Please try again or contact support.' with a 'Retry' button.

**Narrow.** Table scrolls horizontally on mobile. Columns are hidden on mobile except hypothesis and status.

### Research

**Answers.** Display all research observations with their source, evidence level, freshness, contradictions.

**Regions.** Header (logo, navigation, user menu), sidebar (navigation), main content (table of research observations with columns: claim, source, evidence level, freshness, contradictions).

- **ideal** — Table displays all research observations with data.
- **empty** — Table displays empty state: 'No research observations yet. The system will automatically research new demand and opportunities.'
- **loading** — Table displays skeleton loader while data is loading.
- **partial** — Table displays data for loaded rows, skeleton loader for loading rows.
- **error** — Table displays error message: 'Failed to load research observations. Please try again or contact support.' with a 'Retry' button.

**Narrow.** Table scrolls horizontally on mobile. Columns are hidden on mobile except claim and evidence level.

### Memory

**Answers.** Display all learnings with their claim, scope, evidence refs, evidence type, confidence, applicability score, status.

**Regions.** Header (logo, navigation, user menu), sidebar (navigation), main content (table of learnings with columns: claim, scope, evidence type, confidence, status).

- **ideal** — Table displays all learnings with data.
- **empty** — Table displays empty state: 'No learnings yet. The system will automatically learn from its actions and experiments.'
- **loading** — Table displays skeleton loader while data is loading.
- **partial** — Table displays data for loaded rows, skeleton loader for loading rows.
- **error** — Table displays error message: 'Failed to load learnings. Please try again or contact support.' with a 'Retry' button.

**Narrow.** Table scrolls horizontally on mobile. Columns are hidden on mobile except claim and status.

### Actions

**Answers.** Display all actions with their intents, policy decisions, capabilities, receipts, reconciliations.

**Regions.** Header (logo, navigation, user menu), sidebar (navigation), main content (table of actions with columns: timestamp, action type, resource, status, policy decision).

- **ideal** — Table displays all actions with data.
- **empty** — Table displays empty state: 'No actions yet. The system will automatically execute low-risk actions within configured authority.'
- **loading** — Table displays skeleton loader while data is loading.
- **partial** — Table displays data for loaded rows, skeleton loader for loading rows.
- **error** — Table displays error message: 'Failed to load actions. Please try again or contact support.' with a 'Retry' button.

**Narrow.** Table scrolls horizontally on mobile. Columns are hidden on mobile except timestamp and action type.

### Audit

**Answers.** Display all audit events with their timestamp, event type, actor, details.

**Regions.** Header (logo, navigation, user menu), sidebar (navigation), main content (table of audit events with columns: timestamp, event type, actor, details).

- **ideal** — Table displays all audit events with data.
- **empty** — Table displays empty state: 'No audit events yet.'
- **loading** — Table displays skeleton loader while data is loading.
- **partial** — Table displays data for loaded rows, skeleton loader for loading rows.
- **error** — Table displays error message: 'Failed to load audit events. Please try again or contact support.' with a 'Retry' button.

**Narrow.** Table scrolls horizontally on mobile. Columns are hidden on mobile except timestamp and event type.

## Accessibility

- All interactive elements (buttons, links, inputs) are keyboard-navigable (Tab, Shift+Tab, Enter, Space).
- Focus states are visible (outline or border in primary color).
- Color contrast meets WCAG 2.1 AA standards (4.5:1 for normal text, 3:1 for large text).
- All images and icons have alt text or aria-labels.
- All forms have labels (not just placeholders).
- Error messages are associated with their fields via aria-describedby.
- Toast notifications are announced to screen readers via aria-live.
- Modals trap focus and return focus to the triggering element on close.
- Tables have proper headers (th elements) and captions.
- Skip-to-content link is provided for keyboard navigation.
