#!/usr/bin/env python3
# Objective: Resolve workspace paths consistently on Linux, macOS, and Windows.
# Requirements: Anchor relative DATABASE_PATH values to the workspace root; honor WORKSPACE_TMP_DIR; never depend on the caller's current directory.
# Decisions: Mirror the Node helpers in scripts/env.mjs so both runtimes agree on the database and scratch locations.
# Relevant Files: scripts/paths.py, scripts/env.mjs, scripts/scan_tools.py, scripts/scan_environments.py, scripts/tracking_status.py
# Important Context: User file. The database defaults to a workspace-local file; temp files use the OS temp directory.
# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import os
import tempfile
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DATABASE_PATH = ROOT_DIR / "apps" / "api" / "data" / "workspace.sqlite"


def resolve_database_path(database=None, root_dir=None):
    """Resolve the SQLite path, anchoring relative values to the workspace root."""
    root = Path(root_dir) if root_dir is not None else ROOT_DIR
    configured = database if database is not None else os.environ.get("DATABASE_PATH")
    if not configured:
        return Path(DEFAULT_DATABASE_PATH)
    path = Path(configured).expanduser()
    return path if path.is_absolute() else (root / path).resolve()


def workspace_tmp_dir():
    """Return machine-local scratch space, honoring WORKSPACE_TMP_DIR."""
    configured = os.environ.get("WORKSPACE_TMP_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path(tempfile.gettempdir()) / "opencode"
