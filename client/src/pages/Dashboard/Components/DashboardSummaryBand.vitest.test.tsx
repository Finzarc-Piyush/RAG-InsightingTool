// Wave C3/C4 · the Executive Summary band is editable in dashboard edit mode.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DashboardSummaryBand } from "./DashboardSummaryBand";
import { DashboardEditModeProvider } from "../context/DashboardEditModeContext";
import type { DashboardAnswerEnvelope } from "@/shared/schema";

afterEach(() => {
  cleanup();
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
});

const envelope = (): DashboardAnswerEnvelope =>
  ({
    tldr: "Female survival far exceeds male.",
    magnitudes: [
      { label: "female · survival", value: "74.2%" },
      { label: "male · survival", value: "18.9%" },
    ],
    findings: [{ headline: "Sex is the dominant split", evidence: "0.742 vs 0.189." }],
    recommendations: [{ action: "Keep the sex cut", rationale: "Largest gap.", horizon: "now" }],
  }) as DashboardAnswerEnvelope;

function renderBand(
  onUpdate: (patch: unknown) => void,
  canEdit = true,
) {
  return render(
    <DashboardEditModeProvider dashboardId="d1" canEdit={canEdit}>
      <DashboardSummaryBand
        dashboardId="d1"
        envelope={envelope()}
        onUpdate={onUpdate as never}
      />
    </DashboardEditModeProvider>,
  );
}

describe("DashboardSummaryBand · editing", () => {
  it("shows Add + edit/delete affordances in edit mode (owner default)", () => {
    renderBand(vi.fn());
    // DR18E · owners default to edit mode, so the affordances are visible.
    expect(screen.getByText("Add key number")).toBeTruthy();
    expect(screen.getByText("Add finding")).toBeTruthy();
    expect(screen.getByText("Add priority action")).toBeTruthy();
    expect(screen.getAllByLabelText("Delete").length).toBeGreaterThan(0);
  });

  it("deleting the first key number patches the answerEnvelope minus that item", () => {
    const onUpdate = vi.fn();
    renderBand(onUpdate);
    // First Delete control belongs to the first magnitude (magnitudes render first).
    fireEvent.click(screen.getAllByLabelText("Delete")[0]!);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const patch = onUpdate.mock.calls[0]![0] as {
      answerEnvelope?: DashboardAnswerEnvelope;
    };
    expect(patch.answerEnvelope?.magnitudes).toHaveLength(1);
    expect(patch.answerEnvelope?.magnitudes?.[0]?.label).toBe("male · survival");
    // L-021 · sibling fields ride along.
    expect(patch.answerEnvelope?.findings).toHaveLength(1);
  });

  it("stays read-only (no controls) when the viewer cannot edit", () => {
    renderBand(vi.fn(), false);
    expect(screen.queryByText("Add key number")).toBeNull();
    expect(screen.queryAllByLabelText("Delete")).toHaveLength(0);
  });
});
