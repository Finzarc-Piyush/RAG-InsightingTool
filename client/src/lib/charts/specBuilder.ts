import type {
  ChartV2Mark,
  ChartEncoding,
  ChartConfig,
  ChartSpecV2,
  ChartTransform,
} from "@/shared/schema";
import { applyTransforms, sample, topNAndOther, type Row } from "./dataEngine";

const MAX_INLINE_ROWS = 5_000;
const TOP_N_THRESHOLD = 30;

export interface BuildV2SpecInput {
  mark: ChartV2Mark;
  encoding: ChartEncoding;
  config?: Partial<ChartConfig>;
  rows: Row[];
  title?: string;
}

export function buildV2Spec(input: BuildV2SpecInput): ChartSpecV2 {
  const { mark, encoding, config, title } = input;
  let rows = input.rows;

  const transforms: ChartTransform[] = [];

  if (mark === "point" || mark === "bubble" || mark === "regression") {
    if (rows.length > 3_000) {
      rows = sample(rows, 3_000);
    }
  }

  if (
    encoding.x &&
    (encoding.x.type === "n" || encoding.x.type === "o") &&
    mark !== "parallel"
  ) {
    const distinct = new Set(rows.map((r) => String(r[encoding.x!.field])));
    if (distinct.size > TOP_N_THRESHOLD && encoding.y) {
      rows = topNAndOther(rows, encoding.x.field, encoding.y.field, TOP_N_THRESHOLD);
    }
  }

  if (encoding.y?.aggregate && encoding.x) {
    const groupby = [encoding.x.field];
    if (encoding.color && "field" in encoding.color) {
      groupby.push(encoding.color.field);
    }
    transforms.push({
      type: "aggregate" as const,
      groupby,
      ops: [
        {
          op: encoding.y.aggregate,
          field: encoding.y.field,
          as: encoding.y.field,
        },
      ],
    });
  }

  if (transforms.length > 0) {
    rows = applyTransforms(rows, transforms);
  }

  if (rows.length > MAX_INLINE_ROWS) {
    rows = rows.slice(0, MAX_INLINE_ROWS);
  }

  return {
    version: 2 as const,
    mark,
    encoding,
    transform: transforms.length > 0 ? transforms : undefined,
    source: {
      kind: "inline" as const,
      rows: rows as Record<string, string | number | boolean | null>[],
    },
    config: {
      title: title ? { text: title } : undefined,
      ...config,
    } as ChartSpecV2["config"],
  };
}
