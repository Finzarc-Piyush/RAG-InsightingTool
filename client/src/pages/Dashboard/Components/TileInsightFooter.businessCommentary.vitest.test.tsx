import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { TileInsightFooter } from "./TileInsightFooter";

// Globals are not enabled in this vitest config — register cleanup ourselves.
afterEach(cleanup);

/**
 * CI5 · the dashboard tile footer renders the chart's domain `businessCommentary`
 * (via the shared <ChartInsightBody>) beneath the key insight, so a dashboard
 * tile shows the same full insight a chat chart does.
 */
describe("CI5 · TileInsightFooter forwards businessCommentary", () => {
  const base = {
    dashboardId: "d1",
    tileId: "t1",
    canEdit: false,
    isEditing: false,
  };

  test("renders the Business context block when commentary is provided", () => {
    render(
      <TileInsightFooter
        {...base}
        insight="North region leads on sales."
        businessCommentary="Premiumisation tailwind in haircare."
      />,
    );
    expect(screen.getByText("North region leads on sales.")).toBeTruthy();
    expect(screen.getByText("Business context:")).toBeTruthy();
    expect(
      screen.getByText("Premiumisation tailwind in haircare."),
    ).toBeTruthy();
  });

  test("renders no Business context block when commentary is absent", () => {
    render(
      <TileInsightFooter {...base} insight="North region leads on sales." />,
    );
    expect(screen.getByText("North region leads on sales.")).toBeTruthy();
    expect(screen.queryByText("Business context:")).toBeNull();
  });
});
