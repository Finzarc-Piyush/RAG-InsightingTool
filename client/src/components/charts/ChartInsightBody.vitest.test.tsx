import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ChartInsightBody } from "./ChartInsightBody";

// This vitest config does not enable globals, so @testing-library's automatic
// afterEach cleanup is not registered — unmount renders ourselves.
afterEach(cleanup);

describe("ChartInsightBody — the shared insight presentation", () => {
  test("renders the key-insight prose when provided", () => {
    render(<ChartInsightBody keyInsight="West leads on sales." />);
    expect(screen.getByText("West leads on sales.")).toBeTruthy();
  });

  test("renders the business-context block when commentary is provided", () => {
    render(<ChartInsightBody businessCommentary="Haircare premiumisation tailwind." />);
    expect(screen.getByText("Business context:")).toBeTruthy();
    expect(screen.getByText("Haircare premiumisation tailwind.")).toBeTruthy();
  });

  test("renders BOTH prose and commentary together when both are provided", () => {
    render(
      <ChartInsightBody
        keyInsight="North grew fastest."
        businessCommentary="Distribution expansion likely."
      />,
    );
    expect(screen.getByText("North grew fastest.")).toBeTruthy();
    expect(screen.getByText("Distribution expansion likely.")).toBeTruthy();
  });

  test("renders nothing when both are empty/whitespace (callers can drop their own guard)", () => {
    const { container } = render(
      <ChartInsightBody keyInsight="   " businessCommentary="" />,
    );
    expect(container.textContent).toBe("");
  });

  test("renders nothing when given no props at all", () => {
    const { container } = render(<ChartInsightBody />);
    expect(container.textContent).toBe("");
  });
});
