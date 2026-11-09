#!/usr/bin/env python3
# Objective: Implement and maintain this Python module.
# Requirements: Keep behavior aligned with tests and documented APIs.
# Decisions: Follow existing repository conventions.
# Relevant Files: scripts/colab_publish_kaggle.py
# Important Context: User file. Vendor and transient artifacts are excluded from tracking.
# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.

"""Publish artifacts from a Colab runtime to a private Kaggle Dataset.

This is intentionally artifact storage, not a request/response transport. It
uses the Kaggle CLI's normal HTTPS API and keeps the dataset private. Credentials
are read from environment variables or, inside Colab, from Colab Secrets; they
are never written to the staged dataset.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

DATASET_ID_PATTERN = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9_-]*/[A-Za-z0-9][A-Za-z0-9_-]*$"
)
DEFAULT_IGNORED_PATTERNS = (
    ".git",
    ".hg",
    ".svn",
    ".ipynb_checkpoints",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".cache",
    ".venv",
    "venv",
    "node_modules",
    ".env",
    ".env.*",
    ".envrc",
    "kaggle.json",
    "access_token",
    "access_token.txt",
    "credentials.json",
    "client_secret*.json",
    "service-account*.json",
    "token.json",
    "*.jwt",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.jks",
    "*.keystore",
    "id_rsa",
    "id_rsa.*",
    "id_ed25519",
    "id_ed25519.*",
    ".ssh",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".aws",
    ".kube",
    ".config/gcloud",
    ".DS_Store",
    "Thumbs.db",
    "*.pyc",
    "*.pyo",
    "*.egg-info",
)


class PublishError(RuntimeError):
    """A user-facing publishing failure."""


def clean(value):
    return str(value or "").strip()


def secret_value(getter, name):
    if getter is None:
        return ""
    try:
        return clean(getter(name))
    except Exception:  # noqa: BLE001 - Colab raises for missing secrets
        return ""


def default_secret_getter():
    """Return Colab's userdata.get when running inside a Colab runtime."""
    try:
        from google.colab import userdata
    except Exception:  # noqa: BLE001 - not running in Colab
        return None
    return userdata.get


def resolve_credentials(env=None, secret_getter=None):
    """Resolve Kaggle credentials without persisting them.

    Environment variables take precedence over Colab Secrets. Within each
    source, an access token is preferred because Kaggle CLI 2.x introspects it
    for the account name; legacy username/key credentials remain supported.
    """
    env = os.environ if env is None else env

    token = clean(env.get("KAGGLE_API_TOKEN"))
    if token:
        return {"KAGGLE_API_TOKEN": token}, "Kaggle access token (environment)"

    username = clean(env.get("KAGGLE_USERNAME"))
    key = clean(env.get("KAGGLE_KEY"))
    if username and key:
        return {
            "KAGGLE_USERNAME": username,
            "KAGGLE_KEY": key,
        }, "legacy Kaggle API key (environment)"

    token = secret_value(secret_getter, "KAGGLE_API_TOKEN")
    if token:
        return {"KAGGLE_API_TOKEN": token}, "Kaggle access token (Colab Secret)"

    username = secret_value(secret_getter, "KAGGLE_USERNAME")
    key = secret_value(secret_getter, "KAGGLE_KEY")
    if username and key:
        return {
            "KAGGLE_USERNAME": username,
            "KAGGLE_KEY": key,
        }, "legacy Kaggle API key (Colab Secret)"

    raise PublishError(
        "Kaggle credentials are missing. Add KAGGLE_API_TOKEN to Colab Secrets "
        "(or KAGGLE_USERNAME and KAGGLE_KEY), then retry."
    )


def redact(text, credentials):
    """Remove credential values from error text before printing it."""
    for value in credentials.values():
        if value and len(value) >= 8:
            text = text.replace(value, "***")
    return text


def build_metadata(dataset, title=None, license_name="other", description=""):
    if not DATASET_ID_PATTERN.fullmatch(dataset):
        raise PublishError(
            "Dataset must use the form owner/dataset-slug, for example "
            "your-user/workspace-artifacts."
        )

    slug = dataset.split("/", 1)[1]
    metadata = {
        "title": clean(title) or slug.replace("-", " ").replace("_", " ").title(),
        "id": dataset,
        "licenses": [{"name": clean(license_name) or "other"}],
        "isPrivate": True,
    }
    if clean(description):
        metadata["description"] = clean(description)
    return metadata


def is_ignored(relative_path, patterns):
    relative = Path(relative_path).as_posix()
    name = Path(relative_path).name
    return any(
        fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(relative, pattern)
        for pattern in patterns
    )


def iter_source_files(source, excludes=()):
    """Return publishable files without copying them.

    Symlinks are skipped rather than followed so a link cannot pull a secret
    from outside the source tree into the upload. Secret-like names are rejected
    for both directories and single-file sources.
    """
    source_path = Path(source).expanduser()
    if not source_path.exists():
        raise PublishError(f"Source does not exist: {source_path}")
    if source_path.is_symlink():
        raise PublishError(f"Refusing to publish a symbolic link: {source_path}")

    source_path = source_path.resolve()
    patterns = DEFAULT_IGNORED_PATTERNS + tuple(excludes)

    if source_path.is_file():
        if is_ignored(Path(source_path.name), patterns):
            raise PublishError(
                f"Refusing to publish secret-like file: {source_path.name}. "
                "Choose a different source or rename the file."
            )
        return [source_path]

    if not source_path.is_dir():
        raise PublishError(f"Source is not a regular file or directory: {source_path}")

    def on_error(error):
        raise PublishError(f"Could not read {error.filename}: {error.strerror}")

    files = []
    for root, dirnames, filenames in os.walk(
        source_path, followlinks=False, onerror=on_error
    ):
        root_path = Path(root)
        kept = []
        for dirname in dirnames:
            candidate = root_path / dirname
            if candidate.is_symlink():
                continue
            relative = candidate.relative_to(source_path)
            if is_ignored(relative, patterns):
                continue
            kept.append(dirname)
        dirnames[:] = kept

        for filename in filenames:
            candidate = root_path / filename
            if candidate.is_symlink() or not candidate.is_file():
                continue
            relative = candidate.relative_to(source_path)
            if is_ignored(relative, patterns):
                continue
            files.append(candidate)

    if not files:
        raise PublishError(f"Source contains no publishable files: {source_path}")
    return sorted(files)


def stage_files(source, files, staging):
    """Copy already-validated files into the staging folder."""
    source_path = Path(source).expanduser().resolve()
    is_directory = source_path.is_dir()
    staged = []
    for file in files:
        relative = file.relative_to(source_path) if is_directory else Path(file.name)
        target = staging / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, target)
        staged.append(target)
    return staged


def stage_source(source, staging, excludes=()):
    """Copy the requested file or directory into the Kaggle staging folder."""
    source_path = Path(source).expanduser()
    return stage_files(
        source_path,
        iter_source_files(source_path, excludes),
        staging,
    )


def total_size(files):
    return sum(path.stat().st_size for path in files)


def format_size(size):
    if size >= 1024**3:
        return f"{size / 1024**3:.1f} GiB"
    return f"{size / 1024**2:.1f} MiB"


def dataset_exists(dataset, env, runner=subprocess.run):
    """Check for an existing dataset without downloading its contents."""
    result = runner(
        ["kaggle", "datasets", "files", dataset, "--page-size", "1"],
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )
    if result.returncode == 0:
        return True

    message = f"{result.stderr or ''}\n{result.stdout or ''}".lower()
    if any(phrase in message for phrase in ("404", "not found", "does not exist")):
        return False
    raise PublishError(
        f"Could not check dataset {dataset}: "
        f"{(result.stderr or result.stdout or 'unknown error').strip()}"
    )


def publish(
    staging,
    dataset,
    action,
    message,
    env,
    runner=subprocess.run,
    timeout=1800,
    dir_mode="zip",
):
    if dir_mode not in ("zip", "tar", "skip"):
        raise PublishError("Directory mode must be one of: zip, tar, skip.")

    if action == "create":
        command = [
            "kaggle", "datasets", "create",
            "-p", str(staging),
            "--dir-mode", dir_mode,
        ]
    else:
        command = [
            "kaggle", "datasets", "version",
            "-p", str(staging),
            "-m", message,
            "--dir-mode", dir_mode,
        ]

    result = runner(
        command,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "unknown error").strip()
        raise PublishError(f"Kaggle {action} failed for {dataset}: {detail}")
    return command


def ensure_kaggle_cli():
    if shutil.which("kaggle") is None:
        raise PublishError(
            "Kaggle CLI is not installed. In Colab, run: pip install -q kaggle"
        )


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Publish files from a Colab runtime to a private Kaggle Dataset. "
            "Credentials come from KAGGLE_API_TOKEN or KAGGLE_USERNAME/KAGGLE_KEY "
            "environment variables, or from Colab Secrets with the same names."
        )
    )
    parser.add_argument(
        "--source",
        required=True,
        help="File or directory to upload (secret-like files are skipped)",
    )
    parser.add_argument(
        "--dataset",
        required=True,
        help="Private dataset ID in owner/slug form",
    )
    parser.add_argument("--title", help="Dataset title (default: derived from slug)")
    parser.add_argument("--description", default="", help="Optional dataset description")
    parser.add_argument(
        "--license",
        default="other",
        help="Kaggle license name to record (default: other)",
    )
    parser.add_argument(
        "--mode",
        choices=("auto", "create", "version"),
        default="auto",
        help="Create or version the dataset; auto checks which is needed (default)",
    )
    parser.add_argument(
        "--message",
        default="",
        help="Version message (default: timestamped Colab upload)",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="PATTERN",
        help="Additional glob to skip; repeat for more patterns",
    )
    parser.add_argument(
        "--max-size-mb",
        type=int,
        default=0,
        metavar="MB",
        help="Refuse sources larger than this many MiB (default: 0, disabled)",
    )
    parser.add_argument(
        "--dir-mode",
        choices=("zip", "tar", "skip"),
        default="zip",
        help="How Kaggle handles subdirectories (default: zip)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=1800,
        metavar="SECONDS",
        help="Kaggle upload timeout in seconds (default: 1800)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate without contacting Kaggle or copying files",
    )
    parser.add_argument("--json", action="store_true", help="Print a JSON result")
    arguments = parser.parse_args(argv)
    if arguments.timeout < 1:
        parser.error("--timeout must be a positive integer")
    if arguments.max_size_mb < 0:
        parser.error("--max-size-mb must be zero or a positive integer")
    return arguments


def main(argv=None):
    arguments = parse_arguments(argv)
    credentials = {}

    try:
        if arguments.dry_run:
            try:
                _, credential_source = resolve_credentials(
                    secret_getter=default_secret_getter()
                )
            except PublishError:
                credential_source = "not checked (dry run)"
        else:
            credentials, credential_source = resolve_credentials(
                secret_getter=default_secret_getter()
            )
        metadata = build_metadata(
            arguments.dataset,
            title=arguments.title,
            license_name=arguments.license,
            description=arguments.description,
        )

        files = iter_source_files(arguments.source, arguments.exclude)
        source_bytes = total_size(files)
        if arguments.max_size_mb and source_bytes > arguments.max_size_mb * 1024**2:
            raise PublishError(
                f"Source is {format_size(source_bytes)}, above --max-size-mb "
                f"{arguments.max_size_mb}."
            )

        message = clean(arguments.message) or (
            "Colab artifact upload "
            + datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        )

        if arguments.dry_run:
            action = arguments.mode if arguments.mode != "auto" else "create-or-version"
            result = {
                "dryRun": True,
                "dataset": arguments.dataset,
                "action": action,
                "source": str(Path(arguments.source).expanduser()),
                "files": len(files),
                "bytes": source_bytes,
                "metadata": metadata,
                "credentials": credential_source,
            }
            if arguments.json:
                print(json.dumps(result, indent=2))
            else:
                print(
                    f"Dry run: would {action} private dataset "
                    f"{arguments.dataset} with {len(files)} file(s), "
                    f"{format_size(source_bytes)}."
                )
            return 0

        ensure_kaggle_cli()
        environment = {**os.environ, **credentials}

        with tempfile.TemporaryDirectory(prefix="kaggle-colab-publish-") as directory:
            staging = Path(directory)
            stage_files(arguments.source, files, staging)
            (staging / "dataset-metadata.json").write_text(
                json.dumps(metadata, indent=2) + "\n",
                encoding="utf-8",
            )

            if arguments.mode == "auto":
                action = "version" if dataset_exists(
                    arguments.dataset, environment
                ) else "create"
            else:
                action = arguments.mode

            command = publish(
                staging,
                arguments.dataset,
                action,
                message,
                environment,
                timeout=arguments.timeout,
                dir_mode=arguments.dir_mode,
            )

        result = {
            "dataset": arguments.dataset,
            "action": action,
            "source": str(Path(arguments.source).expanduser()),
            "files": len(files),
            "bytes": source_bytes,
            "command": command,
        }
        if arguments.json:
            print(json.dumps(result, indent=2))
        else:
            print(
                f"Published {len(files)} file(s), {format_size(source_bytes)}, to "
                f"private Kaggle dataset {arguments.dataset} ({action})."
            )
        return 0
    except (PublishError, OSError, subprocess.SubprocessError) as error:
        print(
            f"Kaggle publish failed: {redact(str(error), credentials)}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
