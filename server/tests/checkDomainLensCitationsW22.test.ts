import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkDomainLensCitations,
  extractSuppliedPackIds,
  type AnswerEnvelope,
} from "../lib/agents/runtime/checkEnvelopeCompleteness.js";

const env = (domainLens?: string): AnswerEnvelope =>
  domainLens === undefined ? {} : { domainLens };

describe("W22 · extractSuppliedPackIds", () => {
  it("returns [] for undefined / empty domain context", () => {
    assert.deepEqual(extractSuppliedPackIds(undefined), []);
    assert.deepEqual(extractSuppliedPackIds(""), []);
  });

  it("extracts every pack id wrapped in `<<DOMAIN PACK: id>>` markers", () => {
    const dc = `<<DOMAIN PACK: marico-haircare-portfolio>>
# Marico Haircare
…body…
<</DOMAIN PACK>>

<<DOMAIN PACK: kpi-and-metric-glossary>>
# KPI Glossary
…body…
<</DOMAIN PACK>>`;
    const ids = extractSuppliedPackIds(dc);
    assert.deepEqual(ids.sort(), ["kpi-and-metric-glossary", "marico-haircare-portfolio"]);
  });

  it("dedupes when the same id appears twice (defensive)", () => {
    const dc = `<<DOMAIN PACK: marico-haircare-portfolio>>x<</DOMAIN PACK>>
<<DOMAIN PACK: marico-haircare-portfolio>>y<</DOMAIN PACK>>`;
    assert.deepEqual(extractSuppliedPackIds(dc), ["marico-haircare-portfolio"]);
  });

  it("ignores malformed marker variants", () => {
    const dc = `<<PACK marico-x>>noop<</PACK>>
<<DOMAIN PACK : malformed-spacing>>nope<</DOMAIN PACK>>`;
    // The regex requires `DOMAIN PACK:` with optional whitespace then id; the
    // malformed-spacing variant has a space before the colon which still matches
    // because of \s* — verify behaviour.
    const ids = extractSuppliedPackIds(dc);
    // Strict shape must be `<<DOMAIN PACK: id>>` — the second one has a space
    // before the colon and so should not match.
    assert.deepEqual(ids, []);
  });
});

describe("W22 · checkDomainLensCitations — passes", () => {
  it("passes when envelope has no domainLens", () => {
    const r = checkDomainLensCitations(env(), ["marico-haircare-portfolio"]);
    assert.equal(r.ok, true);
  });

  it("passes when no pack ids were supplied (separate completeness path handles missing citations)", () => {
    const r = checkDomainLensCitations(env("Per `marico-haircare-portfolio`, …"), []);
    assert.equal(r.ok, true);
  });

  it("passes when every cited id is in the supplied set", () => {
    const r = checkDomainLensCitations(
      env(
        "Per `marico-haircare-portfolio`, the franchise concentrates margin in MT; per `kpi-and-metric-glossary`, Volume_MT is the primary trade metric."
      ),
      ["marico-haircare-portfolio", "kpi-and-metric-glossary"]
    );
    assert.equal(r.ok, true);
  });

  it("passes when domainLens contains only non-id backticks (column names, etc.)", () => {
    const r = checkDomainLensCitations(
      env("MT volume in `Volume_MT` rolled by `Region` …"),
      ["marico-haircare-portfolio"]
    );
    // No hyphens in those backtick tokens → not flagged as pack-id citations.
    assert.equal(r.ok, true);
  });

  it("passes when domainLens has no backticks at all", () => {
    const r = checkDomainLensCitations(
      env("This category typically rebounds with festive uplift in Q4."),
      ["marico-haircare-portfolio"]
    );
    assert.equal(r.ok, true);
  });
});

describe("W22 · checkDomainLensCitations — fails", () => {
  it("flags a fabricated pack id (looks-like-id, not in supplied set)", () => {
    const r = checkDomainLensCitations(
      env("Per `marico-mythical-pack`, the franchise is unusually exposed."),
      ["marico-haircare-portfolio", "kpi-and-metric-glossary"]
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "HALLUCINATED_DOMAIN_CITATION");
      assert.deepEqual(r.fabricatedIds, ["marico-mythical-pack"]);
      assert.match(r.description, /not in the supplied CONTEXT BUNDLE/);
      assert.match(r.courseCorrection, /Available pack ids/);
    }
  });

  it("flags multiple fabricated citations together, includes them all", () => {
    const r = checkDomainLensCitations(
      env(
        "Per `fmcg-india-mythical` and `competitor-data-2030`, the share dynamics suggest …"
      ),
      ["marico-haircare-portfolio"]
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.deepEqual(
        r.fabricatedIds.sort(),
        ["competitor-data-2030", "fmcg-india-mythical"]
      );
    }
  });

  it("does NOT flag a real citation present alongside a fabricated one — only the fabricated one is reported", () => {
    const r = checkDomainLensCitations(
      env(
        "Per `marico-haircare-portfolio` (real) and `marico-mythical` (fake), the answer …"
      ),
      ["marico-haircare-portfolio"]
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.deepEqual(r.fabricatedIds, ["marico-mythical"]);
    }
  });

  it("courseCorrection lists the available pack ids verbatim so the narrator can pick one", () => {
    const r = checkDomainLensCitations(
      env("Per `bogus-pack`, …"),
      ["marico-foods-edible-oils-portfolio", "fmcg-distribution-channels-india"]
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.courseCorrection, /marico-foods-edible-oils-portfolio/);
      assert.match(r.courseCorrection, /fmcg-distribution-channels-india/);
    }
  });
});
