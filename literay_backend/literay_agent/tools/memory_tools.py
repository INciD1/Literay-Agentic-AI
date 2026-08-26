"""Memory tools — Agent Engine Memory Bank wiring for cross-session recall.

This module owns *how the agent writes and reads user weak-spot memory*
mid-conversation — a personalization concern, parallel to how search.py
owns document grounding.
"""
from __future__ import annotations

from typing import TypedDict

from google.adk.memory import VertexAiMemoryBankService
from google.adk.memory.memory_entry import MemoryEntry
from google.adk.tools import ToolContext
from google.genai.types import Content, Part
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from ..config import settings
from ..logging_config import get_logger

logger = get_logger(__name__)

# Must match the `app_name` the Runner is created with in runner.py
# (Runner(agent=root_agent, app_name="literay", ...)) — Memory Bank scopes
# memories by (app_name, user_id), so a mismatch here means writes and
# reads silently land in different scopes and recall will look empty.
APP_NAME = "literay"


class MemoryResult(TypedDict, total=False):
    """Return shape for memory tools. `weak_spots` present on success for
    get_document_metadata; error_message present on failure.
    """

    status: str
    weak_spots: list[str]
    error_message: str


def _memory_service() -> VertexAiMemoryBankService:
    """Builds a fresh Memory Bank client, scoped to this project's
    Agent Engine instance. Uses agent_engine_location (us-central1), NOT
    settings.location (global) — the Agent Engine instance itself lives in
    a different location than Gemini/Search calls do.
    """
    return VertexAiMemoryBankService(
        project=settings.project_id,
        location=settings.agent_engine_location,
        agent_engine_id=settings.agent_engine_id,
    )


def _user_id_from(tool_context: ToolContext) -> str:
    """Reads the real session user_id from ADK's injected ToolContext,
    instead of asking the model to supply it as a plain argument — Gemini
    has no way to know the actual user_id, so it must never be a
    model-filled parameter.
    """
    return tool_context._invocation_context.session.user_id


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    retry=retry_if_exception_type(Exception),
    reraise=True,
)
async def _write_memory(service: VertexAiMemoryBankService, user_id: str, text: str) -> None:
    """Writes one memory entry, with exponential-backoff retries for
    transient failures."""
    await service.add_memory(
        app_name=APP_NAME,
        user_id=user_id,
        memories=[MemoryEntry(content=Content(parts=[Part(text=text)]))],
    )


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    retry=retry_if_exception_type(Exception),
    reraise=True,
)
async def _search_memory(service: VertexAiMemoryBankService, user_id: str, query: str):
    """Searches past memory entries, with exponential-backoff retries for
    transient failures. Returns a SearchMemoryResponse (has `.memories`,
    a list of MemoryEntry)."""
    return await service.search_memory(app_name=APP_NAME, user_id=user_id, query=query)


async def log_quiz_result(
    tool_context: ToolContext, clause_type: str, was_correct: bool
) -> MemoryResult:
    """Records whether the user answered a clause comprehension question
    correctly, so future sessions can detect recurring weak spots.

    `tool_context` is injected automatically by ADK (detected by its type
    annotation) — never filled in by the model. This is what ties the
    memory write to the *real* session user, not a guessed value.

    This function is registered as an ADK tool, so it must never raise —
    all failures are caught and returned as {"status": "error", ...} so the
    agent can recover mid-conversation instead of crashing the turn.
    """
    user_id = _user_id_from(tool_context)
    logger.info(
        "log_quiz_result: user_id=%s clause_type=%s correct=%s",
        user_id, clause_type, was_correct,
    )
    try:
        service = _memory_service()
        outcome = "correctly" if was_correct else "incorrectly"
        text = f"User answered a {clause_type} clause comprehension question {outcome}."
        await _write_memory(service, user_id, text)
        logger.info("log_quiz_result: written for user_id=%s", user_id)
        return {"status": "success"}
    except Exception as exc:  # noqa: BLE001
        logger.error("log_quiz_result failed for user_id=%s: %s", user_id, exc)
        return {"status": "error", "error_message": str(exc)}


def _extract_text(entry: MemoryEntry) -> str:
    """Pulls the plain text out of a MemoryEntry's Content.parts."""
    if not entry.content or not entry.content.parts:
        return ""
    return " ".join(p.text for p in entry.content.parts if getattr(p, "text", None))


async def get_document_metadata(
    tool_context: ToolContext, clause_type: str
) -> MemoryResult:
    """Checks memory for whether this user has struggled with this clause
    type before, across any past document.

    `tool_context` is injected automatically by ADK — never filled in by
    the model — so this always checks the *real* session user's memory.

    This function is registered as an ADK tool, so it must never raise —
    all failures are caught and returned as {"status": "error", ...} so the
    agent can recover mid-conversation instead of crashing the turn.
    """
    user_id = _user_id_from(tool_context)
    logger.info("get_document_metadata: user_id=%s clause_type=%s", user_id, clause_type)
    try:
        service = _memory_service()
        response = await _search_memory(service, user_id, clause_type)
        weak_spots = [_extract_text(m) for m in (response.memories or [])] if response else []
        weak_spots = [w for w in weak_spots if w]
        logger.info("get_document_metadata: found %d memory entrie(s)", len(weak_spots))
        return {"status": "success", "weak_spots": weak_spots}
    except Exception as exc:  # noqa: BLE001
        logger.error("get_document_metadata failed for user_id=%s: %s", user_id, exc)
        return {"status": "error", "error_message": str(exc)}