"""
PY-4 · table-driven unit tests for the pure pandas helpers in data_operations.py.

Covers the core, side-effect-free analytical primitives:
  - aggregate_data: sum / mean / count semantic renaming + boolean truthy-token
    handling (the PY-5 'true/1/yes/y/t' mapping).
  - pivot_table: index values become column headers (preserved-column path).
  - create_derived_column: a simple np.where expression + the PY-6 denylist
    rejecting an IO token ('to_csv').
  - get_summary: numeric / string / date datatype inference.
  - treat_outliers: IQR happy path (remove treatment).

These run in CI under Python 3.12 — the local 3.9 venv cannot execute them, so
they are validated structurally (ast.parse) and lint-clean (ruff) only.
"""
import unittest

from data_operations import (
    aggregate_data,
    create_derived_column,
    get_summary,
    pivot_table,
    treat_outliers,
)


def _datatype_for(summary: dict, variable: str) -> str | None:
    """Pull the inferred datatype for one column out of a get_summary() result."""
    for entry in summary["summary"]:
        if entry["variable"] == variable:
            return entry["datatype"]
    return None


class TestAggregateData(unittest.TestCase):
    def test_sum_default_renames_with_sum_suffix(self):
        data = [
            {"region": "North", "units": 10},
            {"region": "North", "units": 5},
            {"region": "South", "units": 7},
        ]
        result = aggregate_data(data, group_by_column="region")
        self.assertEqual(result["rows_before"], 3)
        self.assertEqual(result["rows_after"], 2)
        by_region = {row["region"]: row for row in result["data"]}
        # Regular numeric column defaults to SUM, renamed "<col> (Sum)".
        self.assertEqual(by_region["North"]["units (Sum)"], 15)
        self.assertEqual(by_region["South"]["units (Sum)"], 7)

    def test_mean_via_user_intent_renames_with_avg_prefix(self):
        data = [
            {"region": "North", "units": 10},
            {"region": "North", "units": 20},
        ]
        # "average" in user_intent flips the regular-numeric default to mean.
        result = aggregate_data(
            data, group_by_column="region", user_intent="show me the average units"
        )
        row = result["data"][0]
        self.assertEqual(row["region"], "North")
        self.assertEqual(row["avg_units"], 15)

    def test_count_via_explicit_agg_func_renames_with_count_suffix(self):
        data = [
            {"region": "North", "units": 10},
            {"region": "North", "units": 20},
            {"region": "South", "units": 30},
        ]
        result = aggregate_data(
            data,
            group_by_column="region",
            agg_columns=["units"],
            agg_funcs={"units": "count"},
        )
        by_region = {row["region"]: row for row in result["data"]}
        self.assertEqual(by_region["North"]["units (Count)"], 2)
        self.assertEqual(by_region["South"]["units (Count)"], 1)

    def test_boolean_truthy_token_handling_any_aggregation(self):
        # is_active is a boolean column: truthy tokens true/1/yes/y/t -> 1,
        # everything else -> 0; "any" -> max, renamed "any_<col>".
        data = [
            {"region": "North", "units": 1, "is_active": "true"},
            {"region": "North", "units": 1, "is_active": "no"},
            {"region": "South", "units": 1, "is_active": "false"},
        ]
        result = aggregate_data(
            data,
            group_by_column="region",
            agg_columns=["is_active"],
        )
        by_region = {row["region"]: row for row in result["data"]}
        # North has at least one truthy ("true") -> any == 1.
        self.assertEqual(by_region["North"]["any_is_active"], 1)
        # South only has "false" -> any == 0.
        self.assertEqual(by_region["South"]["any_is_active"], 0)

    def test_missing_group_by_column_raises(self):
        data = [{"region": "North", "units": 10}]
        with self.assertRaises(ValueError):
            aggregate_data(data, group_by_column="not_a_column")


class TestPivotTable(unittest.TestCase):
    def test_index_values_become_column_headers(self):
        # "brand" is preserved; "status" values pivot into "<value>_<status>" columns.
        data = [
            {"brand": "A", "status": "Complete", "sales": 100},
            {"brand": "A", "status": "Pending", "sales": 200},
            {"brand": "B", "status": "Complete", "sales": 150},
        ]
        result = pivot_table(
            data,
            index_column="status",
            value_columns=["sales"],
        )
        self.assertEqual(result["rows_before"], 3)
        by_brand = {row["brand"]: row for row in result["data"]}
        # Complete sales for brand A, with status values flattened into headers.
        self.assertEqual(by_brand["A"]["sales_Complete"], 100)
        self.assertEqual(by_brand["A"]["sales_Pending"], 200)
        self.assertEqual(by_brand["B"]["sales_Complete"], 150)
        # Brand B had no Pending row -> None after the left-merge fill.
        self.assertIsNone(by_brand["B"]["sales_Pending"])

    def test_missing_index_column_raises(self):
        data = [{"brand": "A", "sales": 100}]
        with self.assertRaises(ValueError):
            pivot_table(data, index_column="not_a_column")


class TestCreateDerivedColumn(unittest.TestCase):
    def test_np_where_expression_creates_categorical_column(self):
        data = [
            {"region": "North", "units": 10},
            {"region": "South", "units": 2},
        ]
        result = create_derived_column(
            data,
            new_column_name="tier",
            expression="np.where([units] > 5, 'high', 'low')",
        )
        self.assertEqual(result["errors"], [])
        tiers = [row["tier"] for row in result["data"]]
        self.assertEqual(tiers, ["high", "low"])

    def test_forbidden_token_to_csv_is_rejected(self):
        # PY-6 denylist: IO/exec tokens are rejected before evaluation,
        # leaving the input data untouched.
        data = [{"region": "North", "units": 10}]
        result = create_derived_column(
            data,
            new_column_name="evil",
            expression="df.to_csv('/tmp/leak.csv')",
        )
        self.assertTrue(result["errors"])
        self.assertIn("to_csv", result["errors"][0])
        # Data is returned unchanged; no new column added.
        self.assertEqual(result["data"], data)

    def test_unknown_column_reference_reports_error(self):
        data = [{"region": "North", "units": 10}]
        result = create_derived_column(
            data,
            new_column_name="bad",
            expression="[does_not_exist] * 2",
        )
        self.assertTrue(result["errors"])
        self.assertIn("not found", result["errors"][0])


class TestGetSummaryTypeInference(unittest.TestCase):
    def test_numeric_string_and_date_datatypes_inferred(self):
        data = [
            {"amount": 100, "label": "alpha", "day": "2024-01-15"},
            {"amount": 250, "label": "beta", "day": "2024-02-20"},
            {"amount": 175, "label": "gamma", "day": "2024-03-10"},
        ]
        summary = get_summary(data)
        # Integer-valued numeric column.
        self.assertEqual(_datatype_for(summary, "amount"), "int64")
        # Free-text categorical column stays object.
        self.assertEqual(_datatype_for(summary, "label"), "object")
        # ISO date strings are recognised as dates.
        self.assertEqual(_datatype_for(summary, "day"), "date")

    def test_numeric_stats_present_for_numeric_column(self):
        data = [{"amount": 10}, {"amount": 20}, {"amount": 30}]
        summary = get_summary(data)
        amount = next(e for e in summary["summary"] if e["variable"] == "amount")
        self.assertEqual(amount["mean"], 20.0)
        self.assertEqual(amount["min"], 10.0)
        self.assertEqual(amount["max"], 30.0)

    def test_missing_column_returns_empty_summary(self):
        data = [{"amount": 10}]
        summary = get_summary(data, column="not_a_column")
        self.assertEqual(summary["summary"], [])


class TestTreatOutliers(unittest.TestCase):
    def test_iqr_remove_drops_extreme_row(self):
        # A tight cluster plus one extreme value that IQR flags as an outlier.
        data = [{"value": v} for v in [10, 11, 12, 13, 14, 15, 16, 1000]]
        result = treat_outliers(
            data,
            column="value",
            method="iqr",
            treatment="remove",
        )
        self.assertEqual(result["rows_before"], 8)
        # The 1000 outlier is removed; the clustered rows survive.
        self.assertEqual(result["outliers_treated"], 1)
        self.assertEqual(result["rows_after"], 7)
        remaining = [row["value"] for row in result["data"]]
        self.assertNotIn(1000, remaining)
        self.assertIn("iqr", result["treatment_applied"])

    def test_no_outliers_leaves_data_unchanged(self):
        data = [{"value": v} for v in [10, 11, 12, 13, 14]]
        result = treat_outliers(
            data,
            column="value",
            method="iqr",
            treatment="remove",
        )
        self.assertEqual(result["outliers_treated"], 0)
        self.assertEqual(result["rows_after"], result["rows_before"])


if __name__ == "__main__":
    unittest.main()
