# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

ROOT_DIR = Path(__file__).resolve().parents[3]
CHECKPOINT_PATH = ROOT_DIR / "scripts" / "colab_checkpoint.py"
NOTEBOOK_PATH = ROOT_DIR / "notebooks" / "colab-qwen-coder-free-tier.ipynb"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class ColabCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module("colab_checkpoint", CHECKPOINT_PATH)

    def test_script_compiles(self):
        compile(
            CHECKPOINT_PATH.read_text(encoding="utf-8"),
            str(CHECKPOINT_PATH),
            "exec",
        )

    def test_sha256_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artifact.bin"
            path.write_bytes(b"checkpoint-data")
            self.assertEqual(
                self.module.sha256_file(path),
                "3a62706bdd0886a9616878402d6704f2470b1e2f6644dbd8e7776eb2e1563a86",
            )

    def test_atomic_copy_verifies_and_leaves_no_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.bin"
            source.write_bytes(b"checkpoint-data")
            destination = Path(directory) / "drive" / "checkpoint.bin"

            result = self.module.atomic_copy(source, destination)

            self.assertEqual(destination.read_bytes(), b"checkpoint-data")
            self.assertEqual(result["sha256"], self.module.sha256_file(source))
            self.assertEqual(result["bytes"], len(b"checkpoint-data"))
            self.assertFalse(
                destination.with_name(destination.name + ".tmp").exists()
            )

    def test_atomic_copy_detects_destination_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.bin"
            source.write_bytes(b"checkpoint-data")
            destination = Path(directory) / "drive" / "checkpoint.bin"
            expected = self.module.sha256_file(source)

            with mock.patch.object(
                self.module,
                "sha256_file",
                side_effect=[expected, expected, "0" * 64],
            ):
                with self.assertRaises(self.module.CheckpointError) as caught:
                    self.module.atomic_copy(source, destination)

            self.assertIn("verification failed", str(caught.exception))
            self.assertFalse(
                destination.with_name(destination.name + ".tmp").exists()
            )

    def test_atomic_copy_rejects_symlink_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.bin"
            source.write_bytes(b"checkpoint-data")
            link = Path(directory) / "link.bin"
            try:
                link.symlink_to(source)
            except (NotImplementedError, OSError):
                self.skipTest("symlinks are unavailable on this platform")

            with self.assertRaises(self.module.CheckpointError):
                self.module.atomic_copy(link, Path(directory) / "out.bin")

    def test_checkpoint_directory_creates_a_verified_zip(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "artifacts"
            source.mkdir()
            (source / "model.bin").write_bytes(b"weights")
            destination = Path(directory) / "drive" / "bundle.zip"

            result = self.module.checkpoint(source, destination)

            self.assertEqual(result["files"], 1)
            self.assertEqual(result["sourceBytes"], len(b"weights"))
            self.assertEqual(result["sha256"], self.module.sha256_file(destination))
            with zipfile.ZipFile(destination) as bundle:
                self.assertEqual(bundle.namelist(), ["artifacts/model.bin"])

    def test_checkpoint_directory_skips_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "artifacts"
            source.mkdir()
            (source / "real.bin").write_bytes(b"weights")
            try:
                (source / "link.bin").symlink_to(source / "real.bin")
            except (NotImplementedError, OSError):
                self.skipTest("symlinks are unavailable on this platform")
            destination = Path(directory) / "bundle.zip"

            self.module.checkpoint(source, destination)

            with zipfile.ZipFile(destination) as bundle:
                self.assertEqual(bundle.namelist(), ["artifacts/real.bin"])

    def test_checkpoint_directory_requires_a_zip_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "artifacts"
            source.mkdir()
            (source / "model.bin").write_bytes(b"weights")
            with self.assertRaises(self.module.CheckpointError):
                self.module.checkpoint(source, Path(directory) / "bundle.bin")

    def test_checkpoint_rejects_an_empty_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "artifacts"
            source.mkdir()
            with self.assertRaises(self.module.CheckpointError):
                self.module.checkpoint(source, Path(directory) / "bundle.zip")

    def test_publish_bundle_invokes_the_publisher(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "artifacts"
            source.mkdir()
            (source / "model.bin").write_bytes(b"weights")
            publisher = Path(directory) / "colab_publish_kaggle.py"
            publisher.write_text("", encoding="utf-8")
            calls = []

            def runner(command, **kwargs):
                calls.append((command, kwargs))
                return subprocess.CompletedProcess(
                    command,
                    0,
                    '{"dataset": "owner/artifacts"}',
                    "",
                )

            result = self.module.publish_bundle(
                source,
                "owner/artifacts",
                "",
                publisher=publisher,
                runner=runner,
            )

            command, kwargs = calls[0]
            self.assertEqual(command[0], sys.executable)
            self.assertIn(str(publisher), command)
            self.assertEqual(command[command.index("--source") + 1], str(source))
            self.assertEqual(
                command[command.index("--dataset") + 1],
                "owner/artifacts",
            )
            self.assertIn("--json", command)
            self.assertNotIn("--message", command)
            self.assertEqual(kwargs["timeout"], 1900)
            self.assertEqual(result, {"dataset": "owner/artifacts"})

    def test_publish_bundle_surfaces_publisher_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "artifact.bin"
            source.write_bytes(b"weights")
            publisher = Path(directory) / "colab_publish_kaggle.py"
            publisher.write_text("", encoding="utf-8")

            def runner(command, **kwargs):
                return subprocess.CompletedProcess(command, 1, "", "auth failed")

            with self.assertRaises(self.module.CheckpointError) as caught:
                self.module.publish_bundle(
                    source,
                    "owner/artifacts",
                    publisher=publisher,
                    runner=runner,
                )
            self.assertIn("auth failed", str(caught.exception))

    def test_cli_prints_json_and_writes_the_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "artifact.bin"
            source.write_bytes(b"weights")
            destination = Path(directory) / "drive" / "artifact.bin"
            output = io.StringIO()

            with contextlib.redirect_stdout(output):
                code = self.module.main(
                    [
                        "--source",
                        str(source),
                        "--destination",
                        str(destination),
                        "--json",
                    ]
                )

            self.assertEqual(code, 0)
            payload = json.loads(output.getvalue())
            self.assertEqual(payload["path"], str(destination))
            self.assertEqual(destination.read_bytes(), b"weights")

    def test_notebook_checkpoint_cell_precedes_publish_and_flushes_drive(self):
        notebook = json.loads(NOTEBOOK_PATH.read_text(encoding="utf-8"))
        ids = [cell.get("id") for cell in notebook["cells"]]
        checkpoint_index = ids.index("checkpoint-to-drive-code")
        publish_index = ids.index("publish-artifacts-code")
        self.assertLess(checkpoint_index, publish_index)

        source = "".join(notebook["cells"][checkpoint_index]["source"])
        compile(source, str(NOTEBOOK_PATH), "exec")
        self.assertIn("colab_checkpoint.py", source)
        self.assertIn("DESTINATION", source)
        self.assertIn("PUBLISH_DATASET", source)

        cleanup_source = next(
            "".join(cell.get("source", []))
            for cell in notebook["cells"]
            if "runtime.unassign()" in "".join(cell.get("source", []))
        )
        self.assertIn("flush_and_unmount", cleanup_source)


if __name__ == "__main__":
    unittest.main()
