"""
Standalone smoke test for the Vertex AI Search (Discovery Engine) data store.

Run this directly (not via pytest) to confirm the data store returns real,
grounded chunks with clause-level metadata, filtered by document_id the
same way literay_agent/tools/search.py does it.

Setup (already installed if ingest_document.py worked):
    pip install google-cloud-discoveryengine
"""

from google.api_core.client_options import ClientOptions
from google.cloud import discoveryengine_v1 as discoveryengine

# --- Filled in from this session ---
PROJECT_ID = "project-8f7bc805-c4fb-4824-a9e"
LOCATION = "global"  # must be "global" -- this data store type doesn't support asia-southeast1
DATA_STORE_ID = "maindatastore_1787501435502"
DOCUMENT_ID = "a43810f9-926e-4b3b-999c-51d2227c9b76"  # the ToSofCognosphere.pdf ingest
# ------------------------------------

# Replace with terms that actually appear in ToSofCognosphere.pdf
TEST_QUERIES = [
    "termination",
    "user data",
    "liability",
    "refund policy",
]


def build_client() -> discoveryengine.SearchServiceClient:
    client_options = (
        ClientOptions(api_endpoint="discoveryengine.googleapis.com")
        if LOCATION == "global"
        else None
    )
    return discoveryengine.SearchServiceClient(client_options=client_options)


def search(client: discoveryengine.SearchServiceClient, query: str):
    serving_config = (
        f"projects/{PROJECT_ID}/locations/{LOCATION}/"
        f"collections/default_collection/dataStores/{DATA_STORE_ID}/"
        f"servingConfigs/default_search"
    )

    request = discoveryengine.SearchRequest(
        serving_config=serving_config,
        query=query,
        filter=f'document_id: ANY("{DOCUMENT_ID}")',
        page_size=5,
        content_search_spec=discoveryengine.SearchRequest.ContentSearchSpec(
            snippet_spec=discoveryengine.SearchRequest.ContentSearchSpec.SnippetSpec(
                return_snippet=True
            ),
            extractive_content_spec=discoveryengine.SearchRequest.ContentSearchSpec.ExtractiveContentSpec(
                max_extractive_answer_count=1
            ),
        ),
    )

    return client.search(request)


def main():
    client = build_client()

    for query in TEST_QUERIES:
        print(f"\n{'=' * 60}")
        print(f"QUERY: {query!r}  (filtered to document_id={DOCUMENT_ID})")
        print("=" * 60)

        try:
            response = search(client, query)
        except Exception as e:
            print(f"[ERROR] search failed: {e}")
            continue

        results = list(response.results)
        if not results:
            print("[EMPTY] No results -- if this happens for EVERY query, the "
                  "document_id filter is likely matching nothing (check that "
                  "the import actually attached document_id as structData). "
                  "If only SOME queries are empty, the term probably just "
                  "isn't in the document.")
            continue

        for i, result in enumerate(results, start=1):
            doc = result.document
            struct_data = doc.derived_struct_data
            uri = struct_data.get("link", "N/A")
            snippets = struct_data.get("snippets", [])
            extractive = struct_data.get("extractive_answers", [])

            print(f"\n--- Result {i} ---")
            print(f"doc id : {doc.id}")
            print(f"source : {uri}")
            if extractive:
                print(f"answer : {extractive[0].get('content', '')[:300]}")
            elif snippets:
                print(f"snippet: {snippets[0].get('snippet', '')[:300]}")
            else:
                print("(no snippet/extractive answer returned)")

    print(f"\n{'=' * 60}")
    print("Done. If every query returned [EMPTY]:")
    print("  1. Check Documents tab in console -- status must be Active")
    print("  2. Confirm the import actually attached document_id as structData")
    print("     (a plain bucket-level import instead of the JSONL manifest")
    print("      import would NOT have this field)")
    print("  3. Confirm DOCUMENT_ID above matches exactly what was ingested")
    print("=" * 60)


if __name__ == "__main__":
    main()