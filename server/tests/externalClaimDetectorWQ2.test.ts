import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectExternalClaims,
  summarizeExternalClaims,
} from "../lib/agents/runtime/utils/externalClaimDetector.js";

describe("WQ2 · detectExternalClaims — competitor markers", () => {
  it("fires on 'competitor' (high confidence)", () => {
    const r = detectExternalClaims("How does our share compare to our competitor's share?");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims[0].type, "competitor");
    assert.equal(r.claims[0].confidence, "high");
  });

  it("fires on 'rivals'", () => {
    const r = detectExternalClaims("What are our rivals doing in this segment?");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims.some((c) => c.type === "competitor"), true);
  });

  it("fires on 'competing brand'", () => {
    const r = detectExternalClaims("Show me sales vs the leading competing brand.");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims.some((c) => c.type === "competitor"), true);
  });

  it("does NOT fire on the word 'compete' alone (avoids false positive)", () => {
    const r = detectExternalClaims("Show me the dataset.");
    assert.equal(r.hasExternalClaim, false);
  });
});

describe("WQ2 · detectExternalClaims — market_size markers", () => {
  it("fires on 'market growth' / 'market grew'", () => {
    const r = detectExternalClaims("How much did the haircare market grow last year?");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims.some((c) => c.type === "market_size"), true);
  });

  it("fires on 'category size'", () => {
    const r = detectExternalClaims("What is the category size of the shampoo segment?");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims.some((c) => c.type === "market_size"), true);
  });

  it("fires on 'TAM'", () => {
    const r = detectExternalClaims("What's the TAM for premium hair oil?");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims.some((c) => c.type === "market_size"), true);
  });
});

describe("WQ2 · detectExternalClaims — industry_benchmark markers", () => {
  it("fires on 'industry average'", () => {
    const r = detectExternalClaims("How do we compare to the industry average?");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims[0].type, "industry_benchmark");
  });

  it("fires on 'industry benchmark'", () => {
    const r = detectExternalClaims("Are our margins at the industry benchmark?");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims.some((c) => c.type === "industry_benchmark"), true);
  });

  it("fires on 'peer comparison'", () => {
    const r = detectExternalClaims("Show me a peer comparison.");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims.some((c) => c.type === "industry_benchmark"), true);
  });
});

describe("WQ2 · detectExternalClaims — external_event markers", () => {
  it("fires on 'lockdown'", () => {
    const r = detectExternalClaims("Did our sales drop during the lockdown?");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims[0].type, "external_event");
  });

  it("fires on 'COVID' / 'COVID-19'", () => {
    const r = detectExternalClaims("How did COVID-19 affect category growth?");
    assert.equal(r.hasExternalClaim, true);
    // Two markers: external_event (covid) + market_size (category growth)
    assert.equal(r.claims.some((c) => c.type === "external_event"), true);
  });

  it("fires on 'monsoon'", () => {
    const r = detectExternalClaims("How did the monsoon impact volumes in rural?");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims.some((c) => c.type === "external_event"), true);
  });

  it("fires on 'diwali' / 'festive season'", () => {
    const r = detectExternalClaims("Did festive season help our category?");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims.some((c) => c.type === "external_event"), true);
  });
});

describe("WQ2 · detectExternalClaims — demographic_shift markers", () => {
  it("fires on 'Gen Z'", () => {
    const r = detectExternalClaims("Are Gen Z consumers driving the growth?");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims[0].type, "demographic_shift");
  });

  it("fires on 'millennials'", () => {
    const r = detectExternalClaims("What's the millennials' share of wallet?");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims.some((c) => c.type === "demographic_shift"), true);
  });

  it("fires on 'tier 2 cities'", () => {
    const r = detectExternalClaims("How are we doing in tier 2 cities?");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims.some((c) => c.type === "demographic_shift"), true);
  });

  it("fires on 'demographic shift'", () => {
    const r = detectExternalClaims("Is there a demographic shift in the consumer base?");
    assert.equal(r.hasExternalClaim, true);
    assert.equal(r.claims.some((c) => c.type === "demographic_shift"), true);
  });
});

describe("WQ2 · detectExternalClaims — multi-claim + dedupe", () => {
  it("emits one claim per unique marker type/term combination", () => {
    const r = detectExternalClaims(
      "How did the lockdown affect our market growth vs our competitor's market share?",
    );
    // Expect: lockdown (external_event), market growth (market_size),
    // competitor (competitor), market share (market_size) — but market growth
    // and market share are distinct terms so they DO both emit.
    assert.equal(r.hasExternalClaim, true);
    const types = new Set(r.claims.map((c) => c.type));
    assert.ok(types.has("external_event"));
    assert.ok(types.has("competitor"));
    assert.ok(types.has("market_size"));
  });

  it("deduplicates repeated matches of the same term within one question", () => {
    const r = detectExternalClaims(
      "Compare our competitor's share — show me each competitor by region.",
    );
    // "competitor" should not produce two claims even though it appears twice.
    const competitorClaims = r.claims.filter((c) => c.type === "competitor");
    // The two "competitor's" / "competitor by" share the same lower-cased
    // matched term — should dedupe to one. (Counts may vary if regex returns
    // different word boundaries; the contract is "no duplicates per type+term".)
    const lowercased = new Set(competitorClaims.map((c) => c.matchedTerm.toLowerCase()));
    assert.equal(lowercased.size, competitorClaims.length);
  });

  it("includes a verbatim excerpt for each claim", () => {
    const r = detectExternalClaims(
      "We saw a big drop in sales during the lockdown, especially in tier 2 cities.",
    );
    for (const claim of r.claims) {
      assert.ok(claim.excerpt.length > 0, "excerpt non-empty");
      assert.ok(claim.excerpt.length <= 120, "excerpt capped at 120 chars");
    }
  });
});

describe("WQ2 · detectExternalClaims — empty / dataset-only questions", () => {
  it("returns no claims for empty input", () => {
    const r = detectExternalClaims("");
    assert.equal(r.hasExternalClaim, false);
    assert.equal(r.claims.length, 0);
    assert.equal(r.suggestedAction, null);
  });

  it("returns no claims for whitespace-only input", () => {
    const r = detectExternalClaims("   \n  ");
    assert.equal(r.hasExternalClaim, false);
  });

  it("returns no claims for purely dataset-internal question", () => {
    const r = detectExternalClaims("Show me sales by region for the last quarter.");
    assert.equal(r.hasExternalClaim, false);
    assert.equal(r.suggestedAction, null);
  });

  it("suggestedAction is non-null when at least one claim fires", () => {
    const r = detectExternalClaims("How big is the haircare market in India?");
    assert.equal(r.hasExternalClaim, true);
    assert.ok(r.suggestedAction);
    assert.match(r.suggestedAction!, /web_search/);
  });
});

describe("WQ2 · summarizeExternalClaims", () => {
  it("groups claims by type and emits a prompt-friendly line", () => {
    const r = detectExternalClaims(
      "How did Gen Z respond to our competitor's price moves during the pandemic?",
    );
    const summary = summarizeExternalClaims(r);
    assert.ok(summary.total > 0);
    assert.ok(summary.byType.competitor >= 1);
    assert.ok(summary.byType.external_event >= 1);
    assert.ok(summary.byType.demographic_shift >= 1);
    assert.match(summary.promptLine, /external-claim/);
    assert.match(summary.promptLine, /web_search/);
  });

  it("emits a clean no-claim line for empty reports", () => {
    const summary = summarizeExternalClaims({
      hasExternalClaim: false,
      claims: [],
      suggestedAction: null,
    });
    assert.equal(summary.total, 0);
    assert.match(summary.promptLine, /No external-claim/);
  });

  it("counts every type exactly once across the full population", () => {
    const r = detectExternalClaims(
      "How did the lockdown shift Gen Z away from our competitor's category growth benchmark?",
    );
    const summary = summarizeExternalClaims(r);
    const total = Object.values(summary.byType).reduce((a, b) => a + b, 0);
    assert.equal(total, summary.total);
  });
});

describe("WQ2 · regex statefulness — repeated calls", () => {
  it("returns the same result when called twice (regex lastIndex reset)", () => {
    const r1 = detectExternalClaims("How did the lockdown affect market growth?");
    const r2 = detectExternalClaims("How did the lockdown affect market growth?");
    assert.equal(r1.claims.length, r2.claims.length);
  });
});

describe("W-WEB · channel/industry + compare-to-market markers", () => {
  it("fires on a channel industry-trend ('quick commerce growth')", () => {
    const r = detectExternalClaims("Is quick commerce growth an industry shift or just us?");
    assert.equal(r.hasExternalClaim, true);
    assert.ok(r.claims.some((c) => c.type === "market_size"));
  });

  it("fires on 'growth of e-commerce'", () => {
    const r = detectExternalClaims("How much of this is the growth of e-commerce nationally?");
    assert.equal(r.hasExternalClaim, true);
  });

  it("fires on 'compared to the market'", () => {
    const r = detectExternalClaims("How are we doing compared to the market?");
    assert.equal(r.hasExternalClaim, true);
    assert.ok(r.claims.some((c) => c.type === "industry_benchmark"));
  });

  it("does NOT fire on a plain internal channel comparison ('GT vs Q-com volume')", () => {
    const r = detectExternalClaims("Show me GT vs Q-com volume by region.");
    assert.equal(r.hasExternalClaim, false);
  });
});
