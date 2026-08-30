# Literay Backend — ADK Agent + Upload Service

Two independently deployed Python services live in this folder:

| Service | Entry point | What it does |
|---|---|---|
| **ADK agent** | `literay_agent/agent.py` (run via `adk web` / `adk deploy cloud_run`) | The conversational agent — Gemini + RAG + memory |
| **Upload/document service** | `literay_agent/upload_server.py` (FastAPI) | Handles file upload, delete, indexing status |

They're separate because the ADK agent is deployed through `adk deploy
cloud_run` (which generates its own container), while the upload service
needs a normal Dockerfile — trying to run both in one process doesn't work
cleanly with ADK's deploy tooling.

## Layout

```
literay_backend/
├── literay_agent/
│   ├── agent.py              # Agent definition + instruction + tools
│   ├── config.py             # Settings, loaded once from env vars
│   ├── exceptions.py
│   ├── logging_config.py
│   ├── runner.py             # Session + Memory Bank wiring, CLI entrypoint
│   ├── upload_server.py      # FastAPI: /ingest, /status, /documents (DELETE), /progress
│   ├── ingest_document.py    # Upload pipeline (GCS -> Firestore -> Vertex AI Search)
│   ├── delete_document.py    # Delete pipeline (reverse of ingest)
│   ├── deploy_agent_engine.py # One-time script: creates the Agent Engine instance
│   ├── Dockerfile            # For the upload service only — ADK generates its own
│   ├── requirements.txt      # IMPORTANT: must live here, not in literay_backend/ —
│   │                         # adk deploy cloud_run looks inside the agent folder
│   └── tools/
│       ├── search.py         # RAG grounding tool (Vertex AI Search), with retries
│       └── memory_tools.py   # get_document_metadata / log_quiz_result (Memory Bank + Firestore)
├── conftest.py                # pytest config — must stay at this level, not inside literay_agent/
├── pyproject.toml
└── requirements.txt            # local-dev convenience copy; the one that matters for
                                 # deploy is literay_agent/requirements.txt above
```

## 1. Local setup

```bash
cd literay_backend
py -3.13 -m venv .venv
.venv\Scripts\activate          # Windows; use source .venv/bin/activate on Mac/Linux
pip install -r requirements.txt
pip install fastapi "uvicorn[standard]" python-multipart   # for upload_server.py
```

## 2. Authenticate + enable APIs (one-time per GCP project)

```bash
gcloud auth login
gcloud config set project <PROJECT_ID>
gcloud auth application-default login
gcloud services enable aiplatform.googleapis.com discoveryengine.googleapis.com \
  run.googleapis.com firestore.googleapis.com storage.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com
```

## 3. Configure environment

Create `literay_agent/.env` (ADK loads `.env` from inside the agent's own
folder, not the repo root):

```
GOOGLE_CLOUD_PROJECT=<your-project-id>
GOOGLE_CLOUD_LOCATION=global
GOOGLE_GENAI_USE_VERTEXAI=TRUE
VERTEX_SEARCH_ENGINE_ID=<your-vertex-search-datastore-id>
AGENT_ENGINE_ID=<your-agent-engine-id>
LOG_LEVEL=INFO
```

> **`GOOGLE_CLOUD_LOCATION` must be `global`**, not a regional value — Gemini
> and Vertex AI Search both need it here. Agent Engine (Memory Bank/Session)
> is a separate location entirely (see step 5) and does NOT support `global`.

## 4. Run locally

**Agent** (terminal 1):
```bash
adk web           # browser chat UI at http://localhost:8000, no persistence
# or: adk api_server --allow_origins="*"   # headless, for the frontend to call directly
```

**Upload service** (terminal 2):
```bash
python literay_agent/upload_server.py   # http://localhost:8001
```

## 5. One-time: create the Agent Engine instance (Session + Memory Bank)

Agent Engine does **not** support `global` — must be `us-central1` or a
`us`/`eu` multi-region:

```python
import vertexai
from vertexai import agent_engines

vertexai.init(project="<PROJECT_ID>", location="us-central1")
agent_engine = agent_engines.create()
print(agent_engine.name)  # copy into AGENT_ENGINE_ID in .env
```

## 6. Run tests

```bash
pytest
```

## 7. Deploy — Agent

```bash
adk deploy cloud_run --project=<PROJECT_ID> --region=<REGION> \
  --allow_origins=<FRONTEND_URL> literay_agent
```

**Env vars must be set on the deployed service too** (not just local `.env`)
— either via the ADK deploy flow's own prompts, or after deploy:
```bash
gcloud run services update adk-default-service-name --project=<PROJECT_ID> --region=<REGION> \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=<PROJECT_ID>,GOOGLE_CLOUD_LOCATION=global,GOOGLE_GENAI_USE_VERTEXAI=TRUE,VERTEX_SEARCH_ENGINE_ID=<...>,AGENT_ENGINE_ID=<...>"
```
(Quote the whole `--set-env-vars` value — unquoted, commas can get lost
depending on the shell and silently merge everything into one variable.)

## 8. Deploy — Upload service

```bash
cd literay_agent
gcloud run deploy literay-upload-service --source . --project=<PROJECT_ID> \
  --region=<REGION> --allow-unauthenticated
```
Confirm the build log says **"Building using Dockerfile"** — if it says
"Buildpacks" instead, the `Dockerfile` in this folder wasn't found/uploaded
and the build will fail (missing dependencies like `discoveryengine`).

## 9. Grant the Cloud Run service account the roles it needs

Both services run as the default Compute service account
(`<PROJECT_NUMBER>-compute@developer.gserviceaccount.com`), which needs:

```bash
gcloud projects add-iam-policy-binding <PROJECT_ID> --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" --role="roles/datastore.user"
gcloud projects add-iam-policy-binding <PROJECT_ID> --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" --role="roles/aiplatform.user"
gcloud projects add-iam-policy-binding <PROJECT_ID> --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" --role="roles/discoveryengine.editor"
gcloud projects add-iam-policy-binding <PROJECT_ID> --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" --role="roles/storage.objectAdmin"
```
Without these, everything deploys fine but fails at runtime with permission
errors the first time it tries to touch Firestore/Search/Storage.

## Design notes (for the write-up)

- Every tool returns `{"status": ..., ...}` and never raises past the tool
  boundary — one failed API call can't crash a conversation turn.
- Transient failures retry with exponential backoff (`tenacity`).
- Config fails at startup (missing env var), not mid-demo.
- Memory Bank (semantic, agent-facing recall) and Firestore (structured,
  UI-facing data) are kept deliberately separate — neither becomes a
  dumping ground for both concerns.
