"""
Standalone upload API — wraps ingest_document.py's logic behind an HTTP
endpoint so the frontend can actually upload files (ingest_document.py was
previously CLI-only).

Runs as a SEPARATE small server from the ADK agent (adk api_server already
owns port 8000 and its own routing) — run this on its own port instead of
trying to bolt a file-upload route onto the ADK server.

Run:
    pip install fastapi "uvicorn[standard]" python-multipart --break-system-packages
    python upload_server.py
    # serves on http://localhost:8001

Endpoints:
    POST /ingest          multipart file + user_id -> {document_id, status}
    GET  /status/{doc_id} -> {indexing_status, ...} (polls Firestore)
"""
from __future__ import annotations

import datetime
import json
import mimetypes
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from google.api_core.client_options import ClientOptions
from google.cloud import discoveryengine_v1 as discoveryengine
from google.cloud import firestore, storage

# --- Must match ingest_document.py's config exactly ---
PROJECT_ID = "project-8f7bc805-c4fb-4824-a9e"
LOCATION = "global"
BUCKET_NAME = "literay-documents"
DATA_STORE_ID = "maindatastore_1787501435502"
# --------------------------------------------------------

app = FastAPI(title="Literay upload service")

# Wide open for local dev; tighten to the real frontend origin before/at deploy.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _upload_to_gcs(local_path: Path, document_id: str, original_name: str) -> str:
    client = storage.Client(project=PROJECT_ID)
    bucket = client.bucket(BUCKET_NAME)
    blob_path = f"{document_id}/{original_name}"
    blob = bucket.blob(blob_path)
    blob.upload_from_filename(str(local_path))
    return f"gs://{BUCKET_NAME}/{blob_path}"


def _write_firestore_record(document_id: str, user_id: str, gcs_uri: str, filename: str) -> None:
    db = firestore.Client(project=PROJECT_ID)
    db.collection("documents").document(document_id).set(
        {
            "user_id": user_id,
            "original_file_name": filename,
            "gcs_uri": gcs_uri,
            "data_store_id": DATA_STORE_ID,
            "indexing_status": "pending",
            "upload_timestamp": datetime.datetime.utcnow().isoformat(),
        }
    )


def _import_to_datastore(document_id: str, gcs_uri: str, mime_type: str) -> str:
    manifest_line = {
        "id": document_id,
        "structData": {"document_id": document_id},
        "content": {"mimeType": mime_type, "uri": gcs_uri},
    }
    storage_client = storage.Client(project=PROJECT_ID)
    bucket = storage_client.bucket(BUCKET_NAME)
    manifest_blob_name = f"_manifests/{document_id}.jsonl"
    bucket.blob(manifest_blob_name).upload_from_string(
        json.dumps(manifest_line) + "\n", content_type="application/json"
    )
    manifest_uri = f"gs://{BUCKET_NAME}/{manifest_blob_name}"

    client_options = (
        ClientOptions(api_endpoint="discoveryengine.googleapis.com")
        if LOCATION == "global"
        else None
    )
    doc_client = discoveryengine.DocumentServiceClient(client_options=client_options)
    parent = (
        f"projects/{PROJECT_ID}/locations/{LOCATION}/collections/default_collection"
        f"/dataStores/{DATA_STORE_ID}/branches/default_branch"
    )
    request = discoveryengine.ImportDocumentsRequest(
        parent=parent,
        gcs_source=discoveryengine.GcsSource(input_uris=[manifest_uri], data_schema="document"),
        reconciliation_mode=discoveryengine.ImportDocumentsRequest.ReconciliationMode.INCREMENTAL,
    )
    operation = doc_client.import_documents(request=request)
    return operation.operation.name


@app.post("/ingest")
async def ingest(file: UploadFile = File(...), user_id: str = Form(...)):
    """Accepts a file upload, runs the same pipeline as ingest_document.py's
    CLI, and returns the new document_id immediately (indexing continues
    async in the background — poll /status/{document_id} for completion).
    """
    allowed = {"application/pdf", "image/jpeg", "image/png"}
    if file.content_type not in allowed:
        raise HTTPException(400, f"Unsupported file type: {file.content_type}")

    document_id = str(uuid.uuid4())
    mime_type = file.content_type or mimetypes.guess_type(file.filename)[0] or "application/pdf"

    with tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename).suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = Path(tmp.name)

    try:
        gcs_uri = _upload_to_gcs(tmp_path, document_id, file.filename)
        _write_firestore_record(document_id, user_id, gcs_uri, file.filename)
        _import_to_datastore(document_id, gcs_uri, mime_type)
    finally:
        tmp_path.unlink(missing_ok=True)

    return {"document_id": document_id, "status": "processing", "filename": file.filename}


def _check_indexed_in_datastore(document_id: str) -> bool:
    """Ground-truth check: does this document actually exist in the Vertex
    AI Search datastore yet? We do NOT trust a Firestore flag for this —
    nothing updates it automatically once the async import finishes on
    Google's side, so a stored "pending"/"indexed" field would just go
    stale forever. Querying Discovery Engine directly is slower per call
    but always correct.
    """
    client_options = (
        ClientOptions(api_endpoint="discoveryengine.googleapis.com")
        if LOCATION == "global"
        else None
    )
    doc_client = discoveryengine.DocumentServiceClient(client_options=client_options)
    name = (
        f"projects/{PROJECT_ID}/locations/{LOCATION}/collections/default_collection"
        f"/dataStores/{DATA_STORE_ID}/branches/default_branch/documents/{document_id}"
    )
    try:
        doc_client.get_document(name=name)
        return True
    except Exception:
        # NotFound (still importing) or any transient error — treat as "not
        # ready yet" rather than crashing the status endpoint.
        return False


@app.get("/status/{document_id}")
async def status(document_id: str):
    """Frontend polls this after upload to know when indexing is done.
    Checks Vertex AI Search directly (ground truth), then updates Firestore
    to match so other reads of the document record stay in sync too.
    """
    db = firestore.Client(project=PROJECT_ID)
    ref = db.collection("documents").document(document_id)
    doc = ref.get()
    if not doc.exists:
        raise HTTPException(404, "document_id not found")
    data = doc.to_dict()

    is_indexed = _check_indexed_in_datastore(document_id)
    current_status = "indexed" if is_indexed else "pending"
    if is_indexed and data.get("indexing_status") != "indexed":
        ref.update({"indexing_status": "indexed"})

    return {
        "document_id": document_id,
        "indexing_status": current_status,
        "original_file_name": data.get("original_file_name"),
    }


@app.get("/progress/{user_id}")
async def progress(user_id: str):
    """Aggregates this user's quiz_log entries by clause_type, for the
    Progress view — {clause_type: -> total, correct}.
    """
    db = firestore.Client(project=PROJECT_ID)
    docs = db.collection("quiz_log").where("user_id", "==", user_id).stream()

    summary: dict[str, dict[str, int]] = {}
    for doc in docs:
        data = doc.to_dict()
        clause_type = data.get("clause_type", "unknown")
        bucket = summary.setdefault(clause_type, {"total": 0, "correct": 0})
        bucket["total"] += 1
        if data.get("correct"):
            bucket["correct"] += 1

    return {"clauses": summary}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8001)
