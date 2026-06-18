# Convention: the v1 Recharts renderer is FROZEN (convergence interim contract)

**Status:** Active for the v1→v2 chart convergence (Waves V0…V20). The full convergence plan lives
in the Claude plans directory (chart-v1-v2-convergence); see ADR
[`centralized-chart-sort`](../decisions/centralized-chart-sort.md) for the surrounding context.

## Rule

While the chart subsystem converges onto v2 (visx / `PremiumChart`), the **v1 Recharts stack is
frozen**. Do NOT add new chart features, marks, or interactions to:

- `client/src/pages/Home/Components/ChartRenderer.tsx` (the legacy Recharts renderer)
- `client/src/pages/Home/Components/ChartModal.tsx`
- `client/src/pages/Dashboard/Components/ChartOnlyModal.tsx`
- the v1-only export path that mirrors them (`server/lib/exports/chartSsr.ts`,
  `server/lib/exports/pptx/chartSpecToAddChart.ts`) — additively, only the v2 adapter waves touch these

**Allowed on v1:** correctness/security bugfixes, and the mechanical changes a convergence wave makes
to *route through* v2 (e.g. swapping a render call to `ChartShim`/`PremiumChart`).

**New capability goes to v2 only** — a new mark, layer, interaction, or encoding lands in
`client/src/lib/charts/visxRenderers/*` (or the v2 schema / `dataEngine` / `encodingResolver`), never
as a fresh Recharts code path. Anything a v1 surface still does that v2 doesn't is a **feature to
port** (the convergence plan's Phase 3), not a reason to extend v1.

## Why

The whole point of the convergence is to retire the duplicate rendering stack. Every new feature
added to v1 during the migration is a feature that must then be *re-ported* to v2 before v1 can be
deleted — it actively lengthens the endgame and re-grows the "do-it-twice tax" the migration exists
to remove.

## Enforcement

By code review + this convention (deliberately NOT a brittle source-inspection test — see lesson
L-017: a test that pins file shape breaks on legitimate refactors and only the full suite catches it).
When V20 lands (ChartRenderer + the Recharts modal blocks deleted, `recharts` dependency dropped),
delete this convention.
