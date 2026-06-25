// W8 · OffDayAffordance — the non-blocking "exclude the off-day?" pill.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { OffDayAffordance } from "./OffDayAffordance";

afterEach(() => cleanup());

const noop = () => {};

describe("OffDayAffordance", () => {
  it("renders nothing when there is no off-day and nothing excluded", () => {
    const { container } = render(
      <OffDayAffordance
        offWeekdays={[]}
        excluded={false}
        onExclude={noop}
        onKeepAll={noop}
        onUndo={noop}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("offer state: shows the summary + Exclude / Keep all, and fires callbacks", () => {
    const onExclude = vi.fn();
    const onKeepAll = vi.fn();
    render(
      <OffDayAffordance
        offWeekdays={["Sunday"]}
        summary="Sunday averages 0 vs 4.2K on other days"
        excluded={false}
        onExclude={onExclude}
        onKeepAll={onKeepAll}
        onUndo={noop}
      />
    );
    expect(screen.getByText(/recurring off-day/)).toBeTruthy();
    expect(screen.getByText(/0 vs 4.2K/)).toBeTruthy();
    fireEvent.click(screen.getByText("Exclude Sunday"));
    expect(onExclude).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Keep all days"));
    expect(onKeepAll).toHaveBeenCalledOnce();
  });

  it("excluded state: offers Apply to all + Undo when escalation is available", () => {
    const onApplyToAll = vi.fn();
    const onUndo = vi.fn();
    render(
      <OffDayAffordance
        offWeekdays={["Sunday"]}
        excluded
        onExclude={noop}
        onKeepAll={noop}
        onApplyToAll={onApplyToAll}
        onUndo={onUndo}
      />
    );
    expect(screen.getByText(/Excluded Sunday from this chart/)).toBeTruthy();
    fireEvent.click(screen.getByText("Apply to all charts"));
    expect(onApplyToAll).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Undo"));
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it("excluded state: hides Apply-to-all when no escalation callback is given", () => {
    render(
      <OffDayAffordance
        offWeekdays={["Sunday"]}
        excluded
        onExclude={noop}
        onKeepAll={noop}
        onUndo={noop}
      />
    );
    expect(screen.queryByText("Apply to all charts")).toBeNull();
  });

  it("appliedToAll: collapses to a session-wide notice", () => {
    render(
      <OffDayAffordance
        offWeekdays={["Sunday"]}
        excluded
        appliedToAll
        onExclude={noop}
        onKeepAll={noop}
        onApplyToAll={noop}
        onUndo={noop}
      />
    );
    expect(screen.getByText(/excluded across this session/)).toBeTruthy();
    expect(screen.queryByText("Apply to all charts")).toBeNull();
  });
});
