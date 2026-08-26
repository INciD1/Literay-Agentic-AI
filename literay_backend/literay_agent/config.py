"""Centralized, validated configuration for the Literay backend agent.

Settings are read from environment variables exactly once, at import time,
into an immutable Settings object. A missing required variable fails loudly
here — at startup — instead of surfacing deep inside a tool call mid-demo.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from .exceptions import ConfigError


@dataclass(frozen=True)
class Settings:
    """Immutable runtime configuration for the agent."""

    project_id: str
    location: str
    agent_engine_location: str  # deliberately separate from `location`
    search_engine_id: str
    agent_engine_id: str
    log_level: str

    @classmethod
    def from_env(cls) -> "Settings":
        """Builds Settings from environment variables.

        Raises:
            ConfigError: if a required variable is missing.
        """
        try:
            project_id = os.environ["GOOGLE_CLOUD_PROJECT"]
            search_engine_id = os.environ["VERTEX_SEARCH_ENGINE_ID"]
        except KeyError as missing_var:
            raise ConfigError(
                f"Missing required environment variable: {missing_var}"
            ) from missing_var

        return cls(
            project_id=project_id,
            # Used for Gemini model calls and Vertex AI Search — both live at
            # "global" for this project. Do NOT reuse this for Agent Engine.
            location=os.environ.get("GOOGLE_CLOUD_LOCATION", "global"),
            # Agent Engine (Session + Memory Bank) does not support "global" —
            # the instance was created at us-central1. Kept as its own env
            # var so the two never accidentally get set to the same value.
            agent_engine_location=os.environ.get("AGENT_ENGINE_LOCATION", "us-central1"),
            search_engine_id=search_engine_id,
            # Optional until the one-time Agent Engine instance exists (see README step 5).
            agent_engine_id=os.environ.get("AGENT_ENGINE_ID", ""),
            log_level=os.environ.get("LOG_LEVEL", "INFO"),
        )


settings = Settings.from_env()