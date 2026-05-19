/**
 * Wave WD3-wiring-rest-rect · source-inspection tests for the heatmap
 * cell drill-through wiring.
 *
 * RectRenderer cells sit at the intersection of TWO categorical dims
 * (rowCh × colCh). The current single-`column: string` event field
 * doesn't accommodate a row × col drill target out-of-the-box. Two
 * options were on the table:
 *   (1) Widen `DrillThroughEvent.column` to `string | { row, col }` —
 *       cleaner type but touches every existing consumer.
 *   (2) Fire two events with the receiver de-duping — simpler
 *       foundation, more complex (and timing-fragile) receiver.
 *
 * This wave ships a THIRD option: additive optional `extraPins?:
 * DrillThroughPin[]` on the foundation. The primary `column` / `value`
 * carries the row dim; `extraPins[0]` carries the col dim. Other
 * renderers (single-pin) omit `extraPins` → fully backwards-compat (no
 * existing event payload changes; no existing test churns; the field
 * is optional). Server endpoint applies primary + extras as
 * AND-intersection WHERE clauses BEFORE returning rows.
 *
 * Tests pin: foundation widening (DrillThroughPin interface +
 * DrillThroughEvent.extraPins optional field); RectRenderer's modifier
 * branch shape (ONE drill event with row primary + col in extraPins,
 * BEFORE the two cross-filter dispatches); 5-field payload + extraPins
 * with 1 entry; row + col values passed RAW (no toFilterValue); the
 * `return;` after dispatch (single-intent); WD2 two-event cross-filter
 * dispatch preserved; sheet renders Additional pins section iterating
 * extraPins; sheet single-pin events render unchanged; column-symmetry
 * across drill row + cross-filter row dispatches; drill dispatch count
 * = 1 per click (one cell click → one drill event, not two).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const rectSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/RectRenderer.tsx"),
  "utf-8",
);
const drillThroughSrc = readFileSync(
  repoFile("./drillThrough.ts"),
  "utf-8",
);
const sheetSrc = readFileSync(
  repoFile("../Components/DrillThroughSheet.tsx"),
  "utf-8",
);

// ── Foundation widening: DrillThroughPin + extraPins ───────────────

describe("WD3-wiring-rest-rect · drillThrough foundation gains DrillThroughPin + extraPins", () => {
  it("exports a DrillThroughPin interface with column: string + value: unknown", () => {
    // The new shape MUST be exported so RectRenderer + the sheet +
    // the future server module can all consume the same type.
    assert.match(
      drillThroughSrc,
      /export interface DrillThroughPin \{[\s\S]*?column: string;[\s\S]*?value: unknown;[\s\S]*?\}/,
    );
  });

  it("DrillThroughEvent gains an optional `extraPins?: DrillThroughPin[]` field", () => {
    // The field MUST be optional (existing single-pin renderers don't
    // set it). The position in the interface body is after `value`
    // and before `sourceTileId` so the primary pin's three flat
    // fields (chartId, column, value) stay grouped at the top.
    assert.match(
      drillThroughSrc,
      /export interface DrillThroughEvent \{[\s\S]*?value: unknown;[\s\S]*?extraPins\?: DrillThroughPin\[\];[\s\S]*?sourceTileId\?: string;[\s\S]*?\}/,
    );
  });

  it("primary `column: string` + `value: unknown` fields are preserved (no breaking widening)", () => {
    // Pin the flat primary-pin shape so existing single-pin renderers
    // don't have to change. A breaking widening to a union type would
    // force every existing consumer to narrow.
    assert.match(drillThroughSrc, /^\s*\/\*\* Primary pin's column[\s\S]*?column: string;/m);
    assert.match(drillThroughSrc, /^\s*\/\*\* Primary pin's value[\s\S]*?value: unknown;/m);
  });
});

// ── RectRenderer imports + handler signature ───────────────────────

describe("WD3-wiring-rest-rect · RectRenderer imports the drillThrough helpers", () => {
  it("named-imports isModifierClick + dispatchDrillThrough from @/pages/Dashboard/lib/drillThrough", () => {
    assert.match(
      rectSrc,
      /import \{\s*dispatchDrillThrough,\s*isModifierClick,?\s*\} from "@\/pages\/Dashboard\/lib\/drillThrough";/,
    );
  });

  it("keeps the WD2 crossFilter imports untouched (additive change)", () => {
    assert.match(
      rectSrc,
      /import \{\s*dispatchCrossFilter,\s*isCrossFilterActive,\s*toFilterValue,?\s*\} from "@\/pages\/Dashboard\/lib\/crossFilter";/,
    );
  });
});

describe("WD3-wiring-rest-rect · RectRenderer onClick widens to receive a MouseEvent", () => {
  it("the onClick handler now accepts `(event: React.MouseEvent<SVGRectElement>) => void`", () => {
    // Widened from parameterless `() => {...}` so isModifierClick can
    // read metaKey / ctrlKey. SVGRectElement specifically (not
    // SVGElement) because the cell IS a <rect>.
    assert.match(
      rectSrc,
      /onClick=\{[\s\S]*?\(event: React\.MouseEvent<SVGRectElement>\) => \{/,
    );
  });

  it("the existing `dashboardTile ? handler : undefined` conditional shape is preserved", () => {
    // Outside a dashboard tile (chat / explorer / share preview) the
    // click stays a no-op — same invariant as the WD2 wiring. The
    // ternary keeps both the affordance (style cursor:pointer) and
    // the handler aligned on the same gate.
    assert.match(
      rectSrc,
      /onClick=\{\s*dashboardTile\s*\?[\s\S]*?: undefined\s*\}/,
    );
  });
});

// ── RectRenderer modifier branch + payload ─────────────────────────

describe("WD3-wiring-rest-rect · onClick gains the inline modifier-key branch", () => {
  it("the modifier branch fires INSIDE the onClick body, BEFORE the two cross-filter dispatches", () => {
    // Pin the structural ordering: isModifierClick branch + return
    // come FIRST; the two-event WD2 cross-filter dispatches follow. A
    // refactor that reverses the order would triple-fire on cmd-click
    // (one drill + two cross-filter).
    assert.match(
      rectSrc,
      /\(event: React\.MouseEvent<SVGRectElement>\) => \{[\s\S]*?if \(isModifierClick\(event\)\) \{[\s\S]*?dispatchDrillThrough\(\{[\s\S]*?\}\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?dispatchCrossFilter\(\{[\s\S]*?column: rowCh\.field,[\s\S]*?\}\);[\s\S]*?dispatchCrossFilter\(\{[\s\S]*?column: colCh\.field,[\s\S]*?\}\);/,
    );
  });

  it("dispatchDrillThrough payload carries chartId / row primary / extraPins[0]=col / sourceTileId / filters", () => {
    // Pin the full 6-field payload (chartId + column + value +
    // extraPins + sourceTileId + filters). Row is primary because
    // RectRenderer's WD2 dispatch order is row-first (see the
    // existing two-cross-filter call ordering); keeping the same
    // order across both concerns means a future "I clicked a heatmap
    // cell" mental model stays consistent.
    assert.match(
      rectSrc,
      /dispatchDrillThrough\(\{\s*chartId: dashboardTile\.tileId,\s*column: rowCh\.field,\s*value: rowRawByKey\.get\(row\),\s*extraPins: \[\s*\{\s*column: colCh\.field,\s*value: colRawByKey\.get\(col\),?\s*\},?\s*\],\s*sourceTileId: dashboardTile\.tileId,\s*filters: dashboardFilters,?\s*\}\);/,
    );
  });

  it("BOTH row AND col values passed RAW — NOT toFilterValue-coerced", () => {
    // Negative pin against `toFilterValue(` inside the drill block.
    // Server-side canonicaliser handles per-column comparison.
    const drillBlock = rectSrc.match(/dispatchDrillThrough\(\{[\s\S]*?\}\);/)?.[0];
    assert.ok(drillBlock, "RectRenderer must contain a dispatchDrillThrough block");
    assert.doesNotMatch(drillBlock, /toFilterValue\(/);
  });

  it("the `return;` after dispatch is present — single-intent enforcement", () => {
    // Without the return, a cmd-click on a heatmap cell would dispatch
    // drill PLUS two cross-filters — a triple-intent disaster.
    assert.match(
      rectSrc,
      /dispatchDrillThrough\(\{[\s\S]*?\}\);\s*return;/,
    );
  });
});

// ── RectRenderer regression: WD2 two-event cross-filter preserved ──

describe("WD3-wiring-rest-rect · WD2 two-event cross-filter dispatch is preserved", () => {
  it("plain-click still dispatches row first with toFilterValue-coerced rowRaw", () => {
    assert.match(
      rectSrc,
      /dispatchCrossFilter\(\{\s*column: rowCh\.field,\s*value: toFilterValue\(rowRawByKey\.get\(row\)\),\s*sourceTileId: dashboardTile\.tileId,?\s*\}\);/,
    );
  });

  it("plain-click then dispatches col with toFilterValue-coerced colRaw (row-first order)", () => {
    // Pin BOTH dispatches survive AND that row precedes col by
    // string-index. A refactor that reorders would lose the
    // "primary = row" mental model and confuse the WD2-dim per-cell
    // OR-of-row-OR-col contract.
    assert.match(
      rectSrc,
      /dispatchCrossFilter\(\{\s*column: colCh\.field,\s*value: toFilterValue\(colRawByKey\.get\(col\)\),\s*sourceTileId: dashboardTile\.tileId,?\s*\}\);/,
    );
    const rowIdx = rectSrc.search(
      /dispatchCrossFilter\(\{\s*column: rowCh\.field,/,
    );
    const colIdx = rectSrc.search(
      /dispatchCrossFilter\(\{\s*column: colCh\.field,/,
    );
    assert.ok(rowIdx > 0 && colIdx > 0, "both cross-filter dispatches must exist");
    assert.ok(
      rowIdx < colIdx,
      "row dispatch must precede col dispatch in source order",
    );
  });
});

// ── DrillThroughSheet: Additional pins section renders extraPins ───

describe("WD3-wiring-rest-rect · DrillThroughSheet renders extraPins as an Additional pins section", () => {
  it("imports React.Fragment so the per-pin <dt>/<dd> pair can carry a key", () => {
    // The pin loop generates <dt>/<dd> pairs that need stable keys.
    // <> shorthand doesn't accept a key, so Fragment is the right
    // primitive. A drift to `<div>` wrappers would break the <dl>
    // grid layout.
    assert.match(sheetSrc, /import \{ Fragment \} from "react";/);
  });

  it("renders the Additional pins section gated on event.extraPins length > 0", () => {
    // Truthiness AND length > 0 — a future caller that passes
    // `extraPins: []` (empty list) should NOT render an empty
    // section. Mirrors the filterLines.length > 0 gate just below.
    assert.match(
      sheetSrc,
      /event\.extraPins && event\.extraPins\.length > 0 \?[\s\S]*?Additional pins/,
    );
  });

  it("iterates extraPins via .map with pin.column as the key", () => {
    // Pin the iteration shape so a refactor to .forEach or a
    // for-loop is intentional. `key={pin.column}` because column
    // names are stable + unique across the pins (no two pins on the
    // same column makes sense semantically).
    assert.match(
      sheetSrc,
      /event\.extraPins\.map\(\(pin\) => \(\s*<Fragment key=\{pin\.column\}>/,
    );
  });

  it("renders pin.column as the dt label + pin.value as the dd via toFilterValue", () => {
    // Per-pin <dt> = column name (font-mono since it's a field
    // identifier); <dd> = canonicalised value. Same toFilterValue
    // call as the primary pin's value row so the display is
    // visually consistent.
    assert.match(
      sheetSrc,
      /<dt className="font-mono text-muted-foreground">\s*\{pin\.column\}\s*<\/dt>\s*<dd className="font-mono text-foreground">\s*\{toFilterValue\(pin\.value\)\}\s*<\/dd>/,
    );
  });

  it("renders a one-line explanation that the server intersects pins as an AND-filter", () => {
    // The semantic of multiple pins isn't obvious. The placeholder
    // text explicitly names AND-intersection so a user looking at
    // the sheet for the first time doesn't think it's OR.
    assert.match(sheetSrc, /AND-filter/);
  });
});

describe("WD3-wiring-rest-rect · single-pin events render unchanged (backwards-compat)", () => {
  it("the primary Pinned slice section still reads event.chartId / event.column / event.value", () => {
    // The static Column / Value rows for the primary pin are
    // unchanged so the existing WD3-sheet tests stay green.
    assert.match(sheetSrc, /<dt className="text-muted-foreground">Chart<\/dt>/);
    assert.match(sheetSrc, /<dt className="text-muted-foreground">Column<\/dt>/);
    assert.match(sheetSrc, /<dt className="text-muted-foreground">Value<\/dt>/);
  });

  it("the Additional pins section conditional short-circuits to null when extraPins is undefined", () => {
    // Pin the `: null` else-branch so a future refactor doesn't
    // accidentally render an empty section for single-pin events.
    assert.match(sheetSrc, /event\.extraPins && event\.extraPins\.length > 0 \?[\s\S]*?\) : null/);
  });
});

// ── Cross-cutting contracts ─────────────────────────────────────────

describe("WD3-wiring-rest-rect · cross-cutting contracts", () => {
  it("RectRenderer carries the WD3-wiring-rest-rect marker", () => {
    assert.match(rectSrc, /WD3-wiring-rest-rect/);
  });

  it("drill row column matches the WD2 row cross-filter column (rowCh.field) — column-symmetry", () => {
    // Primary pin column = row dim; one of the WD2 cross-filter
    // dispatches also keys on rowCh.field. Drift would produce a
    // "drill on a row column you can't filter on" UX mismatch.
    assert.match(
      rectSrc,
      /dispatchDrillThrough\(\{[\s\S]*?column: rowCh\.field,/,
    );
    assert.match(
      rectSrc,
      /dispatchCrossFilter\(\{\s*column: rowCh\.field,/,
    );
  });

  it("drill col extraPin column matches the WD2 col cross-filter column (colCh.field) — column-symmetry", () => {
    // extraPins[0] column = col dim; the OTHER WD2 cross-filter
    // dispatch keys on colCh.field. Three-way symmetry holds: drill
    // primary = row; drill extras = col; cross-filter dispatches
    // both; dim concern checks both.
    const drillBlock = rectSrc.match(/dispatchDrillThrough\(\{[\s\S]*?\}\);/)?.[0];
    assert.ok(drillBlock, "drill block must exist");
    assert.match(drillBlock, /column: colCh\.field,/);
    assert.match(
      rectSrc,
      /dispatchCrossFilter\(\{\s*column: colCh\.field,/,
    );
  });

  it("drill dispatch count is exactly 1 (one cell click → one drill event, NOT two)", () => {
    // The design choice for this wave: rather than fire two events
    // and dedupe in the receiver, fire ONE event carrying both pins.
    // Pin the count so a refactor that switches to two events is
    // intentional.
    const drillCount = (rectSrc.match(/dispatchDrillThrough\(/g) ?? []).length;
    assert.equal(
      drillCount,
      1,
      `RectRenderer expected 1 drill dispatch, found ${drillCount}`,
    );
  });

  it("cross-filter dispatch count stays at 2 (row + col, unchanged from WD2)", () => {
    // Regression-pin: the WD2 two-event dispatch path is preserved
    // exactly. A refactor that collapsed to one event would break
    // the WD2 toggle contract.
    const crossFilterCount = (rectSrc.match(/dispatchCrossFilter\(/g) ?? []).length;
    assert.equal(
      crossFilterCount,
      2,
      `RectRenderer expected 2 cross-filter dispatches (row + col), found ${crossFilterCount}`,
    );
  });
});
