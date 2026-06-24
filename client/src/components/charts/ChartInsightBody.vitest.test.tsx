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

  test("renders nothing when the key insight is empty/whitespace (callers can drop their own guard)", () => {
    const { container } = render(<ChartInsightBody keyInsight="   " />);
    expect(container.textContent).toBe("");
  });

  test("renders nothing when given no props at all", () => {
    const { container } = render(<ChartInsightBody />);
    expect(container.textContent).toBe("");
  });

  test("renders a tagged HEADLINE / WHY / DO as labelled lanes", () => {
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

  test("Why / Do render at NORMAL text size — no compact 12px, no italic", () => {
    const { container } = render(
      <ChartInsightBody
        keyInsight={
          "North grew fastest.\nWHY: likely wider distribution.\nDO: audit South coverage."
        }
      />,
    );
    const why = container.querySelector('[aria-label="Why it might be happening"]');
    const doLane = container.querySelector('[aria-label="What we can do"]');
    expect(why).toBeTruthy();
    expect(doLane).toBeTruthy();
    // The lanes inherit the host's base size (headline size) — they no longer
    // carry the smaller `text-[12px]` footnote treatment, and Why is no longer italic.
    expect(why!.className.includes("text-[12px]")).toBe(false);
    expect(why!.className.includes("italic")).toBe(false);
    expect(doLane!.className.includes("text-[12px]")).toBe(false);
  });

  test("an untagged legacy string renders as a plain headline with no Why/Do chrome", () => {
    const { container } = render(
      <ChartInsightBody keyInsight="Some older multi-sentence prose with no lane markers." />,
    );
    expect(screen.getByText("Some older multi-sentence prose with no lane markers.")).toBeTruthy();
    expect(container.querySelector('[aria-label="Why it might be happening"]')).toBeNull();
    expect(container.querySelector('[aria-label="What we can do"]')).toBeNull();
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
