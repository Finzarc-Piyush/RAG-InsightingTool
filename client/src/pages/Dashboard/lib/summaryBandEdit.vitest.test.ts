import { describe, it, expect } from "vitest";
import {
  addSummaryItem,
  editSummaryItem,
  deleteSummaryItem,
  makeSummaryItem,
  summaryItemToValues,
  ensureSummaryIds,
} from "./summaryBandEdit";
import type { DashboardAnswerEnvelope } from "@/shared/schema";

const envelope = (): DashboardAnswerEnvelope =>
  ({
    tldr: "Sex dominates survival.",
    magnitudes: [{ label: "female · survival", value: "74.2%" }],
    findings: [{ headline: "Sex split", evidence: "0.742 vs 0.189" }],
    recommendations: [
      { action: "Keep the sex cut", rationale: "Largest gap.", horizon: "now" },
    ],
    likelyDrivers: [
      { explanation: "Lifeboat priority", basis: "domain", confidence: "medium" },
    ],
  }) as DashboardAnswerEnvelope;

describe("summaryBandEdit · pure mutations", () => {
  it("adds a magnitude to the answerEnvelope (not attentionAreas)", () => {
    const patch = addSummaryItem(
      "magnitudes",
      { value: "18.9%", label: "male · survival", tone: "green" },
      envelope(),
      undefined,
    );
    expect(patch.attentionAreas).toBeUndefined();
    expect(patch.answerEnvelope?.magnitudes).toHaveLength(2);
    // W-SBCOLOR · tone replaces confidence on key numbers.
    expect(patch.answerEnvelope?.magnitudes?.[1]).toMatchObject({
      label: "male · survival",
      value: "18.9%",
      tone: "green",
    });
    // L-021 · other envelope fields ride along untouched.
    expect(patch.answerEnvelope?.findings).toHaveLength(1);
    expect(patch.answerEnvelope?.likelyDrivers).toHaveLength(1);
  });

  it("defaults a key number with no chosen colour to amber", () => {
    const item = makeSummaryItem("magnitudes", { value: "5", label: "x", tone: "" });
    expect(item).toMatchObject({ label: "x", value: "5", tone: "amber" });
    expect(item).not.toHaveProperty("confidence");
  });

  it("routes attentionAreas edits to the top-level field", () => {
    const areas = [
      {
        dimension: "Embarked",
        unit: "S",
        metric: "survival_rate by Embarked",
        value: 0.337,
        benchmark: 0.57,
        variancePct: -41,
        status: "red" as const,
      },
    ];
    const patch = addSummaryItem(
      "attentionAreas",
      { unit: "Q", metric: "survival_rate by Embarked", dimension: "Embarked", variancePct: "-32", status: "amber" },
      envelope(),
      areas,
    );
    expect(patch.answerEnvelope).toBeUndefined();
    expect(patch.attentionAreas).toHaveLength(2);
    expect(patch.attentionAreas?.[1]).toMatchObject({
      unit: "Q",
      variancePct: -32,
      status: "amber",
      value: 0,
      benchmark: 0,
    });
  });

  it("preserves a recommendation's hidden rationale on edit", () => {
    const patch = editSummaryItem(
      "recommendations",
      0,
      { action: "Lead with the sex cut", horizon: "this_quarter", expectedImpact: "" },
      envelope(),
      undefined,
    );
    const rec = patch.answerEnvelope?.recommendations?.[0] as Record<string, unknown>;
    expect(rec.action).toBe("Lead with the sex cut");
    expect(rec.horizon).toBe("this_quarter");
    expect(rec.rationale).toBe("Largest gap."); // hidden field kept
  });

  it("derives a driver's confidence from its basis", () => {
    const item = makeSummaryItem("likelyDrivers", {
      explanation: "Boarding mix differs by port",
      basis: "data",
      testable: "true",
    });
    expect(item).toMatchObject({
      explanation: "Boarding mix differs by port",
      basis: "data",
      confidence: "high",
      testable: true,
    });
  });

  it("deletes by index immutably", () => {
    const env = envelope();
    const patch = deleteSummaryItem("findings", 0, env, undefined);
    expect(patch.answerEnvelope?.findings).toHaveLength(0);
    expect(env.findings).toHaveLength(1); // original untouched
  });

  it("round-trips an item through toValues → makeSummaryItem", () => {
    const original = { label: "female · survival", value: "74.2%", tone: "green" };
    const values = summaryItemToValues("magnitudes", original);
    expect(makeSummaryItem("magnitudes", values)).toMatchObject(original);
  });
});

describe("summaryBandEdit · stable ids (W-SBGRID)", () => {
  it("mints an id on add and preserves it on edit", () => {
    const added = makeSummaryItem("magnitudes", { value: "1", label: "a", tone: "amber" });
    expect(typeof added.id).toBe("string");
    expect(added.id).toBeTruthy();

    const edited = makeSummaryItem(
      "magnitudes",
      { value: "2", label: "a", tone: "red" },
      added, // prev carries the id
    );
    expect(edited.id).toBe(added.id); // id survives the edit
    expect(edited.value).toBe("2");
  });

  it("ensureSummaryIds backfills ids for legacy cards and reports changed", () => {
    const env = {
      magnitudes: [{ label: "a", value: "1" }, { label: "b", value: "2", id: "mag_keep" }],
      findings: [{ headline: "h", evidence: "e" }],
    } as unknown as DashboardAnswerEnvelope;
    const areas = [
      { dimension: "d", unit: "u", metric: "m", value: 1, benchmark: 2, variancePct: -10, status: "amber" as const },
    ];
    const { changed, patch } = ensureSummaryIds(env, areas);
    expect(changed).toBe(true);
    const mags = patch.answerEnvelope?.magnitudes as Array<Record<string, unknown>>;
    expect(typeof mags[0].id).toBe("string"); // backfilled
    expect(mags[1].id).toBe("mag_keep"); // existing id untouched
    expect(typeof (patch.attentionAreas?.[0] as Record<string, unknown>).id).toBe("string");
  });

  it("ensureSummaryIds is a no-op (changed=false) when every card has an id", () => {
    const env = {
      magnitudes: [{ label: "a", value: "1", id: "mag_1" }],
    } as unknown as DashboardAnswerEnvelope;
    const { changed, patch } = ensureSummaryIds(env, []);
    expect(changed).toBe(false);
    expect(patch.answerEnvelope).toBeUndefined();
    expect(patch.attentionAreas).toBeUndefined();
  });
});
