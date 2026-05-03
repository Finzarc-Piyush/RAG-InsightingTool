/**
 * Wave-FA · Type-only legacy export.
 *
 * The interactive `ColumnFilterDialog` and `FilterDataModal` UIs were retired
 * with the Wave-FA active-filter overlay (see `FilterDataPanel.tsx`). The
 * legacy `FilterCondition` type is still consumed by `FilterAppliedMessage`
 * and `MessageBubble` to render historical chat bubbles from sessions where
 * the legacy "filter data where ..." natural-language flow ran. Once those
 * older sessions age out we can remove this file entirely.
 */

export type FilterOperator =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "contains"
  | "startsWith"
  | "endsWith"
  | "between"
  | "in";

export interface FilterCondition {
  column: string;
  operator: FilterOperator;
  value?: any;
  value2?: any;
  values?: any[];
}
