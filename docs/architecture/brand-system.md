# Brand system (tokens, theme-check gate)

## Purpose

One place to change how the product looks. Design tokens live in CSS
custom properties; Tailwind config references those vars; components
consume Tailwind classes; a CI gate blocks hand-rolled palette usage
from re-entering the codebase.

The full brand guidebook (palette, typography, motion, elevation, voice)
lives at [`../brand/brand-guidebook.md`](../brand/brand-guidebook.md).
This doc focuses on the **system** — how the pieces hang together and
where the contract boundaries are.

## Key files

- `client/src/index.css` — `:root` and `.dark` CSS custom properties
  (palette, shadows, typography, gradients, motion tokens, keyframes).
- `client/tailwind.config.ts` — Tailwind wires the CSS vars into class
  names (`bg-background`, `border-border`, `shadow-elev-1`, etc.).
- `client/scripts/theme-check.mjs` — CI gate. Rejects hand-rolled
  `bg-white`, `text-gray-*`, raw hex colors, `from-slate-*`, `rgb()` in
  JSX/TSX, etc. Honours a `temporaryDebtFiles` allowlist for known
  debt.
- `client/THEMING.md` — the rules as committed instructions for
  contributors.

## Token ladder (abbreviated)

| Token | Purpose |
|---|---|
| `--background` / `--foreground` | Canvas + ink |
| `--card` / `--card-border` | Card surfaces |
| `--sidebar*`, `--popover*`, `--muted*` | Secondary surfaces |
| `--primary` / `--primary-foreground` | Action colour (hsl 221 83% 53%) |
| `--accent-gold` | Signature emphasis; one gold stroke per view |
| `--chart-1..5` | Colour-blind-safe series palette |
| `--shadow-xs` ... `--shadow-2xl` | Elevation ladder (mapped to `shadow-elev-1..5`) |
| `--ease-*`, `--duration-*` | Motion tokens |
| `--gradient-canvas` / `--gradient-ink-soft` / `--gradient-elevate` | Named gradients |

Canonical alpha ladder: `/5 /10 /15 /25 /35 /55 /80`. Any other value
is a bug.

## Component rules (enforced by `theme-check.mjs`)

- Use semantic token classes: `bg-background`, `bg-card`,
  `text-foreground`, `text-muted-foreground`, `border-border`,
  `bg-primary`, etc. **Never** raw `text-gray-*`, `bg-white`, hex, or
  `rgb(...)` in JSX/TSX.
- Gradients come from the named tokens or inline `var(--gradient-*)`;
  `from-slate-*`, `from-blue-*`, `from-zinc-*`, `to-white`, `to-slate-*`
  are banned.
- Component primitives live in `client/src/components/ui/*`. Prefer
  composing them over hand-styling.
- Table-like surfaces: use the shared utilities from `index.css`
  (`token-table-frame`, `token-table-head`, `surface-hover`,
  `surface-selected`, `surface-positive`).

## tempDebt allowlist

`theme-check.mjs` exports a `temporaryDebtFiles` Set with the files
allowed to break the rules *today*. Intent: the allowlist **shrinks**
over time, never grows. Adding a new file requires a comment explaining
why and a follow-up task.

A file leaves the allowlist by migrating to tokens. Wave F4 of the
audit-resolution plan ships the migrations that remove three files:
`DatasetEnrichmentLoader.tsx`, `FilterAppliedMessage.tsx`,
`pivot/PivotGrid.tsx`.

## Light/dark parity

Every surface must pass manual verification in both themes. The canvas
warms in light mode (40° hue paper neutrals) and cools in dark (240°
hue neutrals); semantic tokens handle the swap. A component that
hard-codes a single-theme palette will read as near-white-on-near-white
(or near-black-on-near-black) in the wrong theme — this is the class of
bug Wave F4 resolves.

## Extension points

- **Add a token**: extend `:root` and `.dark` in `index.css`; expose it
  via `tailwind.config.ts` if consumers need a class name. Update the
  guidebook.
- **Relax a `theme-check` rule**: requires a written rationale in the
  PR. The allowlist is strictly preferred over weakening a pattern.
- **Add a keyframe animation**: define under `@layer utilities` in
  `index.css` with a `prefers-reduced-motion: reduce` short-circuit.

## Known pitfalls

- **Hand-rolled hex / rgb bypass the token system.** Even if it
  matches today's colour, the dark-mode swap won't work.
- **`bg-white/60` looks fine in light mode, catastrophic in dark.**
  Reach for `bg-card/60` or `bg-background/60`.
- **`text-slate-*`** and **`text-gray-*`** are equally bad; both
  forbidden.

## Recent changes

- **Wave F4** — migrated three dark-mode-broken surfaces to semantic
  tokens and shrank the `temporaryDebtFiles` allowlist accordingly:
  `client/src/components/FilterAppliedMessage.tsx`,
  `client/src/pages/Home/Components/DatasetEnrichmentLoader.tsx`,
  `client/src/pages/Home/Components/pivot/PivotGrid.tsx`. The
  allowlist now carries only files with a written rationale (paper-white
  export for dashboards, plus a handful of yet-untouched legacy
  surfaces).
- Initial seed of this doc.
