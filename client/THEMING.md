# Theme Styling Conventions

Use these rules when building or updating UI.

## Color rules
- Use semantic token classes only: `bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`, `text-primary`, etc.
- Avoid hardcoded palette classes (`text-gray-*`, `bg-white`, `border-gray-*`, `hover:bg-gray-*`) in app components.
- Avoid raw hex/rgb/hsl colors in JSX class strings unless there is a clear, documented exception.

## Interaction rules
- For table/list items, prefer shared semantic utilities from `index.css`:
  - `token-table-frame`
  - `token-table-head`
  - `token-table-row`
  - `surface-hover`, `surface-selected`, `surface-positive`
- Keep hover/selected states visible in both themes using semantic surfaces, not fixed light colors.

## Component rules
- Prefer UI primitives (`Button`, `Card`, `Input`, etc.) and variants before adding custom styling.
- If custom styles are needed, compose from token classes and keep contrast-safe text pairings (`text-foreground` on muted/card surfaces).
- For status chips/badges, use semantic token blends (`bg-primary/10`, `border-primary/25`, `text-primary`) instead of light-only color ramps.

## PR checklist
- Verify in both light and dark modes.
- Verify hover, focus, active, and disabled states.
- Run `npm run theme:check` before merging.
