"""Tests for Settings.from_env — config should fail loudly and early."""
import importlib
import os
import unittest


class TestSettings(unittest.TestCase):
    def setUp(self):
        self._saved_env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved_env)

    def test_missing_required_var_raises_config_error(self):
        os.environ.pop("GOOGLE_CLOUD_PROJECT", None)
        os.environ.pop("VERTEX_SEARCH_ENGINE_ID", None)

        from literay_agent import config
        from literay_agent.exceptions import ConfigError

        importlib.reload(config)  # re-evaluate module-level `settings` singleton
        with self.assertRaises(ConfigError):
            config.Settings.from_env()

    def test_defaults_applied_when_optional_vars_absent(self):
        os.environ["GOOGLE_CLOUD_PROJECT"] = "test-project"
        os.environ["VERTEX_SEARCH_ENGINE_ID"] = "test-engine"
        os.environ.pop("GOOGLE_CLOUD_LOCATION", None)

        from literay_agent.config import Settings

        settings = Settings.from_env()
        self.assertEqual(settings.location, "us-central1")
        self.assertEqual(settings.agent_engine_id, "")


if __name__ == "__main__":
    unittest.main()