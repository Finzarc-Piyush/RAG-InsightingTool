/**
 * Wave WI3 · citation hover-cards on regenerated insights.
 *
 * WI3 wires `regen.entry.citations` (the `InsightRegenEntry.citations`
 * array populated by `WI2-server`'s `extractInsightCitations`) into
 * `TileInsightFooter` as a discoverable "Sources:" row of
 * `CitationHoverCard` chips. The inline backtick-wrapped pack-id
 * citations inside the regen prose already render as `[N]` superscript
 * hover-cards transitively through `MarkdownRenderer`'s WQ3 integration
 * — that path needs no new code. WI3's primary contribution is making
 * the citations *array* visible as a separate, scannable list so users
 * who don't notice the inline markings can still discover the cited
 * packs at a glance.
 *
 * Tests are source-inspection — the component renders Radix HoverCards
 * which require a DOM, but the load-bearing decisions (gate, mapping,
 * key, index, label) all live in the source text.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const footerSrc = readFileSync(repoFile("./TileInsightFooter.tsx"), "utf-8");

describe("WI3 · TileInsightFooter sources footer (citations array)", () => {
  it("imports CitationHoverCard from @/components/CitationHoverCard", () => {
    assert.match(
      footerSrc,
      /import \{ CitationHoverCard \} from "@\/components\/CitationHoverCard"/,
    );
  });

  it("renders the Sources row only when citations is non-empty (truthy + length > 0 guard)", () => {
    // The `&&` chain handles both undefined / null and empty arrays —
    // the array is optional on `InsightRegenEntry`, and the server may
    // return an empty array when the regen text has no backtick tokens.
    assert.match(
      footerSrc,
      /regen\?\.entry\?\.citations && regen\.entry\.citations\.length > 0 \?/,
    );
  });

  it("renders the literal 'Sources:' label inside the citations row", () => {
    assert.match(footerSrc, /<span>Sources:<\/span>/);
  });

  it("maps each citation packId to a CitationHoverCard with key=packId and 1-based index", () => {
    // 1-based index matches `CitationHoverCard`'s `[N]` superscript
    // convention. Keying by `packId` is fine because the citations
    // array is expected to be already deduped by the server-side
    // `extractInsightCitations`.
    assert.match(
      footerSrc,
      /regen\.entry\.citations\.map\(\(packId, i\) => \(\s*<CitationHoverCard key=\{packId\} packId=\{packId\} index=\{i \+ 1\} \/>\s*\)\)/,
    );
  });

  it("places the citations row AFTER the metadata line + BEFORE the Re-explain button", () => {
    // Visual order matters — the user reads the prose, then the
    // "Updated N min ago · confidence" metadata, then the sources,
    // then the action button. Pin the structural ordering by index.
    const metadataIdx = footerSrc.indexOf("Updated {formatRelativeShort");
    const sourcesIdx = footerSrc.indexOf("<span>Sources:</span>");
    const buttonIdx = footerSrc.indexOf('aria-label="Re-explain this view"');
    assert.ok(metadataIdx >= 0, "metadata line should be present");
    assert.ok(sourcesIdx >= 0, "sources row should be present");
    assert.ok(buttonIdx >= 0, "regenerate button should be present");
    assert.ok(
      metadataIdx < sourcesIdx,
      "sources row should render after the metadata line",
    );
    assert.ok(
      sourcesIdx < buttonIdx,
      "sources row should render before the regenerate button",
    );
  });

  it("uses a flex-wrap container so long citation lists wrap to multiple lines", () => {
    // A non-wrapping inline row would overflow the narrow tile footer
    // when the LLM cites four or more packs. flex-wrap preserves the
    // "small superscript pill" visual without truncation.
    assert.match(footerSrc, /className="mt-1 flex flex-wrap items-center gap-1 text-\[11px\] text-muted-foreground"/);
  });

  it("does NOT render the Sources row when regen is absent (no `regen` prop)", () => {
    // The outer `regen ? (...) : null` guard on the button block uses
    // `regen?.entry?.citations` for the inner check — both null `regen`
    // and missing citations short-circuit to no render.
    assert.match(footerSrc, /regen\?\.entry\?\.citations/);
  });

  it("documents that inline citation rendering still flows through MarkdownRenderer (no double work)", () => {
    // The comment is load-bearing for future Claude — without it,
    // someone could try to "wire" hover-cards inside the prose,
    // duplicating what MarkdownRenderer's WQ3 integration already does.
    assert.match(
      footerSrc,
      /inline backtick-wrapped pack ids[\s\S]*?MarkdownRenderer[\s\S]*?WQ3/i,
    );
  });
});
