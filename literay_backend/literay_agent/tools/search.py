"""RAG grounding tool — orchestration's wiring for Vertex AI Search.

The datastore/search app itself (settings.search_engine_id) is set up and
tuned by the RAG role. This module only owns *how the agent calls it*
mid-conversation, and how failures are retried and reported — an
orchestration concern.
"""
from __future__ import annotations

from typing import TypedDict

from google.cloud import discoveryengine_v1 as discoveryengine
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from ..config import settings
from ..logging_config import get_logger

logger = get_logger(__name__)


class SearchResult(TypedDict, total=False):
    """Return shape for search_document. `clauses` is present on success,
    `error_message` is present on failure — callers should branch on `status`.
    """

    status: str
    clauses: list[str]
    error_message: str


def _serving_config_path() -> str:
    return (
        f"projects/{settings.project_id}/locations/{settings.location}"
        f"/collections/default_collection/engines/{settings.search_engine_id}"
        f"/servingConfigs/default_config"
    )


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    retry=retry_if_exception_type(Exception),
    reraise=True,
)
def _run_search(
    client: discoveryengine.SearchServiceClient,
    request: discoveryengine.SearchRequest,
):
    """Runs the search with exponential-backoff retries for transient failures."""
    return client.search(request)


def search_document(query: str, document_id: str) -> SearchResult:
    """Retrieves the most relevant clauses from the user's uploaded document
    for a given query, grounded in the actual source text (RAG).

    This function is registered as an ADK tool, so it must never raise —
    all failures are caught and returned as {"status": "error", ...} so the
    agent can recover mid-conversation instead of crashing the turn.

    Args:
        query: what the agent needs to find (e.g. "termination clause").
        document_id: the datastore ID of the active document.

    Returns:
        A SearchResult dict with status "success" (+ clauses) or
        "error" (+ error_message).
    """
    logger.info("search_document: document_id=%s query=%r", document_id, query)
    try:
        client = discoveryengine.SearchServiceClient()
        request = discoveryengine.SearchRequest(
            serving_config=_serving_config_path(),
            query=query,
            filter=f'document_id: ANY("{document_id}")',
            page_size=3,
        )
        results = _run_search(client, request)
        clauses = [r.document.derived_struct_data.get("snippet", "") for r in results]
        logger.info("search_document: found %d clause(s)", len(clauses))
        return {"status": "success", "clauses": clauses}
    except Exception as exc:  # noqa: BLE001 — intentional: tool contract requires a dict, never a raise
        logger.error("search_document failed for document_id=%s: %s", document_id, exc)
        return {"status": "error", "error_message": str(exc)}