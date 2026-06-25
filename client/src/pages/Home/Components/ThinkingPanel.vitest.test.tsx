import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { ThinkingPanel } from "./ThinkingPanel";
import { wittyPoolFor } from "./wittyCopy";
import type { ThinkingStep } from "@/shared/schema";

// Radix Collapsible measures its content via ResizeObserver, absent in jsdom.
beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
});

// This vitest config does not enable globals, so @testing-library's automatic
// afterEach cleanup is not registered — unmount renders ourselves so DOM from
// one test doesn't leak text into the next.
afterEach(cleanup);

function step(partial: Partial<ThinkingStep> & { step: string }): ThinkingStep {
  return { status: "active", timestamp: Date.now(), ...partial } as ThinkingStep;
}

/** True if ANY line from a category bank is currently rendered. */
function aLineFromPoolIsOnScreen(pool: readonly string[]): boolean {
  return pool.some((m) => screen.queryAllByText(m).length > 0);
}

describe("ThinkingPanel · pooled witty copy", () => {
  test("an active step renders a line from that step's category bank", () => {
    render(
      <ThinkingPanel
        steps={[step({ step: "Synthesizing answer", status: "active" })]}
        workbench={[]}
        isStreaming
      />
    );
    // Non-dashboard stages keep the neutral "Thinking" header.
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(aLineFromPoolIsOnScreen(wittyPoolFor("synthesis"))).toBe(true);
    // No dashboard-build quip leaks into a normal step.
    expect(aLineFromPoolIsOnScreen(wittyPoolFor("dashboard"))).toBe(false);
  });

  test("a settled (completed) step still shows a line from its bank", () => {
    render(
      <ThinkingPanel
        steps={[step({ step: "Mapping columns from schema", status: "completed" })]}
        workbench={[]}
        isStreaming
      />
    );
    expect(aLineFromPoolIsOnScreen(wittyPoolFor("columns"))).toBe(true);
  });

  test("active 'Building dashboard' step flips the header and shows a dashboard-bank line", () => {
    render(
      <ThinkingPanel
        steps={[step({ step: "Building dashboard", status: "active" })]}
        workbench={[]}
        isStreaming
      />
    );
    expect(screen.getByText("Building dashboard")).toBeTruthy();
    expect(aLineFromPoolIsOnScreen(wittyPoolFor("dashboard"))).toBe(true);
  });

  test("the 'Building dashboard' header only appears while active AND streaming", () => {
    render(
      <ThinkingPanel
        steps={[step({ step: "Building dashboard", status: "active" })]}
        workbench={[]}
        isStreaming={false}
      />
    );
    // Not streaming → neutral header, no live build banner.
    expect(screen.queryByText("Building dashboard")).toBeNull();
    expect(screen.getByText("Thinking")).toBeTruthy();
  });

  test("shows the live answer timer when given a turn-start timestamp while streaming", () => {
    render(
      <ThinkingPanel
        steps={[step({ step: "Synthesizing answer", status: "active" })]}
        workbench={[]}
        isStreaming
        startedAtMs={Date.now() - 5000}
      />
    );
    // The band chip renders "~low–high(s|min)"; match the band token.
    expect(
      screen.getAllByText((content) => /~\s*\d+\D\d+\s?(s|min)/.test(content)).length
    ).toBeGreaterThan(0);
  });

  test("renders no timer without a start timestamp", () => {
    render(
      <ThinkingPanel
        steps={[step({ step: "Synthesizing answer", status: "active" })]}
        workbench={[]}
        isStreaming
      />
    );
    expect(
      screen.queryAllByText((content) => /~\s*\d+\D\d+\s?(s|min)/.test(content)).length
    ).toBe(0);
  });

  test("a dashboard ask reads the band in minutes from the start", () => {
    render(
      <ThinkingPanel
        steps={[step({ step: "Analyzing user intent", status: "active" })]}
        workbench={[]}
        isStreaming
        startedAtMs={Date.now() - 3000}
        dashboardAsked
      />
    );
    // deepInvestigation → band widens to minutes ("~2–4 min"), not seconds.
    expect(
      screen.getAllByText((content) => /~\s*\d+\D\d+\s?min/.test(content)).length
    ).toBeGreaterThan(0);
  });

  test("the live header keeps rotating even with no active step (all completed)", () => {
    render(
      <ThinkingPanel
        steps={[step({ step: "Mapping columns from schema", status: "completed" })]}
        workbench={[]}
        isStreaming
      />
    );
    // No active step, but streaming → a witty line still shows in the prominent
    // header (it falls back to the last stage's bank), NOT a static count.
    expect(aLineFromPoolIsOnScreen(wittyPoolFor("columns"))).toBe(true);
    expect(screen.queryByText("1 step")).toBeNull();
  });

  test("archived variant shows a static summary and no live pulse/timer", () => {
    render(
      <ThinkingPanel
        variant="archived"
        steps={[step({ step: "Mapping columns from schema", status: "completed" })]}
        workbench={[]}
        isStreaming={false}
        startedAtMs={Date.now() - 5000}
      />
    );
    // Compact static header with the step-count summary; no answer-time band.
    expect(screen.getByText("1 step")).toBeTruthy();
    expect(
      screen.queryAllByText((content) => /~\s*\d+\D\d+\s?(s|min)/.test(content)).length
    ).toBe(0);
  });
});
