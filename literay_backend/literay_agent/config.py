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
            location=os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1"),
            search_engine_id=search_engine_id,
            # Optional until the one-time Agent Engine instance exists (see README step 5).
            agent_engine_id=os.environ.get("AGENT_ENGINE_ID", ""),
            log_level=os.environ.get("LOG_LEVEL", "INFO"),
        )


settings = Settings.from_env()