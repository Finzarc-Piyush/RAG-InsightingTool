"""FastAPI application for Data Operations Service"""
import hmac
import os
import traceback
from typing import Any, Literal

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from config import config
from data_operations import (
    aggregate_data,
    convert_type,
    create_derived_column,
    get_preview,
    get_summary,
    identify_outliers,
    pivot_table,
    remove_nulls,
    suggest_initial_charts,
    treat_outliers,
)
from ml_models import (
    MissingDependencyError,
    train_arima,
    train_bayesian_regression,
    train_catboost,
    train_cox_proportional_hazards,
    train_dbscan,
    train_decision_tree,
    train_elasticnet,
    train_elliptic_envelope,
    train_exponential_smoothing,
    train_extra_trees,
    train_gamma_regression,
    train_gaussian_process,
    train_gradient_boosting,
    train_gru,
    train_hierarchical_clustering,
    train_isolation_forest,
    train_kaplan_meier,
    train_kmeans,
    train_knn,
    train_lasso_regression,
    train_lda,
    train_lightgbm,
    train_linear_regression,
    train_local_outlier_factor,
    train_log_log_regression,
    train_logistic_regression,
    train_lstm,
    train_matrix_factorization,
    train_mlp,
    train_multinomial_logistic,
    train_naive_bayes,
    train_one_class_svm,
    train_pca,
    train_poisson_regression,
    train_polynomial_regression,
    train_qda,
    train_quantile_regression,
    train_random_forest,
    train_ridge_regression,
    train_svm,
    train_tsne,
    train_tweedie_regression,
    train_umap,
    train_xgboost,
)

app = FastAPI(title="Data Operations Service", version="1.0.0")

# CORS middleware
# PY-9: this is a server-to-server API (Node authenticates with X-Internal-Api-Key),
# so the wildcard methods/headers + allow_credentials combo is overly permissive.
# Disable credentials and enumerate exactly the methods/headers actually used.
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Internal-Api-Key", "X-Trace-Id"],
)


# P-037: Refuse to boot in a production-like environment without an API key.
# Setting VERCEL or ENVIRONMENT=production flips this on. Local dev still
# works with the key unset.
if not config.INTERNAL_API_KEY:
    _prod_markers = {
        "VERCEL": os.getenv("VERCEL"),
        "ENVIRONMENT": os.getenv("ENVIRONMENT", "").lower(),
        "NODE_ENV": os.getenv("NODE_ENV", "").lower(),
    }
    if _prod_markers["VERCEL"] or _prod_markers["ENVIRONMENT"] == "production" or _prod_markers["NODE_ENV"] == "production":
        raise RuntimeError(
            "PYTHON_SERVICE_API_KEY must be set in production; refusing to start world-accessible."
        )


@app.middleware("http")
async def bind_trace_id(request: Request, call_next):
    """PY-7/OBS-2: bind the per-request X-Trace-Id (sent by the Node tier) so every
    log line for the request carries it, tying the data-op back to the chat turn."""
    tid = request.headers.get("X-Trace-Id")
    token = trace_id_var.set(tid) if tid else None
    try:
        return await call_next(request)
    finally:
        if token is not None:
            trace_id_var.reset(token)


@app.middleware("http")
async def internal_api_key_gate(request: Request, call_next):
    """Require X-Internal-Api-Key when PYTHON_SERVICE_API_KEY is set (Node must send the same value)."""
    if config.INTERNAL_API_KEY:
        # SEC-5: constant-time comparison so the gate does not leak the secret
        # via response-timing (mirrors the Node side's timingSafeEqual).
        provided = request.headers.get("X-Internal-Api-Key", "")
        if not hmac.compare_digest(provided, config.INTERNAL_API_KEY):
            return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)


# P-010: Reject oversized request bodies before FastAPI parses JSON into memory.
# Default 50 MB which comfortably covers the ~1M-row ceiling for our datasets.
_MAX_BODY_BYTES = int(os.getenv("PYTHON_SERVICE_MAX_BODY_BYTES", str(50 * 1024 * 1024)))


@app.middleware("http")
async def body_size_limit(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            size = int(content_length)
        except ValueError:
            size = 0
        if size > _MAX_BODY_BYTES:
            return JSONResponse(
                status_code=413,
                content={"detail": f"Request body exceeds {_MAX_BODY_BYTES} bytes"},
            )
    return await call_next(request)


# P-010/P-035: cap concurrent training requests so a burst cannot saturate
# every worker thread. Set TRAIN_CONCURRENCY=0 to disable the cap.
import asyncio  # noqa: E402

from logging_config import configure_logging, get_logger, trace_id_var  # noqa: E402

configure_logging()
logger = get_logger(__name__)

_TRAIN_CONCURRENCY = int(os.getenv("TRAIN_CONCURRENCY", "3"))
_train_semaphore: asyncio.Semaphore | None = (
    asyncio.Semaphore(_TRAIN_CONCURRENCY) if _TRAIN_CONCURRENCY > 0 else None
)


async def _with_training_gate(coro_factory, timeout_s: int = 300):
    """Run a blocking training coroutine under the concurrency + timeout gate."""
    if _train_semaphore is None:
        return await asyncio.wait_for(coro_factory(), timeout=timeout_s)
    # Non-blocking acquire first so we can return 503 instead of hanging.
    try:
        await asyncio.wait_for(_train_semaphore.acquire(), timeout=1.0)
    except TimeoutError:
        raise HTTPException(status_code=503, detail="Training queue full; retry shortly") from None
    try:
        return await asyncio.wait_for(coro_factory(), timeout=timeout_s)
    finally:
        _train_semaphore.release()


# Request/Response models
class RemoveNullsRequest(BaseModel):
    data: list[dict[str, Any]]
    column: str | None = None
    method: Literal["delete", "mean", "median", "mode", "custom"] = "delete"
    custom_value: Any | None = None


class PreviewRequest(BaseModel):
    data: list[dict[str, Any]]
    limit: int = Field(default=50, ge=1, le=10000)


class CreateDerivedColumnRequest(BaseModel):
    data: list[dict[str, Any]]
    new_column_name: str
    expression: str


class ConvertTypeRequest(BaseModel):
    data: list[dict[str, Any]]
    column: str
    target_type: Literal["numeric", "string", "date", "percentage", "boolean"]


class AggregateRequest(BaseModel):
    data: list[dict[str, Any]]
    group_by_column: str
    agg_columns: list[str] | None = None
    agg_funcs: dict[str, Literal["sum", "avg", "mean", "min", "max", "count", "median", "std", "var", "p90", "p95", "p99", "any", "all"]] | None = None
    order_by_column: str | None = None
    order_by_direction: Literal["asc", "desc"] = "asc"
    user_intent: str | None = None  # User's original message for semantic intent detection


class PivotRequest(BaseModel):
    data: list[dict[str, Any]]
    index_column: str
    value_columns: list[str] | None = None
    pivot_funcs: dict[str, Literal["sum", "avg", "mean", "min", "max", "count"]] | None = None


class IdentifyOutliersRequest(BaseModel):
    data: list[dict[str, Any]]
    column: str | None = None
    method: Literal["iqr", "zscore", "isolation_forest", "local_outlier_factor"] = "iqr"
    threshold: float | None = None


class TreatOutliersRequest(BaseModel):
    data: list[dict[str, Any]]
    column: str | None = None
    method: Literal["iqr", "zscore", "isolation_forest", "local_outlier_factor"] = "iqr"
    threshold: float | None = None
    treatment: Literal["remove", "cap", "winsorize", "transform", "impute"] = "remove"
    treatment_value: Literal["mean", "median", "mode", "min", "max"] | float | None = None


class TrainModelRequest(BaseModel):
    data: list[dict[str, Any]]
    model_type: Literal[
        "linear", "log_log", "logistic", "ridge", "lasso", "random_forest", "decision_tree",
        "gradient_boosting", "elasticnet", "svm", "knn",
        "polynomial", "bayesian", "quantile", "poisson", "gamma", "tweedie",
        "extra_trees", "xgboost", "lightgbm", "catboost", "gaussian_process", "mlp",
        "multinomial_logistic", "naive_bayes_gaussian", "naive_bayes_multinomial", "naive_bayes_bernoulli",
        "lda", "qda",
        "kmeans", "dbscan", "hierarchical_clustering",
        "pca", "tsne", "umap",
        "arima", "sarima", "exponential_smoothing", "lstm", "gru",
        "isolation_forest", "one_class_svm", "local_outlier_factor", "elliptic_envelope",
        "matrix_factorization",
        "cox_proportional_hazards", "kaplan_meier"
    ]
    target_variable: str | None = None  # Optional for unsupervised models
    features: list[str]
    test_size: float = Field(default=0.2, ge=0.1, le=0.5)
    random_state: int = Field(default=42)
    # Regression/Classification parameters
    alpha: float | None = Field(default=None, ge=0.0)
    l1_ratio: float | None = Field(default=None, ge=0.0, le=1.0)
    n_estimators: int | None = Field(default=None, ge=1)
    max_depth: int | None = Field(default=None, ge=1)
    learning_rate: float | None = Field(default=None, gt=0.0)
    kernel: str | None = Field(default=None)
    C: float | None = Field(default=None, gt=0.0)
    n_neighbors: int | None = Field(default=None, ge=1)
    # Additional parameters
    degree: int | None = Field(default=None, ge=1)  # Polynomial
    quantile: float | None = Field(default=None, ge=0.0, le=1.0)  # Quantile regression
    power: float | None = Field(default=None)  # Tweedie
    iterations: int | None = Field(default=None, ge=1)  # CatBoost
    depth: int | None = Field(default=None, ge=1)  # CatBoost
    hidden_layer_sizes: list[int] | None = Field(default=None)  # MLP
    activation: str | None = Field(default=None)  # MLP
    solver: str | None = Field(default=None)  # MLP
    max_iter: int | None = Field(default=None, ge=1)  # MLP
    variant: str | None = Field(default=None)  # Naive Bayes
    # Clustering parameters
    n_clusters: int | None = Field(default=None, ge=2)  # K-Means, Hierarchical
    eps: float | None = Field(default=None, gt=0.0)  # DBSCAN
    min_samples: int | None = Field(default=None, ge=1)  # DBSCAN
    linkage: str | None = Field(default=None)  # Hierarchical
    # Dimensionality reduction parameters
    n_components: int | None = Field(default=None, ge=1)  # PCA, t-SNE, UMAP
    perplexity: float | None = Field(default=None, gt=0.0)  # t-SNE
    min_dist: float | None = Field(default=None, ge=0.0)  # UMAP
    # Time series parameters
    date_column: str | None = Field(default=None)  # Time series models
    order: list[int] | None = Field(default=None)  # ARIMA order (p, d, q)
    seasonal_order: list[int] | None = Field(default=None)  # SARIMA seasonal order
    trend: str | None = Field(default=None)  # Exponential smoothing
    seasonal: str | None = Field(default=None)  # Exponential smoothing
    seasonal_periods: int | None = Field(default=None, ge=1)  # Exponential smoothing
    sequence_length: int | None = Field(default=None, ge=1)  # LSTM, GRU
    lstm_units: int | None = Field(default=None, ge=1)  # LSTM
    gru_units: int | None = Field(default=None, ge=1)  # GRU
    epochs: int | None = Field(default=None, ge=1)  # LSTM, GRU
    # Anomaly detection parameters
    contamination: float | None = Field(default=None, ge=0.0, le=0.5)  # Anomaly detection
    nu: float | None = Field(default=None, ge=0.0, le=1.0)  # One-Class SVM
    # Recommendation system parameters
    user_column: str | None = Field(default=None)
    item_column: str | None = Field(default=None)
    rating_column: str | None = Field(default=None)
    n_factors: int | None = Field(default=None, ge=1)  # Matrix factorization
    n_epochs: int | None = Field(default=None, ge=1)  # Matrix factorization
    regularization: float | None = Field(default=None, ge=0.0)  # Matrix factorization
    # Survival analysis parameters
    duration_column: str | None = Field(default=None)
    event_column: str | None = Field(default=None)
    group_column: str | None = Field(default=None)  # Kaplan-Meier


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok", "service": "data-ops"}


@app.post("/remove-nulls")
async def remove_nulls_endpoint(request: RemoveNullsRequest):
    """Remove null values from data"""
    try:
        if len(request.data) > config.MAX_ROWS:
            raise HTTPException(
                status_code=400,
                detail=f"Data exceeds maximum rows limit of {config.MAX_ROWS}"
            )

        # PERF-8/PY-1: offload the blocking pandas work off the event loop so
        # one request cannot stall every other concurrent request.
        result = await run_in_threadpool(
            remove_nulls,
            data=request.data,
            column=request.column,
            method=request.method,
            custom_value=request.custom_value,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    except Exception as e:
        logger.error(f"Error in remove_nulls: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}") from None


@app.post("/preview")
async def preview_endpoint(request: PreviewRequest):
    """Get data preview"""
    try:
        if len(request.data) > config.MAX_ROWS:
            raise HTTPException(
                status_code=400,
                detail=f"Data exceeds maximum rows limit of {config.MAX_ROWS}"
            )

        if request.limit > config.MAX_PREVIEW_ROWS:
            request.limit = config.MAX_PREVIEW_ROWS

        # PERF-8/PY-1: offload blocking pandas work off the event loop.
        result = await run_in_threadpool(get_preview, data=request.data, limit=request.limit)
        return result
    except Exception as e:
        logger.error(f"Error in preview: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}") from None


@app.post("/summary")
async def summary_endpoint(request: dict[str, Any]):
    """Get data summary statistics (all columns or a specific column)"""
    try:
        data = request.get("data", [])
        column = request.get("column")  # Optional column name
        if not isinstance(data, list):
            raise HTTPException(status_code=400, detail="Data must be a list")

        if len(data) > config.MAX_ROWS:
            raise HTTPException(
                status_code=400,
                detail=f"Data exceeds maximum rows limit of {config.MAX_ROWS}"
            )

        # PERF-8/PY-1: offload blocking pandas work off the event loop.
        result = await run_in_threadpool(get_summary, data=data, column=column)
        return result
    except Exception as e:
        logger.error(f"Error in summary: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}") from None


@app.post("/initial-analysis")
async def initial_analysis_endpoint(request: dict[str, Any]):
    """Initial analysis: summary stats + rule-based chart suggestions (no AI)."""
    try:
        data = request.get("data", [])
        if not isinstance(data, list):
            raise HTTPException(status_code=400, detail="Data must be a list")
        if len(data) > config.MAX_ROWS:
            raise HTTPException(
                status_code=400,
                detail=f"Data exceeds maximum rows limit of {config.MAX_ROWS}"
            )
        # PERF-8/PY-1: run both blocking steps in one threadpool hop so the
        # chained pandas/rule-based CPU work all stays off the event loop.
        def _initial_analysis() -> dict[str, Any]:
            summary_response = get_summary(data=data)
            chart_suggestions = suggest_initial_charts(summary_response)
            return {"summary": summary_response.get("summary", []), "chart_suggestions": chart_suggestions}

        return await run_in_threadpool(_initial_analysis)
    except Exception as e:
        logger.error(f"Error in initial-analysis: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}") from None


@app.post("/create-derived-column")
async def create_derived_column_endpoint(request: CreateDerivedColumnRequest):
    """Create a new column from an expression"""
    try:
        if len(request.data) > config.MAX_ROWS:
            raise HTTPException(
                status_code=400,
                detail=f"Data exceeds maximum rows limit of {config.MAX_ROWS}"
            )

        # PERF-8/PY-1: offload blocking pandas work off the event loop.
        result = await run_in_threadpool(
            create_derived_column,
            data=request.data,
            new_column_name=request.new_column_name,
            expression=request.expression,
        )

        if result.get("errors") and len(result["errors"]) > 0:
            raise HTTPException(
                status_code=400,
                detail="; ".join(result["errors"])
            )

        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in create_derived_column: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}") from None


@app.post("/convert-type")
async def convert_type_endpoint(request: ConvertTypeRequest):
    """Convert column data type"""
    try:
        if len(request.data) > config.MAX_ROWS:
            raise HTTPException(
                status_code=400,
                detail=f"Data exceeds maximum rows limit of {config.MAX_ROWS}"
            )

        # PERF-8/PY-1: offload blocking pandas work off the event loop.
        result = await run_in_threadpool(
            convert_type,
            data=request.data,
            column=request.column,
            target_type=request.target_type,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    except Exception as e:
        logger.error(f"Error in convert_type: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}") from None


@app.post("/aggregate")
async def aggregate_endpoint(request: AggregateRequest):
    """Aggregate data by grouping on a column"""
    try:
        if len(request.data) > config.MAX_ROWS:
            raise HTTPException(
                status_code=400,
                detail=f"Data exceeds maximum rows limit of {config.MAX_ROWS}"
            )

        # PERF-8/PY-1: offload blocking pandas work off the event loop, WRAPPED by
        # the same training gate as MMM (concurrency semaphore → 503 when full,
        # per-call timeout) so a heavy aggregation cannot starve the worker pool.
        async def _run():
            return await run_in_threadpool(
                aggregate_data,
                data=request.data,
                group_by_column=request.group_by_column,
                agg_columns=request.agg_columns,
                agg_funcs=request.agg_funcs,
                order_by_column=request.order_by_column,
                order_by_direction=request.order_by_direction,
                user_intent=request.user_intent,
            )
        result = await _with_training_gate(_run, timeout_s=180)
        return result
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    except Exception as e:
        logger.error(f"Error in aggregate: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}") from None


@app.post("/pivot")
async def pivot_endpoint(request: PivotRequest):
    """Create a pivot table"""
    try:
        if len(request.data) > config.MAX_ROWS:
            raise HTTPException(
                status_code=400,
                detail=f"Data exceeds maximum rows limit of {config.MAX_ROWS}"
            )

        # PERF-8/PY-1: offload blocking pandas work off the event loop, WRAPPED by
        # the same training gate as MMM (concurrency semaphore → 503 when full,
        # per-call timeout) so a heavy pivot cannot starve the worker pool.
        async def _run():
            return await run_in_threadpool(
                pivot_table,
                data=request.data,
                index_column=request.index_column,
                value_columns=request.value_columns,
                pivot_funcs=request.pivot_funcs,
            )
        result = await _with_training_gate(_run, timeout_s=180)
        return result
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    except Exception as e:
        logger.error(f"Error in pivot: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}") from None


@app.post("/identify-outliers")
async def identify_outliers_endpoint(request: IdentifyOutliersRequest):
    """Identify outliers in data"""
    try:
        if len(request.data) > config.MAX_ROWS:
            raise HTTPException(
                status_code=400,
                detail=f"Data exceeds maximum rows limit of {config.MAX_ROWS}"
            )

        # PERF-8/PY-1: offload blocking pandas/sklearn work off the event loop.
        result = await run_in_threadpool(
            identify_outliers,
            data=request.data,
            column=request.column,
            method=request.method,
            threshold=request.threshold,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    except Exception as e:
        logger.error(f"Error in identify_outliers: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}") from None


@app.post("/treat-outliers")
async def treat_outliers_endpoint(request: TreatOutliersRequest):
    """Treat outliers in data"""
    try:
        if len(request.data) > config.MAX_ROWS:
            raise HTTPException(
                status_code=400,
                detail=f"Data exceeds maximum rows limit of {config.MAX_ROWS}"
            )

        # PERF-8/PY-1: offload blocking pandas/sklearn work off the event loop,
        # WRAPPED by the same training gate as MMM (concurrency semaphore → 503 when
        # full, per-call timeout) so heavy outlier treatment cannot starve the pool.
        async def _run():
            return await run_in_threadpool(
                treat_outliers,
                data=request.data,
                column=request.column,
                method=request.method,
                threshold=request.threshold,
                treatment=request.treatment,
                treatment_value=request.treatment_value,
            )
        result = await _with_training_gate(_run, timeout_s=180)
        return result
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    except Exception as e:
        logger.error(f"Error in treat_outliers: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}") from None


@app.post("/train-model")
async def train_model_endpoint(request: TrainModelRequest):
    """Train a machine learning model"""
    try:
        # Validate data
        if not request.data or len(request.data) == 0:
            raise HTTPException(
                status_code=400,
                detail="Data is empty or not provided"
            )

        if len(request.data) > config.MAX_ROWS:
            raise HTTPException(
                status_code=400,
                detail=f"Data exceeds maximum rows limit of {config.MAX_ROWS}"
            )

        # Validate features list
        if not request.features or len(request.features) == 0:
            raise HTTPException(
                status_code=400,
                detail="At least one feature must be specified"
            )

        # Check for duplicate features
        if len(request.features) != len(set(request.features)):
            raise HTTPException(
                status_code=400,
                detail="Duplicate features found in features list"
            )

        # Validate target variable (required for supervised models, optional for unsupervised)
        unsupervised_models = ["kmeans", "dbscan", "hierarchical_clustering", "pca", "tsne", "umap"]
        is_unsupervised = request.model_type in unsupervised_models

        if not is_unsupervised:
            if not request.target_variable or not request.target_variable.strip():
                raise HTTPException(
                    status_code=400,
                    detail="Target variable is required for supervised learning models"
                )
            # Validate that target is not in features
            if request.target_variable in request.features:
                raise HTTPException(
                    status_code=400,
                    detail="Target variable cannot be in the features list"
                )

        # PERF-8/PY-1: dispatch + fit (blocking sklearn/heavy-ML CPU work) runs in
        # the threadpool so a long-running training job cannot stall the event loop
        # and starve every other concurrent request. HTTPException/ValueError raised
        # inside _dispatch_train_model propagate back through await and are handled
        # by the same except clauses below — behavior is identical.
        # PY-1: the threadpool offload is WRAPPED by the same training gate as MMM —
        # a concurrency semaphore (queue-full → 503) plus a per-call timeout, so a
        # burst of ML fits cannot saturate every worker thread.
        async def _run():
            return await run_in_threadpool(_dispatch_train_model, request)
        result = await _with_training_gate(_run, timeout_s=180)

        return result
    except MissingDependencyError as e:
        # PY-2: the requested model type's backing library is not installed in
        # this image. Return a distinct 501 Not-Implemented (not 400/500) so an
        # operator can tell "unsupported in this deployment" from "bad input".
        logger.warning(f"MissingDependency in train_model: model_type={request.model_type}: {str(e)}")
        raise HTTPException(status_code=501, detail=str(e)) from None
    except ValueError as e:
        logger.error(f"ValueError in train_model: {str(e)}")
        logger.debug(f"Request details: model_type={request.model_type}, target_variable={request.target_variable}, features={request.features}")
        raise HTTPException(status_code=400, detail=str(e)) from None
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in train_model: {traceback.format_exc()}")
        logger.debug(f"Request details: model_type={request.model_type}, target_variable={request.target_variable}, features={request.features}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}") from None


def _dispatch_train_model(request: TrainModelRequest) -> dict[str, Any]:
    """PERF-8/PY-1: synchronous dispatch + fit for /train-model. Runs in the
    threadpool (off the event loop) via run_in_threadpool. Behavior is identical
    to the previous inline chain; HTTPException/ValueError propagate to the caller."""
    # Train model based on type
    if request.model_type == "linear":
        result = train_linear_regression(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "log_log":
        result = train_log_log_regression(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "logistic":
        result = train_logistic_regression(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "ridge":
        alpha = request.alpha if request.alpha is not None else 1.0
        result = train_ridge_regression(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            alpha=alpha,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "lasso":
        alpha = request.alpha if request.alpha is not None else 1.0
        result = train_lasso_regression(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            alpha=alpha,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "random_forest":
        n_estimators = request.n_estimators if request.n_estimators is not None else 100
        result = train_random_forest(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            n_estimators=n_estimators,
            max_depth=request.max_depth,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "decision_tree":
        result = train_decision_tree(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            max_depth=request.max_depth,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "gradient_boosting":
        n_estimators = request.n_estimators if request.n_estimators is not None else 100
        learning_rate = request.learning_rate if request.learning_rate is not None else 0.1
        max_depth = request.max_depth if request.max_depth is not None else 3
        result = train_gradient_boosting(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            n_estimators=n_estimators,
            learning_rate=learning_rate,
            max_depth=max_depth,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "elasticnet":
        alpha = request.alpha if request.alpha is not None else 1.0
        l1_ratio = request.l1_ratio if request.l1_ratio is not None else 0.5
        result = train_elasticnet(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            alpha=alpha,
            l1_ratio=l1_ratio,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "svm":
        kernel = request.kernel if request.kernel is not None else 'rbf'
        C = request.C if request.C is not None else 1.0
        result = train_svm(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            kernel=kernel,
            C=C,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "knn":
        n_neighbors = request.n_neighbors if request.n_neighbors is not None else 5
        result = train_knn(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            n_neighbors=n_neighbors,
            test_size=request.test_size,
            random_state=request.random_state
        )
    # Additional regression models
    elif request.model_type == "polynomial":
        degree = request.degree if request.degree is not None else 2
        result = train_polynomial_regression(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            degree=degree,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "bayesian":
        result = train_bayesian_regression(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "quantile":
        quantile = request.quantile if request.quantile is not None else 0.5
        alpha = request.alpha if request.alpha is not None else 1.0
        result = train_quantile_regression(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            quantile=quantile,
            alpha=alpha,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "poisson":
        alpha = request.alpha if request.alpha is not None else 1.0
        result = train_poisson_regression(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            alpha=alpha,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "gamma":
        alpha = request.alpha if request.alpha is not None else 1.0
        result = train_gamma_regression(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            alpha=alpha,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "tweedie":
        power = request.power if request.power is not None else 0.0
        alpha = request.alpha if request.alpha is not None else 1.0
        result = train_tweedie_regression(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            power=power,
            alpha=alpha,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "extra_trees":
        n_estimators = request.n_estimators if request.n_estimators is not None else 100
        result = train_extra_trees(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            n_estimators=n_estimators,
            max_depth=request.max_depth,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "xgboost":
        n_estimators = request.n_estimators if request.n_estimators is not None else 100
        max_depth = request.max_depth if request.max_depth is not None else 3
        learning_rate = request.learning_rate if request.learning_rate is not None else 0.1
        result = train_xgboost(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            n_estimators=n_estimators,
            max_depth=max_depth,
            learning_rate=learning_rate,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "lightgbm":
        n_estimators = request.n_estimators if request.n_estimators is not None else 100
        max_depth = request.max_depth if request.max_depth is not None else -1
        learning_rate = request.learning_rate if request.learning_rate is not None else 0.1
        result = train_lightgbm(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            n_estimators=n_estimators,
            max_depth=max_depth,
            learning_rate=learning_rate,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "catboost":
        iterations = request.iterations if request.iterations is not None else 100
        depth = request.depth if request.depth is not None else 6
        learning_rate = request.learning_rate if request.learning_rate is not None else 0.1
        result = train_catboost(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            iterations=iterations,
            depth=depth,
            learning_rate=learning_rate,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "gaussian_process":
        result = train_gaussian_process(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "mlp":
        hidden_layer_sizes = tuple(request.hidden_layer_sizes) if request.hidden_layer_sizes else (100,)
        activation = request.activation if request.activation else 'relu'
        solver = request.solver if request.solver else 'adam'
        max_iter = request.max_iter if request.max_iter else 200
        result = train_mlp(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            hidden_layer_sizes=hidden_layer_sizes,
            activation=activation,
            solver=solver,
            alpha=request.alpha if request.alpha else 0.0001,
            learning_rate='constant',
            max_iter=max_iter,
            test_size=request.test_size,
            random_state=request.random_state
        )
    # Additional classification models
    elif request.model_type == "multinomial_logistic":
        result = train_multinomial_logistic(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type.startswith("naive_bayes_"):
        variant = request.model_type.replace("naive_bayes_", "")
        result = train_naive_bayes(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            variant=variant,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "lda":
        result = train_lda(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "qda":
        result = train_qda(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            test_size=request.test_size,
            random_state=request.random_state
        )
    # Unsupervised learning - Clustering
    elif request.model_type == "kmeans":
        n_clusters = request.n_clusters if request.n_clusters is not None else 3
        result = train_kmeans(
            data=request.data,
            features=request.features,
            n_clusters=n_clusters,
            random_state=request.random_state
        )
    elif request.model_type == "dbscan":
        eps = request.eps if request.eps is not None else 0.5
        min_samples = request.min_samples if request.min_samples is not None else 5
        result = train_dbscan(
            data=request.data,
            features=request.features,
            eps=eps,
            min_samples=min_samples
        )
    elif request.model_type == "hierarchical_clustering":
        n_clusters = request.n_clusters if request.n_clusters is not None else 3
        linkage = request.linkage if request.linkage else 'ward'
        result = train_hierarchical_clustering(
            data=request.data,
            features=request.features,
            n_clusters=n_clusters,
            linkage=linkage
        )
    # Unsupervised learning - Dimensionality Reduction
    elif request.model_type == "pca":
        result = train_pca(
            data=request.data,
            features=request.features,
            n_components=request.n_components
        )
    elif request.model_type == "tsne":
        n_components = request.n_components if request.n_components is not None else 2
        perplexity = request.perplexity if request.perplexity is not None else 30.0
        result = train_tsne(
            data=request.data,
            features=request.features,
            n_components=n_components,
            perplexity=perplexity,
            random_state=request.random_state
        )
    elif request.model_type == "umap":
        n_components = request.n_components if request.n_components is not None else 2
        min_dist = request.min_dist if request.min_dist is not None else 0.1
        n_neighbors = request.n_neighbors if request.n_neighbors is not None else 15
        result = train_umap(
            data=request.data,
            features=request.features,
            n_components=n_components,
            n_neighbors=n_neighbors,
            min_dist=min_dist,
            random_state=request.random_state
        )
    # Time series models
    elif request.model_type in ["arima", "sarima"]:
        order = tuple(request.order) if request.order and len(request.order) == 3 else (1, 1, 1)
        seasonal_order = tuple(request.seasonal_order) if request.seasonal_order and len(request.seasonal_order) == 4 else None
        result = train_arima(
            data=request.data,
            target_variable=request.target_variable,
            date_column=request.date_column,
            order=order,
            seasonal_order=seasonal_order
        )
    elif request.model_type == "exponential_smoothing":
        result = train_exponential_smoothing(
            data=request.data,
            target_variable=request.target_variable,
            date_column=request.date_column,
            trend=request.trend,
            seasonal=request.seasonal,
            seasonal_periods=request.seasonal_periods
        )
    elif request.model_type == "lstm":
        sequence_length = request.sequence_length if request.sequence_length is not None else 10
        lstm_units = request.lstm_units if request.lstm_units is not None else 50
        epochs = request.epochs if request.epochs is not None else 50
        result = train_lstm(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            sequence_length=sequence_length,
            lstm_units=lstm_units,
            epochs=epochs,
            test_size=request.test_size,
            random_state=request.random_state
        )
    elif request.model_type == "gru":
        sequence_length = request.sequence_length if request.sequence_length is not None else 10
        gru_units = request.gru_units if request.gru_units is not None else 50
        epochs = request.epochs if request.epochs is not None else 50
        result = train_gru(
            data=request.data,
            target_variable=request.target_variable,
            features=request.features,
            sequence_length=sequence_length,
            gru_units=gru_units,
            epochs=epochs,
            test_size=request.test_size,
            random_state=request.random_state
        )
    # Anomaly detection models
    elif request.model_type == "isolation_forest":
        contamination = request.contamination if request.contamination is not None else 0.1
        n_estimators = request.n_estimators if request.n_estimators is not None else 100
        result = train_isolation_forest(
            data=request.data,
            features=request.features,
            contamination=contamination,
            n_estimators=n_estimators,
            random_state=request.random_state
        )
    elif request.model_type == "one_class_svm":
        nu = request.nu if request.nu is not None else 0.1
        kernel = request.kernel if request.kernel is not None else 'rbf'
        result = train_one_class_svm(
            data=request.data,
            features=request.features,
            nu=nu,
            kernel=kernel,
            random_state=request.random_state
        )
    elif request.model_type == "local_outlier_factor":
        n_neighbors = request.n_neighbors if request.n_neighbors is not None else 20
        contamination = request.contamination if request.contamination is not None else 0.1
        result = train_local_outlier_factor(
            data=request.data,
            features=request.features,
            n_neighbors=n_neighbors,
            contamination=contamination
        )
    elif request.model_type == "elliptic_envelope":
        contamination = request.contamination if request.contamination is not None else 0.1
        result = train_elliptic_envelope(
            data=request.data,
            features=request.features,
            contamination=contamination,
            random_state=request.random_state
        )
    # Recommendation systems
    elif request.model_type == "matrix_factorization":
        if not request.user_column or not request.item_column or not request.rating_column:
            raise HTTPException(
                status_code=400,
                detail="user_column, item_column, and rating_column are required for matrix factorization"
            )
        n_factors = request.n_factors if request.n_factors is not None else 50
        n_epochs = request.n_epochs if request.n_epochs is not None else 20
        learning_rate = request.learning_rate if request.learning_rate is not None else 0.01
        regularization = request.regularization if request.regularization is not None else 0.1
        result = train_matrix_factorization(
            data=request.data,
            user_column=request.user_column,
            item_column=request.item_column,
            rating_column=request.rating_column,
            n_factors=n_factors,
            n_epochs=n_epochs,
            learning_rate=learning_rate,
            regularization=regularization
        )
    # Survival analysis
    elif request.model_type == "cox_proportional_hazards":
        if not request.duration_column or not request.event_column:
            raise HTTPException(
                status_code=400,
                detail="duration_column and event_column are required for Cox Proportional Hazards"
            )
        result = train_cox_proportional_hazards(
            data=request.data,
            duration_column=request.duration_column,
            event_column=request.event_column,
            features=request.features
        )
    elif request.model_type == "kaplan_meier":
        if not request.duration_column or not request.event_column:
            raise HTTPException(
                status_code=400,
                detail="duration_column and event_column are required for Kaplan-Meier"
            )
        result = train_kaplan_meier(
            data=request.data,
            duration_column=request.duration_column,
            event_column=request.event_column,
            group_column=request.group_column
        )
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported model type: {request.model_type}"
        )

    return result


class BudgetRedistributeRequest(BaseModel):
    """W50 — input contract for /mmm/budget-redistribute. See docs/architecture/mmm.md."""
    data: list[dict[str, Any]]
    spend_columns: list[str] = Field(min_length=1, max_length=20)
    outcome_column: str
    time_column: str
    total_budget: float | None = Field(default=None, gt=0)
    per_channel_bounds: dict[str, list[float]] | None = None
    bound_multipliers: list[float] | None = None
    bootstrap_iters: int = Field(default=50, ge=0, le=500)
    seed: int = 42
    ridge_alpha: float = Field(default=1.0, ge=1e-6, le=1e6)
    sweeps: int = Field(default=2, ge=1, le=4)
    max_obs: int | None = Field(default=None, ge=12, le=1040)


@app.post("/mmm/budget-redistribute")
async def budget_redistribute_endpoint(request: BudgetRedistributeRequest):
    """Fit MMM and run constrained budget reallocation. Returns optimal totals,
    projected lift, response curves, and diagnostics. Compute is gated by the
    same training semaphore so an MMM job cannot starve the service."""
    try:
        if not request.data:
            raise HTTPException(status_code=400, detail="Data is empty or not provided")
        if len(request.data) > config.MAX_ROWS:
            raise HTTPException(status_code=400, detail=f"Data exceeds maximum rows limit of {config.MAX_ROWS}")
        if request.outcome_column in request.spend_columns:
            raise HTTPException(status_code=400, detail="outcome_column cannot also be in spend_columns")
        if len(set(request.spend_columns)) != len(request.spend_columns):
            raise HTTPException(status_code=400, detail="Duplicate entries in spend_columns")

        # PERF-8/PY-1: the pandas cleaning/resampling is blocking CPU work; run it
        # off the event loop too (the MMM fit was already offloaded below).
        spend_df, y, dates = await run_in_threadpool(_prepare_mmm_frame, request)

        from mmm.fit import channel_response_curve, fit_mmm
        from mmm.optimize import optimize_allocation

        async def _run():
            return await asyncio.to_thread(
                _run_mmm_pipeline, spend_df, y, dates, request, fit_mmm, channel_response_curve, optimize_allocation
            )
        return await _with_training_gate(_run, timeout_s=180)
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    except Exception as e:
        logger.error(f"Error in budget_redistribute: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}") from None


def _prepare_mmm_frame(request: BudgetRedistributeRequest):
    """PERF-8/PY-1: synchronous pandas cleaning + weekly resampling for
    /mmm/budget-redistribute. Runs in the threadpool. Returns (spend_df, y, dates);
    raises HTTPException on validation failures (propagated through await)."""
    import pandas as pd  # local import — pd not used elsewhere in main.py

    df = pd.DataFrame(request.data)
    for col in [*request.spend_columns, request.outcome_column, request.time_column]:
        if col not in df.columns:
            raise HTTPException(status_code=400, detail=f"Column '{col}' not present in data")

    df[request.time_column] = pd.to_datetime(df[request.time_column], errors="coerce")
    df = df.dropna(subset=[request.time_column])
    for col in [*request.spend_columns, request.outcome_column]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=[*request.spend_columns, request.outcome_column])
    if len(df) < 12:
        raise HTTPException(status_code=400, detail=f"Need at least 12 valid observations after cleaning; got {len(df)}")

    weekly = (
        df.set_index(request.time_column)
          .sort_index()
          .resample("W-MON")
          .agg({**{c: "sum" for c in request.spend_columns}, request.outcome_column: "sum"})
          .dropna()
    )
    if len(weekly) < 12:
        raise HTTPException(status_code=400, detail=f"Need at least 12 weekly observations; got {len(weekly)}")

    spend_df = weekly[request.spend_columns].astype(float).reset_index(drop=True)
    y = weekly[request.outcome_column].astype(float).values
    dates = weekly.index.values
    return spend_df, y, dates


def _run_mmm_pipeline(spend_df, y, dates, request: BudgetRedistributeRequest, fit_mmm, channel_response_curve, optimize_allocation):
    fit = fit_mmm(
        spend_df, y, dates=dates,
        ridge_alpha=request.ridge_alpha,
        sweeps=request.sweeps,
        bootstrap_iters=request.bootstrap_iters,
        seed=request.seed,
        max_obs=request.max_obs,
    )
    bounds = None
    if request.per_channel_bounds:
        bounds = {}
        for ch, pair in request.per_channel_bounds.items():
            if len(pair) != 2 or pair[0] < 0 or pair[1] < pair[0]:
                raise ValueError(f"per_channel_bounds[{ch}] must be [min, max] with 0 ≤ min ≤ max")
            bounds[ch] = (float(pair[0]), float(pair[1]))
    bm = (0.5, 2.0)
    if request.bound_multipliers:
        if len(request.bound_multipliers) != 2 or request.bound_multipliers[0] < 0 or request.bound_multipliers[1] < request.bound_multipliers[0]:
            raise ValueError("bound_multipliers must be [low, high] with 0 ≤ low ≤ high")
        bm = (float(request.bound_multipliers[0]), float(request.bound_multipliers[1]))
    opt = optimize_allocation(fit, total_budget=request.total_budget, bounds=bounds, bound_multipliers=bm)

    response_curves: dict[str, Any] = {}
    for cf in fit.channels:
        rc = channel_response_curve(fit, cf.name)
        rc["optimal_x"] = float(opt.optimal_totals[cf.name])
        response_curves[cf.name] = rc

    channels_out: list[dict[str, Any]] = []
    for cf in fit.channels:
        cur_t = float(opt.current_totals[cf.name])
        opt_t = float(opt.optimal_totals[cf.name])
        channels_out.append({
            "name": cf.name,
            "decay": cf.decay, "k": cf.k, "alpha": cf.alpha,
            "beta": cf.beta,
            "elasticity": cf.elasticity,
            "elasticity_ci95": list(cf.elasticity_ci95),
            "current_total_spend": cur_t,
            "optimal_total_spend": opt_t,
            "delta_pct": (opt_t - cur_t) / max(cur_t, 1e-12) * 100.0,
        })
    return {
        "channels": channels_out,
        "current_allocation": {k: float(v) for k, v in opt.current_totals.items()},
        "optimal_allocation": {k: float(v) for k, v in opt.optimal_totals.items()},
        "current_outcome": opt.current_outcome,
        "optimal_outcome": opt.optimal_outcome,
        "projected_lift_pct": opt.lift_pct,
        "converged": opt.converged,
        "iterations": opt.iterations,
        "bounds_used": {ch: [float(b[0]), float(b[1])] for ch, b in opt.bounds_used.items()},
        "total_budget_used": opt.total_budget_used,
        "fit_metrics": {
            "r_squared": fit.r_squared,
            "rmse": fit.rmse,
            "n_observations": fit.n_observations,
            "max_pairwise_vif": fit.diagnostics.get("max_pairwise_vif", 1.0),
        },
        "model_caveats": list(fit.diagnostics.get("model_caveats", [])),
        "response_curves": response_curves,
    }


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Global exception handler"""
    logger.error(f"Unhandled exception: {traceback.format_exc()}")
    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal server error: {str(exc)}"}
    )


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=config.HOST,
        port=config.PORT,
        reload=True,
        # Avoid reload loops when pip writes into .venv (watchfiles otherwise retriggers constantly).
        reload_excludes=[".venv", "**/.venv/**"],
    )

