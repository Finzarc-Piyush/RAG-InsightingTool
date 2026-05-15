/**
 * AMR5 · Pin the schema contract for `recalledFromPriorAnalysis` (the field
 * that the chip mounts on) + the message-level `pivotArtifacts` shape. We
 * can't easily render React components in this vitest config (env: 'node';
 * no @testing-library) — the chip itself is ~30 lines of pure JSX, so we
 * cover the data contract that drives it and trust the component.
 */
import { describe, expect, test } from "vitest";
import { messageSchema, type Message } from "@/shared/schema";

describe("AMR5 · Message.recalledFromPriorAnalysis schema contract", () => {
  test("round-trips an exact-match cache-hit message", () => {
    const msg = {
      role: "assistant" as const,
      content: "Recalled answer text",
      timestamp: Date.now(),
      recalledFromPriorAnalysis: {
        originalSessionId: "session_old",
        originalTurnId: "turn_old_001",
        originalCreatedAt: Date.now() - 1000 * 60 * 60 * 24 * 3, // 3 days ago
        matchKind: "exact" as const,
      },
    };
    const parsed = messageSchema.parse(msg);
    expect(parsed.recalledFromPriorAnalysis?.matchKind).toBe("exact");
    expect(parsed.recalledFromPriorAnalysis?.originalSessionId).toBe("session_old");
  });

  test("round-trips a semantic cache-hit message with rich payload", () => {
    const msg: Message = {
      role: "assistant",
      content: "Semantic recall answer",
      timestamp: Date.now(),
      recalledFromPriorAnalysis: {
        originalSessionId: "s_old",
        originalTurnId: "t_old",
        originalCreatedAt: Date.now() - 7200_000,
        matchKind: "semantic",
      },
      answerEnvelope: {
        tldr: "Original turn's TL;DR carries through to the recalled bubble.",
      },
      pivotArtifacts: [
        {
          artifactId: "abc",
          plan: {},
          pivotDefaults: { rows: ["Products"], values: ["Value"] },
          columnHeaders: ["Products", "Value"],
          rowCount: 10,
          storage: {
            kind: "inline",
            rows: [{ Products: "MARICO", Value: 2200 }],
          },
        },
      ],
    };
    const parsed = messageSchema.parse(msg);
    expect(parsed.recalledFromPriorAnalysis?.matchKind).toBe("semantic");
    expect(parsed.answerEnvelope?.tldr).toMatch(/TL;DR/);
    expect(parsed.pivotArtifacts).toHaveLength(1);
    expect(parsed.pivotArtifacts?.[0]?.storage.kind).toBe("inline");
  });

  test("fresh agent turn (no recall fields) parses cleanly", () => {
    const parsed = messageSchema.parse({
      role: "assistant",
      content: "Fresh agent answer",
      timestamp: Date.now(),
    });
    expect(parsed.recalledFromPriorAnalysis).toBeUndefined();
    expect(parsed.pivotArtifacts).toBeUndefined();
  });

  test("rejects an unknown matchKind", () => {
    expect(() =>
      messageSchema.parse({
        role: "assistant",
        content: "x",
        timestamp: Date.now(),
        recalledFromPriorAnalysis: {
          originalSessionId: "s",
          originalTurnId: "t",
          originalCreatedAt: 0,
          matchKind: "fuzzy",
        },
      })
    ).toThrow();
  });

  test("blob-storage pivot artifact rides on message without raw rows", () => {
    const parsed = messageSchema.parse({
      role: "assistant",
      content: "x",
      timestamp: Date.now(),
      pivotArtifacts: [
        {
          artifactId: "blob_abc",
          plan: {},
          pivotDefaults: { rows: [], values: [] },
          columnHeaders: ["A", "B"],
          rowCount: 5000,
          storage: {
            kind: "blob",
            blobName: "past-analyses-pivots/blob_abc.json",
            bytes: 420_000,
          },
        },
      ],
    });
    expect(parsed.pivotArtifacts?.[0]?.storage.kind).toBe("blob");
    // No `rows` field on a blob-storage discriminant.
    expect(
      Object.prototype.hasOwnProperty.call(
        parsed.pivotArtifacts?.[0]?.storage ?? {},
        "rows"
      )
    ).toBe(false);
  });
});
