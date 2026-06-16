"""Machine Learning Model Training Functions

CQ-4 / PY-3 refactor: the ~25 public ``train_*`` functions used to each carry a
fully copy-pasted train→split→fit→predict→metrics→assemble skeleton (~3,300 LOC).
The shared mechanics now live in a small set of internal templates
(:func:`_run_supervised`, :func:`_run_unsupervised`) plus per-feature config, and
every public ``train_<model>`` is a thin wrapper. Public names, signatures and
return-dict shapes are unchanged — the FastAPI ``/train-model`` dispatch and its
callers see identical behaviour.

PY-3: the previous uniform ``except Exception: raise ValueError(...) from None``
swallowed the root cause. We now preserve the cause (``from e``) and log the
traceback exactly once via :data:`logger`, while keeping ``ValueError`` as the
type that crosses the FastAPI boundary for genuine training failures (so the
HTTP 400 mapping in ``main.py`` is unchanged). Genuine input-validation still
raises ``ValueError`` directly (no double-log) via the ``_InputError`` marker.

PY-2: model types whose backing library is NOT pinned in ``requirements.txt``
(xgboost, lightgbm, catboost, umap-learn, statsmodels, tensorflow, lifelines)
raise :class:`MissingDependencyError` when the import is absent. ``main.py`` maps
that to HTTP 501 Not-Implemented so a deployment that DOES install the optional
lib keeps working, while the default image gives a clear, distinct status.
"""
from collections.abc import Callable
from typing import Any, Literal

import numpy as np
import pandas as pd
from sklearn.cluster import (
    DBSCAN,
    AgglomerativeClustering,
    KMeans,
)
from sklearn.covariance import EllipticEnvelope
from sklearn.decomposition import PCA
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis, QuadraticDiscriminantAnalysis
from sklearn.ensemble import (
    ExtraTreesClassifier,
    ExtraTreesRegressor,
    GradientBoostingClassifier,
    GradientBoostingRegressor,
    IsolationForest,
    RandomForestClassifier,
    RandomForestRegressor,
)
from sklearn.linear_model import (
    BayesianRidge,
    ElasticNet,
    Lasso,
    LinearRegression,
    LogisticRegression,
    Ridge,
)
from sklearn.manifold import TSNE
from sklearn.metrics import (
    accuracy_score,
    f1_score,
    mean_absolute_error,
    mean_squared_error,
    precision_score,
    r2_score,
    recall_score,
    silhouette_score,
)
from sklearn.model_selection import cross_val_score, train_test_split
from sklearn.naive_bayes import BernoulliNB, GaussianNB, MultinomialNB
from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor
from sklearn.neural_network import MLPClassifier, MLPRegressor
from sklearn.preprocessing import PolynomialFeatures, StandardScaler
from sklearn.svm import SVC, SVR
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor

from logging_config import get_logger

logger = get_logger(__name__)

# Optional imports for advanced models
try:
    import xgboost as xgb
    XGBOOST_AVAILABLE = True
except ImportError:
    XGBOOST_AVAILABLE = False

try:
    import lightgbm as lgb
    LIGHTGBM_AVAILABLE = True
except ImportError:
    LIGHTGBM_AVAILABLE = False

try:
    import catboost as cb
    CATBOOST_AVAILABLE = True
except ImportError:
    CATBOOST_AVAILABLE = False

try:
    from sklearn.gaussian_process import GaussianProcessRegressor
    from sklearn.gaussian_process.kernels import RBF
    from sklearn.gaussian_process.kernels import ConstantKernel as C
    GAUSSIAN_PROCESS_AVAILABLE = True
except ImportError:
    GAUSSIAN_PROCESS_AVAILABLE = False

try:
    from statsmodels.tsa.arima.model import ARIMA
    from statsmodels.tsa.holtwinters import ExponentialSmoothing
    from statsmodels.tsa.statespace.sarimax import SARIMAX
    STATSMODELS_AVAILABLE = True
except ImportError:
    STATSMODELS_AVAILABLE = False

try:
    from umap import UMAP
    UMAP_AVAILABLE = True
except ImportError:
    UMAP_AVAILABLE = False

try:
    from hdbscan import HDBSCAN  # noqa: F401
    HDBSCAN_AVAILABLE = True
except ImportError:
    HDBSCAN_AVAILABLE = False


# ============================================================================
# ERROR HANDLING (PY-3 / PY-2)
# ============================================================================

class MissingDependencyError(Exception):
    """PY-2: a model type whose backing library is absent at runtime.

    ``main.py`` maps this to HTTP 501 Not-Implemented (distinct from the 400 a
    ``ValueError`` produces) so an operator can tell "you asked for a model the
    image doesn't ship" apart from "your input was invalid".
    """


class _InputError(ValueError):
    """Internal marker: a genuine input-validation failure raised inside the
    training body. It is a ``ValueError`` (so the boundary still returns 400)
    but ``_train`` re-raises it verbatim WITHOUT logging a traceback, since the
    cause is the caller's data, not a server fault."""


def _train(label: str, fn: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    """PY-3 shared error boundary for every public ``train_*`` function.

    Runs ``fn`` and:
      * passes :class:`MissingDependencyError` through untouched (→ 501);
      * passes :class:`_InputError` through as a plain ``ValueError`` (→ 400),
        WITHOUT logging — it is expected user-input noise;
      * wraps any other exception in ``ValueError(f"Error training {label}: ...")``
        with the original cause preserved (``from e``) and the traceback logged
        exactly once. This keeps the ``ValueError → HTTP 400`` contract that
        ``main.py`` relies on while no longer hiding the root cause.
    """
    try:
        return fn()
    except MissingDependencyError:
        raise
    except _InputError as e:
        # Genuine input validation. The original code raised these inside the
        # try and let the blanket handler prepend "Error training {label}: ",
        # so we keep that exact wording for response-shape parity — but DON'T
        # log a server-side traceback (the cause is the caller's data).
        raise ValueError(f"Error training {label}: {str(e)}") from None
    except ValueError as e:
        # A plain ValueError raised inside the body (e.g. from _prepare_data or
        # a defensive ImportError->ValueError) is also caller-facing; preserve
        # the prefixed message and the 400 mapping, no traceback log.
        raise ValueError(f"Error training {label}: {str(e)}") from e
    except Exception as e:
        # Genuine server/library fault: log the traceback ONCE (PY-3 — no longer
        # silently swallowed), preserve the cause, and keep the ValueError type
        # so the HTTP status is unchanged (400, exactly as before).
        logger.error("Error training %s", label, exc_info=True)
        raise ValueError(f"Error training {label}: {str(e)}") from e


def _require(available: bool, model_label: str, pip_name: str) -> None:
    """PY-2 guard for an optional dependency. Raises :class:`MissingDependencyError`
    (→ HTTP 501) when the backing library is not installed."""
    if not available:
        raise MissingDependencyError(
            f"{model_label} is not available: install it with `pip install {pip_name}`"
        )


# ============================================================================
# DATA PREP + METRICS (shared)
# ============================================================================

def _prepare_data(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str]
) -> tuple:
    """
    Prepare data for model training.

    Returns:
        X (DataFrame): Feature matrix
        y (Series): Target variable
    """
    df = pd.DataFrame(data)

    if len(df) == 0:
        raise ValueError("Dataset is empty")

    # Check if columns exist
    missing_cols = [col for col in [target_variable] + features if col not in df.columns]
    if missing_cols:
        raise ValueError(f"Columns not found in data: {', '.join(missing_cols)}. Available columns: {', '.join(df.columns.tolist()[:10])}")

    # Extract features and target
    X = df[features].copy()
    y = df[target_variable].copy()

    # Check initial null counts for better error messages
    initial_rows = len(df)
    target_null_count = y.isna().sum()
    feature_null_counts = {col: X[col].isna().sum() for col in features}

    # Convert to numeric, coercing errors to NaN
    for col in features:
        if not pd.api.types.is_numeric_dtype(X[col]):
            X[col] = pd.to_numeric(X[col], errors='coerce')

    if not pd.api.types.is_numeric_dtype(y):
        y = pd.to_numeric(y, errors='coerce')

    # Check how many rows have valid target
    valid_target_mask = ~y.isna()
    valid_target_count = valid_target_mask.sum()

    if valid_target_count == 0:
        raise ValueError(
            f"Target variable '{target_variable}' has no valid numeric values. "
            f"All {initial_rows} rows have null or non-numeric values in the target variable."
        )

    # Remove rows with NaN in target
    X = X[valid_target_mask]
    y = y[valid_target_mask]

    # Check how many rows have at least one valid feature
    feature_valid_mask = X.notna().any(axis=1)
    valid_feature_count = feature_valid_mask.sum()

    if valid_feature_count == 0:
        raise ValueError(
            f"After removing rows with null target values, no rows have valid feature values. "
            f"Target variable '{target_variable}' had {valid_target_count} valid values, "
            f"but all features are null in those rows. "
            f"Feature null counts: {feature_null_counts}"
        )

    # Remove rows where all features are NaN
    X = X[feature_valid_mask]
    y = y[feature_valid_mask]

    # Fill remaining NaN in features with mean (only for columns that have at least one non-null value)
    for col in X.columns:
        if X[col].isna().any():
            col_mean = X[col].mean()
            if pd.isna(col_mean):
                # If mean is NaN, all values are NaN - this shouldn't happen after filtering, but handle it
                raise ValueError(f"Feature '{col}' has no valid numeric values after cleaning")
            X[col] = X[col].fillna(col_mean)

    if len(X) == 0:
        raise ValueError(
            f"No valid data rows after cleaning. "
            f"Initial rows: {initial_rows}, "
            f"Rows with valid target: {valid_target_count}, "
            f"Rows with valid features: {valid_feature_count}"
        )

    if len(X) < 2:
        raise ValueError(
            f"Need at least 2 data points to train a model, but only {len(X)} valid row(s) found after cleaning. "
            f"Initial rows: {initial_rows}, "
            f"Target nulls: {target_null_count}, "
            f"Feature nulls: {feature_null_counts}"
        )

    return X, y


def _determine_task_type(y: pd.Series) -> Literal["regression", "classification"]:
    """Determine if task is regression or classification based on target variable."""
    # If target is numeric and has many unique values, treat as regression
    if pd.api.types.is_numeric_dtype(y):
        unique_ratio = y.nunique() / len(y)
        # If more than 10% unique values, treat as regression
        if unique_ratio > 0.1:
            return "regression"
        # If binary (2 unique values), treat as classification
        elif y.nunique() == 2:
            return "classification"
        # If few unique values, treat as classification
        else:
            return "classification"
    else:
        return "classification"


def _calculate_regression_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict[str, float]:
    """Calculate regression metrics."""
    return {
        "r2_score": float(r2_score(y_true, y_pred)),
        "rmse": float(np.sqrt(mean_squared_error(y_true, y_pred))),
        "mae": float(mean_absolute_error(y_true, y_pred)),
        "mse": float(mean_squared_error(y_true, y_pred))
    }


def _calculate_classification_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict[str, Any]:
    """Calculate classification metrics."""
    accuracy = float(accuracy_score(y_true, y_pred))

    # For binary classification, calculate precision, recall, F1
    if len(np.unique(y_true)) == 2:
        precision = float(precision_score(y_true, y_pred, average='binary', zero_division=0))
        recall = float(recall_score(y_true, y_pred, average='binary', zero_division=0))
        f1 = float(f1_score(y_true, y_pred, average='binary', zero_division=0))
    else:
        # Multi-class
        precision = float(precision_score(y_true, y_pred, average='weighted', zero_division=0))
        recall = float(recall_score(y_true, y_pred, average='weighted', zero_division=0))
        f1 = float(f1_score(y_true, y_pred, average='weighted', zero_division=0))

    return {
        "accuracy": accuracy,
        "precision": precision,
        "recall": recall,
        "f1_score": f1
    }


def _coefficients(model, features: list[str]) -> dict[str, Any]:
    """Linear-family coefficient block: intercept + per-feature weights."""
    return {
        "intercept": float(model.intercept_),
        "features": {
            feature: float(coef) for feature, coef in zip(features, model.coef_, strict=False)
        }
    }


def _feature_importance(model, features: list[str]) -> dict[str, float]:
    """Tree/ensemble feature-importance block."""
    return {
        feature: float(importance)
        for feature, importance in zip(features, model.feature_importances_, strict=False)
    }


# ============================================================================
# SUPERVISED TEMPLATE
# ============================================================================

def _run_supervised(
    *,
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    test_size: float,
    random_state: int,
    make_regressor: Callable[[], Any] | None,
    make_classifier: Callable[[], Any] | None,
    forced_task_type: str | None = None,
    scale_features: bool = False,
    stratify: bool = False,
    has_coefficients: bool = False,
    has_feature_importance: bool = False,
    extra_fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Shared supervised skeleton: prepare → (scale) → task → split → fit →
    predict → metrics → CV → assemble. Mirrors the exact logic the individual
    train_* functions used; flags select the per-model variations.

    ``model_type`` / ``task_type`` are NOT set here — the caller assembles the
    final dict from this template's output so the public return shape (field
    order, extra params) stays byte-for-byte identical.
    """
    X, y = _prepare_data(data, target_variable, features)

    fit_X = X
    if scale_features:
        scaler = StandardScaler()
        fit_X = pd.DataFrame(scaler.fit_transform(X), columns=X.columns, index=X.index)

    task_type = forced_task_type or _determine_task_type(y)

    stratify_arg = y if (stratify and task_type == "classification" and y.nunique() > 1) else None
    X_train, X_test, y_train, y_test = train_test_split(
        fit_X, y, test_size=test_size, random_state=random_state, stratify=stratify_arg
    )

    if task_type == "regression":
        model = make_regressor()
    else:
        model = make_classifier()

    model.fit(X_train, y_train)

    y_train_pred = model.predict(X_train)
    y_test_pred = model.predict(X_test)

    if task_type == "regression":
        train_metrics = _calculate_regression_metrics(y_train.values, y_train_pred)
        test_metrics = _calculate_regression_metrics(y_test.values, y_test_pred)
        cv_scoring = 'r2'
    else:
        train_metrics = _calculate_classification_metrics(y_train.values, y_train_pred)
        test_metrics = _calculate_classification_metrics(y_test.values, y_test_pred)
        cv_scoring = 'accuracy'

    cv_scores = cross_val_score(model, fit_X, y, cv=5, scoring=cv_scoring)

    y_pred_full = model.predict(fit_X)

    result: dict[str, Any] = {
        "task_type": task_type,
        "target_variable": target_variable,
        "features": features,
    }
    if extra_fields:
        result.update(extra_fields)

    result["coefficients"] = _coefficients(model, features) if has_coefficients else None
    result["metrics"] = {
        "train": train_metrics,
        "test": test_metrics,
        "cross_validation": {
            f"mean_{cv_scoring}": float(cv_scores.mean()),
            f"std_{cv_scoring}": float(cv_scores.std())
        }
    }
    result["predictions"] = y_pred_full.tolist()
    result["feature_importance"] = _feature_importance(model, features) if has_feature_importance else None
    result["n_samples"] = len(X)
    result["n_train"] = len(X_train)
    result["n_test"] = len(X_test)
    return result


def _run_unsupervised_prep(
    data: list[dict[str, Any]],
    features: list[str],
    scale: bool = True,
) -> tuple:
    """Shared unsupervised/anomaly/dimensionality prep: prepare → select
    features → (scale). Returns (X, X_for_model)."""
    X, _ = _prepare_data(data, features[0], features)  # first feature as dummy target
    X = X[features]
    if scale:
        scaler = StandardScaler()
        return X, scaler.fit_transform(X)
    return X, X.values


# ============================================================================
# LINEAR / REGRESSION MODELS
# ============================================================================

def train_linear_regression(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a linear regression model."""
    def _build() -> dict[str, Any]:
        result = _run_supervised(
            data=data, target_variable=target_variable, features=features,
            test_size=test_size, random_state=random_state,
            make_regressor=lambda: LinearRegression(), make_classifier=None,
            forced_task_type="regression", has_coefficients=True,
        )
        return {"model_type": "linear_regression", **result}
    return _train("linear regression", _build)


def train_ridge_regression(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    alpha: float = 1.0,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a ridge regression model."""
    def _build() -> dict[str, Any]:
        result = _run_supervised(
            data=data, target_variable=target_variable, features=features,
            test_size=test_size, random_state=random_state,
            make_regressor=lambda: Ridge(alpha=alpha, random_state=random_state),
            make_classifier=None, forced_task_type="regression",
            has_coefficients=True, extra_fields={"alpha": alpha},
        )
        return {"model_type": "ridge_regression", **result}
    return _train("ridge regression", _build)


def train_lasso_regression(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    alpha: float = 1.0,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a lasso regression model."""
    def _build() -> dict[str, Any]:
        result = _run_supervised(
            data=data, target_variable=target_variable, features=features,
            test_size=test_size, random_state=random_state,
            make_regressor=lambda: Lasso(alpha=alpha, random_state=random_state, max_iter=1000),
            make_classifier=None, forced_task_type="regression",
            has_coefficients=True, extra_fields={"alpha": alpha},
        )
        return {"model_type": "lasso_regression", **result}
    return _train("lasso regression", _build)


def train_elasticnet(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    alpha: float = 1.0,
    l1_ratio: float = 0.5,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train an ElasticNet regression model (L1 + L2 regularization)."""
    def _build() -> dict[str, Any]:
        result = _run_supervised(
            data=data, target_variable=target_variable, features=features,
            test_size=test_size, random_state=random_state,
            make_regressor=lambda: ElasticNet(alpha=alpha, l1_ratio=l1_ratio, random_state=random_state, max_iter=1000),
            make_classifier=None, forced_task_type="regression",
            has_coefficients=True, extra_fields={"alpha": alpha, "l1_ratio": l1_ratio},
        )
        return {"model_type": "elasticnet", **result}
    return _train("ElasticNet", _build)


def train_bayesian_regression(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    alpha_1: float = 1e-6,
    alpha_2: float = 1e-6,
    lambda_1: float = 1e-6,
    lambda_2: float = 1e-6,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a Bayesian ridge regression model."""
    def _build() -> dict[str, Any]:
        result = _run_supervised(
            data=data, target_variable=target_variable, features=features,
            test_size=test_size, random_state=random_state,
            make_regressor=lambda: BayesianRidge(
                alpha_1=alpha_1, alpha_2=alpha_2, lambda_1=lambda_1, lambda_2=lambda_2
            ),
            make_classifier=None, forced_task_type="regression", has_coefficients=True,
        )
        return {"model_type": "bayesian_regression", **result}
    return _train("Bayesian regression", _build)


def train_log_log_regression(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    test_size: float = 0.2,
    random_state: int = 42,
    offset: float = 1.0
) -> dict[str, Any]:
    """
    Train a log-log regression model.

    A log-log model applies log transformation to both the target variable
    and all feature variables before training a linear regression. This is useful
    for modeling multiplicative relationships and elasticity analysis.

    Args:
        data: List of dictionaries containing the data
        target_variable: Name of the target variable
        features: List of feature variable names
        test_size: Proportion of data to use for testing
        random_state: Random seed for reproducibility
        offset: Offset to add before log transformation (to handle zeros/negatives)

    Returns:
        Dictionary containing model results, metrics, and coefficients
    """
    def _build() -> dict[str, Any]:
        X, y = _prepare_data(data, target_variable, features)

        # Check for non-positive values that would cause issues with log transformation
        if (y <= 0).any():
            negative_or_zero_count = (y <= 0).sum()
            raise _InputError(
                f"Log-log model requires all target values to be positive. "
                f"Found {negative_or_zero_count} non-positive values in '{target_variable}'. "
                f"Consider using an offset or filtering out non-positive values."
            )

        for feature in features:
            if (X[feature] <= 0).any():
                negative_or_zero_count = (X[feature] <= 0).sum()
                raise _InputError(
                    f"Log-log model requires all feature values to be positive. "
                    f"Found {negative_or_zero_count} non-positive values in feature '{feature}'. "
                    f"Consider using an offset or filtering out non-positive values."
                )

        # Apply log transformation to target and features
        y_log = np.log(y)
        X_log = X.copy()
        for feature in features:
            X_log[feature] = np.log(X_log[feature])

        X_train, X_test, y_train, y_test = train_test_split(
            X_log, y_log, test_size=test_size, random_state=random_state
        )

        model = LinearRegression()
        model.fit(X_train, y_train)

        # Predictions (log space) → back to original scale
        y_train_pred = np.exp(model.predict(X_train))
        y_test_pred = np.exp(model.predict(X_test))
        y_train_actual = np.exp(y_train.values)
        y_test_actual = np.exp(y_test.values)

        train_metrics = _calculate_regression_metrics(y_train_actual, y_train_pred)
        test_metrics = _calculate_regression_metrics(y_test_actual, y_test_pred)

        cv_scores = cross_val_score(model, X_log, y_log, cv=5, scoring='r2')

        coefficients = {
            "intercept": float(model.intercept_),
            "features": {
                feature: float(coef) for feature, coef in zip(features, model.coef_, strict=False)
            },
            "interpretation": "Coefficients represent elasticities: a 1% change in a feature leads to a (coefficient)% change in the target variable"
        }

        y_pred_full = np.exp(model.predict(X_log))

        return {
            "model_type": "log_log_regression",
            "task_type": "regression",
            "target_variable": target_variable,
            "features": features,
            "coefficients": coefficients,
            "metrics": {
                "train": train_metrics,
                "test": test_metrics,
                "cross_validation": {
                    "mean_r2": float(cv_scores.mean()),
                    "std_r2": float(cv_scores.std())
                }
            },
            "predictions": y_pred_full.tolist(),
            "feature_importance": None,
            "n_samples": len(X),
            "n_train": len(X_train),
            "n_test": len(X_test),
            "transformation_applied": "log-log transformation applied to both target and features",
            "note": "Model coefficients represent elasticities. A coefficient of 0.5 means a 1% increase in the feature leads to a 0.5% increase in the target."
        }
    return _train("log-log regression", _build)


def train_logistic_regression(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a logistic regression model."""
    def _build() -> dict[str, Any]:
        X, y = _prepare_data(data, target_variable, features)

        task_type = _determine_task_type(y)

        unique_values = sorted(y.unique())
        is_binary = len(unique_values) == 2

        if is_binary and set(unique_values).issubset({0, 1}):
            task_type = "classification"
        elif is_binary:
            y = y.map({unique_values[0]: 0, unique_values[1]: 1})
            task_type = "classification"
        elif task_type != "classification":
            median = y.median()
            y = (y > median).astype(int)
            task_type = "classification"

        use_stratify = len(y.unique()) == 2 and min(y.value_counts()) >= 2

        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=test_size, random_state=random_state, stratify=y if use_stratify else None
        )

        model = LogisticRegression(max_iter=1000, random_state=random_state)
        model.fit(X_train, y_train)

        y_train_pred = model.predict(X_train)
        y_test_pred = model.predict(X_test)

        train_metrics = _calculate_classification_metrics(y_train.values, y_train_pred)
        test_metrics = _calculate_classification_metrics(y_test.values, y_test_pred)

        cv_scores = cross_val_score(model, X, y, cv=5, scoring='accuracy')

        # coef_ has shape (n_classes, n_features); for binary take first row
        coef_array = model.coef_[0] if len(model.coef_.shape) > 1 else model.coef_
        coefficients = {
            "intercept": float(model.intercept_[0]) if len(model.intercept_) == 1 else model.intercept_.tolist(),
            "features": {
                feature: float(coef)
                for feature, coef in zip(features, coef_array, strict=False)
            }
        }

        y_pred_full = model.predict(X)

        return {
            "model_type": "logistic_regression",
            "task_type": "classification",
            "target_variable": target_variable,
            "features": features,
            "coefficients": coefficients,
            "metrics": {
                "train": train_metrics,
                "test": test_metrics,
                "cross_validation": {
                    "mean_accuracy": float(cv_scores.mean()),
                    "std_accuracy": float(cv_scores.std())
                }
            },
            "predictions": y_pred_full.tolist(),
            "feature_importance": None,
            "n_samples": len(X),
            "n_train": len(X_train),
            "n_test": len(X_test)
        }
    return _train("logistic regression", _build)


def train_polynomial_regression(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    degree: int = 2,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a polynomial regression model."""
    def _build() -> dict[str, Any]:
        X, y = _prepare_data(data, target_variable, features)

        poly = PolynomialFeatures(degree=degree, include_bias=False)
        X_poly = poly.fit_transform(X)
        X_poly = pd.DataFrame(X_poly, columns=[f"poly_{i}" for i in range(X_poly.shape[1])])

        X_train, X_test, y_train, y_test = train_test_split(
            X_poly, y, test_size=test_size, random_state=random_state
        )

        model = LinearRegression()
        model.fit(X_train, y_train)

        y_train_pred = model.predict(X_train)
        y_test_pred = model.predict(X_test)

        train_metrics = _calculate_regression_metrics(y_train.values, y_train_pred)
        test_metrics = _calculate_regression_metrics(y_test.values, y_test_pred)

        cv_scores = cross_val_score(model, X_poly, y, cv=5, scoring='r2')

        return {
            "model_type": "polynomial_regression",
            "task_type": "regression",
            "target_variable": target_variable,
            "features": features,
            "degree": degree,
            "coefficients": {
                "intercept": float(model.intercept_),
                "n_coefficients": len(model.coef_)
            },
            "metrics": {
                "train": train_metrics,
                "test": test_metrics,
                "cross_validation": {
                    "mean_r2": float(cv_scores.mean()),
                    "std_r2": float(cv_scores.std())
                }
            },
            "predictions": model.predict(X_poly).tolist(),
            "feature_importance": None,
            "n_samples": len(X),
            "n_train": len(X_train),
            "n_test": len(X_test)
        }
    return _train("polynomial regression", _build)


def _train_glm_regression(
    *,
    model_type: str,
    label: str,
    import_error_msg: str,
    make_model: Callable[[], Any],
    import_model: Callable[[], None],
    sign_check: Callable[[pd.Series], None] | None,
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    test_size: float,
    random_state: int,
    extra_fields: dict[str, Any],
) -> dict[str, Any]:
    """Shared body for the sklearn GLM-family regressors (quantile, poisson,
    gamma, tweedie) — each lazily imports its estimator, optionally sign-checks
    the target, then runs the standard regression skeleton with coefficients."""
    # Defensive import (these estimators ship with the pinned scikit-learn, so
    # this only fires on a downgrade). Match the original: a bare, unprefixed
    # ValueError -> HTTP 400, raised OUTSIDE the _train wrapper so it is not
    # given the "Error training ..." prefix.
    try:
        import_model()
    except ImportError:
        raise ValueError(import_error_msg) from None

    def _build() -> dict[str, Any]:
        X, y = _prepare_data(data, target_variable, features)

        if sign_check is not None:
            sign_check(y)

        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=test_size, random_state=random_state
        )

        model = make_model()
        model.fit(X_train, y_train)

        train_metrics = _calculate_regression_metrics(y_train.values, model.predict(X_train))
        test_metrics = _calculate_regression_metrics(y_test.values, model.predict(X_test))

        cv_scores = cross_val_score(model, X, y, cv=5, scoring='r2')

        result: dict[str, Any] = {
            "model_type": model_type,
            "task_type": "regression",
            "target_variable": target_variable,
            "features": features,
        }
        result.update(extra_fields)
        result["coefficients"] = _coefficients(model, features)
        result["metrics"] = {
            "train": train_metrics,
            "test": test_metrics,
            "cross_validation": {
                "mean_r2": float(cv_scores.mean()),
                "std_r2": float(cv_scores.std())
            }
        }
        result["predictions"] = model.predict(X).tolist()
        result["feature_importance"] = None
        result["n_samples"] = len(X)
        result["n_train"] = len(X_train)
        result["n_test"] = len(X_test)
        return result
    return _train(label, _build)


def train_quantile_regression(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    quantile: float = 0.5,
    alpha: float = 1.0,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a quantile regression model."""
    def _import() -> None:
        global QuantileRegressor
        from sklearn.linear_model import QuantileRegressor

    return _train_glm_regression(
        model_type="quantile_regression", label="quantile regression",
        import_error_msg="QuantileRegressor requires scikit-learn >= 1.0. Please upgrade scikit-learn.",
        import_model=_import,
        make_model=lambda: QuantileRegressor(quantile=quantile, alpha=alpha, solver='highs'),
        sign_check=None,
        data=data, target_variable=target_variable, features=features,
        test_size=test_size, random_state=random_state,
        extra_fields={"quantile": quantile},
    )


def train_poisson_regression(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    alpha: float = 1.0,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a Poisson regression model (for count data)."""
    def _import() -> None:
        global PoissonRegressor
        from sklearn.linear_model import PoissonRegressor

    def _check(y: pd.Series) -> None:
        if (y < 0).any():
            raise _InputError("Poisson regression requires non-negative target values")

    return _train_glm_regression(
        model_type="poisson_regression", label="Poisson regression",
        import_error_msg="PoissonRegressor requires scikit-learn >= 0.23. Please upgrade scikit-learn.",
        import_model=_import,
        make_model=lambda: PoissonRegressor(alpha=alpha, max_iter=1000),
        sign_check=_check,
        data=data, target_variable=target_variable, features=features,
        test_size=test_size, random_state=random_state,
        extra_fields={"alpha": alpha},
    )


def train_gamma_regression(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    alpha: float = 1.0,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a Gamma regression model (for positive continuous data)."""
    def _import() -> None:
        global GammaRegressor
        from sklearn.linear_model import GammaRegressor

    def _check(y: pd.Series) -> None:
        if (y <= 0).any():
            raise _InputError("Gamma regression requires positive target values")

    return _train_glm_regression(
        model_type="gamma_regression", label="Gamma regression",
        import_error_msg="GammaRegressor requires scikit-learn >= 0.23. Please upgrade scikit-learn.",
        import_model=_import,
        make_model=lambda: GammaRegressor(alpha=alpha, max_iter=1000),
        sign_check=_check,
        data=data, target_variable=target_variable, features=features,
        test_size=test_size, random_state=random_state,
        extra_fields={"alpha": alpha},
    )


def train_tweedie_regression(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    power: float = 0.0,
    alpha: float = 1.0,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a Tweedie regression model."""
    def _import() -> None:
        global TweedieRegressor
        from sklearn.linear_model import TweedieRegressor

    def _check(y: pd.Series) -> None:
        if (y < 0).any():
            raise _InputError("Tweedie regression requires non-negative target values")

    return _train_glm_regression(
        model_type="tweedie_regression", label="Tweedie regression",
        import_error_msg="TweedieRegressor requires scikit-learn >= 0.23. Please upgrade scikit-learn.",
        import_model=_import,
        make_model=lambda: TweedieRegressor(power=power, alpha=alpha, max_iter=1000),
        sign_check=_check,
        data=data, target_variable=target_variable, features=features,
        test_size=test_size, random_state=random_state,
        extra_fields={"power": power, "alpha": alpha},
    )


# ============================================================================
# TREE / ENSEMBLE MODELS (dual task, feature importance)
# ============================================================================

def train_random_forest(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    n_estimators: int = 100,
    max_depth: int | None = None,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a random forest model (regression or classification)."""
    def _build() -> dict[str, Any]:
        result = _run_supervised(
            data=data, target_variable=target_variable, features=features,
            test_size=test_size, random_state=random_state,
            make_regressor=lambda: RandomForestRegressor(
                n_estimators=n_estimators, max_depth=max_depth, random_state=random_state),
            make_classifier=lambda: RandomForestClassifier(
                n_estimators=n_estimators, max_depth=max_depth, random_state=random_state),
            stratify=True, has_feature_importance=True,
            extra_fields={"n_estimators": n_estimators, "max_depth": max_depth},
        )
        return {"model_type": "random_forest", **result}
    return _train("random forest", _build)


def train_decision_tree(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    max_depth: int | None = None,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a decision tree model (regression or classification)."""
    def _build() -> dict[str, Any]:
        result = _run_supervised(
            data=data, target_variable=target_variable, features=features,
            test_size=test_size, random_state=random_state,
            make_regressor=lambda: DecisionTreeRegressor(max_depth=max_depth, random_state=random_state),
            make_classifier=lambda: DecisionTreeClassifier(max_depth=max_depth, random_state=random_state),
            stratify=True, has_feature_importance=True,
            extra_fields={"max_depth": max_depth},
        )
        return {"model_type": "decision_tree", **result}
    return _train("decision tree", _build)


def train_gradient_boosting(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    n_estimators: int = 100,
    learning_rate: float = 0.1,
    max_depth: int | None = 3,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a gradient boosting model (regression or classification)."""
    def _build() -> dict[str, Any]:
        result = _run_supervised(
            data=data, target_variable=target_variable, features=features,
            test_size=test_size, random_state=random_state,
            make_regressor=lambda: GradientBoostingRegressor(
                n_estimators=n_estimators, learning_rate=learning_rate,
                max_depth=max_depth, random_state=random_state),
            make_classifier=lambda: GradientBoostingClassifier(
                n_estimators=n_estimators, learning_rate=learning_rate,
                max_depth=max_depth, random_state=random_state),
            stratify=True, has_feature_importance=True,
            extra_fields={"n_estimators": n_estimators, "learning_rate": learning_rate, "max_depth": max_depth},
        )
        return {"model_type": "gradient_boosting", **result}
    return _train("gradient boosting", _build)


def train_extra_trees(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    n_estimators: int = 100,
    max_depth: int | None = None,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train an Extra Trees model (regression or classification)."""
    def _build() -> dict[str, Any]:
        result = _run_supervised(
            data=data, target_variable=target_variable, features=features,
            test_size=test_size, random_state=random_state,
            make_regressor=lambda: ExtraTreesRegressor(
                n_estimators=n_estimators, max_depth=max_depth, random_state=random_state),
            make_classifier=lambda: ExtraTreesClassifier(
                n_estimators=n_estimators, max_depth=max_depth, random_state=random_state),
            stratify=True, has_feature_importance=True,
            extra_fields={"n_estimators": n_estimators, "max_depth": max_depth},
        )
        return {"model_type": "extra_trees", **result}
    return _train("Extra Trees", _build)


def train_xgboost(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    n_estimators: int = 100,
    max_depth: int = 3,
    learning_rate: float = 0.1,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train an XGBoost model (regression or classification)."""
    _require(XGBOOST_AVAILABLE, "XGBoost", "xgboost")

    def _build() -> dict[str, Any]:
        result = _run_supervised(
            data=data, target_variable=target_variable, features=features,
            test_size=test_size, random_state=random_state,
            make_regressor=lambda: xgb.XGBRegressor(
                n_estimators=n_estimators, max_depth=max_depth,
                learning_rate=learning_rate, random_state=random_state),
            make_classifier=lambda: xgb.XGBClassifier(
                n_estimators=n_estimators, max_depth=max_depth,
                learning_rate=learning_rate, random_state=random_state),
            stratify=True, has_feature_importance=True,
            extra_fields={"n_estimators": n_estimators, "max_depth": max_depth, "learning_rate": learning_rate},
        )
        return {"model_type": "xgboost", **result}
    return _train("XGBoost", _build)


def train_lightgbm(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    n_estimators: int = 100,
    max_depth: int = -1,
    learning_rate: float = 0.1,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a LightGBM model (regression or classification)."""
    _require(LIGHTGBM_AVAILABLE, "LightGBM", "lightgbm")

    def _build() -> dict[str, Any]:
        result = _run_supervised(
            data=data, target_variable=target_variable, features=features,
            test_size=test_size, random_state=random_state,
            make_regressor=lambda: lgb.LGBMRegressor(
                n_estimators=n_estimators, max_depth=max_depth,
                learning_rate=learning_rate, random_state=random_state, verbose=-1),
            make_classifier=lambda: lgb.LGBMClassifier(
                n_estimators=n_estimators, max_depth=max_depth,
                learning_rate=learning_rate, random_state=random_state, verbose=-1),
            stratify=True, has_feature_importance=True,
            extra_fields={"n_estimators": n_estimators, "max_depth": max_depth, "learning_rate": learning_rate},
        )
        return {"model_type": "lightgbm", **result}
    return _train("LightGBM", _build)


def train_catboost(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    iterations: int = 100,
    depth: int = 6,
    learning_rate: float = 0.1,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a CatBoost model (regression or classification)."""
    _require(CATBOOST_AVAILABLE, "CatBoost", "catboost")

    def _build() -> dict[str, Any]:
        result = _run_supervised(
            data=data, target_variable=target_variable, features=features,
            test_size=test_size, random_state=random_state,
            make_regressor=lambda: cb.CatBoostRegressor(
                iterations=iterations, depth=depth, learning_rate=learning_rate,
                random_state=random_state, verbose=False),
            make_classifier=lambda: cb.CatBoostClassifier(
                iterations=iterations, depth=depth, learning_rate=learning_rate,
                random_state=random_state, verbose=False),
            stratify=True, has_feature_importance=True,
            extra_fields={"iterations": iterations, "depth": depth, "learning_rate": learning_rate},
        )
        return {"model_type": "catboost", **result}
    return _train("CatBoost", _build)


# ============================================================================
# SCALED DUAL-TASK MODELS (no coefficients, no feature importance)
# ============================================================================

def train_svm(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    kernel: str = 'rbf',
    C: float = 1.0,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a Support Vector Machine model (regression or classification)."""
    def _build() -> dict[str, Any]:
        result = _run_supervised(
            data=data, target_variable=target_variable, features=features,
            test_size=test_size, random_state=random_state,
            make_regressor=lambda: SVR(kernel=kernel, C=C),
            make_classifier=lambda: SVC(kernel=kernel, C=C, random_state=random_state),
            scale_features=True, stratify=True,
            extra_fields={"kernel": kernel, "C": C},
        )
        return {"model_type": "svm", **result}
    return _train("SVM", _build)


def train_knn(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    n_neighbors: int = 5,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a K-Nearest Neighbors model (regression or classification)."""
    def _build() -> dict[str, Any]:
        result = _run_supervised(
            data=data, target_variable=target_variable, features=features,
            test_size=test_size, random_state=random_state,
            make_regressor=lambda: KNeighborsRegressor(n_neighbors=n_neighbors),
            make_classifier=lambda: KNeighborsClassifier(n_neighbors=n_neighbors),
            scale_features=True, stratify=True,
            extra_fields={"n_neighbors": n_neighbors},
        )
        return {"model_type": "knn", **result}
    return _train("KNN", _build)


def train_mlp(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    hidden_layer_sizes: tuple = (100,),
    activation: str = 'relu',
    solver: str = 'adam',
    alpha: float = 0.0001,
    learning_rate: str = 'constant',
    max_iter: int = 200,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a Multi-Layer Perceptron (MLP) model (regression or classification)."""
    def _build() -> dict[str, Any]:
        result = _run_supervised(
            data=data, target_variable=target_variable, features=features,
            test_size=test_size, random_state=random_state,
            make_regressor=lambda: MLPRegressor(
                hidden_layer_sizes=hidden_layer_sizes, activation=activation,
                solver=solver, alpha=alpha, learning_rate=learning_rate,
                max_iter=max_iter, random_state=random_state),
            make_classifier=lambda: MLPClassifier(
                hidden_layer_sizes=hidden_layer_sizes, activation=activation,
                solver=solver, alpha=alpha, learning_rate=learning_rate,
                max_iter=max_iter, random_state=random_state),
            scale_features=True, stratify=True,
            extra_fields={
                "hidden_layer_sizes": hidden_layer_sizes,
                "activation": activation,
                "solver": solver,
            },
        )
        return {"model_type": "mlp", **result}
    return _train("MLP", _build)


def train_gaussian_process(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a Gaussian Process regression model."""
    # GaussianProcessRegressor ships with the pinned scikit-learn, so this guard
    # is defensive only. Keep the original bare ValueError (-> HTTP 400); GP is
    # NOT a PY-2 missing-dependency case (the lib is always present).
    if not GAUSSIAN_PROCESS_AVAILABLE:
        raise ValueError("Gaussian Process requires scikit-learn >= 0.18")

    def _build() -> dict[str, Any]:
        X, y = _prepare_data(data, target_variable, features)

        # Limit data size for GP (can be slow)
        if len(X) > 1000:
            X = X.sample(n=1000, random_state=random_state)
            y = y.loc[X.index]

        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=test_size, random_state=random_state
        )

        kernel = C(1.0, (1e-3, 1e3)) * RBF(1.0, (1e-2, 1e2))
        model = GaussianProcessRegressor(kernel=kernel, random_state=random_state, n_restarts_optimizer=5)
        model.fit(X_train, y_train)

        train_metrics = _calculate_regression_metrics(y_train.values, model.predict(X_train))
        test_metrics = _calculate_regression_metrics(y_test.values, model.predict(X_test))

        cv_scores = cross_val_score(model, X_train, y_train, cv=min(5, len(X_train)//10), scoring='r2')

        return {
            "model_type": "gaussian_process",
            "task_type": "regression",
            "target_variable": target_variable,
            "features": features,
            "coefficients": None,
            "metrics": {
                "train": train_metrics,
                "test": test_metrics,
                "cross_validation": {
                    "mean_r2": float(cv_scores.mean()) if len(cv_scores) > 0 else 0.0,
                    "std_r2": float(cv_scores.std()) if len(cv_scores) > 0 else 0.0
                }
            },
            "predictions": model.predict(X).tolist(),
            "feature_importance": None,
            "n_samples": len(X),
            "n_train": len(X_train),
            "n_test": len(X_test)
        }
    return _train("Gaussian Process", _build)


# ============================================================================
# ADDITIONAL CLASSIFICATION MODELS
# ============================================================================

def _train_multiclass_classifier(
    *,
    model_type: str,
    label: str,
    make_model: Callable[[], Any],
    min_classes_msg: str,
    cv_on: Literal["full", "train"],
    predict_on: Literal["full", "train"],
    bernoulli_binarize: bool,
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    test_size: float,
    random_state: int,
    extra_fields: dict[str, Any],
) -> dict[str, Any]:
    """Shared body for the always-classification estimators (multinomial
    logistic, LDA, QDA, naive bayes). Preserves each one's exact CV-source and
    prediction-source quirks via ``cv_on`` / ``predict_on``."""
    def _build() -> dict[str, Any]:
        X, y = _prepare_data(data, target_variable, features)

        unique_classes = y.nunique()
        if unique_classes < 2:
            raise _InputError(min_classes_msg)

        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=test_size, random_state=random_state,
            stratify=y if unique_classes > 1 else None
        )

        if bernoulli_binarize:
            X_train = (X_train > X_train.mean()).astype(int)
            X_test = (X_test > X_test.mean()).astype(int)

        model = make_model()
        model.fit(X_train, y_train)

        train_metrics = _calculate_classification_metrics(y_train.values, model.predict(X_train))
        test_metrics = _calculate_classification_metrics(y_test.values, model.predict(X_test))

        cv_source_X, cv_source_y = (X, y) if cv_on == "full" else (X_train, y_train)
        cv_scores = cross_val_score(model, cv_source_X, cv_source_y, cv=5, scoring='accuracy')

        predict_source = X if predict_on == "full" else X_train

        result: dict[str, Any] = {
            "model_type": model_type,
            "task_type": "classification",
            "target_variable": target_variable,
            "features": features,
        }
        result.update(extra_fields)
        result["coefficients"] = None
        result["metrics"] = {
            "train": train_metrics,
            "test": test_metrics,
            "cross_validation": {
                "mean_accuracy": float(cv_scores.mean()),
                "std_accuracy": float(cv_scores.std())
            }
        }
        result["predictions"] = model.predict(predict_source).tolist()
        result["feature_importance"] = None
        result["n_samples"] = len(X)
        result["n_train"] = len(X_train)
        result["n_test"] = len(X_test)
        return result
    return _train(label, _build)


def train_multinomial_logistic(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a multinomial logistic regression model."""
    # n_classes is computed inside the template; recompute for the extra field.
    def _build() -> dict[str, Any]:
        X, y = _prepare_data(data, target_variable, features)
        unique_classes = y.nunique()
        if unique_classes < 2:
            raise _InputError("Multinomial logistic regression requires at least 2 classes")

        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=test_size, random_state=random_state,
            stratify=y if unique_classes > 1 else None
        )

        model = LogisticRegression(multi_class='multinomial', max_iter=1000, random_state=random_state)
        model.fit(X_train, y_train)

        train_metrics = _calculate_classification_metrics(y_train.values, model.predict(X_train))
        test_metrics = _calculate_classification_metrics(y_test.values, model.predict(X_test))

        cv_scores = cross_val_score(model, X, y, cv=5, scoring='accuracy')

        return {
            "model_type": "multinomial_logistic",
            "task_type": "classification",
            "target_variable": target_variable,
            "features": features,
            "n_classes": unique_classes,
            "coefficients": None,
            "metrics": {
                "train": train_metrics,
                "test": test_metrics,
                "cross_validation": {
                    "mean_accuracy": float(cv_scores.mean()),
                    "std_accuracy": float(cv_scores.std())
                }
            },
            "predictions": model.predict(X).tolist(),
            "feature_importance": None,
            "n_samples": len(X),
            "n_train": len(X_train),
            "n_test": len(X_test)
        }
    return _train("multinomial logistic regression", _build)


def train_naive_bayes(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    variant: str = 'gaussian',
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a Naive Bayes model (Gaussian, Multinomial, or Bernoulli)."""
    def _build() -> dict[str, Any]:
        X, y = _prepare_data(data, target_variable, features)

        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=test_size, random_state=random_state,
            stratify=y if y.nunique() > 1 else None
        )

        variant_l = variant.lower()
        if variant_l == 'gaussian':
            model = GaussianNB()
        elif variant_l == 'multinomial':
            if (X < 0).any().any():
                raise _InputError("Multinomial Naive Bayes requires non-negative feature values")
            model = MultinomialNB()
        elif variant_l == 'bernoulli':
            X_train = (X_train > X_train.mean()).astype(int)
            X_test = (X_test > X_test.mean()).astype(int)
            model = BernoulliNB()
        else:
            raise _InputError(f"Unknown Naive Bayes variant: {variant}. Use 'gaussian', 'multinomial', or 'bernoulli'")

        model.fit(X_train, y_train)

        train_metrics = _calculate_classification_metrics(y_train.values, model.predict(X_train))
        test_metrics = _calculate_classification_metrics(y_test.values, model.predict(X_test))

        cv_scores = cross_val_score(model, X_train, y_train, cv=5, scoring='accuracy')

        return {
            "model_type": f"naive_bayes_{variant_l}",
            "task_type": "classification",
            "target_variable": target_variable,
            "features": features,
            "variant": variant_l,
            "coefficients": None,
            "metrics": {
                "train": train_metrics,
                "test": test_metrics,
                "cross_validation": {
                    "mean_accuracy": float(cv_scores.mean()),
                    "std_accuracy": float(cv_scores.std())
                }
            },
            "predictions": model.predict(X_train).tolist(),
            "feature_importance": None,
            "n_samples": len(X),
            "n_train": len(X_train),
            "n_test": len(X_test)
        }
    return _train(f"Naive Bayes ({variant})", _build)


def train_lda(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a Linear Discriminant Analysis (LDA) model."""
    def _build() -> dict[str, Any]:
        X, y = _prepare_data(data, target_variable, features)
        unique_classes = y.nunique()
        if unique_classes < 2:
            raise _InputError("LDA requires at least 2 classes")

        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=test_size, random_state=random_state,
            stratify=y if unique_classes > 1 else None
        )

        model = LinearDiscriminantAnalysis()
        model.fit(X_train, y_train)

        train_metrics = _calculate_classification_metrics(y_train.values, model.predict(X_train))
        test_metrics = _calculate_classification_metrics(y_test.values, model.predict(X_test))

        cv_scores = cross_val_score(model, X, y, cv=5, scoring='accuracy')

        return {
            "model_type": "lda",
            "task_type": "classification",
            "target_variable": target_variable,
            "features": features,
            "n_classes": unique_classes,
            "coefficients": None,
            "metrics": {
                "train": train_metrics,
                "test": test_metrics,
                "cross_validation": {
                    "mean_accuracy": float(cv_scores.mean()),
                    "std_accuracy": float(cv_scores.std())
                }
            },
            "predictions": model.predict(X).tolist(),
            "feature_importance": None,
            "n_samples": len(X),
            "n_train": len(X_train),
            "n_test": len(X_test)
        }
    return _train("LDA", _build)


def train_qda(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a Quadratic Discriminant Analysis (QDA) model."""
    def _build() -> dict[str, Any]:
        X, y = _prepare_data(data, target_variable, features)
        unique_classes = y.nunique()
        if unique_classes < 2:
            raise _InputError("QDA requires at least 2 classes")

        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=test_size, random_state=random_state,
            stratify=y if unique_classes > 1 else None
        )

        model = QuadraticDiscriminantAnalysis()
        model.fit(X_train, y_train)

        train_metrics = _calculate_classification_metrics(y_train.values, model.predict(X_train))
        test_metrics = _calculate_classification_metrics(y_test.values, model.predict(X_test))

        cv_scores = cross_val_score(model, X, y, cv=5, scoring='accuracy')

        return {
            "model_type": "qda",
            "task_type": "classification",
            "target_variable": target_variable,
            "features": features,
            "n_classes": unique_classes,
            "coefficients": None,
            "metrics": {
                "train": train_metrics,
                "test": test_metrics,
                "cross_validation": {
                    "mean_accuracy": float(cv_scores.mean()),
                    "std_accuracy": float(cv_scores.std())
                }
            },
            "predictions": model.predict(X).tolist(),
            "feature_importance": None,
            "n_samples": len(X),
            "n_train": len(X_train),
            "n_test": len(X_test)
        }
    return _train("QDA", _build)


# ============================================================================
# UNSUPERVISED LEARNING MODELS - CLUSTERING
# ============================================================================

def train_kmeans(
    data: list[dict[str, Any]],
    features: list[str],
    n_clusters: int = 3,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a K-Means clustering model."""
    def _build() -> dict[str, Any]:
        X, X_scaled = _run_unsupervised_prep(data, features, scale=True)

        model = KMeans(n_clusters=n_clusters, random_state=random_state, n_init=10)
        labels = model.fit_predict(X_scaled)

        try:
            silhouette = float(silhouette_score(X_scaled, labels))
        except Exception:
            silhouette = 0.0

        return {
            "model_type": "kmeans",
            "task_type": "clustering",
            "features": features,
            "n_clusters": n_clusters,
            "labels": labels.tolist(),
            "inertia": float(model.inertia_),
            "silhouette_score": silhouette,
            "n_samples": len(X)
        }
    return _train("K-Means", _build)


def train_dbscan(
    data: list[dict[str, Any]],
    features: list[str],
    eps: float = 0.5,
    min_samples: int = 5
) -> dict[str, Any]:
    """Train a DBSCAN clustering model."""
    def _build() -> dict[str, Any]:
        X, X_scaled = _run_unsupervised_prep(data, features, scale=True)

        model = DBSCAN(eps=eps, min_samples=min_samples)
        labels = model.fit_predict(X_scaled)

        n_clusters = len(set(labels)) - (1 if -1 in labels else 0)
        n_noise = list(labels).count(-1)

        try:
            if n_clusters > 1:
                silhouette = float(silhouette_score(X_scaled, labels))
            else:
                silhouette = -1.0
        except Exception:
            silhouette = -1.0

        return {
            "model_type": "dbscan",
            "task_type": "clustering",
            "features": features,
            "n_clusters": n_clusters,
            "n_noise": n_noise,
            "labels": labels.tolist(),
            "silhouette_score": silhouette,
            "n_samples": len(X)
        }
    return _train("DBSCAN", _build)


def train_hierarchical_clustering(
    data: list[dict[str, Any]],
    features: list[str],
    n_clusters: int = 3,
    linkage: str = 'ward'
) -> dict[str, Any]:
    """Train a Hierarchical/Agglomerative clustering model."""
    def _build() -> dict[str, Any]:
        X, X_scaled = _run_unsupervised_prep(data, features, scale=True)

        model = AgglomerativeClustering(n_clusters=n_clusters, linkage=linkage)
        labels = model.fit_predict(X_scaled)

        try:
            silhouette = float(silhouette_score(X_scaled, labels))
        except Exception:
            silhouette = 0.0

        return {
            "model_type": "hierarchical_clustering",
            "task_type": "clustering",
            "features": features,
            "n_clusters": n_clusters,
            "linkage": linkage,
            "labels": labels.tolist(),
            "silhouette_score": silhouette,
            "n_samples": len(X)
        }
    return _train("Hierarchical Clustering", _build)


# ============================================================================
# DIMENSIONALITY REDUCTION
# ============================================================================

def train_pca(
    data: list[dict[str, Any]],
    features: list[str],
    n_components: int | None = None
) -> dict[str, Any]:
    """Train a Principal Component Analysis (PCA) model."""
    def _build() -> dict[str, Any]:
        X, X_scaled = _run_unsupervised_prep(data, features, scale=True)

        model = PCA(n_components=n_components)
        X_transformed = model.fit_transform(X_scaled)

        explained_variance_ratio = model.explained_variance_ratio_.tolist()
        cumulative_variance = np.cumsum(explained_variance_ratio).tolist()

        return {
            "model_type": "pca",
            "task_type": "dimensionality_reduction",
            "features": features,
            "n_components": model.n_components_,
            "explained_variance_ratio": explained_variance_ratio,
            "cumulative_variance": cumulative_variance,
            "transformed_data": X_transformed.tolist(),
            "n_samples": len(X)
        }
    return _train("PCA", _build)


def train_tsne(
    data: list[dict[str, Any]],
    features: list[str],
    n_components: int = 2,
    perplexity: float = 30.0,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a t-SNE dimensionality reduction model."""
    def _build() -> dict[str, Any]:
        X, _ = _prepare_data(data, features[0], features)
        X = X[features]

        # Limit data size for t-SNE (can be slow)
        if len(X) > 1000:
            X = X.sample(n=1000, random_state=random_state)

        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(X)

        model = TSNE(n_components=n_components, perplexity=perplexity, random_state=random_state)
        X_transformed = model.fit_transform(X_scaled)

        return {
            "model_type": "tsne",
            "task_type": "dimensionality_reduction",
            "features": features,
            "n_components": n_components,
            "perplexity": perplexity,
            "transformed_data": X_transformed.tolist(),
            "n_samples": len(X)
        }
    return _train("t-SNE", _build)


def train_umap(
    data: list[dict[str, Any]],
    features: list[str],
    n_components: int = 2,
    n_neighbors: int = 15,
    min_dist: float = 0.1,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a UMAP dimensionality reduction model."""
    _require(UMAP_AVAILABLE, "UMAP", "umap-learn")

    def _build() -> dict[str, Any]:
        X, X_scaled = _run_unsupervised_prep(data, features, scale=True)

        model = UMAP(n_components=n_components, n_neighbors=n_neighbors, min_dist=min_dist, random_state=random_state)
        X_transformed = model.fit_transform(X_scaled)

        return {
            "model_type": "umap",
            "task_type": "dimensionality_reduction",
            "features": features,
            "n_components": n_components,
            "transformed_data": X_transformed.tolist(),
            "n_samples": len(X)
        }
    return _train("UMAP", _build)


# ============================================================================
# TIME SERIES MODELS
# ============================================================================

def _extract_time_series(
    data: list[dict[str, Any]],
    target_variable: str,
    date_column: str | None,
) -> pd.Series:
    """Shared time-series extraction: validate target, sort by date if given,
    drop nulls, enforce minimum length."""
    df = pd.DataFrame(data)

    if target_variable not in df.columns:
        raise _InputError(f"Target variable '{target_variable}' not found in data")

    if date_column and date_column in df.columns:
        df[date_column] = pd.to_datetime(df[date_column], errors='coerce')
        df = df.sort_values(date_column)
        ts = df[target_variable].dropna()
    else:
        ts = pd.Series(df[target_variable].dropna())

    if len(ts) < 10:
        raise _InputError("Time series must have at least 10 observations")

    return ts


def train_arima(
    data: list[dict[str, Any]],
    target_variable: str,
    date_column: str | None = None,
    order: tuple = (1, 1, 1),
    seasonal_order: tuple | None = None
) -> dict[str, Any]:
    """Train an ARIMA or SARIMA time series model."""
    _require(STATSMODELS_AVAILABLE, "statsmodels (ARIMA/SARIMA)", "statsmodels")

    def _build() -> dict[str, Any]:
        ts = _extract_time_series(data, target_variable, date_column)

        if seasonal_order:
            model = SARIMAX(ts, order=order, seasonal_order=seasonal_order)
        else:
            model = ARIMA(ts, order=order)

        fitted_model = model.fit()

        forecast = fitted_model.forecast(steps=min(10, len(ts) // 4))

        aic = float(fitted_model.aic) if hasattr(fitted_model, 'aic') else None
        bic = float(fitted_model.bic) if hasattr(fitted_model, 'bic') else None

        return {
            "model_type": "sarima" if seasonal_order else "arima",
            "task_type": "time_series",
            "target_variable": target_variable,
            "order": order,
            "seasonal_order": seasonal_order,
            "aic": aic,
            "bic": bic,
            "forecast": forecast.tolist(),
            "n_samples": len(ts),
            "fitted_values": fitted_model.fittedvalues.tolist()
        }
    return _train("ARIMA/SARIMA", _build)


def train_exponential_smoothing(
    data: list[dict[str, Any]],
    target_variable: str,
    date_column: str | None = None,
    trend: str | None = None,
    seasonal: str | None = None,
    seasonal_periods: int | None = None
) -> dict[str, Any]:
    """Train an Exponential Smoothing time series model."""
    _require(STATSMODELS_AVAILABLE, "statsmodels (Exponential Smoothing)", "statsmodels")

    def _build() -> dict[str, Any]:
        ts = _extract_time_series(data, target_variable, date_column)

        model = ExponentialSmoothing(
            ts, trend=trend, seasonal=seasonal, seasonal_periods=seasonal_periods
        )
        fitted_model = model.fit()

        forecast = fitted_model.forecast(steps=min(10, len(ts) // 4))

        return {
            "model_type": "exponential_smoothing",
            "task_type": "time_series",
            "target_variable": target_variable,
            "trend": trend,
            "seasonal": seasonal,
            "seasonal_periods": seasonal_periods,
            "aic": float(fitted_model.aic) if hasattr(fitted_model, 'aic') else None,
            "forecast": forecast.tolist(),
            "n_samples": len(ts),
            "fitted_values": fitted_model.fittedvalues.tolist()
        }
    return _train("Exponential Smoothing", _build)


def _train_keras_sequence(
    *,
    model_type: str,
    label: str,
    build_layer: Callable[[Any, int, int], Any],
    units_key: str,
    units: int,
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    sequence_length: int,
    epochs: int,
    test_size: float,
    random_state: int,
) -> dict[str, Any]:
    """Shared body for the Keras recurrent models (LSTM, GRU): build sequences,
    split, build a single-recurrent-layer Sequential net, fit, score, and
    release TF resources (P-034). PY-2: TensorFlow is not pinned, so a missing
    import yields HTTP 501 via :class:`MissingDependencyError`."""
    try:
        import tensorflow as tf
        from tensorflow.keras.layers import Dense, Dropout
        from tensorflow.keras.models import Sequential
        from tensorflow.keras.optimizers import Adam
    except ImportError as ie:
        raise MissingDependencyError(
            "TensorFlow is not available: install it with `pip install tensorflow`"
        ) from ie

    keras_model = None

    def _build() -> dict[str, Any]:
        nonlocal keras_model
        X, y = _prepare_data(data, target_variable, features)

        def create_sequences(arr, seq_length):
            X_seq, y_seq = [], []
            for i in range(len(arr) - seq_length):
                X_seq.append(arr[i:i+seq_length])
                y_seq.append(arr[i+seq_length])
            return np.array(X_seq), np.array(y_seq)

        data_array = X.values
        X_seq, y_seq = create_sequences(data_array, sequence_length)

        if len(X_seq) < 10:
            raise _InputError(f"Need at least {sequence_length + 10} samples for {label}")

        split_idx = int(len(X_seq) * (1 - test_size))
        X_train, X_test = X_seq[:split_idx], X_seq[split_idx:]
        y_train, y_test = y_seq[:split_idx], y_seq[split_idx:]

        X_train = X_train.reshape((X_train.shape[0], X_train.shape[1], X_train.shape[2]))
        X_test = X_test.reshape((X_test.shape[0], X_test.shape[1], X_test.shape[2]))

        keras_model = Sequential([
            build_layer(units, sequence_length, len(features)),
            Dropout(0.2),
            Dense(1)
        ])
        keras_model.compile(optimizer=Adam(learning_rate=0.001), loss='mse', metrics=['mae'])

        keras_model.fit(
            X_train, y_train, epochs=epochs, batch_size=32,
            validation_data=(X_test, y_test), verbose=0
        )

        y_train_pred = keras_model.predict(X_train, verbose=0).flatten()
        y_test_pred = keras_model.predict(X_test, verbose=0).flatten()
        predictions = keras_model.predict(X_seq, verbose=0).flatten().tolist()

        train_metrics = _calculate_regression_metrics(y_train, y_train_pred)
        test_metrics = _calculate_regression_metrics(y_test, y_test_pred)

        return {
            "model_type": model_type,
            "task_type": "time_series",
            "target_variable": target_variable,
            "features": features,
            "sequence_length": sequence_length,
            units_key: units,
            "coefficients": None,
            "metrics": {
                "train": train_metrics,
                "test": test_metrics,
                "cross_validation": {}
            },
            "predictions": predictions,
            "feature_importance": None,
            "n_samples": len(X_seq),
            "n_train": len(X_train),
            "n_test": len(X_test)
        }

    try:
        return _train(label, _build)
    finally:
        # P-034: release the TF graph / variables once metrics have been extracted.
        try:
            if keras_model is not None:
                del keras_model
            tf.keras.backend.clear_session()
        except Exception:
            pass


def train_lstm(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    sequence_length: int = 10,
    lstm_units: int = 50,
    epochs: int = 50,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train an LSTM time series model."""
    def _layer(units, seq_len, n_feat):
        from tensorflow.keras.layers import LSTM
        return LSTM(units, activation='relu', input_shape=(seq_len, n_feat))

    return _train_keras_sequence(
        model_type="lstm", label="LSTM", build_layer=_layer,
        units_key="lstm_units", units=lstm_units,
        data=data, target_variable=target_variable, features=features,
        sequence_length=sequence_length, epochs=epochs,
        test_size=test_size, random_state=random_state,
    )


def train_gru(
    data: list[dict[str, Any]],
    target_variable: str,
    features: list[str],
    sequence_length: int = 10,
    gru_units: int = 50,
    epochs: int = 50,
    test_size: float = 0.2,
    random_state: int = 42
) -> dict[str, Any]:
    """Train a GRU time series model."""
    def _layer(units, seq_len, n_feat):
        from tensorflow.keras.layers import GRU
        return GRU(units, activation='relu', input_shape=(seq_len, n_feat))

    return _train_keras_sequence(
        model_type="gru", label="GRU", build_layer=_layer,
        units_key="gru_units", units=gru_units,
        data=data, target_variable=target_variable, features=features,
        sequence_length=sequence_length, epochs=epochs,
        test_size=test_size, random_state=random_state,
    )


# ============================================================================
# ANOMALY DETECTION MODELS
# ============================================================================

def train_isolation_forest(
    data: list[dict[str, Any]],
    features: list[str],
    contamination: float = 0.1,
    n_estimators: int = 100,
    random_state: int = 42
) -> dict[str, Any]:
    """Train an Isolation Forest anomaly detection model."""
    def _build() -> dict[str, Any]:
        X, X_scaled = _run_unsupervised_prep(data, features, scale=True)

        model = IsolationForest(
            contamination=contamination, n_estimators=n_estimators, random_state=random_state
        )
        predictions = model.fit_predict(X_scaled)

        anomaly_indices = np.where(predictions == -1)[0].tolist()
        n_anomalies = len(anomaly_indices)

        return {
            "model_type": "isolation_forest",
            "task_type": "anomaly_detection",
            "features": features,
            "contamination": contamination,
            "n_anomalies": n_anomalies,
            "anomaly_indices": anomaly_indices,
            "anomaly_scores": model.score_samples(X_scaled).tolist(),
            "n_samples": len(X)
        }
    return _train("Isolation Forest", _build)


def train_one_class_svm(
    data: list[dict[str, Any]],
    features: list[str],
    nu: float = 0.1,
    kernel: str = 'rbf',
    random_state: int = 42
) -> dict[str, Any]:
    """Train a One-Class SVM anomaly detection model."""
    def _build() -> dict[str, Any]:
        from sklearn.svm import OneClassSVM

        X, X_scaled = _run_unsupervised_prep(data, features, scale=True)

        model = OneClassSVM(nu=nu, kernel=kernel)
        predictions = model.fit_predict(X_scaled)

        anomaly_indices = np.where(predictions == -1)[0].tolist()
        n_anomalies = len(anomaly_indices)

        return {
            "model_type": "one_class_svm",
            "task_type": "anomaly_detection",
            "features": features,
            "nu": nu,
            "kernel": kernel,
            "n_anomalies": n_anomalies,
            "anomaly_indices": anomaly_indices,
            "n_samples": len(X)
        }
    return _train("One-Class SVM", _build)


def train_local_outlier_factor(
    data: list[dict[str, Any]],
    features: list[str],
    n_neighbors: int = 20,
    contamination: float = 0.1
) -> dict[str, Any]:
    """Train a Local Outlier Factor (LOF) anomaly detection model."""
    def _build() -> dict[str, Any]:
        from sklearn.neighbors import LocalOutlierFactor

        X, X_scaled = _run_unsupervised_prep(data, features, scale=True)

        model = LocalOutlierFactor(n_neighbors=n_neighbors, contamination=contamination)
        predictions = model.fit_predict(X_scaled)

        anomaly_indices = np.where(predictions == -1)[0].tolist()
        n_anomalies = len(anomaly_indices)

        return {
            "model_type": "local_outlier_factor",
            "task_type": "anomaly_detection",
            "features": features,
            "n_neighbors": n_neighbors,
            "contamination": contamination,
            "n_anomalies": n_anomalies,
            "anomaly_indices": anomaly_indices,
            "outlier_scores": model.negative_outlier_factor_.tolist(),
            "n_samples": len(X)
        }
    return _train("Local Outlier Factor", _build)


def train_elliptic_envelope(
    data: list[dict[str, Any]],
    features: list[str],
    contamination: float = 0.1,
    random_state: int = 42
) -> dict[str, Any]:
    """Train an Elliptic Envelope anomaly detection model."""
    def _build() -> dict[str, Any]:
        X, X_scaled = _run_unsupervised_prep(data, features, scale=True)

        model = EllipticEnvelope(contamination=contamination, random_state=random_state)
        predictions = model.fit_predict(X_scaled)

        anomaly_indices = np.where(predictions == -1)[0].tolist()
        n_anomalies = len(anomaly_indices)

        return {
            "model_type": "elliptic_envelope",
            "task_type": "anomaly_detection",
            "features": features,
            "contamination": contamination,
            "n_anomalies": n_anomalies,
            "anomaly_indices": anomaly_indices,
            "n_samples": len(X)
        }
    return _train("Elliptic Envelope", _build)


# ============================================================================
# RECOMMENDATION SYSTEMS
# ============================================================================

def train_matrix_factorization(
    data: list[dict[str, Any]],
    user_column: str,
    item_column: str,
    rating_column: str,
    n_factors: int = 50,
    n_epochs: int = 20,
    learning_rate: float = 0.01,
    regularization: float = 0.1
) -> dict[str, Any]:
    """Train a Matrix Factorization recommendation model (simplified ALS)."""
    def _build() -> dict[str, Any]:
        df = pd.DataFrame(data)

        required_cols = [user_column, item_column, rating_column]
        missing = [col for col in required_cols if col not in df.columns]
        if missing:
            raise _InputError(f"Missing columns: {missing}")

        user_item_matrix = df.pivot_table(
            index=user_column, columns=item_column, values=rating_column, fill_value=0
        )

        from sklearn.decomposition import NMF

        model = NMF(n_components=n_factors, random_state=42, max_iter=n_epochs)
        W = model.fit_transform(user_item_matrix)
        H = model.components_

        reconstructed = np.dot(W, H)
        mse = np.mean((user_item_matrix.values - reconstructed) ** 2)

        return {
            "model_type": "matrix_factorization",
            "task_type": "recommendation",
            "user_column": user_column,
            "item_column": item_column,
            "rating_column": rating_column,
            "n_factors": n_factors,
            "n_users": len(user_item_matrix),
            "n_items": len(user_item_matrix.columns),
            "reconstruction_error": float(mse),
            "n_samples": len(df)
        }
    return _train("Matrix Factorization", _build)


# ============================================================================
# SURVIVAL ANALYSIS
# ============================================================================

def train_cox_proportional_hazards(
    data: list[dict[str, Any]],
    duration_column: str,
    event_column: str,
    features: list[str]
) -> dict[str, Any]:
    """Train a Cox Proportional Hazards survival analysis model."""
    try:
        from lifelines import CoxPHFitter
    except ImportError as ie:
        raise MissingDependencyError(
            "lifelines is not available: install it with `pip install lifelines`"
        ) from ie

    def _build() -> dict[str, Any]:
        df = pd.DataFrame(data)

        required_cols = [duration_column, event_column] + features
        missing = [col for col in required_cols if col not in df.columns]
        if missing:
            raise _InputError(f"Missing columns: {missing}")

        survival_data = df[[duration_column, event_column] + features].copy()
        survival_data = survival_data.dropna()

        if len(survival_data) < 10:
            raise _InputError("Need at least 10 samples for survival analysis")

        cph = CoxPHFitter()
        cph.fit(survival_data, duration_column=duration_column, event_col=event_column)

        return {
            "model_type": "cox_proportional_hazards",
            "task_type": "survival_analysis",
            "duration_column": duration_column,
            "event_column": event_column,
            "features": features,
            "concordance_index": float(cph.concordance_index_) if hasattr(cph, 'concordance_index_') else None,
            "coefficients": {
                feature: float(cph.hazard_ratios_[feature]) if feature in cph.hazard_ratios_.index else None
                for feature in features
            },
            "n_samples": len(survival_data)
        }
    return _train("Cox Proportional Hazards", _build)


def train_kaplan_meier(
    data: list[dict[str, Any]],
    duration_column: str,
    event_column: str,
    group_column: str | None = None
) -> dict[str, Any]:
    """Train a Kaplan-Meier survival estimator."""
    try:
        from lifelines import KaplanMeierFitter
    except ImportError as ie:
        raise MissingDependencyError(
            "lifelines is not available: install it with `pip install lifelines`"
        ) from ie

    def _build() -> dict[str, Any]:
        df = pd.DataFrame(data)

        required_cols = [duration_column, event_column]
        if group_column:
            required_cols.append(group_column)
        missing = [col for col in required_cols if col not in df.columns]
        if missing:
            raise _InputError(f"Missing columns: {missing}")

        survival_data = df[[duration_column, event_column]].copy()
        if group_column:
            survival_data[group_column] = df[group_column]
        survival_data = survival_data.dropna()

        if len(survival_data) < 10:
            raise _InputError("Need at least 10 samples for survival analysis")

        kmf = KaplanMeierFitter()

        if group_column:
            groups = survival_data[group_column].unique()
            results = {}
            for group in groups:
                group_data = survival_data[survival_data[group_column] == group]
                kmf.fit(group_data[duration_column], group_data[event_column], label=str(group))
                results[str(group)] = {
                    "median_survival": float(kmf.median_survival_time_) if hasattr(kmf, 'median_survival_time_') else None,
                    "n_samples": len(group_data)
                }
        else:
            kmf.fit(survival_data[duration_column], survival_data[event_column])
            results = {
                "median_survival": float(kmf.median_survival_time_) if hasattr(kmf, 'median_survival_time_') else None,
                "n_samples": len(survival_data)
            }

        return {
            "model_type": "kaplan_meier",
            "task_type": "survival_analysis",
            "duration_column": duration_column,
            "event_column": event_column,
            "group_column": group_column,
            "results": results,
            "n_samples": len(survival_data)
        }
    return _train("Kaplan-Meier", _build)
