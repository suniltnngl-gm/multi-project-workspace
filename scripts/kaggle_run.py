# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:  # Imported as scripts.kaggle_run in tests.
    from . import job_manifest
except ImportError:  # Executed directly or loaded by file path.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import job_manifest


ROOT_DIR = Path(__file__).resolve().parents[1]
NOTEBOOK_PATH = ROOT_DIR / "notebooks" / "kaggle-qwen-coder.ipynb"
METADATA_PATH = ROOT_DIR / "notebooks" / "kernel-metadata.json"
DEFAULT_KERNEL_ID = "edmundrosariosunil/kaggle-qwen-coder"
DEFAULT_DATASET_HANDLE = "edmundrosariosunil/qwen2-5-coder-3b-instruct"
REQUIRED_TASK_FIELDS = (
    "title",
    "project",
    "task_type",
)


def resolve_kaggle_config(metadata, kernel_id=None, dataset_handle=None):
    resolved_kernel_id = (
        (kernel_id or "").strip()
        or os.environ.get("KAGGLE_AI_KERNEL_ID", "").strip()
        or str(metadata.get("id") or "").strip()
        or DEFAULT_KERNEL_ID
    )
    metadata_sources = metadata.get("dataset_sources") or []
    default_source = str(metadata_sources[0]).strip() if metadata_sources else ""
    resolved_dataset_handle = (
        (dataset_handle or "").strip()
        or os.environ.get("KAGGLE_AI_DATASET_HANDLE", "").strip()
        or default_source
        or DEFAULT_DATASET_HANDLE
    )
    return resolved_kernel_id, resolved_dataset_handle


def load_task(task_path):
    with task_path.open(encoding="utf-8") as task_file:
        task = json.load(task_file)
    if not isinstance(task, dict):
        raise ValueError("The task JSON must be an object.")
    missing = [
        field
        for field in REQUIRED_TASK_FIELDS
        if not isinstance(task.get(field), str) or not task[field].strip()
    ]
    if missing:
        raise ValueError(
            "Task JSON must contain non-empty string fields: "
            + ", ".join(missing)
        )
    for field in (
        "description",
        "acceptance_criteria",
        "objectives",
        "requirements",
        "decisions",
        "relevant_files",
        "important_context",
    ):
        if task.get(field) is None:
            task[field] = ""
    return task


def prepare_run_directory(task, run_dir, kernel_id=None, dataset_handle=None):
    with NOTEBOOK_PATH.open(encoding="utf-8") as notebook_file:
        notebook = json.load(notebook_file)
    with METADATA_PATH.open(encoding="utf-8") as metadata_file:
        metadata = json.load(metadata_file)

    effective_kernel_id, effective_dataset_handle = resolve_kaggle_config(
        metadata, kernel_id=kernel_id, dataset_handle=dataset_handle
    )
    metadata["id"] = effective_kernel_id
    metadata["dataset_sources"] = [effective_dataset_handle]

    if effective_dataset_handle != DEFAULT_DATASET_HANDLE:
        for paths_cell in notebook["cells"]:
            if paths_cell.get("id") != "kaggle-paths":
                continue
            paths_source = "".join(paths_cell.get("source", []))
            paths_lines = paths_source.splitlines(keepends=True)
            for idx, line in enumerate(paths_lines):
                if line.startswith("DATASET_HANDLE = "):
                    paths_lines[idx] = (
                        f"DATASET_HANDLE = {json.dumps(effective_dataset_handle)}\n"
                    )
                    break
            paths_cell["source"] = paths_lines

    inference_cells = [
        cell
        for cell in notebook["cells"]
        if cell.get("id") == "kaggle-inference"
    ]
    if len(inference_cells) != 1:
        raise ValueError("Expected exactly one kaggle-inference notebook cell.")

    cell = inference_cells[0]
    source = "".join(cell.get("source", []))
    task_lines = [
        index
        for index, line in enumerate(source.splitlines())
        if line.startswith("task = ")
    ]
    if len(task_lines) != 1:
        raise ValueError("Expected exactly one task assignment in inference cell.")
    lines = source.splitlines(keepends=True)
    encoded_task = json.dumps(task, ensure_ascii=False)
    lines[task_lines[0]] = f"task = json.loads({json.dumps(encoded_task)})\n"
    cell["source"] = lines

    run_dir.mkdir(parents=True, exist_ok=True)
    notebook_target = run_dir / NOTEBOOK_PATH.name
    metadata_target = run_dir / METADATA_PATH.name
    notebook_target.write_text(
        json.dumps(notebook, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8",
    )
    metadata_target.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return effective_kernel_id, notebook_target


def run_kaggle(arguments, timeout=60):
    result = subprocess.run(
        arguments,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    output = (result.stdout + "\n" + result.stderr).strip()
    if result.returncode:
        raise RuntimeError(
            f"Kaggle CLI command failed with exit code {result.returncode}: "
            f"{output}"
        )
    return output


def cancel_kernel(kernel_id, fallback="none"):
    """Best-effort cancellation for a kernel left behind by a timeout.

    Kaggle CLI 2.2.5 does not expose ``kernels cancel`` yet, so the first
    attempt is forward-compatible rather than guaranteed. Setting
    ``KAGGLE_AI_CANCEL_FALLBACK=delete`` deletes the kernel as a last resort;
    that stops the run but also removes the private notebook, which the next
    submission recreates.
    """
    commands = [["kaggle", "kernels", "cancel", kernel_id]]
    if fallback == "delete":
        commands.append(["kaggle", "kernels", "delete", kernel_id, "-y"])

    for command in commands:
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except (OSError, subprocess.SubprocessError) as error:
            print(
                f"Could not cancel Kaggle kernel {kernel_id}: {error}",
                file=sys.stderr,
            )
            continue
        if result.returncode == 0:
            print(f"Cancelled Kaggle kernel {kernel_id}.", file=sys.stderr)
            return True

    print(
        f"Warning: could not cancel Kaggle kernel {kernel_id}. "
        "Stop it from https://www.kaggle.com/code if it is still queued or running.",
        file=sys.stderr,
    )
    return False


def wait_for_completion(kernel_id, timeout_seconds, poll_interval):
    deadline = time.monotonic() + timeout_seconds
    while True:
        status = run_kaggle(
            ["kaggle", "kernels", "status", kernel_id],
            timeout=60,
        )
        normalized = status.lower()
        if "not complete" not in normalized and re.search(
            r"\b(?:kernelworkerstatus\.)?complete\b", normalized
        ):
            return
        if re.search(
            r"\b(?:kernelworkerstatus\.)?(?:error|failed|cancelled|canceled)\b",
            normalized,
        ):
            raise RuntimeError(f"Kaggle kernel ended unsuccessfully: {status}")
        if time.monotonic() >= deadline:
            raise TimeoutError(
                f"Timed out waiting for Kaggle kernel {kernel_id}. "
                "Check it with `kaggle kernels status`."
            )
        time.sleep(poll_interval)


def validate_response(response_path):
    with response_path.open(encoding="utf-8") as response_file:
        response = json.load(response_file)
    if (
        not isinstance(response, dict)
        or not isinstance(response.get("description"), str)
        or not isinstance(response.get("acceptance_criteria"), str)
    ):
        raise ValueError(
            f"Kaggle output is not a validated task response: {response_path}"
        )
    return response


def save_resume_state(manifest_file, manifest, **updates):
    """Persist resume metadata; a read-only state dir must not break inference."""
    merged = {**(manifest or {}), **updates}
    if manifest_file is None:
        return merged
    try:
        job_manifest.save_manifest(manifest_file, merged)
    except OSError as error:
        print(
            f"Warning: could not write the Kaggle manifest {manifest_file}: {error}",
            file=sys.stderr,
        )
    return merged


def load_resume_state(manifest_file, fingerprint):
    manifest = job_manifest.load_manifest(manifest_file)
    if not manifest or manifest.get("taskHash") != fingerprint:
        return None
    return manifest


def reuse_completed_manifest(manifest, artifact_file, output_path):
    """Serve a previously downloaded response without touching Kaggle."""
    if (
        not manifest
        or manifest.get("phase") not in ("downloaded", "done")
        or artifact_file is None
    ):
        return False
    if not artifact_file.exists():
        return False
    digest = job_manifest.output_sha256(artifact_file)
    if digest != manifest.get("outputSha256"):
        return False
    output_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(artifact_file, output_path)
    print("Reusing the completed Kaggle result for this task.", flush=True)
    print(artifact_file.read_text(encoding="utf-8").strip(), flush=True)
    return True


def execute(
    task,
    output_path,
    timeout_seconds,
    poll_interval,
    cancel_fallback="none",
    manifest_dir=None,
    kernel_id_override=None,
    dataset_handle_override=None,
):
    if shutil.which("kaggle") is None:
        raise FileNotFoundError(
            "Kaggle CLI is required. Install it and configure your Kaggle API credentials."
        )

    fingerprint = job_manifest.task_fingerprint(task)
    manifest_file = (
        job_manifest.manifest_path(manifest_dir, fingerprint)
        if manifest_dir is not None
        else None
    )
    artifact_file = (
        job_manifest.artifact_path(manifest_dir, fingerprint)
        if manifest_dir is not None
        else None
    )
    manifest = load_resume_state(manifest_file, fingerprint)
    if reuse_completed_manifest(manifest, artifact_file, output_path):
        return

    phase = manifest.get("phase") if manifest else None
    kernel_id = (
        manifest.get("kernelId")
        if phase in ("submitted", "running", "complete")
        else None
    )

    with tempfile.TemporaryDirectory(prefix="kaggle-qwen-run-") as temporary_dir:
        if not kernel_id:
            kernel_id, _ = prepare_run_directory(
                task,
                Path(temporary_dir),
                kernel_id=kernel_id_override,
                dataset_handle=dataset_handle_override,
            )
            print(f"Submitting one private Kaggle notebook run: {kernel_id}", flush=True)
            print(
                run_kaggle(
                    ["kaggle", "kernels", "push", "-p", temporary_dir],
                    timeout=180,
                ),
                flush=True,
            )
            manifest = save_resume_state(
                manifest_file,
                None,
                taskHash=fingerprint,
                kernelId=kernel_id,
                phase="submitted",
            )
            phase = "submitted"
        else:
            # The kernel already exists: polling and downloading are free of
            # submission quota, so resume instead of pushing a duplicate.
            print(f"Resuming Kaggle kernel {kernel_id} from phase {phase}.", flush=True)

        try:
            if phase != "complete":
                manifest = save_resume_state(
                    manifest_file,
                    manifest,
                    taskHash=fingerprint,
                    kernelId=kernel_id,
                    phase="running",
                )
                wait_for_completion(kernel_id, timeout_seconds, poll_interval)
                manifest = save_resume_state(
                    manifest_file,
                    manifest,
                    taskHash=fingerprint,
                    kernelId=kernel_id,
                    phase="complete",
                )

            with tempfile.TemporaryDirectory(prefix="kaggle-qwen-output-") as output_dir:
                print("Downloading completed notebook output.", flush=True)
                print(
                    run_kaggle(
                        [
                            "kaggle",
                            "kernels",
                            "output",
                            kernel_id,
                            "-p",
                            output_dir,
                            "--file-pattern",
                            r"response\.json$",
                        ],
                        timeout=180,
                    ),
                    flush=True,
                )
                response_files = list(Path(output_dir).rglob("response.json"))
                if len(response_files) != 1:
                    raise FileNotFoundError(
                        "Expected one response.json in Kaggle output; "
                        f"found {response_files}."
                    )
                response = validate_response(response_files[0])
                digest = job_manifest.output_sha256(response_files[0])
                if artifact_file is not None:
                    try:
                        artifact_file.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(response_files[0], artifact_file)
                    except OSError as error:
                        print(
                            "Warning: could not save the Kaggle response copy: "
                            f"{error}",
                            file=sys.stderr,
                        )
                manifest = save_resume_state(
                    manifest_file,
                    manifest,
                    taskHash=fingerprint,
                    kernelId=kernel_id,
                    phase="downloaded",
                    outputSha256=digest,
                )
        except TimeoutError:
            # A timed-out kernel may still finish after this process exits.
            # Keep it and the manifest so the next run resumes polling instead
            # of spending another submission.
            save_resume_state(
                manifest_file,
                manifest,
                taskHash=fingerprint,
                kernelId=kernel_id,
                phase="running",
            )
            raise
        except BaseException:
            # Any other failure (kernel error, bad payload) is not resumable;
            # forget the manifest and clean up the kernel.
            job_manifest.clear_manifest(manifest_file)
            cancel_kernel(kernel_id, cancel_fallback)
            raise

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(response, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if artifact_file is not None:
        # Store the normalized response as the reusable copy. The manifest hash
        # and the artifact must describe the same bytes or reuse would reject a
        # valid result.
        try:
            artifact_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(output_path, artifact_file)
        except OSError as error:
            print(
                f"Warning: could not save the Kaggle response copy: {error}",
                file=sys.stderr,
            )
    save_resume_state(
        manifest_file,
        manifest,
        taskHash=fingerprint,
        kernelId=kernel_id,
        phase="done",
        outputSha256=job_manifest.output_sha256(output_path),
    )
    print(json.dumps(response, ensure_ascii=False, indent=2))


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            "Submit one task to the private Kaggle Qwen notebook, wait for the "
            "run, and save its validated response."
        )
    )
    parser.add_argument(
        "--task-json",
        required=True,
        type=Path,
        help=(
            "JSON object with title, project, task_type, description, "
            "acceptance_criteria, objectives, requirements, decisions, "
            "relevant_files, and important_context"
        ),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("kaggle-output/response.json"),
        help="Where to save the validated JSON response (default: ./kaggle-output/response.json)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=3600,
        help="Maximum wait for Kaggle completion in seconds (default: 3600)",
    )
    parser.add_argument(
        "--poll-interval",
        type=int,
        default=30,
        help="Seconds between Kaggle status checks (default: 30)",
    )
    parser.add_argument(
        "--cancel-fallback",
        choices=("none", "delete"),
        default=os.environ.get("KAGGLE_AI_CANCEL_FALLBACK", "none"),
        help=(
            "Best-effort cleanup after a timeout. 'delete' also deletes the "
            "private kernel if the CLI has no cancel command (default: none)"
        ),
    )
    parser.add_argument(
        "--manifest-dir",
        type=Path,
        default=(
            Path(os.environ["KAGGLE_AI_MANIFEST_DIR"])
            if os.environ.get("KAGGLE_AI_MANIFEST_DIR")
            else None
        ),
        help=(
            "Directory for resumable run manifests and downloaded responses. "
            "When omitted, each run submits a new kernel and does not resume "
            "(default: $KAGGLE_AI_MANIFEST_DIR or none)"
        ),
    )
    parser.add_argument(
        "--kernel-id",
        default=None,
        help="Override Kaggle kernel slug (<owner>/<slug>; defaults to $KAGGLE_AI_KERNEL_ID or notebooks/kernel-metadata.json).",
    )
    parser.add_argument(
        "--dataset-handle",
        default=None,
        help="Override Kaggle dataset handle (<owner>/<dataset>; defaults to $KAGGLE_AI_DATASET_HANDLE or notebooks/kernel-metadata.json).",
    )
    arguments = parser.parse_args(argv)
    if arguments.timeout < 1 or arguments.poll_interval < 1:
        parser.error("--timeout and --poll-interval must be positive integers")
    return arguments


def raise_interrupt(_signum, _frame):
    raise KeyboardInterrupt


def main(argv=None):
    arguments = parse_arguments(argv)
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(signum, raise_interrupt)
        except (OSError, ValueError):
            pass
    try:
        task = load_task(arguments.task_json)
        execute(
            task,
            arguments.output,
            arguments.timeout,
            arguments.poll_interval,
            arguments.cancel_fallback,
            arguments.manifest_dir,
            kernel_id_override=arguments.kernel_id,
            dataset_handle_override=arguments.dataset_handle,
        )
    except KeyboardInterrupt:
        print("Kaggle inference cancelled.", file=sys.stderr)
        return 130
    except (
        OSError,
        json.JSONDecodeError,
        subprocess.TimeoutExpired,
        TimeoutError,
        ValueError,
        RuntimeError,
    ) as error:
        print(f"Kaggle inference failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
