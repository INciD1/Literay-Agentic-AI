"""Unit tests for the search tool, mocking Vertex AI Search so it runs
without real credentials or network access.
"""
import os
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("GOOGLE_CLOUD_PROJECT", "test-project")
os.environ.setdefault("VERTEX_SEARCH_ENGINE_ID", "test-engine")

from literay_agent.tools.search import search_document


class TestSearchDocument(unittest.TestCase):
    @patch("literay_agent.tools.search.discoveryengine.SearchServiceClient")
    def test_success_returns_clauses(self, mock_client_cls):
        mock_result = MagicMock()
        mock_result.document.derived_struct_data = {"snippet": "Tenant shall pay rent by the 1st."}
        mock_client_cls.return_value.search.return_value = [mock_result]

        result = search_document("rent due date", "document_id")

        self.assertEqual(result["status"], "success")
        self.assertIn("Tenant shall pay rent by the 1st.", result["clauses"])

    @patch("literay_agent.tools.search.discoveryengine.SearchServiceClient")
    def test_failure_returns_error_status_not_raise(self, mock_client_cls):
        mock_client_cls.return_value.search.side_effect = Exception("timeout")

        result = search_document("rent due date", "doc123")  # must not raise

        self.assertEqual(result["status"], "error")
        self.assertIn("timeout", result["error_message"])

    @patch("literay_agent.tools.search.discoveryengine.SearchServiceClient")
    def test_empty_results_returns_empty_clause_list(self, mock_client_cls):
        mock_client_cls.return_value.search.return_value = []

        result = search_document("nonexistent clause", "doc123")

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["clauses"], [])

def test_filters_by_document_id(self, mock_client_cls):
    mock_client_cls.return_value.search.return_value = []
    search_document("rent due date", "document_id")

    call_args = mock_client_cls.return_value.search.call_args
    request = call_args[0][0] if call_args[0] else call_args.kwargs["request"]
    self.assertIn("document_id", str(request.filter))


if __name__ == "__main__":
    unittest.main()