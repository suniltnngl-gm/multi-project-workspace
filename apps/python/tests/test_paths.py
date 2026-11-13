# Objective: Cover the shared Python path helpers.
# Requirements: Exercise relative and absolute database paths and the temp-directory override.
# Decisions: Add scripts/ to sys.path because the helpers are shared by standalone scanners rather than the installed package.
# Relevant Files: scripts/paths.py, apps/python/tests/test_paths.py
# Important Context: User file. The default database stays inside the checkout.
# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))

import paths  # noqa: E402


class PathsTest(unittest.TestCase):
    def test_relative_database_path_is_anchored_to_the_root(self):
        resolved = paths.resolve_database_path(
            "apps/api/data/workspace.sqlite", root_dir=Path("/workspace")
        )
        self.assertEqual(resolved, Path("/workspace/apps/api/data/workspace.sqlite"))

    def test_absolute_database_path_is_preserved(self):
        absolute = Path("/var/lib/workspace.sqlite")
        self.assertEqual(paths.resolve_database_path(str(absolute)), absolute)

    def test_environment_database_path_is_used(self):
        previous = os.environ.get("DATABASE_PATH")
        os.environ["DATABASE_PATH"] = "relative.sqlite"
        try:
            resolved = paths.resolve_database_path(root_dir=Path("/workspace"))
        finally:
            if previous is None:
                os.environ.pop("DATABASE_PATH", None)
            else:
                os.environ["DATABASE_PATH"] = previous
        self.assertEqual(resolved, Path("/workspace/relative.sqlite"))

    def test_workspace_tmp_dir_honors_override(self):
        previous = os.environ.get("WORKSPACE_TMP_DIR")
        os.environ["WORKSPACE_TMP_DIR"] = "/custom/tmp"
        try:
            self.assertEqual(paths.workspace_tmp_dir(), Path("/custom/tmp"))
        finally:
            if previous is None:
                os.environ.pop("WORKSPACE_TMP_DIR", None)
            else:
                os.environ["WORKSPACE_TMP_DIR"] = previous

    def test_workspace_tmp_dir_defaults_to_the_os_temp_directory(self):
        previous = os.environ.get("WORKSPACE_TMP_DIR")
        os.environ.pop("WORKSPACE_TMP_DIR", None)
        try:
            self.assertEqual(
                paths.workspace_tmp_dir(),
                Path(tempfile.gettempdir()) / "opencode",
            )
        finally:
            if previous is not None:
                os.environ["WORKSPACE_TMP_DIR"] = previous


if __name__ == "__main__":
    unittest.main()
