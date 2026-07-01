// Wave W7 (data-bound cards) · the DATA-BOUND KPI scorecard component. Pins:
// value formatting, direction-aware delta text (▲/▼, % vs pp), the "—" empty
// state, and the flag-gated row (off by default, on via localStorage override).
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { DashboardScorecardSpec } from "@/shared/schema";
import { DashboardScorecard } from "./DashboardScorecard";
import { DashboardScorecardRow } from "./DashboardScorecardRow";

// recharts' ResponsiveContainer uses ResizeObserver, absent in jsdom.
if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(() => cleanup());

function sc(over: Partial<DashboardScorecardSpec> = {}): DashboardScorecardSpec {
  return {
    id: "sc1",
    title: "Net Revenue",
    format: "number",
    metricPolarity: "higher_better",
    cardDefinition: {
      cardType: "scorecard",
      measure: { kind: "column", ref: "NR", label: "Net Revenue" },
      aggregation: "sum",
      comparison: { mode: "period_over_period" },
    },
    snapshot: {
      value: 482,
      priorValue: 445,
      deltaAbs: 37,
      deltaPct: 0.083,
      tone: "good",
      sparkline: [
        { label: "Feb", value: 4.1 },
        { label: "Mar", value: 4.45 },
        { label: "Apr", value: 4.82 },
      ],
      periodLabel: "Apr vs Mar",
      computedAt: 1,
    },
    ...over,
  } as DashboardScorecardSpec;
}

describe("DashboardScorecard", () => {
  it("renders title, value and a +% delta with the period label", () => {
    render(<DashboardScorecard scorecard={sc()} />);
    expect(screen.getByText("Net Revenue")).toBeTruthy();
    expect(screen.getByText(/482/)).toBeTruthy();
    expect(screen.getByText("+8.3%")).toBeTruthy();
    expect(screen.getByText("Apr vs Mar")).toBeTruthy();
  });

  it("shows an em-dash and NO delta when the value is null", () => {
    render(
      <DashboardScorecard
        scorecard={sc({ snapshot: { value: null, tone: "neutral", computedAt: 1 } })}
      />
    );
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText(/%$/)).toBeNull();
  });

  it("a percent measure shows the delta in percentage POINTS (pp)", () => {
    render(
      <DashboardScorecard
        scorecard={sc({
          format: "percent",
          title: "GC%",
          snapshot: {
            value: 33,
            priorValue: 30,
            deltaAbs: 3,
            deltaPct: 0.1,
            tone: "good",
            computedAt: 1,
          },
        })}
      />
    );
    expect(screen.getByText("+3.0pp")).toBeTruthy();
  });
});

describe("DashboardScorecardRow · flag gating", () => {
  beforeEach(() => {
    try {
      localStorage.removeItem("scorecard.execSummary");
    } catch {
      /* ignore */
    }
  });

  it("renders nothing when the flag is off (default)", () => {
    const { container } = render(<DashboardScorecardRow scorecards={[sc()]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the cards when the localStorage override is on", () => {
    localStorage.setItem("scorecard.execSummary", "true");
    render(<DashboardScorecardRow scorecards={[sc(), sc({ id: "sc2", title: "Volume" })]} />);
    expect(screen.getByText("Net Revenue")).toBeTruthy();
    expect(screen.getByText("Volume")).toBeTruthy();
    localStorage.removeItem("scorecard.execSummary");
  });
});
