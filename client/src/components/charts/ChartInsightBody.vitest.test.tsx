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

  test("suppresses a persisted 'build a dashboard' DO lane at render (historical cleanup) but keeps headline + Why", () => {
    const { container } = render(
      <ChartInsightBody
        keyInsight={
          "West leads at 74% vs 19%.\nWHY: likely stronger metro reach.\nDO: Build a dashboard to track regional sell-through."
        }
      />,
    );
    // Headline + Why survive…
    expect(screen.getByText(/West leads at 74% vs 19%/)).toBeTruthy();
    expect(container.querySelector('[aria-label="Why it might be happening"]')).toBeTruthy();
    // …but the meta-tool DO lane is dropped: no Do affordance, no "build a dashboard" text.
    expect(container.querySelector('[aria-label="What we can do"]')).toBeNull();
    expect(container.textContent).not.toContain("dashboard");
  });

  test("keeps a real managerial DO lane (does not over-strip 'track' / 'report' actions)", () => {
    const { container } = render(
      <ChartInsightBody
        keyInsight={
          "West leads at 74% vs 19%.\nDO: Track promo compliance with the East field team."
        }
      />,
    );
    expect(container.querySelector('[aria-label="What we can do"]')).toBeTruthy();
    expect(screen.getByText("Track promo compliance with the East field team.")).toBeTruthy();
  });

  test("uses fallbackDo as the Do lane when the insight carries no DO of its own", () => {
    const { container } = render(
      <ChartInsightBody
        keyInsight={"West leads at 74% vs 19%.\nWHY: likely stronger metro reach."}
        fallbackDo="Compare what West does that East doesn't."
      />,
    );
    expect(container.querySelector('[aria-label="What we can do"]')).toBeTruthy();
    expect(screen.getByText("Do:")).toBeTruthy();
    expect(screen.getByText("Compare what West does that East doesn't.")).toBeTruthy();
  });

  test("the insight's own DO lane wins over fallbackDo when both are present", () => {
    render(
      <ChartInsightBody
        keyInsight={"West leads at 74% vs 19%.\nDO: audit East shelf presence."}
        fallbackDo="this fallback must not appear"
      />,
    );
    expect(screen.getByText("audit East shelf presence.")).toBeTruthy();
    expect(screen.queryByText("this fallback must not appear")).toBeNull();
  });

  test("fallbackDo does NOT resurrect a Do when there is no headline at all", () => {
    const { container } = render(<ChartInsightBody keyInsight="   " fallbackDo="x" />);
    // Headline is required — an empty insight renders nothing even with a fallback.
    expect(container.textContent).toBe("");
  });

  test("fallbackDo replaces a stripped meta-tool DO lane with a real action", () => {
    const { container } = render(
      <ChartInsightBody
        keyInsight={
          "West leads at 74% vs 19%.\nDO: Build a dashboard to track regional sell-through."
        }
        fallbackDo="Compare what West does that East doesn't."
      />,
    );
    // The meta-tool advice is gone…
    expect(container.textContent).not.toContain("dashboard");
    // …and the deterministic fallback action takes its place.
    expect(container.querySelector('[aria-label="What we can do"]')).toBeTruthy();
    expect(screen.getByText("Compare what West does that East doesn't.")).toBeTruthy();
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
