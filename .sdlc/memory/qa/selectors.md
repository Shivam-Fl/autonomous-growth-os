# Stable selectors

Prefer these over anything derived from text or DOM position — text changes with copy edits
and positions change with layout, and both produce failures that waste an attempt.

## Demo app
| Element | Selector |
|---|---|
| New todo input | `#new-todo` |
| Add button | `#add` |
| Error message | `#error` (has `role=alert`) |
| Todo list | `#list` |
| A todo row | `.todo[data-id="<id>"]` |
| Row checkbox | `.todo input[type=checkbox]` |
| Row text | `.todo .text` |
| Remove button | `.todo .remove` |
| Remaining count | `#count` |
| Filter buttons | `.filter[data-filter="all\|active\|done"]` |
