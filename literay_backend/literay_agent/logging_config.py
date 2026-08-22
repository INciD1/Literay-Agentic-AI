"""Centralized logging setup so every module logs in the same format.

Usage:
    from .logging_config import get_logger
    logger = get_logger(__name__)
"""
from __future__ import annotations

import logging
import sys

_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"


def get_logger(name: str) -> logging.Logger:
    """Returns a configured logger, attaching a handler only once per name."""
    from .config import settings  # local import: avoids a circular import at module load

    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter(_FORMAT))
        logger.addHandler(handler)
        logger.setLevel(settings.log_level)
        logger.propagate = False
    return logger