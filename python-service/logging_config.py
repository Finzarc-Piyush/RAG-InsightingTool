"""
PY-7 / OBS-2 · Structured logging for the data-ops service.

The service previously used bare ``print()`` (64 sites, no levels, no
correlation), so production had no log-level control and verbose
expression/dataframe traces (some carrying user data) always emitted.

``configure_logging()`` installs a JSON formatter on the root logger (level
from ``LOG_LEVEL``, default ``INFO``), mirroring the Node tier's structured
output (OBS-1). ``get_logger(name)`` returns a namespaced child logger. An
optional ``X-Trace-Id`` (set per-request via ``contextvars``) is stamped on
every record so a line can be tied to the turn that produced it.
"""
from __future__ import annotations

import json
import logging
import os
from contextvars import ContextVar
from datetime import UTC, datetime

# Per-request trace id (best-effort; bound by the request middleware).
trace_id_var: ContextVar[str | None] = ContextVar("trace_id", default=None)


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": datetime.now(UTC).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        tid = trace_id_var.get()
        if tid:
            payload["traceId"] = tid
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


_configured = False


def configure_logging() -> None:
    """Idempotently install the JSON handler + level from LOG_LEVEL (default INFO)."""
    global _configured
    if _configured:
        return
    level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    handler = logging.StreamHandler()
    handler.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)
    _configured = True


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"dataops.{name}")
