#!/usr/bin/env python3
"""Publish artifacts from a Colab runtime to a private Kaggle Dataset.

This is intentionally artifact storage, not a request/response transport. It
uses the Kaggle CLI's normal HTTPS API and keeps the dataset private. Credentials
are read from environment variables or, inside Colab, from Colab Secrets; they
are never written to the staged dataset.
"""

from __future__ import annotations

import argparse
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
IGNORED_NAMES = (
    ".git",
    ".ipynb_checkpoints",
    "__pycache__",
    ".env",
    ".env.*",
    "kaggle.json",
    "access_token",
    "*.pem",
    "*.key",
    "*.pyc",
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

    An access token is preferred because Kaggle CLI 2.x introspects it for the
    account name. Legacy username/key credentials are still supported.
    """
    env = os.environ if env is None else env

    token = clean(env.get("KAGGLE_API_TOKEN"))
    if not token:
        token = secret_value(secret_getter, "KAGGLE_API_TOKEN")
    if token:
        return {"KAGGLE_API_TOKEN": token}, "Kaggle access token"

    username = clean(env.get("KAGGLE_USERNAME"))
    key = clean(env.get("KAGGLE_KEY"))
    if not username:
        username = secret_value(secret_getter, "KAGGLE_USERNAME")
    if not key:
        key = secret_value(secret_getter, "KAGGLE_KEY")
    if username and key:
        return {
            "KAGGLE_USERNAME": username,
            "KAGGLE_KEY": key,
        }, "legacy Kaggle API key"

    raise PublishError(
        "Kaggle credentials are missing. Add KAGGLE_API_TOKEN to Colab Secrets "
        "(or KAGGLE_USERNAME and KAGGLE_KEY), then retry."
    )


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


def stage_source(source, staging):
    """Copy the requested file or directory into the Kaggle staging folder."""
    source = Path(source).expanduser()
    if not source.exists():
        raise PublishError(f"Source does not exist: {source}")

    ignore = shutil.ignore_patterns(*IGNORED_NAMES)
    if source.is_dir():
        shutil.copytree(source, staging, dirs_exist_ok=True, ignore=ignore)
    else:
        shutil.copy2(source, staging / source.name)

    files = [path for path in staging.rglob("*") if path.is_file()]
    if not files:
        raise PublishError(f"Source contains no publishable files: {source}")
    return files


def dataset_exists(dataset, env, runner=subprocess.run):
    """Check for an existing dataset without downloading its contents."""
    result = runner(
        ["kaggle", "datasets", "files", dataset],
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


def publish(staging, dataset, action, message, env, runner=subprocess.run):
    if action == "create":
        command = [
            "kaggle", "datasets", "create",
            "-p", str(staging),
            "--dir-mode", "zip",
        ]
    else:
        command = [
            "kaggle", "datasets", "version",
            "-p", str(staging),
            "-m", message,
            "--dir-mode", "zip",
        ]

    result = runner(
        command,
        capture_output=True,
        text=True,
        timeout=900,
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
        "--dry-run",
        action="store_true",
        help="Validate and stage files without contacting Kaggle",
    )
    parser.add_argument("--json", action="store_true", help="Print a JSON result")
    return parser.parse_args(argv)


def main(argv=None):
    arguments = parse_arguments(argv)

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

        with tempfile.TemporaryDirectory(prefix="kaggle-colab-publish-") as directory:
            staging = Path(directory)
            files = stage_source(arguments.source, staging)
            (staging / "dataset-metadata.json").write_text(
                json.dumps(metadata, indent=2) + "\n",
                encoding="utf-8",
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
                    "metadata": metadata,
                    "credentials": credential_source,
                }
                if arguments.json:
                    print(json.dumps(result, indent=2))
                else:
                    print(
                        f"Dry run: would {action} private dataset "
                        f"{arguments.dataset} with {len(files)} file(s)."
                    )
                return 0

            ensure_kaggle_cli()
            environment = {**os.environ, **credentials}

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
            )
            result = {
                "dataset": arguments.dataset,
                "action": action,
                "source": str(Path(arguments.source).expanduser()),
                "files": len(files),
                "command": command,
            }
            if arguments.json:
                print(json.dumps(result, indent=2))
            else:
                print(
                    f"Published {len(files)} file(s) to private Kaggle dataset "
                    f"{arguments.dataset} ({action})."
                )
            return 0
    except (PublishError, OSError, subprocess.SubprocessError) as error:
        print(f"Kaggle publish failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
