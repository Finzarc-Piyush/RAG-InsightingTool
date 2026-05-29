import { extractUserDirectives } from "../lib/agents/runtime/extractUserDirectives.js";
import { inferFiltersFromQuestion } from "../lib/agents/utils/inferFiltersFromQuestion.js";

const brandSummary = {
  rowCount: 100,
  columnCount: 2,
  columns: [
    { name: "Brand", type: "string", sampleValues: ["Hair Oil", "Pure Sense", "Set Wet"],
      topValues: [{ value: "Hair Oil", count: 40 }, { value: "Pure Sense", count: 30 }, { value: "Set Wet", count: 30 }] },
    { name: "Sales", type: "number", sampleValues: [100, 200, 300] },
  ],
  numericColumns: ["Sales"],
  dateColumns: [],
} as any;

const msg = "From now on only show Hair Oil in brand breakdowns.";
console.log("inferred filters:", JSON.stringify(inferFiltersFromQuestion(msg, brandSummary), null, 2));
const out = extractUserDirectives({ message: msg, summary: brandSummary });
console.log("extracted:", JSON.stringify(out, null, 2));
