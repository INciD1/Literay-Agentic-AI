"""Ensures required env vars exist before literay_agent (which validates
config at import time) gets imported by any test module. Lives at the repo
root — not inside literay_agent/ — so pytest loads it before it has to
import the literay_agent package at all.
"""
import os

os.environ.setdefault("GOOGLE_CLOUD_PROJECT", "test-project")
os.environ.setdefault("VERTEX_SEARCH_ENGINE_ID", "test-engine")