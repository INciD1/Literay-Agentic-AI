# Literay — Backend / ADK Agent Orchestration

Spin-up instructions for the orchestration service. Requires Python 3.11+
and a Google Cloud project with billing enabled.

## Layout

```
literay_backend/
├── literay_agent/
│   ├── agent.py            # Agent definition + instruction + tool list
│   ├── config.py           # Settings, loaded once from env vars
│   ├── exceptions.py       # Typed error hierarchy
│   ├── logging_config.py   # Shared logger setup
│   ├── runner.py           # Session + Memory Bank wiring, CLI entrypoint
│   └── tools/
│       └── search.py       # RAG grounding tool (Vertex AI Search), with retries
├── tests/
├── requirements.txt
├── .env.example
└── pyproject.toml          # black / ruff / pytest config
```

## 1. Install dependencies

```bash
git clone <your-repo-url>
cd literay_backend
pip install -r requirements.txt
```

## 2. Authenticate and enable APIs

```bash
gcloud auth application-default login
gcloud services enable \
  aiplatform.googleapis.com \
  discoveryengine.googleapis.com \
  run.googleapis.com
```

## 3. Configure environment variables

```bash
cp .env.example .env
# fill in GOOGLE_CLOUD_PROJECT, VERTEX_SEARCH_ENGINE_ID (from the RAG role),
# leave AGENT_ENGINE_ID blank until step 5
export $(grep -v '^#' .env | xargs)
```

## 4. Run locally without persistence first

Sanity-checks the instruction and tool-calling loop before wiring real services.

```bash
adk web literay_agent
# opens a local chat UI, default http://localhost:8000
```

## 5. Create an Agent Engine instance (one-time, gives Session + Memory Bank)

```python
import vertexai
from vertexai import agent_engines

vertexai.init(project="<PROJECT_ID>", location="<LOCATION>")
agent_engine = agent_engines.create()
print(agent_engine.name)  # copy the ID into AGENT_ENGINE_ID in .env
```

> Check this against the current Agent Engine docs before running — the
> Python SDK surface for Session/Memory Bank creation has been changing as
> the product matures.

## 6. Test with persistent memory

```bash
python -m literay_agent.runner --message "Explain this lease"
```

## 7. Run tests

```bash
pytest
```

## 8. Deploy to Cloud Run

```bash
adk deploy cloud_run \
  --project=$GOOGLE_CLOUD_PROJECT \
  --region=$GOOGLE_CLOUD_LOCATION \
  literay_agent
# note the printed SERVICE_URL
```

## 9. Verify it's live on Cloud Run

```bash
curl -X POST "$SERVICE_URL/run" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "demo", "user_id": "demo", "message": "Explain this lease"}'
```

Keep the Cloud Run URL and a screenshot of the Cloud Run dashboard / Vertex
AI logs — the hackathon submission requires visible proof the backend runs
on Google Cloud.

## Design notes (for the Project Story / judging write-up)

- **Every tool returns a dict with a `status` key** (`tools/search.py`) —
  failures never raise past the tool boundary, so one bad API call can't
  crash the whole conversation turn.
- **Transient failures are retried with exponential backoff** (`tenacity`,
  3 attempts) before being reported as an error — distinguishes a flaky
  network blip from a real grounding failure.
- **Config fails at startup, not mid-demo** — `Settings.from_env()` raises
  immediately if a required variable is missing, instead of surfacing a
  confusing `KeyError` three calls deep during the live demo.
- **State is intentionally split**: Memory Bank (semantic, agent-facing
  recall) vs. Firestore (structured, UI-facing session/quiz data), owned by
  separate roles so neither becomes a dumping ground for both concerns.