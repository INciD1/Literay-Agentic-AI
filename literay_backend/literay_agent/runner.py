"""Wires the agent to persistent Session + Memory services for production
use and Cloud Run deployment.

For quick local testing without persistence, use `adk web literay_agent`
instead — it does not need this file.

CLI usage:
    python -m literay_agent.runner --message "Explain this lease" \\
        --session-id demo --user-id demo
"""
from __future__ import annotations

import argparse
import asyncio

from google.adk.memory import VertexAiMemoryBankService
from google.adk.runners import Runner
from google.adk.sessions import VertexAiSessionService
from google.genai import types

from . import config
from .agent import root_agent
from .logging_config import get_logger

logger = get_logger(__name__)

session_service = VertexAiSessionService(
    project=config.settings.project_id,
    location=config.settings.agent_engine_location,
    agent_engine_id=config.settings.agent_engine_id,
)
memory_service = VertexAiMemoryBankService(
    project=config.settings.project_id,
    location=config.settings.agent_engine_location,
    agent_engine_id=config.settings.agent_engine_id,
)

runner = Runner(
    agent=root_agent,
    app_name="literay",
    session_service=session_service,
    memory_service=memory_service,
)


async def call_agent(query: str, session_id: str, user_id: str) -> str:
    """Sends one message to the agent and returns its final text response."""
    logger.info("call_agent: session_id=%s user_id=%s", session_id, user_id)
    content = types.Content(role="user", parts=[types.Part(text=query)])
    final_text = ""
    async for event in runner.run_async(
        user_id=user_id, session_id=session_id, new_message=content
    ):
        if event.is_final_response():
            final_text = event.content.parts[0].text
    return final_text


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send a one-off message to the Literay agent.")
    parser.add_argument("--message", default="I just uploaded my apartment lease, walk me through it.")
    parser.add_argument("--session-id", default="demo_session")
    parser.add_argument("--user-id", default="demo_user")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    reply = asyncio.run(call_agent(args.message, args.session_id, args.user_id))
    print(reply)


if __name__ == "__main__":
    main()