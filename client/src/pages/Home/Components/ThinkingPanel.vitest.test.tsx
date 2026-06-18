import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { ThinkingPanel } from "./ThinkingPanel";
import { DASHBOARD_BUILD_MESSAGES } from "./dashboardBuildMessages";
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

function aBuildMessageIsOnScreen(): boolean {
  return DASHBOARD_BUILD_MESSAGES.some(
    (m) => screen.queryAllByText(m).length > 0
  );
}

describe("ThinkingPanel · dashboard-build rotating status", () => {
  test("active 'Building dashboard' step shows the witty label + a rotating line while streaming", () => {
    render(
      <ThinkingPanel
        steps={[step({ step: "Building dashboard", status: "active" })]}
        workbench={[]}
        isStreaming
      />
    );

    // Pill maps the raw server step to the witty label.
    expect(
      screen.getAllByText("Assembling your dashboard…").length
    ).toBeGreaterThan(0);
    // The header flips to "Building dashboard".
    expect(screen.getByText("Building dashboard")).toBeTruthy();
    // A real line from the bank is on screen (rotating ticker).
    expect(aBuildMessageIsOnScreen()).toBe(true);
  });

  test("completed build step keeps the label but stops the rotating line", () => {
    render(
      <ThinkingPanel
        steps={[step({ step: "Building dashboard", status: "completed" })]}
        workbench={[]}
        isStreaming
      />
    );

    expect(
      screen.getAllByText("Assembling your dashboard…").length
    ).toBeGreaterThan(0);
    // Not active → no rotating quip from the bank.
    expect(aBuildMessageIsOnScreen()).toBe(false);
  });

  test("does not rotate when the turn is no longer streaming", () => {
    render(
      <ThinkingPanel
        steps={[step({ step: "Building dashboard", status: "active" })]}
        workbench={[]}
        isStreaming={false}
      />
    );
    expect(aBuildMessageIsOnScreen()).toBe(false);
  });

  test("a normal step is unaffected (no dashboard ticker)", () => {
    render(
      <ThinkingPanel
        steps={[step({ step: "Synthesizing answer", status: "active" })]}
        workbench={[]}
        isStreaming
      />
    );
    expect(screen.getAllByText("Stitching it all together…").length).toBeGreaterThan(0);
    expect(aBuildMessageIsOnScreen()).toBe(false);
  });
});
