"""
Deletes a document end-to-end: Vertex AI Search entry -> GCS objects
(original file + import manifest) -> Firestore record.

Mirrors ingest_document.py's CLI/spawn shape on purpose so server.js can call
it the same way it already calls the ingest script (spawn a Python process,
read stdout/exit code) -- no long-running service required for this.

Reuses ingest_document.py's PROJECT_ID / LOCATION / BUCKET_NAME /
DATA_STORE_ID constants directly instead of redefining them here, so the
two scripts can never drift apart on where a document's data actually lives
(bucket name, data store id, etc.) -- change it once, in one place.

Usage:
    python delete_document.py <document_id> --user-id <user_id>

Exit codes (server.js keys off of these):
    0  deleted (fully, or "not found" -- nothing left to point to either way)
    2  document_id exists but belongs to a different user_id (do NOT clear
       it locally on this one -- it still exists, just not this caller's)
    3  found and owned by this user_id, but one or more delete steps failed
       partway through -- Firestore record is intentionally left in place
       so a retry has something to look at

Setup:
    pip install google-cloud-storage google-cloud-firestore google-cloud-discoveryengine
"""

from __future__ import annotations

import argparse
import sys

from google.api_core.client_options import ClientOptions
from google.api_core.exceptions import NotFound
from google.cloud import discoveryengine_v1 as discoveryengine
from google.cloud import firestore, storage

from ingest_document import BUCKET_NAME, DATA_STORE_ID, LOCATION, PROJECT_ID


def delete_from_datastore(document_id: str) -> None:
    """Removes the document from Vertex AI Search. NotFound is fine here --
    it just means indexing never finished, or it was already removed."""
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
        doc_client.delete_document(name=name)
    except NotFound:
        pass


def delete_from_gcs(document_id: str) -> None:
    """Deletes every blob under `{document_id}/` (the original uploaded
    file(s), per upload_to_gcs's naming) plus the one-line import manifest
    at `_manifests/{document_id}.jsonl` written during ingest -- both need
    cleaning up, not just the original file."""
    storage_client = storage.Client(project=PROJECT_ID)
    bucket = storage_client.bucket(BUCKET_NAME)
    for blob in storage_client.list_blobs(bucket, prefix=f"{document_id}/"):
        blob.delete()
    manifest_blob = bucket.blob(f"_manifests/{document_id}.jsonl")
    if manifest_blob.exists():
        manifest_blob.delete()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document_id", help="The document_id to delete")
    parser.add_argument("--user-id", required=True, help="Caller's user_id, checked against the record's owner")
    args = parser.parse_args()

    db = firestore.Client(project=PROJECT_ID)
    ref = db.collection("documents").document(args.document_id)
    doc = ref.get()

    if not doc.exists:
        # Nothing at the source at all -- exit 0 so the caller can safely
        # clear its own local record too, there's nothing left to point to.
        print(f"NOT_FOUND: document_id={args.document_id} (already absent, nothing to delete)")
        sys.exit(0)

    data = doc.to_dict()
    if data.get("user_id") != args.user_id:
        print(f"FORBIDDEN: document_id={args.document_id} does not belong to user_id={args.user_id}")
        sys.exit(2)

    errors: list[str] = []

    print("[1/3] Removing from Vertex AI Search ...")
    try:
        delete_from_datastore(args.document_id)
        print("      -> done")
    except Exception as exc:  # noqa: BLE001 - reported to caller, not swallowed
        errors.append(f"search index: {exc}")
        print(f"      -> failed: {exc}")

    print("[2/3] Removing GCS objects ...")
    try:
        delete_from_gcs(args.document_id)
        print("      -> done")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"gcs: {exc}")
        print(f"      -> failed: {exc}")

    if errors:
        # Leave the Firestore record in place on partial failure -- it's the
        # only evidence left that cleanup is still incomplete, so a retry
        # (or a human) has something to go on.
        print(f"PARTIAL: document_id={args.document_id} errors={errors}")
        sys.exit(3)

    print("[3/3] Removing Firestore record ...")
    ref.delete()
    print("      -> done")

    print(f"DELETED: document_id={args.document_id}")
    sys.exit(0)


if __name__ == "__main__":
    main()