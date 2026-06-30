// W-SBGRID / W-SBCOLOR · the free-form grid must paint a key number in its
// chosen tone (green/amber/red) — the regression guard for "selecting a colour
// does nothing": the render path reads `m.tone` and applies the colour classes.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { DashboardSummaryGrid } from "./DashboardSummaryGrid";
import type { DashboardAnswerEnvelope } from "@/shared/schema";

afterEach(cleanup);

const env = (tone?: string): DashboardAnswerEnvelope =>
  ({
    magnitudes: [{ label: "GT · NR (Rs Cr)", value: "470.92", id: "m1", ...(tone ? { tone } : {}) }],
  }) as DashboardAnswerEnvelope;

describe("DashboardSummaryGrid · key-number tone", () => {
  it("paints a green-tone key number with the success colour", () => {
    const { container } = render(
      <DashboardSummaryGrid envelope={env("green")} isEditing={false} />,
    );
    expect(container.innerHTML).toContain("var(--success)");
  });

  it("paints a red-tone key number with the destructive colour", () => {
    const { container } = render(
      <DashboardSummaryGrid envelope={env("red")} isEditing={false} />,
    );
    expect(container.innerHTML).toContain("border-l-destructive");
  });

  it("defaults an un-toned key number to amber", () => {
    const { container } = render(
      <DashboardSummaryGrid envelope={env()} isEditing={false} />,
    );
    expect(container.innerHTML).toContain("border-l-amber-500");
  });

  it("centres + fluid-scales the number (container query)", () => {
    const { container } = render(
      <DashboardSummaryGrid envelope={env("green")} isEditing={false} />,
    );
    // The card is a query container and the value font scales with cqmin
    // (asserted via the Tailwind class — jsdom doesn't apply cq units, but the
    // class is present and a real browser resolves it).
    expect(container.innerHTML).toContain("container-type: size");
    expect(container.innerHTML).toContain("items-center");
    expect(container.innerHTML).toContain("justify-center");
    expect(container.innerHTML).toContain("cqmin");
  });
});
