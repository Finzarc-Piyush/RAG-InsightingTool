import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chartIdentityKey } from "../shared/schema.js";

/**
 * Guards the chart persistence/re-hydration identity (the root fix for
 * "investigated charts show on the dashboard but render blank in chat after
 * reload"). The message-chart strip removes only `data`/`trendLine`, so the
 * identity must key on the surviving axis metadata — NOT just type+title, which
 * collides for an investigated follow-up chart that re-uses a primary chart's
 * title but breaks the metric down on a different dimension.
 */
describe("chartIdentityKey", () => {
  const base = { type: "bar" as const, title: "Adherence Rate", x: "Cluster", y: "adherence" };

  it("two charts sharing type+title but differing on the x axis get DISTINCT keys", () => {
    const primary = chartIdentityKey(base);
    const investigated = chartIdentityKey({ ...base, x: "ASM" }); // same title, diff breakdown
    assert.notEqual(primary, investigated, "axis-aware key must not collide on title+type alone");
  });

  it("differing on y axis or seriesColumn also yields distinct keys", () => {
    assert.notEqual(chartIdentityKey(base), chartIdentityKey({ ...base, y: "compliance" }));
    assert.notEqual(
      chartIdentityKey(base),
      chartIdentityKey({ ...base, seriesColumn: "Region" })
    );
  });

  it("identical charts produce identical keys (true duplicates still dedupe / re-hydrate)", () => {
    assert.equal(chartIdentityKey(base), chartIdentityKey({ ...base }));
  });

  it("is stable when only data/trendLine differ (the fields the persist strip removes)", () => {
    const withData = chartIdentityKey({ ...base, data: [{ a: 1 }], trendLine: [1, 2] } as never);
    const stripped = chartIdentityKey(base); // data/trendLine gone after persist strip
    assert.equal(withData, stripped, "re-hydration key must survive the data strip");
  });

  it("tolerates missing/undefined axis fields without throwing or colliding by accident", () => {
    const a = chartIdentityKey({ type: "line", title: "Trend" });
    const b = chartIdentityKey({ type: "line", title: "Trend", x: "Date" });
    assert.equal(a, "line::Trend::::::");
    assert.notEqual(a, b);
  });
});
