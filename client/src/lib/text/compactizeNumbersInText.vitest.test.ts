import { describe, expect, it } from "vitest";
import { compactizeNumbersInText } from "./compactizeNumbersInText";

describe("compactizeNumbersInText · currency (Indian: ₹ + Cr/Lac/K)", () => {
  it("maps $ → ₹ (data is INR-only) and compacts in lakhs", () => {
    expect(compactizeNumbersInText("$446,299.18")).toBe("₹4.46 Lac");
    expect(compactizeNumbersInText("$306,361.15")).toBe("₹3.06 Lac");
    expect(compactizeNumbersInText("$168,572.53")).toBe("₹1.69 Lac");
  });

  it("compacts at lakh and crore tiers", () => {
    expect(compactizeNumbersInText("$1,234,567")).toBe("₹12.3 Lac");
    expect(compactizeNumbersInText("$2,000,000,000")).toBe("₹200 Cr");
  });

  it("keeps explicit ₹, £, €, ¥ symbols (only $ is remapped)", () => {
    expect(compactizeNumbersInText("₹1,500,000")).toBe("₹15 Lac");
    expect(compactizeNumbersInText("£999,000")).toBe("£9.99 Lac");
    expect(compactizeNumbersInText("€1,234")).toBe("€1.23 K");
    expect(compactizeNumbersInText("¥2,500,000")).toBe("¥25 Lac");
  });

  it("preserves negative sign on currency", () => {
    expect(compactizeNumbersInText("-$1,234,567")).toBe("-₹12.3 Lac");
  });

  it("rewrites currency in flowing prose", () => {
    expect(
      compactizeNumbersInText(
        "California sales of $446,299.18, New York $306,361.15, Texas $168,572.53.",
      ),
    ).toBe("California sales of ₹4.46 Lac, New York ₹3.06 Lac, Texas ₹1.69 Lac.");
  });
});

describe("compactizeNumbersInText · plain numbers", () => {
  it("compacts plain numbers with thousands separators", () => {
    expect(compactizeNumbersInText("1,234,567")).toBe("12.3 Lac");
    expect(compactizeNumbersInText("50,000")).toBe("50 K");
  });

  it("compacts plain numbers without separators", () => {
    expect(compactizeNumbersInText("50000 units")).toBe("50 K units");
    expect(compactizeNumbersInText("we shipped 1234567 boxes")).toBe(
      "we shipped 12.3 Lac boxes",
    );
  });

  it("preserves negative sign on plain numbers", () => {
    expect(compactizeNumbersInText("-1,234,567")).toBe("-12.3 Lac");
  });
});

describe("compactizeNumbersInText · skips", () => {
  it("leaves sub-threshold numbers untouched", () => {
    expect(compactizeNumbersInText("$999.99")).toBe("$999.99");
    expect(compactizeNumbersInText("Only 42 rows.")).toBe("Only 42 rows.");
    expect(compactizeNumbersInText("999")).toBe("999");
  });

  it("leaves percentages untouched", () => {
    expect(compactizeNumbersInText("12.3%")).toBe("12.3%");
    expect(compactizeNumbersInText("growth was 1234%")).toBe(
      "growth was 1234%",
    );
  });

  it("leaves years untouched", () => {
    expect(compactizeNumbersInText("In 2024, sales rose.")).toBe(
      "In 2024, sales rose.",
    );
    expect(compactizeNumbersInText("between 1999 and 2099")).toBe(
      "between 1999 and 2099",
    );
  });

  it("leaves numerical ranges untouched when both ends are sub-threshold", () => {
    expect(compactizeNumbersInText("range 24.0-41.0 inclusive")).toBe(
      "range 24.0-41.0 inclusive",
    );
  });

  it("is idempotent on already-Indian shorthand", () => {
    // The mantissa is < 1000, so a value already rendered "₹1.95 Cr" / "104.9 Cr"
    // is left untouched on a second pass.
    expect(compactizeNumbersInText("₹1.95 Cr")).toBe("₹1.95 Cr");
    expect(compactizeNumbersInText("710 K and 2.3 Cr")).toBe("710 K and 2.3 Cr");
  });

  it("does not touch identifiers that contain digits", () => {
    expect(compactizeNumbersInText("user_12345")).toBe("user_12345");
    expect(compactizeNumbersInText("ID:1234567")).toBe("ID:1234567");
  });

  it("does not corrupt URL-shaped digits", () => {
    expect(compactizeNumbersInText("/api/v1/items/1234567")).toBe(
      "/api/v1/items/1234567",
    );
    expect(compactizeNumbersInText("?id=1234567")).toBe("?id=1234567");
  });
});

describe("compactizeNumbersInText · markdown safety", () => {
  it("compacts numbers inside bold markers", () => {
    expect(compactizeNumbersInText("**$446,299.18**")).toBe("**₹4.46 Lac**");
  });

  it("is a no-op on text with no numbers", () => {
    expect(compactizeNumbersInText("California leads the way.")).toBe(
      "California leads the way.",
    );
  });

  it("is a no-op on empty input", () => {
    expect(compactizeNumbersInText("")).toBe("");
  });
});

describe("compactizeNumbersInText · screenshot reproduction", () => {
  it("reformats the Key-Insights full-precision numbers into Cr (bare numbers get no ₹)", () => {
    // The narrator emits these as bare numbers, so compaction renders magnitude
    // words only — the ₹ prefix comes from the narrator's own output (prompt) or
    // from field-typed chart axes, not from a context-free bare number.
    const input =
      "GT holds the largest retailer-margin pool at 1,049,389,992.94, ahead of MT at 311,587,406.72.";
    const output = compactizeNumbersInText(input);
    expect(output).toContain("104.9 Cr");
    expect(output).toContain("31.2 Cr");
    expect(output).not.toContain("1,049,389,992");
    expect(output).not.toContain("311,587,406");
  });
});
