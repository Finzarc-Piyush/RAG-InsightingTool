# Convention: host pre-extract at 1,500 LOC

> Introduced in Wave W61-host-extract (2026-05-21). Precedent set by Wave W61-detail-extract (2026-05-20). See `docs/WAVES.md` for both entries.

## Rule

When a React host file (a page-level component, top-level container, or any single `.tsx` that owns multiple sections of UI) crosses 1,500 LOC, the NEXT wave that would touch that host MUST be preceded by a pre-extract refactor that carves out one or more top-level presentational units into sibling files. The pre-extract refactor is its own wave — pure file-move + import-rewire only, no JSX node changes, no prop-semantics changes, no new tests. The refactor is verified by typecheck-baseline-preserved + existing tests passing rather than by new tests.

Exceptions where a host-touching wave can land WITHOUT pre-extract:

- The wave is very small (≤ ~50 LOC delta against the host).
- The wave is a clearly self-contained sibling-component-from-the-start (it ships a new file under `components/`, mounts it from the host, but adds ≤ ~50 LOC to the host's render tree).
- The wave is a pure delete that reduces host LOC.

## Why

A single React host file that owns multiple sections (cards, panels, tabs) accumulates render-tree LOC quickly because each section carries its own header / footer / row components + per-section state slots + per-section handlers. Past ~1,500 LOC the file becomes hard to read top-to-bottom and hard to reason about which section owns which state; each subsequent wave compounds the problem because the natural next wave touches a section that already has its sub-components inlined.

The pre-extract pattern breaks the compounding: carving out top-level presentational units into sibling files leaves the host as a thin shell that owns only (a) the data fetch, (b) the cross-section state, (c) the modal mount points, and (d) the section-card instantiations. Each carved sibling stays under the 1,500-LOC threshold and its own internal complexity is bounded by its single section's responsibility.

The discipline of "pure file-move only, no JSX changes, no prop-semantics changes, no new tests" is load-bearing — entangling refactor with cleanup or behavioural changes inflates risk surface for no benefit. The underlying pure helpers are already pinned by their respective lib-test files; the row + card components are simple wrappers around those helpers plus framework primitives, so a typecheck-baseline-preserved verification is sufficient.

## How to apply

When you're about to start a wave that will touch a React host file:

1. `wc -l <host-file>` to check current size.
2. If > 1,500 LOC AND your wave would add LOC, propose a pre-extract refactor wave first. State the candidate carve points (each section / card / tab that lives inline in the host).
3. Run the pre-extract as a discrete wave with its own `/wave-commit`:
   - File-move each carved unit into a sibling under the host's `components/` directory.
   - If multiple carved units share presentational primitives (badges, editable cells, action buttons), put the primitives in a shared sibling (e.g. `semanticModelCells.tsx`) — don't duplicate them across siblings.
   - Update the host's imports.
   - Replace the moved JSX with `<CarvedComponent … />` instantiations, threading the host's state + callbacks via props keyed by the row / entry identifier (not by closed-over primitives — the inlining of `(next) => callback(name, next)` wrappers should happen INSIDE the carved file).
   - Run typecheck — the baseline error count must be preserved verbatim.
   - Run tests — no regressions.
   - Commit the code wave with subject `Wave W<id>-host-extract · <verb> <Components> from <HostFile> (<beforeLOC> → <afterLOC> LOC) …`.
4. THEN ship the originally-planned wave on top of the carved structure.

When choosing what to carve:

- Top-level sections (cards, tabs, panels) are natural carve points — they have a clear visual boundary and own a coherent slice of state.
- Per-row sub-components (`MetricRow`, `DimensionRow`) carve with their parent card, not separately. The row exists to render one entry within a section; splitting them apart inflates the prop surface for zero readability win.
- Cell-level primitives (badges, editable inputs, icon buttons) shared across multiple sections go in a shared sibling (one cells file per host), not co-located with one consumer.
- Modal components and confirmation dialogs are typically already siblings and don't need carving — the host mounts them at root.

When choosing what to keep on the host:

- Data fetch + the result slot (`useState<Data | null>`) and its `useEffect`.
- Cross-section state (filter chips state shared across all sections, an in-flight mutation flag, an error banner slot).
- Modal mount points and their open-signal state.
- Async handlers that route mutations through the API client (`patchSemanticModel`, `addSemanticModelEntry`, etc.) and update the host's `data` slot on success.
- Loading + error render branches (the `if (loading) return …` / `if (error) return …` guards).
- Page header / footer / breadcrumb scaffolding that doesn't belong to any single section.

## Related

- [Wave W61-host-extract entry](../WAVES.md) — the second instance, carved `MetricsCard` + `DimensionsCard` + `HierarchiesCard` + shared `semanticModelCells` from [`AdminSemanticModelDetail.tsx`](../../client/src/pages/Admin/AdminSemanticModelDetail.tsx) (1,545 → 802 LOC).
- [Wave W61-detail-extract entry](../WAVES.md) — the first instance, carved `SourceFilterChips` + `AuditHistoryCard` from the same host (1,295 → 1,131 LOC).
- [`client/src/pages/Admin/components/`](../../client/src/pages/Admin/components/) — current sibling layout: `SourceFilterChips.tsx`, `AuditHistoryCard.tsx`, `DeleteEntryConfirmation.tsx`, `AddEntryForm.tsx`, `HierarchyEditor.tsx`, `MetricsCard.tsx`, `DimensionsCard.tsx`, `HierarchiesCard.tsx`, `semanticModelCells.tsx`.
