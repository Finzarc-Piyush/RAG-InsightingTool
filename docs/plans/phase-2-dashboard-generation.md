# Phase 2 — Generate a dashboard from a chat answer

**Status:** 2.A / 2.B / 2.C shipped end-to-end on `claude/add-claude-documentation-PaA9h`. **Feature flag:** `DASHBOARD_AUTOGEN_ENABLED` (default off until rollout).

## Progress

| PR | Status | Summary |
|----|--------|---------|
| 2.A | ✅ shipped | `DashboardSpec` + `dashboardSpecSchema` (mirrored), `createDashboardFromSpec` model, `POST /api/dashboards/from-spec` endpoint, client `dashboardsApi.createFromSpec`. |
| 2.B | ✅ shipped | `AnalysisBrief.requestsDashboard` + prompt, `buildDashboard` module (`shouldBuildDashboard` guard + `buildDashboardFromTurn` LLM call), agent-loop dispatch + `dashboard_draft` SSE, threaded through `AgentLoopResult → dataAnalyzer → Message`. |
| 2.C | ✅ shipped | Deterministic grid-layout templates (`executive` / `deep_dive` / `monitoring`) via `dashboardTemplates.ts`; client `DashboardDraftCard` renders inline with "Create dashboard" CTA that POSTs `/from-spec` and navigates. |
| 2.D | ⏳ | Rollout gating (staging 10% → 100%). |
| 2.E | ⏳ stretch | `patch_dashboard` tool for follow-up edits. |

## Context

Users ask the chat "build me a dashboard for this analysis" and expect a
multi-chart, multi-section dashboard with narrative, not just a list of
saved charts. Today only manual promotion exists via the chat →
Dashboard "Save to Dashboard" action and the existing
`POST /dashboards/from-analysis` (`createReportDashboardFromAnalysis` in
`server/models/dashboard.model.ts`). The server-side persistence layer is
90% ready; what's missing is the *agent* emitting a structured
`DashboardSpec` and a client preview-and-commit flow.

## Lessons applied from how Claude produces artifacts

1. **Draft → preview → user edits → commit.** Never persist a generated
   artifact silently. The user sees the proposal inline, can swap charts,
   rename sections, adjust layout, then confirms.
2. **One-shot spec, not a sequence of mutations.** The agent returns a
   full `DashboardSpec`; client persists atomically.
3. **Narrative with evidence refs.** Every insight in the dashboard
   points at the chart that supports it (`_agentEvidenceRef`, already a
   field on charts in this repo).
4. **Templates are starting points, not ceilings.** Provide three named
   layout templates (Executive, Deep-dive, Monitoring) and let the user
   switch between them post-draft.

## Sub-problems

- **P2.1 — Chat trigger detection.** Recognize "build me a dashboard",
  "turn this into a dashboard", etc., route to the new skill.
- **P2.2 — Dashboard skill.** Compose a full `DashboardSpec` from the
  turn's charts + insights + analysis brief.
- **P2.3 — Layout templates.** Three templates (Executive 3-chart,
  Deep-dive 6-chart, Monitoring KPI-strip).
- **P2.4 — Preview surface.** Inline the proposed dashboard in chat as a
  non-persistent artifact with "Edit" and "Create" CTAs.
- **P2.5 — Atomic commit.** Client POSTs the spec; server persists in one
  Cosmos write; returns `dashboardId`; chat adds a "Open dashboard" CTA.
- **P2.6 — Post-create refinement loop.** User says "add a chart for
  margin by region" → agent patches the existing dashboard via a new
  `patch_dashboard` tool. (Stretch — not required for v1.)

## Solution design

### Data contract — `DashboardSpec`

Added to `server/shared/schema.ts` and mirrored in
`client/src/shared/schema.ts` (schema drift gate will verify parity):

```ts
type DashboardSpec = {
  name: string;                                // pre-filled from question
  template: 'executive' | 'deep_dive' | 'monitoring';
  sheets: DashboardSheetSpec[];
  defaultSheetId: string;
};

type DashboardSheetSpec = {
  id: string;
  name: string;
  narrativeBlocks?: NarrativeBlock[];          // exec summary, limitations, etc.
  tiles: DashboardTileSpec[];
  gridLayout?: { lg?: Layout[]; md?: Layout[]; sm?: Layout[] };  // optional hint
};

type DashboardTileSpec =
  | { kind: 'chart'; chart: ChartSpec; evidenceRef?: string }
  | { kind: 'metric'; label: string; value: string | number; delta?: { value: number; label: string } }
  | { kind: 'narrative'; role: 'summary' | 'limitations' | 'recommendations' | 'section'; body: string };
```

### P2.1 — Chat trigger detection

Extend `analysisIntent` parser from Phase 1 with a `requestsDashboard`
boolean. If true, after the analytical skill finishes, the
`build_dashboard` skill runs instead of (or in addition to) standard
synthesis.

### P2.2 — Dashboard skill

New `server/lib/agents/runtime/skills/buildDashboard.ts`. Inputs:

- `ctx.analysisIntent`
- final answer body + insights from synthesis
- all `mergedCharts` + `deferredPlanCharts` materialised this turn
- `analysisBrief` if present

One LLM call with `completeJson(dashboardSpecSchema)` to:
- Title the dashboard from the question.
- Pick the right template (executive for high-level, deep_dive for
  diagnostic, monitoring for KPI questions).
- Allocate charts across sheets with narrative wrappers.
- Fill `narrativeBlocks.summary` from the answer body.

Returns `DashboardSpec`; emitted via SSE `dashboard_draft` event.

### P2.3 — Layout templates

Small pure module `server/lib/agents/runtime/skills/dashboardTemplates.ts`
with three template generators. Each accepts `(charts, narrative)` and
returns a pre-wired `gridLayout` for the Evidence sheet so the client
doesn't have to compute positions.

- **Executive (3 charts)**: 1 hero chart (w=12,h=6) + 2 support
  (w=6,h=5 each). KPI strip above.
- **Deep-dive (6 charts)**: 2×3 grid (w=6,h=5). Narrative column
  embedded between rows 1 and 2.
- **Monitoring (KPI-heavy)**: KPI strip (4×w=3,h=3) + single chart
  below (w=12,h=6).

### P2.4 — Preview surface

Client adds a new message kind: `dashboard_draft`. Renders inline in
chat as a compact card with:
- Thumbnail grid of proposed sheets.
- Template picker dropdown (switches template, calls a cheap client-only
  re-layout).
- "Edit" button → opens the live dashboard grid in a modal with the
  draft layout preloaded (reuses the fixed swap-UX grid from the
  dashboard-ux-collision-fix plan).
- "Create" button → commits.

Nothing is persisted to Cosmos until Create is clicked.

### P2.5 — Atomic commit

Add `POST /api/dashboards/from-spec`:
- Body: `DashboardSpec`.
- Server validates with `dashboardSpecSchema` (Zod).
- Calls a new `createDashboardFromSpec(spec, username)` in
  `server/models/dashboard.model.ts` that reuses the existing
  `createReportDashboardFromAnalysis` plumbing but accepts the
  pre-shaped sheets.
- Returns `{ dashboardId, dashboardUrl }`.

Client updates the chat message in place: replace the draft card with a
"Dashboard created" chip linking to `/dashboard?open=<id>`.

### P2.6 — Patch loop (stretch)

Later: `patch_dashboard` tool that takes `(dashboardId, patch)` with
`patch` = `{ addCharts?: [...], removeTileIds?: [...], renameSheet?: … }`.
Not required for v1.

## File-level changes

New:
- `server/lib/agents/runtime/skills/buildDashboard.ts`
- `server/lib/agents/runtime/skills/dashboardTemplates.ts`
- `server/routes/dashboards.ts` — new handler `POST /dashboards/from-spec`.
- `server/models/dashboard.model.ts` — `createDashboardFromSpec()`.
- `client/src/pages/Home/Components/DashboardDraftCard.tsx`.
- `client/src/pages/Home/Components/DashboardDraftEditor.tsx`
  (modal reuses the fixed grid).
- `server/tests/buildDashboardSkill.test.ts`.

Modified:
- `server/lib/agents/runtime/analysisIntent.ts` — add `requestsDashboard`.
- `server/lib/agents/runtime/agentLoop.service.ts` — dispatch to the
  skill when flag + flag on intent; emit SSE.
- `server/shared/schema.ts` + `client/src/shared/schema.ts` — add
  `DashboardSpec` types.
- `client/src/shared/schema.ts` — same additions to keep the drift gate
  green.
- `client/src/pages/Home/Components/MessageBubble.tsx` — render
  `DashboardDraftCard`.
- `client/src/lib/api/dashboards.ts` — `createDashboardFromSpec` call.

## Rollout

1. **Phase 2.A** — ship `DashboardSpec` types and the `/from-spec`
   endpoint behind auth; no chat trigger yet.
2. **Phase 2.B** — chat trigger + skill + preview card; flag on in
   staging only.
3. **Phase 2.C** — three templates + live editor modal.
4. **Phase 2.D** — ship flag on for 10% of sessions, then 100%.
5. **Phase 2.E** (stretch) — `patch_dashboard` tool for follow-ups.

Each phase is a separate PR. Phase 2 begins only after Phase 1's rich
answer envelope (PR 1.G) lands — the dashboard skill reuses the
magnitudes and hypothesis table as narrative inputs.

## Dependencies on other plans

- **Dashboard UX fix** (`dashboard-ux-collision-fix.md`) — the preview
  modal reuses the fixed grid. Ship UX fix first.
- **Phase 1 rich envelope** (`phase-1-deep-analysis.md` § Layer 7) — the
  skill uses structured answer fields as narrative inputs.

## Verification

- **Unit tests** for each template generator: golden grid output for 3
  and 6 chart inputs.
- **Integration smoke**: synthetic turn with 4 charts + a 200-word
  answer → `build_dashboard` skill → valid spec → `/from-spec` persists
  → GET returns the same sheets back.
- **Manual**: three question shapes — "build me a dashboard for Q3
  sales", "turn this analysis into a dashboard", "make a monitoring
  view for margin by region". Each produces the right template.
- **Security**: `/from-spec` validates user owns any referenced
  session; Zod rejects unknown fields.
- **Perf**: spec emission + persistence completes under 2s for 8
  charts.

## Open questions

- Should the agent auto-create, or always require user "Create" click?
  Start with click (safer); revisit after usage data.
- Narrative block word limits per template? Start 120 words (Executive),
  200 (Deep-dive), 80 (Monitoring).
- If the turn produced zero charts, does the skill still run? No —
  short-circuit with a chat message "I'd need a few charts first; try
  asking me to analyse X."
