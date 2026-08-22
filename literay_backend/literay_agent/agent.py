"""Literay — ADK agent definition (backend / orchestration role).

Loop this agent drives, per document session:
  ingest -> explain clause -> ask clarifying question (if needed)
  -> quiz -> (role 4's Firestore/memory tools log the result)

Run locally:
    adk web literay_agent      # browser chat UI
    adk run literay_agent      # terminal chat
"""
from __future__ import annotations

from google.adk.agents import Agent

from .tools import search_document

# TODO (role 4 hands these off): once ready, import and append to TOOLS below.
#   from .tools.memory_tools import log_quiz_result, get_document_metadata
# Keep the same TypedDict-with-"status" return convention used by
# search_document so error handling in the agent loop stays consistent.

AGENT_INSTRUCTION = (
    "You are Literay, a reading partner for dense documents (contracts, leases, ToS). "
    "For each clause: (1) call search_document to ground your explanation in the real "
    "source text, never invent clause language, (2) explain it in plain language, "
    "(3) ask a clarifying question only if the clause depends on the user's specific "
    "situation, (4) ask one short comprehension question. Before explaining a clause "
    "type, check memory for whether this user has struggled with it before, and if so, "
    "explain it more slowly and concretely."
)

TOOLS = [search_document]  # role 4's tools get appended here once ready

root_agent = Agent(
    model="gemini-3.5-flash",
    name="literay_agent",
    description="Walks a user through a dense document clause by clause.",
    instruction=AGENT_INSTRUCTION,
    tools=TOOLS,
)