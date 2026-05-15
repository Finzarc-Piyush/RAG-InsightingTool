import { describe, it, expect } from "vitest";
import { augmentSpecFromMessage } from "./augmentSpecFromMessage";
import type { DashboardSpec, Message } from "@/shared/schema";

/**
 * DPF3 · pin the manual-create augmentation contract.
 *
 * Goal: when the user clicks "Create dashboard" via DashboardDraftCard /
 * BuildDashboardCallout, the four message-only fields (businessActions,
 * followUpPrompts, investigationSummary, priorInvestigationsSnapshot)
 * are folded onto the spec at POST time so the dashboard mirrors what
 * the user is looking at in chat.
 *
 * Spec values win — the agent's auto-populated spec is authoritative
 * if it carries the field. Only missing fields get filled from the
 * message.
 */

const baseSpec = (): DashboardSpec => ({
  name: "Q4 review",
  template: "deep_dive",
  defaultSheetId: "sheet_summary",
  sheets: [{ id: "sheet_summary", name: "Executive Summary", charts: [] }],
});

const baseMessage = (overrides: Partial<Message> = {}): Message => ({
  role: "assistant",
  content: "answer body",
  timestamp: 1_700_000_000_000,
  ...overrides,
});

describe("DPF3 · augmentSpecFromMessage", () => {
  it("returns the spec unchanged when message is undefined", () => {
    const spec = baseSpec();
    const out = augmentSpecFromMessage(spec, undefined);
    expect(out).toEqual(spec);
  });

  it("folds in businessActions from the message when spec has none", () => {
    const spec = baseSpec();
    const msg = baseMessage({
      businessActions: [
        {
          title: "Reallocate Q4 trade spend",
          rationale: "ZAYO ROAS leads — capture before it reverts.",
          horizon: "this_quarter",
          confidence: "medium",
        },
      ],
    });
    const out = augmentSpecFromMessage(spec, msg);
    expect(out.businessActions).toEqual(msg.businessActions);
  });

  it("folds in followUpPrompts from the message when spec has none", () => {
    const spec = baseSpec();
    const msg = baseMessage({
      followUpPrompts: ["What's driving ZAYO?", "Compare LASHE vs ZAYO"],
    });
    const out = augmentSpecFromMessage(spec, msg);
    expect(out.followUpPrompts).toEqual(msg.followUpPrompts);
  });

  it("folds in investigationSummary from the message when spec has none", () => {
    const spec = baseSpec();
    const msg = baseMessage({
      investigationSummary: {
        hypotheses: [
          { text: "MT shifted toward online", status: "confirmed", evidenceCount: 2 },
        ],
      },
    });
    const out = augmentSpecFromMessage(spec, msg);
    expect(out.investigationSummary).toEqual(msg.investigationSummary);
  });

  it("folds in priorInvestigationsSnapshot from the message when spec has none", () => {
    const spec = baseSpec();
    const msg = baseMessage({
      priorInvestigationsSnapshot: [
        {
          at: "2026-04-01",
          question: "Why is share declining?",
          hypothesesConfirmed: ["Distribution gap"],
          hypothesesRefuted: [],
          hypothesesOpen: [],
          headlineFinding: "Metro MT distribution down 4pp",
        },
      ],
    });
    const out = augmentSpecFromMessage(spec, msg);
    expect(out.priorInvestigationsSnapshot).toEqual(msg.priorInvestigationsSnapshot);
  });

  it("spec values win over message values (agent auto-populated spec is authoritative)", () => {
    const specPrompts = ["Spec follow-up A", "Spec follow-up B"];
    const spec = { ...baseSpec(), followUpPrompts: specPrompts };
    const msg = baseMessage({
      followUpPrompts: ["Message follow-up X (should be ignored)"],
    });
    const out = augmentSpecFromMessage(spec, msg);
    expect(out.followUpPrompts).toEqual(specPrompts);
  });

  it("does not invent fields when both spec and message lack them", () => {
    const out = augmentSpecFromMessage(baseSpec(), baseMessage());
    expect(out.businessActions).toBeUndefined();
    expect(out.followUpPrompts).toBeUndefined();
    expect(out.investigationSummary).toBeUndefined();
    expect(out.priorInvestigationsSnapshot).toBeUndefined();
  });

  it("preserves non-augmented spec fields verbatim (name, template, sheets, etc.)", () => {
    const spec = { ...baseSpec(), question: "What drove Q4 lift?" };
    const out = augmentSpecFromMessage(spec, baseMessage());
    expect(out.name).toBe(spec.name);
    expect(out.template).toBe(spec.template);
    expect(out.sheets).toEqual(spec.sheets);
    expect(out.defaultSheetId).toBe(spec.defaultSheetId);
    expect(out.question).toBe(spec.question);
  });

  it("folds all four fields from message when spec has none", () => {
    const msg = baseMessage({
      businessActions: [
        {
          title: "Action item title",
          rationale: "Long enough rationale to clear the min-10 floor.",
          horizon: "now",
          confidence: "high",
        },
      ],
      followUpPrompts: ["Follow-up A"],
      investigationSummary: {
        hypotheses: [{ text: "h1", status: "open", evidenceCount: 1 }],
      },
      priorInvestigationsSnapshot: [
        {
          at: "2026-04-01",
          question: "q",
          hypothesesConfirmed: [],
          hypothesesRefuted: [],
          hypothesesOpen: [],
        },
      ],
    });
    const out = augmentSpecFromMessage(baseSpec(), msg);
    expect(out.businessActions).toEqual(msg.businessActions);
    expect(out.followUpPrompts).toEqual(msg.followUpPrompts);
    expect(out.investigationSummary).toEqual(msg.investigationSummary);
    expect(out.priorInvestigationsSnapshot).toEqual(msg.priorInvestigationsSnapshot);
  });
});
