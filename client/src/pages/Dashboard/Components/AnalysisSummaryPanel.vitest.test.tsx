import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AnalysisSummaryPanel } from "./AnalysisSummaryPanel";

// This vitest config does not enable globals, so register cleanup manually.
afterEach(cleanup);

const PROMPTS = [
  "Within each Cluster, how does Compliance Visit vary by ASM?",
  "What explains the differences in Compliance Visit by Cluster?",
];

describe("AnalysisSummaryPanel · suggested follow-ups", () => {
  test("renders follow-ups as clickable rows and fires onSelectFollowUp with the question", () => {
    const onSelect = vi.fn();
    render(
      <AnalysisSummaryPanel followUpPrompts={PROMPTS} onSelectFollowUp={onSelect} />,
    );

    expect(screen.getByTestId("dashboard-followups")).toBeTruthy();
    const buttons = screen.getAllByRole("button");
    // One button per follow-up (no collapsible sections without an envelope).
    expect(buttons.length).toBe(PROMPTS.length);

    fireEvent.click(screen.getByTestId("dashboard-followup-0"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(PROMPTS[0]);

    fireEvent.click(screen.getByTestId("dashboard-followup-1"));
    expect(onSelect).toHaveBeenCalledWith(PROMPTS[1]);
  });

  test("renders read-only text (no buttons) when no handler is provided", () => {
    render(<AnalysisSummaryPanel followUpPrompts={PROMPTS} />);
    expect(screen.queryByTestId("dashboard-followups")).toBeNull();
    expect(screen.queryByTestId("dashboard-followup-0")).toBeNull();
    // No interactive elements at all in the plain-text branch.
    expect(screen.queryAllByRole("button").length).toBe(0);
    // …but the text is still present.
    expect(
      screen.getByText((_content, el) => el?.textContent === `· ${PROMPTS[0]}`),
    ).toBeTruthy();
  });
});
