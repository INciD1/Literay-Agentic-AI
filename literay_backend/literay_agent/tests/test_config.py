"""Tests for Settings.from_env — config should fail loudly and early."""
import os
import unittest

from literay_agent.config import Settings
from literay_agent.exceptions import ConfigError


class TestSettings(unittest.TestCase):
    def setUp(self):
        self._saved_env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved_env)

    def test_missing_required_var_raises_config_error(self):
        os.environ.pop("GOOGLE_CLOUD_PROJECT", None)
        os.environ.pop("VERTEX_SEARCH_ENGINE_ID", None)

        with self.assertRaises(ConfigError):
            Settings.from_env()

    def test_defaults_applied_when_optional_vars_absent(self):
        os.environ["GOOGLE_CLOUD_PROJECT"] = "test-project"
        os.environ["VERTEX_SEARCH_ENGINE_ID"] = "test-engine"
        os.environ.pop("GOOGLE_CLOUD_LOCATION", None)
        os.environ.pop("AGENT_ENGINE_LOCATION", None)

        settings = Settings.from_env()
        self.assertEqual(settings.location, "global")
        self.assertEqual(settings.agent_engine_location, "us-central1")
        self.assertEqual(settings.agent_engine_id, "")


if __name__ == "__main__":
    unittest.main()