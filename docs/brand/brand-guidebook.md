# Marico Insight — Brand guidebook

**Audience:** anyone shipping UI in this repo. Canonical source: this
file. Tokens live in `client/src/index.css` and `client/tailwind.config.js`.
CI enforcement lives in `client/scripts/theme-check.mjs`.

**Brand essence — quiet intelligence.** Data is the hero; the UI frames
it. Typography is the load-bearing wall. Motion carries meaning, not
decoration. Restraint over flourish. One accent and one signature
moment per view. The result should feel closer to a private-banking
console or a high-end editorial product than to a generic SaaS
dashboard.

---

## 1 · Brand mark & lockup

- **Product name (ambient):** *Marico Insight*. Two words, equal weight.
- **Wordmark type:** "Marico" in `Source Serif 4` Semibold 22px tracking
  `-0.02em`; "Insight" in `Plus Jakarta Sans` Medium 22px tracking
  `0.01em`; a 1px vertical divider between them using `hsl(var(--border))`.
- **Minimum clear space:** the height of the capital M on every side.
- **Monogram (future):** a stacked `mi` glyph in Source Serif italic,
  reserved for favicon + compact sidebar.
- **No decorative illustrations, no stock icons. Data is the brand.**

## 2 · Palette

All colour references are HSL custom properties wrapped in
`hsl(var(--token) / <alpha>)`. Never hardcode hex or rgb in JSX/TSX.

### Surface & ink (unchanged)

| Token | Use |
|-------|-----|
| `--background` | Canvas (light `40 20% 98%` · dark `240 6% 7%`) |
| `--foreground` | Ink (light `240 6% 10%` · dark `40 12% 97%`) |
| `--card` + `--card-border` | Cards |
| `--sidebar` + `--sidebar-border` + `--sidebar-accent` | Shell left rail |
| `--border`, `--input` | Dividers, hairlines, input fields |
| `--muted`, `--muted-foreground` | Secondary text + quiet surfaces |
| `--popover`, `--popover-border` | Floating surfaces |

### Primary

`hsl(221 83% 53%)` (dark mode `58%`). Always via `--primary`; never
with tinted hex. Used for interactive affordances, focus rings, chart
primary series.

### Signature accent — Brand Gold *(new in UX-0)*

`--accent-gold: 43 45% 55%` (light) · `43 55% 62%` (dark).

**One gold stroke per view.** Reserved for:

- The magnitudes pill (Phase-1 rich envelope).
- The dashboard sheet-tab active underline.
- The wordmark divider tick.
- A single 1px hairline under hero display headlines.

Everything else uses `--primary` or neutrals.

### Semantic

| Token | Value | Use |
|-------|-------|-----|
| `--success` | `152 55% 38%` / `152 50% 52%` (dark) | Positive deltas, success toasts |
| `--warning` | `32 92% 46%` / `32 88% 58%` (dark) | Non-blocking warnings |
| `--destructive` | existing | Destructive actions, errors |

### Chart palette (unchanged)

Five colourblind-safe series: `--chart-1` blue · `--chart-2` teal ·
`--chart-3` amber · `--chart-4` rose · `--chart-5` violet.

### Alpha ladder (canonical)

Allowed alpha values: **`/5 /10 /15 /25 /35 /55 /80`**. Any other value
is a bug — keeps hovers, selected states and washes consistent.

### Gradient tokens *(new in UX-0)*

Import via Tailwind `bg-gradient-canvas` / `bg-gradient-ink-soft` /
`bg-gradient-elevate` or via CSS `background-image: var(--gradient-*)`.

- `--gradient-canvas` — top-down paper warmth (page backgrounds, hero).
- `--gradient-ink-soft` — radial halo behind display type (hero).
- `--gradient-elevate` — card surface cap on hover (interactive cards).

Hard-coded `from-slate-*`, `to-white`, `from-blue-50`, `from-zinc-*`,
`rgb(…)`, `rgba(…)` in JSX/TSX are now blocked by `theme-check`.

## 3 · Typography

**Two families do the work.** Both already loaded via Google Fonts in
`client/index.html`; no new CDN requests.

| Role | Family | Weight | Size / leading | Tracking |
|------|--------|--------|----------------|----------|
| Display XL (hero H1) | Source Serif 4 | 500 | 48 / 52 | -0.02em |
| Display LG (page H1) | Source Serif 4 | 500 | 36 / 40 | -0.02em |
| Heading XL | Plus Jakarta Sans | 600 | 28 / 34 | -0.015em |
| Heading LG (card title) | Plus Jakarta Sans | 600 | 22 / 28 | -0.012em |
| Heading MD (section) | Plus Jakarta Sans | 600 | 18 / 24 | -0.008em |
| Body LG (chat) | Plus Jakarta Sans | 400 | 15 / 24 | 0 |
| Body MD (UI) | Plus Jakarta Sans | 400 | 14 / 22 | 0 |
| Body SM (meta) | Plus Jakarta Sans | 400 | 13 / 20 | 0 |
| Caption / eyebrow | Plus Jakarta Sans | 600 | 11 / 16 | 0.06em uppercase |
| Metric / number | JetBrains Mono | 500 | 15 / 20 tabular-nums | -0.01em |
| Code | Geist Mono | 400 | 13 / 20 | 0 |

### Tailwind utilities

- `font-sans` · Plus Jakarta Sans (default).
- `font-display` · Source Serif 4 — hero + page H1 only.
- `font-mono` · JetBrains Mono.
- `font-metric` · JetBrains Mono with tabular-nums intent — numeric
  columns, KPIs, magnitudes pills.

### Rules

- **One display moment per view.** Either the hero headline or the
  page H1 — never both.
- Numeric columns in tables + KPIs always render with
  `font-variant-numeric: tabular-nums`.
- Selection colour: `hsl(var(--primary) / 0.2)` — already globally set.
- `<Display>`, `<Heading>`, `<Eyebrow>`, `<Metric>`, `<Caption>`
  components ship in UX-1 at `client/src/components/ui/typography.tsx`.
  Consumers stop hand-setting sizes.

## 4 · Shape & density

### Radius ladder

| Token | Value | Use |
|-------|-------|-----|
| `rounded-brand-sm` | 6px | Inline chips, inputs |
| `rounded-brand-md` | 10px | Buttons, pill badges |
| `rounded-brand-lg` | 12px | Cards, message bubbles |
| `rounded-brand-xl` | 16px | Dialogs |
| `rounded-brand-2xl` | 20px | Hero cards, export dialog |
| `rounded-full` | 9999px | Avatar, status dot, gold-accent pills |

Legacy `rounded-sm/md/lg` are kept at their previous values (3/6/9px)
for back-compat; primitives migrate to `brand-*` one PR at a time.

### Spacing

Tailwind defaults (4px base). Vertical rhythm inside the typography
components uses a discrete stack set: **8 / 12 / 16 / 24 / 40**.

### Layout gutters

Desktop 24px · narrow 16px. The dashboard grid keeps 24×24 margin
(already set in `DashboardTiles.tsx`).

### Data-table density

- Row 44px at rest, 36px under `density=compact`.
- 8/12px column padding.
- 1px `--border` separators. No full grids.

## 5 · Elevation

Six levels, aliased from the existing `--shadow-*` stack. Components
stop hand-setting shadows — use `shadow-elev-*`.

| Level | Use | Resting | Hover (if interactive) |
|------:|-----|---------|-------------------------|
| 0 | Inline chips, eyebrow text | none | none |
| 1 (`shadow-elev-1`) | Resting card, tiles at rest | `--shadow-xs` | `--shadow-sm` + `translateY(-1px)` |
| 2 (`shadow-elev-2`) | Interactive card | `--shadow-sm` | `--shadow-md` + `translateY(-2px)` |
| 3 (`shadow-elev-3`) | Floating — popover, cmdk, toast | `--shadow-md` | — |
| 4 (`shadow-elev-4`) | Modal / dialog | `--shadow-lg` | — |
| 5 (`shadow-elev-5`) | Command palette, export dialog | `--shadow-2xl` | — |

Hover lifts use
`transition: transform var(--duration-base) var(--ease-entrance), box-shadow var(--duration-base) var(--ease-entrance)`.

## 6 · Motion

**Premium means decisive + honest.** Work surfaces never bounce;
spring is reserved for delight moments (CTA confirm, chart
first-render, dashboard "Create" transition).

### Easing tokens

| Token | Tailwind utility | Curve |
|-------|------------------|-------|
| `--ease-entrance` | `ease-entrance` | `cubic-bezier(0.16, 1, 0.3, 1)` (default for enters) |
| `--ease-exit` | `ease-exit` | `cubic-bezier(0.7, 0, 0.84, 0)` |
| `--ease-standard` | `ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` |
| `--ease-emphasized` | `ease-emphasized` | `cubic-bezier(0.2, 0, 0, 1)` (sheet underline, tab swap) |

Spring physics (framer-motion) only when needed — import via the
`useMotionPreset` hook landing in UX-1.

### Duration tokens

| Token | Tailwind utility | ms | Use |
|-------|------------------|----|-----|
| `--duration-instant` | `duration-instant` | 100 | Hover colour swap |
| `--duration-quick` | `duration-quick` | 160 | Focus ring, badge tint |
| `--duration-base` | `duration-base` | 220 | Card hover, most transitions |
| `--duration-slow` | `duration-slow` | 320 | Dialog / sheet enter |
| `--duration-decisive` | `duration-decisive` | 420 | Hero settle, streaming |

### Keyframes

All registered on Tailwind; consumers use `.animate-brand-*`. Every
animation is auto-disabled under `prefers-reduced-motion: reduce`
(handled globally in `client/src/index.css`).

- `.animate-brand-settle` — 0→1 opacity + 8px rise, 320ms entrance.
- `.animate-brand-shimmer` — 1500ms linear shimmer sweep for skeletons.
- `.animate-brand-breathe` — 1800ms standard-ease pulse for streaming
  indicators.
- `.animate-brand-underline` — tab / sheet-tab active underline scale-x.
- `.animate-brand-ring` — focus halo pulse on primary CTAs.

### Rules

- Every opacity animation must pair with a micro-transform so the
  change has direction.
- CSS > framer-motion for single-element micro-interactions. Reach for
  framer when ≥3 elements stagger or a gesture is in play.
- Reuse `useGradualReveal` for streamed-text reveals; do not reinvent.

## 7 · Iconography

- **Library:** Lucide (already used). Stroke `1.5`, size buckets
  `14 / 16 / 20 / 24`.
- **Colour:** inherits surrounding text colour. Tints to `--primary`
  only when the icon IS the interactive affordance (send, add sheet,
  add chart).
- **No second icon library. Emoji never appear in UI chrome** — only
  in user-generated content.

## 8 · Voice & tone

- **Eight-word test:** every headline fits in ≤8 words.
- **System messages:** first person plural ("We couldn't determine…").
- **Suggestions / help:** second person ("You can add columns…").
- **Never** exclaim. **Never** "Oops".
- **Numbers:** tabular, always with unit. `$1.2M · -23.4% · 4.2×`.
- **Loading:** stateful verb ("Decomposing variance…"), not "Loading".
- **Errors:** lead with what failed, not what the user did. Offer
  exactly one recovery verb.

## 9 · Do / don't

- **Do** use one display font moment per view (hero or page H1).
- **Do** reserve gold accent for a single element per view.
- **Do** pair a typographic hero with a quiet, wide body column.
- **Don't** combine `shadow-lg` with `border` and `ring` on the same
  element — pick one depth cue.
- **Don't** animate opacity alone; always pair with a micro-transform.
- **Don't** use primary blue for body text or borders.
- **Don't** place more than 5 chart series, 3 CTAs, or 2 dialogs on
  one screen.
- **Don't** ship hard-coded hex, rgb, or gradient shortcuts — the
  `theme-check` gate rejects them.

---

## Cross-references

- Implementation plan: `/root/.claude/plans/i-suggest-we-start-keen-koala.md`
  (repo-local mirror: none — plan file lives in the Claude Code plan
  directory; copy relevant sections into PR descriptions).
- Tokens: `client/src/index.css` (`:root` + `.dark`).
- Tailwind extensions: `client/tailwind.config.js`.
- Enforcement: `client/scripts/theme-check.mjs`.
- Motion primitives (UX-1): `client/src/components/ui/motion.tsx`,
  `client/src/hooks/useMotionPreset.ts`.
- Typography primitives (UX-1): `client/src/components/ui/typography.tsx`.
