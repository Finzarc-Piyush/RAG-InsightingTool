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

  test("on-accent tone still renders the commentary but drops the neutral muted card (harmonizes on colored panels)", () => {
    const { container } = render(
      <ChartInsightBody
        keyInsight="North grew fastest."
        businessCommentary="Distribution expansion likely."
        tone="on-accent"
      />,
    );
    // Content still renders.
    expect(screen.getByText("Business context:")).toBeTruthy();
    expect(screen.getByText("Distribution expansion likely.")).toBeTruthy();
    // The neutral muted-card background is NOT applied (so it inherits the host).
    const commentary = container.querySelector('[aria-label="Business commentary"]');
    expect(commentary).toBeTruthy();
    expect(commentary!.className.includes("bg-muted/30")).toBe(false);
  });

  test("default tone keeps the neutral muted card", () => {
    const { container } = render(
      <ChartInsightBody businessCommentary="Domain framing." />,
    );
    const commentary = container.querySelector('[aria-label="Business commentary"]');
    expect(commentary!.className.includes("bg-muted/30")).toBe(true);
  });

  test("renders a tagged HEADLINE / WHY / DO as labelled compact lanes", () => {
    const { container } = render(
      <ChartInsightBody
        keyInsight={
          "West leads at 74% vs 19%.\nWHY: likely stronger metro reach.\nDO: audit East shelf presence."
        }
      />,
    );
    // Headline renders as prose.
    expect(screen.getByText(/West leads at 74% vs 19%/)).toBeTruthy();
    // Why / Do render as labelled affordances…
    expect(container.querySelector('[aria-label="Why it might be happening"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="What we can do"]')).toBeTruthy();
    expect(screen.getByText("Why:")).toBeTruthy();
    expect(screen.getByText("Do:")).toBeTruthy();
    expect(screen.getByText("likely stronger metro reach.")).toBeTruthy();
    expect(screen.getByText("audit East shelf presence.")).toBeTruthy();
    // …with the raw uppercase wire-format tokens stripped (never shown).
    expect(container.textContent).not.toContain("WHY:");
    expect(container.textContent).not.toContain("DO:");
  });

  test("an untagged legacy string renders as a plain headline with no Why/Do chrome", () => {
    const { container } = render(
      <ChartInsightBody keyInsight="Some older multi-sentence prose with no lane markers." />,
    );
    expect(screen.getByText("Some older multi-sentence prose with no lane markers.")).toBeTruthy();
    expect(container.querySelector('[aria-label="Why it might be happening"]')).toBeNull();
    expect(container.querySelector('[aria-label="What we can do"]')).toBeNull();
  });

  test("tagged lanes still render the business-context block alongside (no regression)", () => {
    render(
      <ChartInsightBody
        keyInsight={"North grew fastest.\nWHY: likely wider distribution."}
        businessCommentary="Premiumisation tailwind."
      />,
    );
    expect(screen.getByText(/North grew fastest/)).toBeTruthy();
    expect(screen.getByText("likely wider distribution.")).toBeTruthy();
    expect(screen.getByText("Business context:")).toBeTruthy();
  });

  test("on-accent tone renders the Why lane inheriting the host (drops the neutral muted text)", () => {
    const { container } = render(
      <ChartInsightBody
        keyInsight={"North grew fastest.\nWHY: likely wider distribution."}
        tone="on-accent"
      />,
    );
    const why = container.querySelector('[aria-label="Why it might be happening"]');
    expect(why).toBeTruthy();
    expect(why!.className.includes("text-muted-foreground")).toBe(false);
  });
});
