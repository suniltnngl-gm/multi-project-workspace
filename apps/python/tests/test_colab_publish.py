import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT_DIR = Path(__file__).resolve().parents[3]
PUBLISH_PATH = ROOT_DIR / "scripts" / "colab_publish_kaggle.py"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class ColabPublishTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module("colab_publish_kaggle", PUBLISH_PATH)

    def test_script_compiles(self):
        compile(PUBLISH_PATH.read_text(encoding="utf-8"), str(PUBLISH_PATH), "exec")

    def test_access_token_is_preferred(self):
        credentials, source = self.module.resolve_credentials(
            env={
                "KAGGLE_API_TOKEN": "token-value",
                "KAGGLE_USERNAME": "ignored",
                "KAGGLE_KEY": "ignored",
            }
        )
        self.assertEqual(credentials, {"KAGGLE_API_TOKEN": "token-value"})
        self.assertIn("access token", source)

    def test_legacy_username_and_key_are_supported(self):
        credentials, source = self.module.resolve_credentials(
            env={"KAGGLE_USERNAME": "user", "KAGGLE_KEY": "key"}
        )
        self.assertEqual(
            credentials,
            {"KAGGLE_USERNAME": "user", "KAGGLE_KEY": "key"},
        )
        self.assertIn("legacy", source)

    def test_colab_secrets_are_used_when_environment_is_empty(self):
        values = {"KAGGLE_API_TOKEN": "secret-token"}

        def getter(name):
            if name not in values:
                raise KeyError(name)
            return values[name]

        credentials, _ = self.module.resolve_credentials(env={}, secret_getter=getter)
        self.assertEqual(credentials, {"KAGGLE_API_TOKEN": "secret-token"})

    def test_missing_credentials_are_reported(self):
        with self.assertRaises(self.module.PublishError):
            self.module.resolve_credentials(env={}, secret_getter=lambda _name: "")

    def test_metadata_is_always_private(self):
        metadata = self.module.build_metadata("owner/workspace-artifacts")
        self.assertEqual(metadata["id"], "owner/workspace-artifacts")
        self.assertEqual(metadata["title"], "Workspace Artifacts")
        self.assertTrue(metadata["isPrivate"])
        self.assertEqual(metadata["licenses"], [{"name": "other"}])

    def test_invalid_dataset_ids_are_rejected(self):
        for value in ("workspace-artifacts", "owner/", "/slug", "owner/slug/extra"):
            with self.subTest(value=value):
                with self.assertRaises(self.module.PublishError):
                    self.module.build_metadata(value)

    def test_staging_skips_secret_and_vcs_files(self):
        with tempfile.TemporaryDirectory() as source_directory, \
                tempfile.TemporaryDirectory() as staging_directory:
            source = Path(source_directory)
            (source / "model.pt").write_text("weights", encoding="utf-8")
            (source / ".env").write_text("SECRET=1", encoding="utf-8")
            (source / "kaggle.json").write_text("{}", encoding="utf-8")
            (source / ".git").mkdir()
            (source / ".git" / "config").write_text("secret", encoding="utf-8")

            files = self.module.stage_source(source, Path(staging_directory))
            names = sorted(path.name for path in files)
            self.assertEqual(names, ["model.pt"])
            self.assertFalse((Path(staging_directory) / ".env").exists())
            self.assertFalse((Path(staging_directory) / "kaggle.json").exists())

    def test_dataset_exists_uses_the_kaggle_files_command(self):
        calls = []

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            return subprocess.CompletedProcess(command, 1, "", "404 Not Found")

        self.assertFalse(
            self.module.dataset_exists("owner/artifacts", {"KAGGLE_API_TOKEN": "x"}, runner)
        )
        self.assertEqual(calls[0][0][:3], ["kaggle", "datasets", "files"])
        self.assertEqual(calls[0][0][3], "owner/artifacts")

    def test_dataset_exists_surfaces_unexpected_errors(self):
        def runner(command, **kwargs):
            return subprocess.CompletedProcess(command, 1, "", "authentication failed")

        with self.assertRaises(self.module.PublishError):
            self.module.dataset_exists("owner/artifacts", {}, runner)

    def test_publish_builds_create_and_version_commands(self):
        calls = []

        def runner(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0, "ok", "")

        staging = Path("/tmp/staging")
        self.module.publish(staging, "owner/artifacts", "create", "message", {}, runner)
        self.module.publish(staging, "owner/artifacts", "version", "message", {}, runner)

        self.assertEqual(calls[0][:4], ["kaggle", "datasets", "create", "-p"])
        self.assertIn("--dir-mode", calls[0])
        self.assertEqual(calls[1][:4], ["kaggle", "datasets", "version", "-p"])
        self.assertEqual(calls[1][calls[1].index("-m") + 1], "message")

    def test_dry_run_validates_without_credentials_or_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / "artifact.bin").write_text("data", encoding="utf-8")
            output = io.StringIO()
            with mock.patch.dict(os.environ, {}, clear=True), \
                    contextlib.redirect_stdout(output):
                code = self.module.main([
                    "--source", str(source),
                    "--dataset", "owner/artifacts",
                    "--mode", "create",
                    "--dry-run",
                ])
            self.assertEqual(code, 0)
            self.assertIn("Dry run: would create private dataset owner/artifacts", output.getvalue())

    def test_invalid_dataset_returns_a_failure_code(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / "artifact.bin").write_text("data", encoding="utf-8")
            stderr = io.StringIO()
            with mock.patch.dict(os.environ, {"KAGGLE_API_TOKEN": "x"}), \
                    contextlib.redirect_stderr(stderr):
                code = self.module.main([
                    "--source", str(source),
                    "--dataset", "invalid",
                    "--dry-run",
                ])
            self.assertEqual(code, 1)
            self.assertIn("owner/dataset-slug", stderr.getvalue())

    def test_dry_run_json_includes_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / "artifact.bin").write_text("data", encoding="utf-8")
            output = io.StringIO()
            with mock.patch.dict(os.environ, {"KAGGLE_API_TOKEN": "x"}), \
                    contextlib.redirect_stdout(output):
                code = self.module.main([
                    "--source", str(source),
                    "--dataset", "owner/artifacts",
                    "--mode", "create",
                    "--dry-run",
                    "--json",
                ])
            self.assertEqual(code, 0)
            payload = json.loads(output.getvalue())
            self.assertTrue(payload["dryRun"])
            self.assertTrue(payload["metadata"]["isPrivate"])


if __name__ == "__main__":
    unittest.main()
