"""Unit tests for mmm.transforms — runnable via `python -m unittest`."""
import unittest

import numpy as np

from mmm.transforms import (
    geometric_adstock,
    hill_saturation,
    transform_channel,
    adstock_grid,
    hill_k_grid,
    hill_alpha_grid,
)


class TestGeometricAdstock(unittest.TestCase):
    def test_decay_zero_is_identity(self):
        x = np.array([10.0, 20.0, 30.0])
        np.testing.assert_array_almost_equal(geometric_adstock(x, 0.0), x)

    def test_known_sequence_decay_05(self):
        x = np.array([10.0, 0.0, 0.0, 0.0])
        # impulse at t=0 with decay 0.5 → 10, 5, 2.5, 1.25
        out = geometric_adstock(x, 0.5)
        np.testing.assert_array_almost_equal(out, [10.0, 5.0, 2.5, 1.25])

    def test_does_not_mutate_input(self):
        x = np.array([1.0, 2.0, 3.0])
        x_orig = x.copy()
        geometric_adstock(x, 0.5)
        np.testing.assert_array_equal(x, x_orig)

    def test_invalid_decay_raises(self):
        with self.assertRaises(ValueError):
            geometric_adstock(np.array([1.0]), -0.1)
        with self.assertRaises(ValueError):
            geometric_adstock(np.array([1.0]), 1.0)


class TestHillSaturation(unittest.TestCase):
    def test_at_half_saturation_value_is_half(self):
        # f(k) = k^a / (k^a + k^a) = 0.5
        for k in [1.0, 5.0, 100.0]:
            for a in [0.5, 1.0, 2.0]:
                self.assertAlmostEqual(
                    float(hill_saturation(np.array([k]), k, a)[0]), 0.5, places=6
                )

    def test_zero_input_is_zero(self):
        self.assertEqual(float(hill_saturation(np.array([0.0]), 1.0, 1.0)[0]), 0.0)

    def test_monotone_increasing(self):
        x = np.linspace(0, 100, 50)
        y = hill_saturation(x, 25.0, 2.0)
        self.assertTrue(np.all(np.diff(y) >= -1e-12))

    def test_alpha_steepness(self):
        # higher alpha → sharper transition around k → larger gap between f(0.5k) and f(2k)
        x = np.array([0.5, 2.0])  # symmetric around k=1
        gap_low_alpha = float(np.diff(hill_saturation(x, 1.0, 1.0))[0])
        gap_high_alpha = float(np.diff(hill_saturation(x, 1.0, 4.0))[0])
        self.assertGreater(gap_high_alpha, gap_low_alpha)

    def test_invalid_params_raise(self):
        with self.assertRaises(ValueError):
            hill_saturation(np.array([1.0]), 0.0, 1.0)
        with self.assertRaises(ValueError):
            hill_saturation(np.array([1.0]), 1.0, 0.0)


class TestComposition(unittest.TestCase):
    def test_transform_channel_equals_compose(self):
        x = np.array([1.0, 2.0, 3.0, 4.0])
        decay, k, a = 0.3, 2.0, 1.5
        expected = hill_saturation(geometric_adstock(x, decay), k, a)
        actual = transform_channel(x, decay, k, a)
        np.testing.assert_array_almost_equal(actual, expected)


class TestGrids(unittest.TestCase):
    def test_adstock_grid_default(self):
        g = adstock_grid()
        self.assertEqual(g[0], 0.0)
        self.assertLess(max(g), 1.0)
        self.assertGreater(len(g), 1)

    def test_hill_k_grid_anchors_to_spend_quantiles(self):
        spend = np.linspace(1, 100, 200)
        g = hill_k_grid(spend, n=5)
        self.assertEqual(len(g), 5)
        self.assertGreater(min(g), 0)
        self.assertLessEqual(max(g), 100)

    def test_hill_k_grid_handles_all_zero(self):
        g = hill_k_grid(np.zeros(10))
        self.assertEqual(g, [1.0])

    def test_hill_alpha_grid_includes_unity(self):
        self.assertIn(1.0, hill_alpha_grid())


if __name__ == "__main__":
    unittest.main()
