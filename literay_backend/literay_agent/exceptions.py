"""Custom exception hierarchy for the Literay backend.

Tools still return plain dicts to satisfy the ADK tool-calling contract
(see tools/search.py), but internally we raise these so failure modes are
explicit, typed, and easy to catch in tests — rather than passing bare
Exception around.
"""


class LiterayError(Exception):
    """Base class for all errors raised by the Literay backend."""


class ConfigError(LiterayError):
    """Raised when required configuration is missing or invalid."""


class SearchGroundingError(LiterayError):
    """Raised when Vertex AI Search grounding fails after all retries."""