#!/usr/bin/env python3
# Objective: Implement and maintain this Python module.
# Requirements: Keep behavior aligned with tests and documented APIs.
# Decisions: Follow existing repository conventions.
# Relevant Files: scripts/colab_checkpoint.py
# Important Context: User file. Vendor and transient artifacts are excluded from tracking.
# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.

"""Atomically checkpoint local artifacts to Google Drive and verify them.

This is storage, not a transport. Use it at explicit stage boundaries in a
human-driven Colab session, then optionally publish the verified local bundle
with ``colab_publish_kaggle.py``. Do not run it as a polling worker.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

CHUNK_SIZE = 1024 * 1024


class CheckpointError(RuntimeError):
    """A user-facing checkpoint failure."""


def sha256_file(path, chunk_size=CHUNK_SIZE):
    digest = hashlib.sha256()
    with Path(path).open("rb") as file:
        for chunk in iter(lambda: file.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _fsync_directory(directory):
    """Best-effort directory fsync; Drive FUSE may not support it."""
    try:
        descriptor = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def atomic_copy(source, destination):
    """Copy a file to Drive with fsync, atomic rename, and read-back verification."""
    source = Path(source).expanduser()
    destination = Path(destination).expanduser()

    if not source.exists():
        raise CheckpointError(f"Source file does not exist: {source}")
    if source.is_symlink():
        raise CheckpointError(f"Refusing to checkpoint a symbolic link: {source}")
    if not source.is_file():
        raise CheckpointError(f"Source is not a regular file: {source}")
    if destination.is_symlink():
        raise CheckpointError(f"Refusing to replace a symbolic link: {destination}")
    if destination.exists() and destination.is_dir():
        raise CheckpointError(f"Destination must be a file path: {destination}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".tmp")
    expected_size = source.stat().st_size
    expected_hash = sha256_file(source)

    try:
        with source.open("rb") as source_file, temporary.open("wb") as target_file:
            shutil.copyfileobj(source_file, target_file, length=CHUNK_SIZE)
            target_file.flush()
            os.fsync(target_file.fileno())

        temporary_size = temporary.stat().st_size
        temporary_hash = sha256_file(temporary)
        if temporary_size != expected_size or temporary_hash != expected_hash:
            raise CheckpointError(
                f"Local copy verification failed for {destination}: "
                f"expected {expected_size} bytes/{expected_hash}, "
                f"got {temporary_size} bytes/{temporary_hash}"
            )

        os.replace(temporary, destination)
        _fsync_directory(destination.parent)

        actual_size = destination.stat().st_size
        actual_hash = sha256_file(destination)
        if actual_size != expected_size or actual_hash != expected_hash:
            raise CheckpointError(
                f"Drive checkpoint verification failed for {destination}: "
                f"expected {expected_size} bytes/{expected_hash}, "
                f"got {actual_size} bytes/{actual_hash}"
            )

        return {
            "path": str(destination),
            "bytes": actual_size,
            "sha256": actual_hash,
        }
    finally:
        if temporary.exists():
            temporary.unlink()


def iter_regular_files(source):
    """Yield regular files without following symlinks."""
    files = []
    for root, dirnames, filenames in os.walk(source, followlinks=False):
        root_path = Path(root)
        dirnames[:] = [
            name for name in dirnames if not (root_path / name).is_symlink()
        ]
        for name in filenames:
            path = root_path / name
            if path.is_symlink() or not path.is_file():
                continue
            files.append(path)
    return sorted(files)


def zip_directory(source, archive):
    """Zip a directory as one file so Drive sees a single large write."""
    files = iter_regular_files(source)
    if not files:
        raise CheckpointError(f"Source directory contains no files: {source}")

    source_bytes = sum(path.stat().st_size for path in files)
    with zipfile.ZipFile(
        archive,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=1,
    ) as bundle:
        for path in files:
            relative = path.relative_to(source.parent)
            bundle.write(path, relative.as_posix())
    return files, source_bytes


def checkpoint_directory(source, destination):
    source = Path(source).expanduser().resolve()
    destination = Path(destination).expanduser()
    if destination.suffix.lower() != ".zip":
        raise CheckpointError(
            "Directory checkpoints require a .zip destination, for example "
            "/content/drive/MyDrive/colab-workspace/checkpoints/bundle.zip."
        )

    with tempfile.TemporaryDirectory(prefix="colab-checkpoint-") as directory:
        archive = Path(directory) / "checkpoint.zip"
        files, source_bytes = zip_directory(source, archive)
        result = atomic_copy(archive, destination)

    result.update(
        {
            "source": str(source),
            "files": len(files),
            "sourceBytes": source_bytes,
        }
    )
    return result


def checkpoint(source, destination):
    """Checkpoint a file, or zip a directory, and return verified metadata."""
    source = Path(source).expanduser()
    if not source.exists():
        raise CheckpointError(f"Source does not exist: {source}")
    if source.is_symlink():
        raise CheckpointError(f"Refusing to checkpoint a symbolic link: {source}")
    source = source.resolve()

    if source.is_dir():
        return checkpoint_directory(source, destination)
    if not source.is_file():
        raise CheckpointError(f"Source is not a regular file or directory: {source}")

    result = atomic_copy(source, destination)
    result.update(
        {
            "source": str(source),
            "files": 1,
            "sourceBytes": source.stat().st_size,
        }
    )
    return result


def publish_bundle(
    source,
    dataset,
    message="",
    publisher=None,
    runner=subprocess.run,
    timeout=1900,
):
    """Publish the verified local source through the existing Kaggle publisher."""
    publisher_path = (
        Path(publisher)
        if publisher
        else Path(__file__).with_name("colab_publish_kaggle.py")
    )
    if not publisher_path.is_file():
        raise CheckpointError(f"Kaggle publisher not found: {publisher_path}")

    command = [
        sys.executable,
        str(publisher_path),
        "--source",
        str(Path(source).expanduser()),
        "--dataset",
        dataset,
        "--json",
    ]
    if str(message or "").strip():
        command += ["--message", str(message).strip()]

    result = runner(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "unknown error").strip()
        raise CheckpointError(f"Kaggle publish failed: {detail}")

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise CheckpointError(
            f"Could not parse Kaggle publish output: {error}"
        ) from error


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Atomically checkpoint a local file or directory to Google Drive, "
            "verify its SHA-256, and optionally publish the verified source to "
            "a private Kaggle Dataset."
        )
    )
    parser.add_argument(
        "--source",
        required=True,
        help="Local file or directory to checkpoint",
    )
    parser.add_argument(
        "--destination",
        required=True,
        help="Drive file path; directory sources require a .zip destination",
    )
    parser.add_argument(
        "--publish-dataset",
        default="",
        help="Optionally publish the verified source to this private Kaggle dataset",
    )
    parser.add_argument(
        "--publish-message",
        default="",
        help="Version message for --publish-dataset",
    )
    parser.add_argument(
        "--publisher",
        type=Path,
        help="Path to colab_publish_kaggle.py (default: sibling of this script)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=1900,
        metavar="SECONDS",
        help="Publish timeout in seconds (default: 1900)",
    )
    parser.add_argument("--json", action="store_true", help="Print a JSON result")
    arguments = parser.parse_args(argv)
    if arguments.timeout < 1:
        parser.error("--timeout must be a positive integer")
    return arguments


def main(argv=None):
    arguments = parse_arguments(argv)

    try:
        result = checkpoint(arguments.source, arguments.destination)
        if arguments.publish_dataset:
            result["publish"] = publish_bundle(
                arguments.source,
                arguments.publish_dataset,
                arguments.publish_message,
                publisher=arguments.publisher,
                timeout=arguments.timeout,
            )

        if arguments.json:
            print(json.dumps(result, indent=2))
        else:
            print(
                f"Checkpoint verified at {result['path']} "
                f"({result['bytes']} bytes, sha256 {result['sha256'][:12]}...)."
            )
            if "publish" in result:
                print(f"Published to {arguments.publish_dataset}.")
        return 0
    except (CheckpointError, OSError, subprocess.SubprocessError) as error:
        print(f"Checkpoint failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
