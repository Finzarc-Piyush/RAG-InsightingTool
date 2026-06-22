import { describe, it } from "node:test";
import { writeFileSync } from "node:fs";
import { applyQueryTransformations } from "../lib/dataTransform.js";
import { createDataSummary } from "../lib/fileParser.js";
describe("dbg", () => {
  it("dbg", () => {
    const rows = [
      { Stamp: "2026-06-20 08:00:00", Logins: 10 },
      { Stamp: "2026-06-20 14:00:00", Logins: 30 },
      { Stamp: "2026-06-21 08:00:00", Logins: 20 },
      { Stamp: "2026-06-21 14:00:00", Logins: 40 },
    ];
    const summary = createDataSummary(rows);
    const parsed: any = {
      rawQuestion: "x",
      groupBy: ["Hour of day · Stamp"],
      aggregations: [{ column: "Logins", operation: "mean" }],
    };
    let result: string;
    try {
      const out = applyQueryTransformations(rows, summary, parsed);
      result = "OK " + JSON.stringify(out);
    } catch (e) {
      result = "ERR " + (e as Error).stack;
    }
    writeFileSync("/tmp/h5out.txt", result);
  });
});
