# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts import job_manifest


class JobManifestTests(unittest.TestCase):
    def test_task_fingerprint_ignores_key_order(self):
        first = {"title": "Draft", "project": "workspace", "task_type": "feature"}
        second = {"task_type": "feature", "project": "workspace", "title": "Draft"}
        third = {"title": "Other", "project": "workspace", "task_type": "feature"}

        self.assertEqual(
            job_manifest.task_fingerprint(first),
            job_manifest.task_fingerprint(second),
        )
        self.assertNotEqual(
            job_manifest.task_fingerprint(first),
            job_manifest.task_fingerprint(third),
        )
        self.assertEqual(len(job_manifest.task_fingerprint(first)), 64)

    def test_manifest_and_artifact_paths_are_distinct_and_short(self):
        fingerprint = "a" * 64
        with tempfile.TemporaryDirectory() as directory:
            manifest = job_manifest.manifest_path(directory, fingerprint)
            artifact = job_manifest.artifact_path(directory, fingerprint)

            self.assertEqual(manifest.parent, Path(directory))
            self.assertEqual(manifest.name, "kaggle-aaaaaaaaaaaaaaaa.json")
            self.assertEqual(artifact.name, "kaggle-aaaaaaaaaaaaaaaa.response.json")
            self.assertNotEqual(manifest, artifact)

    def test_save_manifest_is_atomic_and_stamps_the_update_time(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runs" / "manifest.json"
            saved = job_manifest.save_manifest(
                path,
                {"taskHash": "abc", "kernelId": "owner/kernel", "phase": "running"},
            )

            self.assertTrue(path.exists())
            self.assertIn("updatedAt", saved)
            loaded = job_manifest.load_manifest(path)
            self.assertEqual(loaded["kernelId"], "owner/kernel")
            self.assertEqual(loaded["taskHash"], "abc")
            self.assertIn("updatedAt", loaded)
            # No temporary files are left behind after the atomic replace.
            self.assertEqual(
                sorted(entry.name for entry in path.parent.iterdir()),
                ["manifest.json"],
            )

    def test_load_manifest_tolerates_missing_and_invalid_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            self.assertIsNone(job_manifest.load_manifest(None))
            self.assertIsNone(job_manifest.load_manifest(path))

            path.write_text("{not json", encoding="utf-8")
            self.assertIsNone(job_manifest.load_manifest(path))

            path.write_text(json.dumps(["not", "a", "dict"]), encoding="utf-8")
            self.assertIsNone(job_manifest.load_manifest(path))

    def test_clear_manifest_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            job_manifest.save_manifest(path, {"phase": "running"})
            job_manifest.clear_manifest(path)
            self.assertFalse(path.exists())
            job_manifest.clear_manifest(path)
            job_manifest.clear_manifest(None)

    def test_output_sha256_matches_the_file_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "response.json"
            contents = '{"description":"draft"}\n'
            path.write_text(contents, encoding="utf-8")

            self.assertEqual(
                job_manifest.output_sha256(path),
                hashlib.sha256(contents.encode("utf-8")).hexdigest(),
            )


if __name__ == "__main__":
    unittest.main()
