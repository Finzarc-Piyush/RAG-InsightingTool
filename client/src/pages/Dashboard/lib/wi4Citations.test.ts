/**
 * Wave WI4-citations · source-inspection pins for the Sources row on
 * the ExplainSlicePanel.
 *
 * The WI3 footer wave shipped citation chips on TileInsightFooter as
 * a `Sources:` row of CitationHoverCard chips. The WI4 panel mirrors
 * the same pattern over `regen.entry.citations`. The inline backtick-
 * wrapped pack ids inside the regen prose continue to render as `[N]`
 * superscript hover-cards via MarkdownRenderer's WQ3 integration —
 * this row is the discoverable, scan-at-a-glance surface for the full
 * citation list.
 *
 * The row slots between the regen prose and the Re-explain button so
 * the three regen affordances stack in source order: read → sources
 * → refresh. Mirrors the WI3 footer's layout (regen prose →
 * metadata line → Sources row → Re-explain button).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const panelSrc = readFileSync(
  repoFile("../Components/ExplainSlicePanel.tsx"),
  "utf-8",
);

describe("WI4-citations · ExplainSlicePanel imports for the Sources row", () => {
  it("imports CitationHoverCard from the canonical components path", () => {
    assert.match(
      panelSrc,
      /import \{ CitationHoverCard \} from "@\/components\/CitationHoverCard";/,
    );
  });
});

describe("WI4-citations · Sources row render shape", () => {
  it("gates on regen.entry?.citations existing AND length > 0", () => {
    // Two-part gate: the `?.` short-circuits on undefined entry /
    // undefined citations; the length check filters out the empty-
    // array case (the row should not render with just "Sources:"
    // and no chips).
    assert.match(
      panelSrc,
      /\{regen\.entry\?\.citations && regen\.entry\.citations\.length > 0 \? \(/,
    );
  });

  it("uses the WI3 footer's row styling (mt-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground)", () => {
    // Byte-for-byte parity with TileInsightFooter's WI3 row so the two
    // regen surfaces stay structurally parallel — a future styling
    // tweak should land in both files together.
    assert.match(
      panelSrc,
      /<div className="mt-2 flex flex-wrap items-center gap-1 text-\[11px\] text-muted-foreground">/,
    );
  });

  it("emits a literal `Sources:` label as the first child of the row", () => {
    assert.match(panelSrc, /<span>Sources:<\/span>/);
  });

  it("maps citations to CitationHoverCard chips keyed by packId, indexed from 1", () => {
    // The index prop is 1-based to match the inline [N] superscript
    // numbering convention WQ3 established; the key is the packId
    // itself because pack ids are unique within a citations array.
    assert.match(
      panelSrc,
      /\{regen\.entry\.citations\.map\(\(packId, i\) => \(\s*<CitationHoverCard key=\{packId\} packId=\{packId\} index=\{i \+ 1\} \/>\s*\)\)\}/,
    );
  });

  it("Wave WI4-citations marker present in the panel comment block", () => {
    assert.match(panelSrc, /Wave WI4-citations/);
  });
});

describe("WI4-citations · structural composition with the WI4-wire + WI4-rexplain surfaces", () => {
  it("Sources row sits between the prose render and the Re-explain button (source order: prose → sources → refresh)", () => {
    // Three landmarks must appear in this order:
    //   1. "Waiting for the first regeneration…" (end of the prose branch)
    //   2. <span>Sources:</span>                 (start of citation row)
    //   3. aria-label="Re-explain this slice"    (start of WI4-rexplain button block)
    // The ordering pin catches a future drift to "sources above the
    // prose" (would obscure the prose) or "sources below the button"
    // (would break the read → sources → refresh reading order).
    const proseEnd = panelSrc.indexOf("Waiting for the first regeneration…");
    const sourcesRow = panelSrc.indexOf("<span>Sources:</span>");
    const rexplainButton = panelSrc.indexOf('aria-label="Re-explain this slice"');
    assert.ok(proseEnd > 0, "prose-end landmark must be present");
    assert.ok(
      sourcesRow > proseEnd,
      "Sources row must appear AFTER the prose render branch",
    );
    assert.ok(
      rexplainButton > sourcesRow,
      "Re-explain button must appear AFTER the Sources row",
    );
  });

  it("Sources row lives inside the `Regenerated insight` section (not its own section)", () => {
    // The WI4 panel has three top-level <section> blocks: Pinned slice,
    // Filter context, Regenerated insight. The Sources row is a child
    // of the third — citations are an attribute of the regen output,
    // not a separate pin metadata concern. Use the unique <h3> header
    // landmark (the SheetDescription string at the top of the file
    // also contains "Regenerated insight" but isn't the section
    // header — match the literal header by its surrounding tags).
    const insightHeader = panelSrc.indexOf(
      "                Regenerated insight\n",
    );
    const sourcesRow = panelSrc.indexOf("<span>Sources:</span>", insightHeader);
    assert.ok(
      insightHeader > 0,
      "Regenerated insight <h3> header landmark must be present",
    );
    assert.ok(sourcesRow > insightHeader);
    const interveningClose = panelSrc
      .slice(insightHeader, sourcesRow)
      .indexOf("</section>");
    assert.equal(
      interveningClose,
      -1,
      "Sources row must NOT live in its own <section> — keep it inside Regenerated insight",
    );
  });
});
