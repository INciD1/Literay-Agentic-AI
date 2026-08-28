"""
Ingest a document end-to-end: GCS upload -> Firestore record -> Vertex AI
Search import with `document_id` attached as filterable metadata -> WAIT for
the import to actually finish -> update Firestore status to "indexed" (or
"failed") automatically.

This closes two gaps from earlier versions:
  1. search.py's filter:
         filter=f'document_id: ANY("{document_id}")'
     only matches if the imported document carries a `document_id` struct
     field -- a plain "import the whole bucket" from the console does NOT
     attach this, so we import via a JSONL manifest instead.
  2. import_documents is an async long-running operation (LRO) -- it
     returns immediately while indexing keeps running in the background.
     This script now BLOCKS until the operation actually completes, then
     writes indexing_status back to Firestore itself -- no more manual
     console edits, and the agent can safely query the document the
     moment this script exits successfully.

Usage:
    python ingest_document.py path/to/lease1.pdf --user-id demo-user

Setup:
    pip install google-cloud-storage google-cloud-firestore google-cloud-discoveryengine
"""

from __future__ import annotations

import argparse
import datetime
import json
import mimetypes
import sys
import uuid
from pathlib import Path

from google.api_core.client_options import ClientOptions
from google.api_core.exceptions import GoogleAPICallError
from google.cloud import discoveryengine_v1 as discoveryengine
from google.cloud import firestore, storage

# --- Fill these in to match your project ---
PROJECT_ID = "project-8f7bc805-c4fb-4824-a9e"
LOCATION = "global"  # data store location -- must be global, not asia-southeast1
BUCKET_NAME = "literay-documents"
DATA_STORE_ID = "maindatastore_1787501435502"
IMPORT_TIMEOUT_SECONDS = 600  # 10 min ceiling while waiting for indexing
# --------------------------------------------


def upload_to_gcs(local_path: Path, document_id: str) -> str:
    """Uploads the file to GCS under a document_id-prefixed path. Returns the gs:// uri."""
    client = storage.Client(project=PROJECT_ID)
    bucket = client.bucket(BUCKET_NAME)
    blob_path = f"{document_id}/{local_path.name}"
    blob = bucket.blob(blob_path)
    blob.upload_from_filename(str(local_path))
    return f"gs://{BUCKET_NAME}/{blob_path}"


def firestore_client() -> firestore.Client:
    return firestore.Client(project=PROJECT_ID)


def write_firestore_record(db: firestore.Client, document_id: str, user_id: str, gcs_uri: str, filename: str) -> None:
    """Creates the Firestore record in `documents/{document_id}`, status=pending."""
    db.collection("documents").document(document_id).set(
        {
            "user_id": user_id,
            "original_file_name": filename,
            "gcs_uri": gcs_uri,
            "data_store_id": DATA_STORE_ID,
            "indexing_status": "pending",
            "upload_timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }
    )


def update_indexing_status(db: firestore.Client, document_id: str, status: str, error: str | None = None) -> None:
    """Flips indexing_status once we know the real outcome -- 'indexed' or 'failed'."""
    update = {"indexing_status": status}
    if error:
        update["indexing_error"] = error
    db.collection("documents").document(document_id).update(update)


def import_to_datastore(document_id: str, gcs_uri: str, mime_type: str) -> "discoveryengine_operation":
    """Writes a one-line JSONL manifest with document_id as structData, uploads it
    to a manifest/ path in the same bucket, and triggers an import from it.
    Returns the LRO object so the caller can wait on it.
    """
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
        gcs_source=discoveryengine.GcsSource(
            input_uris=[manifest_uri],
            data_schema="document",  # "document" schema reads structData + content per line
        ),
        reconciliation_mode=discoveryengine.ImportDocumentsRequest.ReconciliationMode.INCREMENTAL,
    )

    operation = doc_client.import_documents(request=request)
    print(f"Import started, operation: {operation.operation.name}")
    return operation


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file_path", type=Path, help="Local path to the document")
    parser.add_argument("--user-id", required=True, help="User ID to attach in Firestore")
    args = parser.parse_args()

    if not args.file_path.exists():
        raise SystemExit(f"File not found: {args.file_path}")

    document_id = str(uuid.uuid4())
    mime_type, _ = mimetypes.guess_type(str(args.file_path))
    mime_type = mime_type or "application/pdf"

    db = firestore_client()

    print(f"[1/4] Uploading to GCS as document_id={document_id} ...")
    gcs_uri = upload_to_gcs(args.file_path, document_id)
    print(f"      -> {gcs_uri}")

    print("[2/4] Writing Firestore record (status=pending) ...")
    write_firestore_record(db, document_id, args.user_id, gcs_uri, args.file_path.name)

    print("[3/4] Importing into Vertex AI Search with document_id metadata ...")
    operation = import_to_datastore(document_id, gcs_uri, mime_type)

    print(f"[4/4] Waiting for indexing to finish (up to {IMPORT_TIMEOUT_SECONDS}s) ...")
    try:
        result = operation.result(timeout=IMPORT_TIMEOUT_SECONDS)
        error_samples = getattr(result, "error_samples", [])
        if error_samples:
            # Import call succeeded overall but individual doc(s) failed
            first_error = str(error_samples[0])
            print(f"      -> completed with per-document errors: {first_error}")
            update_indexing_status(db, document_id, "failed", error=first_error)
            sys.exit(1)
        else:
            print("      -> indexing complete")
            update_indexing_status(db, document_id, "indexed")
    except GoogleAPICallError as exc:
        print(f"      -> import failed: {exc}")
        update_indexing_status(db, document_id, "failed", error=str(exc))
        sys.exit(1)
    except TimeoutError:
        # Still running past our wait window -- leave it pending, don't mark failed
        print(f"      -> still indexing after {IMPORT_TIMEOUT_SECONDS}s, left as 'pending'. "
              f"Check console or re-run a status check later.")
        sys.exit(1)

    print(f"\nDone. document_id = {document_id}  (indexing_status = indexed)")


if __name__ == "__main__":
    main()