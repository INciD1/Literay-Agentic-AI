"""
Ingest a document end-to-end: GCS upload -> Firestore record -> Vertex AI
Search import with `document_id` attached as filterable metadata.

This closes the gap in search.py's filter:
    filter=f'document_id: ANY("{document_id}")'
which only matches if the imported document actually carries a
`document_id` struct field — a plain "import the whole bucket" from the
console does NOT attach this, so the filter silently matches nothing.

Usage:
    python ingest_document.py path/to/lease1.pdf --user-id demo-user

Setup:
    pip install google-cloud-storage google-cloud-firestore google-cloud-discoveryengine --break-system-packages
"""

from __future__ import annotations

import argparse
import datetime
import json
import mimetypes
import uuid
from pathlib import Path

from google.api_core.client_options import ClientOptions
from google.cloud import discoveryengine_v1 as discoveryengine
from google.cloud import firestore, storage

# --- Fill these in to match your project ---
PROJECT_ID = "project-8f7bc805-c4fb-4824-a9e"
LOCATION = "global"  # data store location — must be global, not asia-southeast1
BUCKET_NAME = "literay-documents"  # your bucket name, no gs:// prefix
DATA_STORE_ID = "maindatastore_1787501435502"
# --------------------------------------------


def upload_to_gcs(local_path: Path, document_id: str) -> str:
    """Uploads the file to GCS under a document_id-prefixed path. Returns the gs:// uri."""
    client = storage.Client(project=PROJECT_ID)
    bucket = client.bucket(BUCKET_NAME)
    blob_path = f"{document_id}/{local_path.name}"
    blob = bucket.blob(blob_path)
    blob.upload_from_filename(str(local_path))
    return f"gs://{BUCKET_NAME}/{blob_path}"


def write_firestore_record(document_id: str, user_id: str, gcs_uri: str, filename: str) -> None:
    """Creates the Firestore record in `documents/{document_id}`, status=pending."""
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


def import_to_datastore(document_id: str, gcs_uri: str, mime_type: str) -> str:
    """Writes a one-line JSONL manifest with document_id as structData, uploads it
    to a manifest/ path in the same bucket, and triggers an import from it.
    This is what attaches document_id as a *filterable* metadata field —
    a plain bucket-level import does not.
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
    print("This runs async — check the Documents tab in console, or poll the operation.")
    return operation.operation.name


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

    print(f"[1/3] Uploading to GCS as document_id={document_id} ...")
    gcs_uri = upload_to_gcs(args.file_path, document_id)
    print(f"      -> {gcs_uri}")

    print("[2/3] Writing Firestore record (status=pending) ...")
    write_firestore_record(document_id, args.user_id, gcs_uri, args.file_path.name)

    print("[3/3] Importing into Vertex AI Search with document_id metadata ...")
    import_to_datastore(document_id, gcs_uri, mime_type)

    print(f"\nDone. document_id = {document_id}")
    print("Update Firestore indexing_status to 'indexed' once the import "
          "operation completes (or wire this via Cloud Function on operation done).")


if __name__ == "__main__":
    main()
