import vertexai
from vertexai import agent_engines
from literay_agent import config
from literay_agent.agent import root_agent

vertexai.init(
    project=config.settings.project_id,
    location=config.settings.location,
    staging_bucket="gs://literay-agent-staging-bucket",
)

remote_agent = agent_engines.create(
    agent_engine=root_agent,
    requirements=[
        "google-cloud-aiplatform[agent_engines,adk]",
        "google-cloud-discoveryengine",
        "tenacity",
    ],
    extra_packages=["./literay_agent"],   # เพิ่มบรรทัดนี้ — แนบโค้ดทั้งแพ็กเกจขึ้นไปด้วย
    env_vars={
        "VERTEX_SEARCH_ENGINE_ID": config.settings.search_engine_id,
    },
)

print(remote_agent.resource_name)  # นี่คือ AGENT_ENGINE_ID ที่ต้องเอาไปตั้ง env variable