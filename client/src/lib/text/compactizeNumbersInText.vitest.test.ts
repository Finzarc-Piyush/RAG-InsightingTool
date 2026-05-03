import { describe, expect, it } from "vitest";
import { compactizeNumbersInText } from "./compactizeNumbersInText";

describe("compactizeNumbersInText · currency", () => {
  it("compacts USD with thousands separators and decimals", () => {
    expect(compactizeNumbersInText("$446,299.18")).toBe("$446.3K");
    expect(compactizeNumbersInText("$306,361.15")).toBe("$306.4K");
    expect(compactizeNumbersInText("$168,572.53")).toBe("$168.6K");
  });

  it("compacts at million and billion tiers", () => {
    expect(compactizeNumbersInText("$1,234,567")).toBe("$1.2M");
    expect(compactizeNumbersInText("$2,000,000,000")).toBe("$2B");
  });

  it("supports ₹, £, €, ¥", () => {
    expect(compactizeNumbersInText("₹1,500,000")).toBe("₹1.5M");
    expect(compactizeNumbersInText("£999,000")).toBe("£999K");
    expect(compactizeNumbersInText("€1,234")).toBe("€1.2K");
    expect(compactizeNumbersInText("¥2,500,000")).toBe("¥2.5M");
  });

  it("preserves negative sign on currency", () => {
    expect(compactizeNumbersInText("-$1,234,567")).toBe("-$1.2M");
  });

  it("rewrites currency in flowing prose", () => {
    expect(
      compactizeNumbersInText(
        "California sales of $446,299.18, New York $306,361.15, Texas $168,572.53.",
      ),
    ).toBe("California sales of $446.3K, New York $306.4K, Texas $168.6K.");
  });
});

describe("compactizeNumbersInText · plain numbers", () => {
  it("compacts plain numbers with thousands separators", () => {
    expect(compactizeNumbersInText("1,234,567")).toBe("1.2M");
    expect(compactizeNumbersInText("50,000")).toBe("50K");
  });

  it("compacts plain numbers without separators", () => {
    expect(compactizeNumbersInText("50000 units")).toBe("50K units");
    expect(compactizeNumbersInText("we shipped 1234567 boxes")).toBe(
      "we shipped 1.2M boxes",
    );
  });

  it("preserves negative sign on plain numbers", () => {
    expect(compactizeNumbersInText("-1,234,567")).toBe("-1.2M");
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

  it("does not double-format numbers already shorthand", () => {
    expect(compactizeNumbersInText("$1.95M")).toBe("$1.95M");
    expect(compactizeNumbersInText("710K and 2.3B")).toBe("710K and 2.3B");
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
    expect(compactizeNumbersInText("**$446,299.18**")).toBe("**$446.3K**");
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
  it("reformats the prose from the bug report", () => {
    const input =
      "California generates the highest sales revenue among U.S. states, with total sales of $446,299.18. New York follows with $306,361.15, and Texas ranks third at $168,572.53.";
    const output = compactizeNumbersInText(input);
    expect(output).toContain("$446.3K");
    expect(output).toContain("$306.4K");
    expect(output).toContain("$168.6K");
    expect(output).not.toContain("299.18");
    expect(output).not.toContain("361.15");
    expect(output).not.toContain("572.53");
  });
});
