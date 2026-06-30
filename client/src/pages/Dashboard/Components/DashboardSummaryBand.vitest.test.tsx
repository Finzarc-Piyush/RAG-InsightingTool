// Wave C3/C4 · the Executive Summary band is editable in dashboard edit mode.
// W-SBGRID · the band is now ONE free-form react-grid-layout canvas: the six
// per-section "Add" buttons collapsed into a single "Add ▾" menu, and cards
// gain stable ids on first edit (so positions survive a sibling delete).
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

// Items carry ids so the id-hydration mount effect is a no-op (changed=false)
// and we can assert delete in isolation.
const envelope = (): DashboardAnswerEnvelope =>
  ({
    tldr: "Female survival far exceeds male.",
    magnitudes: [
      { label: "female · survival", value: "74.2%", tone: "green", id: "mag_1" },
      { label: "male · survival", value: "18.9%", tone: "red", id: "mag_2" },
    ],
    findings: [
      { headline: "Sex is the dominant split", evidence: "0.742 vs 0.189.", id: "find_1" },
    ],
    recommendations: [
      { action: "Keep the sex cut", rationale: "Largest gap.", horizon: "now", id: "rec_1" },
    ],
  }) as DashboardAnswerEnvelope;

function renderBand(onUpdate: (patch: unknown) => void, canEdit = true) {
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
  it("shows the Add menu + edit/delete affordances in edit mode (owner default)", () => {
    renderBand(vi.fn());
    // DR18E · owners default to edit mode → affordances visible.
    // W-SBGRID · a single "Add" menu trigger replaces the per-section buttons.
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    expect(screen.getAllByLabelText("Delete").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Edit").length).toBeGreaterThan(0);
  });

  it("deleting the first key number patches the answerEnvelope minus that item", () => {
    const onUpdate = vi.fn();
    renderBand(onUpdate);
    // First Delete control belongs to the first magnitude (magnitudes render first).
    fireEvent.click(screen.getAllByLabelText("Delete")[0]!);
    // ids present → no id-hydration call on mount, so delete is the only patch.
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const patch = onUpdate.mock.calls[0]![0] as {
      answerEnvelope?: DashboardAnswerEnvelope;
    };
    expect(patch.answerEnvelope?.magnitudes).toHaveLength(1);
    expect(patch.answerEnvelope?.magnitudes?.[0]?.label).toBe("male · survival");
    // L-021 · sibling fields ride along.
    expect(patch.answerEnvelope?.findings).toHaveLength(1);
  });

  it("backfills stable ids on mount when cards lack them", () => {
    const onUpdate = vi.fn();
    render(
      <DashboardEditModeProvider dashboardId="d2" canEdit>
        <DashboardSummaryBand
          dashboardId="d2"
          envelope={{ magnitudes: [{ label: "a", value: "1" }] } as DashboardAnswerEnvelope}
          onUpdate={onUpdate as never}
        />
      </DashboardEditModeProvider>,
    );
    // The mount effect persists ids for the id-less magnitude.
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const patch = onUpdate.mock.calls[0]![0] as {
      answerEnvelope?: DashboardAnswerEnvelope;
    };
    expect(typeof patch.answerEnvelope?.magnitudes?.[0]?.id).toBe("string");
  });

  it("stays read-only (no controls) when the viewer cannot edit", () => {
    renderBand(vi.fn(), false);
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryAllByLabelText("Delete")).toHaveLength(0);
  });
});
