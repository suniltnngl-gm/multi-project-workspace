#!/usr/bin/env python3
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


ROOT_DIR = Path(__file__).resolve().parents[1]
NOTEBOOK_PATH = ROOT_DIR / "notebooks" / "kaggle-qwen-coder.ipynb"
METADATA_PATH = ROOT_DIR / "notebooks" / "kernel-metadata.json"
REQUIRED_TASK_FIELDS = (
    "title",
    "project",
    "task_type",
)


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
    for field in ("description", "acceptance_criteria"):
        if task.get(field) is None:
            task[field] = ""
    return task


def prepare_run_directory(task, run_dir):
    with NOTEBOOK_PATH.open(encoding="utf-8") as notebook_file:
        notebook = json.load(notebook_file)
    with METADATA_PATH.open(encoding="utf-8") as metadata_file:
        metadata = json.load(metadata_file)

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
    shutil.copyfile(METADATA_PATH, metadata_target)
    return metadata["id"], notebook_target


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


def execute(task, output_path, timeout_seconds, poll_interval, cancel_fallback="none"):
    if shutil.which("kaggle") is None:
        raise FileNotFoundError(
            "Kaggle CLI is required. Install it and configure your Kaggle API credentials."
        )

    with tempfile.TemporaryDirectory(prefix="kaggle-qwen-run-") as temporary_dir:
        kernel_id, _ = prepare_run_directory(task, Path(temporary_dir))
        try:
            print(f"Submitting one private Kaggle notebook run: {kernel_id}", flush=True)
            print(
                run_kaggle(
                    ["kaggle", "kernels", "push", "-p", temporary_dir],
                    timeout=180,
                ),
                flush=True,
            )
            wait_for_completion(kernel_id, timeout_seconds, poll_interval)

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
        except BaseException:
            # A timed-out or interrupted runner must not leave the kernel
            # consuming queue space or GPU time.
            cancel_kernel(kernel_id, cancel_fallback)
            raise

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(response, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
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
        help="JSON object with title, project, task_type, description, and acceptance_criteria",
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
