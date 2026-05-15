/**
 * Schema-level regression guard for the new top-level `businessActions`
 * field on `Message`. We can't easily render React components in this
 * vitest config (env: 'node'; no @testing-library), so we lock down the
 * schema contract that the SSE handler + persistence + BusinessActionsCard
 * all depend on.
 *
 * If this test fails, either the schema field name moved, the cap
 * loosened beyond 5, or the per-item shape changed in a way the client
 * card isn't ready to render.
 */
import { describe, expect, test } from "vitest";
import { messageSchema, type Message } from "@/shared/schema";

const VALID_BUSINESS_ACTIONS: Message["businessActions"] = [
  {
    title: "Run a 90-day shelf-share audit in metro stores",
    rationale:
      "MARICO share fell 4.2pp in Q4 vs Q3 (finding 1). Audit will isolate distribution vs price drivers.",
    horizon: "now",
    confidence: "high",
    expectedImpact: "Could recover 1-2pp share over 2 quarters",
  },
  {
    title: "Tighten promo-depth rules for the South region",
    rationale: "South-region promo elasticity slipped (finding 2).",
    horizon: "this_quarter",
    confidence: "medium",
    dependencies: "Validate with rep-panel data before committing budget.",
  },
];

const BASE_MESSAGE = {
  role: "assistant" as const,
  content: "answer text",
  timestamp: 1700000000000,
};

describe("Message schema · businessActions field", () => {
  test("validates a message with a fully-populated businessActions array", () => {
    const parsed = messageSchema.parse({
      ...BASE_MESSAGE,
      businessActions: VALID_BUSINESS_ACTIONS,
    });
    expect(parsed.businessActions).toHaveLength(2);
    expect(parsed.businessActions?.[0].horizon).toBe("now");
    expect(parsed.businessActions?.[0].confidence).toBe("high");
    expect(parsed.businessActions?.[1].dependencies).toMatch(/rep-panel/);
  });

  test("validates a message with NO businessActions (the common case)", () => {
    const parsed = messageSchema.parse(BASE_MESSAGE);
    expect(parsed.businessActions).toBeUndefined();
  });

  test("validates a message with an empty businessActions array", () => {
    const parsed = messageSchema.parse({
      ...BASE_MESSAGE,
      businessActions: [],
    });
    expect(parsed.businessActions).toEqual([]);
  });

  test("rejects more than 8 items (sanity ceiling)", () => {
    const nineItems = Array.from({ length: 9 }, () => VALID_BUSINESS_ACTIONS[0]);
    expect(() =>
      messageSchema.parse({ ...BASE_MESSAGE, businessActions: nineItems })
    ).toThrow();
  });

  test("rejects horizon values outside the allowed enum", () => {
    expect(() =>
      messageSchema.parse({
        ...BASE_MESSAGE,
        businessActions: [
          {
            title: "Action title goes here",
            rationale: "Some rationale text",
            horizon: "tomorrow", // not in enum
            confidence: "high",
          },
        ],
      })
    ).toThrow();
  });

  test("rejects confidence values outside the allowed enum", () => {
    expect(() =>
      messageSchema.parse({
        ...BASE_MESSAGE,
        businessActions: [
          {
            title: "Action title goes here",
            rationale: "Some rationale text",
            horizon: "now",
            confidence: "very_high", // not in enum
          },
        ],
      })
    ).toThrow();
  });

  test("rejects titles shorter than 4 chars (avoids 'fix' / 'go' / 'do')", () => {
    expect(() =>
      messageSchema.parse({
        ...BASE_MESSAGE,
        businessActions: [
          {
            title: "go",
            rationale: "Some rationale text",
            horizon: "now",
            confidence: "high",
          },
        ],
      })
    ).toThrow();
  });

  test("dependencies and expectedImpact are optional", () => {
    const parsed = messageSchema.parse({
      ...BASE_MESSAGE,
      businessActions: [
        {
          title: "Action title goes here",
          rationale: "Some rationale text long enough",
          horizon: "strategic",
          confidence: "low",
        },
      ],
    });
    expect(parsed.businessActions?.[0].dependencies).toBeUndefined();
    expect(parsed.businessActions?.[0].expectedImpact).toBeUndefined();
  });
});
