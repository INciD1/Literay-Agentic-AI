"""Creates the Agent Engine instance that hosts this agent's Session +
Memory Bank services.

Agent Engine does NOT support location "global" — must be a real region
(us-central1) or the "us"/"eu" multi-region — so this hardcodes its own
location instead of reusing config.settings.location (which is "global",
set for Gemini model calls and Vertex AI Search).
"""
import vertexai
from vertexai import agent_engines

from literay_agent import config
from literay_agent.agent import root_agent

AGENT_ENGINE_LOCATION = "us-central1"  # intentionally NOT config.settings.location

vertexai.init(
    project=config.settings.project_id,
    location=AGENT_ENGINE_LOCATION,
    staging_bucket="gs://literay-agent-staging-bucket",
)

remote_agent = agent_engines.create(
    agent_engine=root_agent,
    requirements=[
        "google-adk[gcp]",  # required — the packaged agent imports google.adk directly
        "google-cloud-aiplatform[agent_engines,adk]",
        "google-cloud-discoveryengine",
        "tenacity",
    ],
    extra_packages=["./literay_agent"],  # bundles the whole package with the deploy
    env_vars={
        "VERTEX_SEARCH_ENGINE_ID": config.settings.search_engine_id,
    },
)

print(remote_agent.resource_name)  # this is the AGENT_ENGINE_ID to set as an env var