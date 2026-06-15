"""
EX13/14 · regression tests for the data-operations coercion + expression-eval
hardening (PY-5 boolean corruption, PY-6 asteval denylist).
"""
import unittest

import pandas as pd

from data_operations import (
    _FORBIDDEN_EXPR_TOKENS,
    coerce_to_boolean_with_warning,
)


class TestBooleanCoercion(unittest.TestCase):
    def test_recognised_truthy_falsy_tokens(self):
        s = pd.Series(["true", "false", "yes", "no", "1", "0", "T", "F"])
        result, ambiguous = coerce_to_boolean_with_warning(s)
        self.assertEqual(
            list(result), [True, False, True, False, True, False, True, False]
        )
        self.assertEqual(ambiguous, 0)

    def test_false_string_maps_to_false(self):
        # PY-5 regression: astype(bool) turned the string 'false' into True.
        s = pd.Series(["false", "false", "false"])
        result, _ = coerce_to_boolean_with_warning(s)
        self.assertFalse(bool(result.any()))

    def test_case_and_whitespace_insensitive(self):
        s = pd.Series([" TRUE ", "Yes", "  no"])
        result, ambiguous = coerce_to_boolean_with_warning(s)
        self.assertEqual(list(result), [True, True, False])
        self.assertEqual(ambiguous, 0)

    def test_unrecognised_values_counted_ambiguous_and_false(self):
        s = pd.Series(["true", "maybe", "2"])
        result, ambiguous = coerce_to_boolean_with_warning(s)
        self.assertEqual(list(result), [True, False, False])
        self.assertEqual(ambiguous, 2)

    def test_nan_is_false_not_ambiguous(self):
        s = pd.Series(["true", None])
        result, ambiguous = coerce_to_boolean_with_warning(s)
        self.assertEqual(list(result), [True, False])
        self.assertEqual(ambiguous, 0)


class TestExpressionDenylist(unittest.TestCase):
    def test_io_tokens_are_forbidden(self):
        for tok in ("to_csv", "import", "open(", "system", "subprocess", "__"):
            self.assertIn(tok, _FORBIDDEN_EXPR_TOKENS)


if __name__ == "__main__":
    unittest.main()
