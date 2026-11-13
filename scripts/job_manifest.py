# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.

"""Durable run manifests for the Kaggle batch lane.

A Kaggle kernel can outlive the process that submitted it: the API may
restart, the caller may time out, or the runner may be interrupted. The
manifest records the task fingerprint, the kernel id, the current phase, and
the SHA-256 of the downloaded response so a later run can resume polling or
download instead of spending another submission.

This module is storage only. It does not call the Kaggle CLI.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path


MANIFEST_PHASES = (
    "submitted",
    "running",
    "complete",
    "downloaded",
    "done",
)


def task_fingerprint(task):
    """Stable identity for a task payload, independent of key order."""
    encoded = json.dumps(
        task,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def manifest_path(manifest_dir, fingerprint):
    return Path(manifest_dir) / f"kaggle-{fingerprint[:16]}.json"


def artifact_path(manifest_dir, fingerprint):
    """Local copy of a downloaded response, used to serve an identical task."""
    return Path(manifest_dir) / f"kaggle-{fingerprint[:16]}.response.json"


def load_manifest(path):
    if path is None:
        return None
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def save_manifest(path, manifest):
    """Atomically replace the manifest so a crash cannot leave half a file."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = dict(manifest)
    payload["taskHash"] = payload.get("taskHash", "")
    payload["updatedAt"] = datetime.now(timezone.utc).isoformat()
    handle, temporary = tempfile.mkstemp(
        prefix=f".{target.name}.",
        dir=str(target.parent),
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as manifest_file:
            json.dump(payload, manifest_file, ensure_ascii=False, indent=2)
            manifest_file.write("\n")
            manifest_file.flush()
            os.fsync(manifest_file.fileno())
        os.replace(temporary, target)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return payload


def clear_manifest(path):
    if path is None:
        return
    try:
        Path(path).unlink()
    except FileNotFoundError:
        pass


def output_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as output_file:
        for chunk in iter(lambda: output_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
