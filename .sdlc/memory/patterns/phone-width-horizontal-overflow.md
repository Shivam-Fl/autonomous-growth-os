# Symptom: a long unbreakable string makes the whole page scroll sideways at phone widths

The single most-repeated bug shape in this repo's history. Six PRs in one day were this
same defect on six different cards: #65 (KPI band, journal filter row), #50, #60, #69,
#62, #73. If a card is clipped or the page scrolls horizontally at 320px, this is the
entry to read.

## How it presents

`document.documentElement.scrollWidth > window.innerWidth` at 320, 375 or 414. A single
long token is enough — a 137-character tenant name, a 120-character learning claim, an
unbreakable experiment name. The visible symptom is the whole viewport shifted sideways,
not the one card that overflowed.

## The real cause

Two separate traps, and it is easy to fix one and think you are done.

**1. A grid item's automatic minimum size is its min-content width.** Cards live in
`.experiment-list` and `.approval-list`, both `display: grid`. A track sizes to its
string, so wrapping rules applied *inside* the card do nothing — the grid item is
already as wide as the unbroken token before the browser tries to lay anything out.

**2. `overflow-wrap: break-word` leaves intrinsic sizing alone.** Only `anywhere` makes
the min-content contribution shrink. This is why swapping in `break-word` looks like
it half-works and then regresses at a different string length.

The rule that actually holds (in `src/web/styles.css`):

```css
.experiment-card,
.opportunity-row,
.approval-card,
.learning-card {
  overflow-wrap: anywhere;
}
```

## The scope constraint — do not widen it

Scoped to those four lists, **never to `#main`, never with a `*` descendant**.

`overflow-wrap` is inherited, so a blanket rule on `#main` reaches table cells, and then
every wide table wraps to its column instead of scrolling inside its own
`.table-scroll` region. That trade is deliberate: `.table-scroll` is the one element
allowed to scroll horizontally, and the wrap rule must stay off the tables so it does.

The mutation tests in `test/web/pages.test.js` lock this down. Each of these turns the
suite red with a message naming the class or the declaration — treat a red mutation here
as a real regression, not a flaky assertion:

- dropping `.learning-card` from the wrap rule
- renaming a class in that rule
- appending a later `.approval-card { overflow-wrap: break-word; }` (cascading override)
- changing `min-width: 16ch` on `.approval-actions input` to `0`
- removing `flex-wrap: wrap` from `.approval-actions`

## How to check for it quickly

The repo's own assertion, at three widths:

```
document.documentElement.scrollWidth === window.innerWidth
```

plus: no element outside a `.table-scroll` extends past the viewport right edge, and
every `.table-scroll` region still satisfies `scrollWidth > clientWidth` (a wrap rule
that leaked onto a table makes the second check fail first). AC-7 in #73 is the
canonical statement of the full contract.
