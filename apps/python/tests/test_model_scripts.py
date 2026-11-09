import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock


ROOT_DIR = Path(__file__).resolve().parents[3]
SERVER_PATH = ROOT_DIR / "scripts" / "colab_model_server.py"
CLIENT_PATH = ROOT_DIR / "scripts" / "colab_model_client.py"
KAGGLE_PATH = ROOT_DIR / "scripts" / "kaggle_run.py"
RESULT_SENTINEL = "__WORKSPACE_MODEL_RESULT__"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def sample_task():
    return {
        "title": "Draft a task",
        "project": "workspace",
        "task_type": "feature",
        "description": "",
        "acceptance_criteria": "",
    }


def valid_response():
    return json.dumps(
        {"description": "draft", "acceptance_criteria": "done"}
    )


class ModelScriptTests(unittest.TestCase):
    def test_scripts_compile(self):
        for path in (SERVER_PATH, CLIENT_PATH, KAGGLE_PATH):
            with self.subTest(path=path.name):
                compile(path.read_text(encoding="utf-8"), str(path), "exec")

    def test_kaggle_task_allows_optional_description_and_criteria(self):
        module = load_module("kaggle_run_optional", KAGGLE_PATH)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "task.json"
            path.write_text(
                json.dumps(
                    {
                        "title": "Draft a task",
                        "project": "workspace",
                        "task_type": "feature",
                    }
                ),
                encoding="utf-8",
            )
            task = module.load_task(path)

        self.assertEqual(task["description"], "")
        self.assertEqual(task["acceptance_criteria"], "")

    def test_kaggle_task_requires_title_project_and_type(self):
        module = load_module("kaggle_run_required", KAGGLE_PATH)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "task.json"
            path.write_text(json.dumps({"title": "Draft a task"}), encoding="utf-8")
            with self.assertRaises(ValueError) as caught:
                module.load_task(path)

        self.assertIn("project", str(caught.exception))
        self.assertIn("task_type", str(caught.exception))

    def test_kaggle_timeout_attempts_to_cancel_the_kernel(self):
        module = load_module("kaggle_run_timeout_cancel", KAGGLE_PATH)
        task = {
            "title": "Draft a task",
            "project": "workspace",
            "task_type": "feature",
            "description": "",
            "acceptance_criteria": "",
        }
        cancelled = []

        def fake_run_kaggle(arguments, timeout=60):
            if arguments[:3] == ["kaggle", "kernels", "status"]:
                return "KernelWorkerStatus.QUEUED"
            return "submitted"

        def fake_cancel(kernel_id, fallback="none"):
            cancelled.append((kernel_id, fallback))
            return True

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "response.json"
            with mock.patch.object(
                module, "run_kaggle", side_effect=fake_run_kaggle
            ), mock.patch.object(
                module, "cancel_kernel", side_effect=fake_cancel
            ), mock.patch.object(
                module.shutil, "which", return_value="/usr/bin/kaggle"
            ):
                with self.assertRaises(TimeoutError):
                    module.execute(task, output, 0, 1, "delete")

        self.assertEqual(
            cancelled, [("edmundrosariosunil/kaggle-qwen-coder", "delete")]
        )

    def test_kaggle_success_does_not_cancel_the_kernel(self):
        module = load_module("kaggle_run_success", KAGGLE_PATH)
        task = {
            "title": "Draft a task",
            "project": "workspace",
            "task_type": "feature",
            "description": "",
            "acceptance_criteria": "",
        }
        cancelled = []

        def fake_run_kaggle(arguments, timeout=60):
            if arguments[:3] == ["kaggle", "kernels", "status"]:
                return "KernelWorkerStatus.COMPLETE"
            if arguments[:3] == ["kaggle", "kernels", "output"]:
                output_dir = Path(arguments[arguments.index("-p") + 1])
                (output_dir / "response.json").write_text(
                    json.dumps(
                        {"description": "draft", "acceptance_criteria": "done"}
                    ),
                    encoding="utf-8",
                )
            return "ok"

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "response.json"
            with mock.patch.object(
                module, "run_kaggle", side_effect=fake_run_kaggle
            ), mock.patch.object(
                module,
                "cancel_kernel",
                side_effect=lambda kernel_id, fallback="none": cancelled.append(
                    (kernel_id, fallback)
                ),
            ), mock.patch.object(
                module.shutil, "which", return_value="/usr/bin/kaggle"
            ):
                module.execute(task, output, 30, 1)

            self.assertEqual(json.loads(output.read_text()), {
                "description": "draft",
                "acceptance_criteria": "done",
            })

        self.assertEqual(cancelled, [])

    def test_kaggle_output_download_filters_to_response_json(self):
        module = load_module("kaggle_run_output_filter", KAGGLE_PATH)
        task = {
            "title": "Draft a task",
            "project": "workspace",
            "task_type": "feature",
            "description": "",
            "acceptance_criteria": "",
        }
        output_commands = []

        def fake_run_kaggle(arguments, timeout=60):
            if arguments[:3] == ["kaggle", "kernels", "status"]:
                return "KernelWorkerStatus.COMPLETE"
            if arguments[:3] == ["kaggle", "kernels", "output"]:
                output_commands.append(arguments)
                output_dir = Path(arguments[arguments.index("-p") + 1])
                (output_dir / "response.json").write_text(
                    json.dumps(
                        {"description": "draft", "acceptance_criteria": "done"}
                    ),
                    encoding="utf-8",
                )
            return "ok"

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "response.json"
            with mock.patch.object(
                module, "run_kaggle", side_effect=fake_run_kaggle
            ), mock.patch.object(
                module.shutil, "which", return_value="/usr/bin/kaggle"
            ):
                module.execute(task, output, 30, 1)

        self.assertEqual(len(output_commands), 1)
        command = output_commands[0]
        self.assertIn("--file-pattern", command)
        self.assertEqual(
            command[command.index("--file-pattern") + 1],
            r"response\.json$",
        )

    def _execute_with_fake_kaggle(
        self, module, statuses, output_writer=None, which="/usr/bin/kaggle"
    ):
        """Patch the Kaggle CLI surface and record the commands execute() runs."""
        recorder = []
        cancelled = []
        staged = {}

        def fake_run_kaggle(arguments, timeout=60):
            recorder.append((list(arguments), timeout))
            if arguments[:3] == ["kaggle", "kernels", "push"]:
                directory = Path(arguments[arguments.index("-p") + 1])
                staged["files"] = sorted(path.name for path in directory.iterdir())
                return "submitted"
            if arguments[:3] == ["kaggle", "kernels", "status"]:
                return next(statuses)
            if arguments[:3] == ["kaggle", "kernels", "output"] and output_writer:
                output_writer(Path(arguments[arguments.index("-p") + 1]))
            return "ok"

        def fake_cancel(kernel_id, fallback="none"):
            cancelled.append((kernel_id, fallback))
            return True

        patches = [
            mock.patch.object(module.shutil, "which", return_value=which),
            mock.patch.object(module, "run_kaggle", side_effect=fake_run_kaggle),
            mock.patch.object(module, "cancel_kernel", side_effect=fake_cancel),
        ]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        return recorder, cancelled, staged

    def test_execute_runs_push_status_output_in_order(self):
        module = load_module("kaggle_run_execute_order", KAGGLE_PATH)
        recorder, cancelled, staged = self._execute_with_fake_kaggle(
            module,
            iter(["KernelWorkerStatus.COMPLETE"]),
            lambda output_dir: (output_dir / "response.json").write_text(
                valid_response(), encoding="utf-8"
            ),
        )

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "kaggle-output" / "response.json"
            module.execute(sample_task(), output, 30, 1)
            self.assertEqual(
                json.loads(output.read_text()),
                {"description": "draft", "acceptance_criteria": "done"},
            )

        self.assertEqual(
            [command[2] for command, _ in recorder],
            ["push", "status", "output"],
        )

        push, push_timeout = recorder[0]
        self.assertEqual(push[:4], ["kaggle", "kernels", "push", "-p"])
        self.assertEqual(push_timeout, 180)
        self.assertEqual(
            staged["files"],
            ["kaggle-qwen-coder.ipynb", "kernel-metadata.json"],
        )

        status, status_timeout = recorder[1]
        self.assertEqual(status[:3], ["kaggle", "kernels", "status"])
        self.assertEqual(status_timeout, 60)

        download, download_timeout = recorder[2]
        self.assertEqual(download[:3], ["kaggle", "kernels", "output"])
        self.assertIn("--file-pattern", download)
        self.assertEqual(
            download[download.index("--file-pattern") + 1],
            r"response\.json$",
        )
        self.assertEqual(download_timeout, 180)
        self.assertEqual(cancelled, [])

    def test_execute_requires_the_kaggle_cli(self):
        module = load_module("kaggle_run_missing_cli", KAGGLE_PATH)
        recorder, cancelled, _ = self._execute_with_fake_kaggle(
            module, iter([]), which=None
        )

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "response.json"
            with self.assertRaises(FileNotFoundError):
                module.execute(sample_task(), output, 30, 1)
            self.assertFalse(output.exists())

        self.assertEqual(recorder, [])
        self.assertEqual(cancelled, [])

    def test_execute_aborts_before_output_when_kernel_fails(self):
        module = load_module("kaggle_run_execute_error", KAGGLE_PATH)
        recorder, cancelled, _ = self._execute_with_fake_kaggle(
            module, iter(["KernelWorkerStatus.ERROR"])
        )

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "response.json"
            with self.assertRaises(RuntimeError):
                module.execute(sample_task(), output, 30, 1)
            self.assertFalse(output.exists())

        self.assertEqual(
            [command[2] for command, _ in recorder], ["push", "status"]
        )
        self.assertEqual(
            cancelled, [("edmundrosariosunil/kaggle-qwen-coder", "none")]
        )

    def test_execute_rejects_a_missing_response_json(self):
        module = load_module("kaggle_run_missing_response", KAGGLE_PATH)
        recorder, cancelled, _ = self._execute_with_fake_kaggle(
            module, iter(["KernelWorkerStatus.COMPLETE"])
        )

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "response.json"
            with self.assertRaises(FileNotFoundError) as caught:
                module.execute(sample_task(), output, 30, 1)
            self.assertFalse(output.exists())

        self.assertIn("Expected one response.json", str(caught.exception))
        self.assertEqual(
            [command[2] for command, _ in recorder],
            ["push", "status", "output"],
        )
        self.assertEqual(
            cancelled, [("edmundrosariosunil/kaggle-qwen-coder", "none")]
        )

    def test_execute_rejects_multiple_response_json_files(self):
        module = load_module("kaggle_run_multiple_response", KAGGLE_PATH)

        def write_duplicates(output_dir):
            for name in ("first", "second"):
                nested = output_dir / name
                nested.mkdir()
                (nested / "response.json").write_text(
                    valid_response(), encoding="utf-8"
                )

        _, cancelled, _ = self._execute_with_fake_kaggle(
            module,
            iter(["KernelWorkerStatus.COMPLETE"]),
            write_duplicates,
        )

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "response.json"
            with self.assertRaises(FileNotFoundError) as caught:
                module.execute(sample_task(), output, 30, 1)
            self.assertFalse(output.exists())

        self.assertIn("Expected one response.json", str(caught.exception))
        self.assertIn("first/response.json", str(caught.exception))
        self.assertIn("second/response.json", str(caught.exception))
        self.assertEqual(
            cancelled, [("edmundrosariosunil/kaggle-qwen-coder", "none")]
        )

    def test_execute_rejects_invalid_response_payloads(self):
        cases = {
            "malformed": ("{", json.JSONDecodeError),
            "schema": (json.dumps({"description": "draft"}), ValueError),
        }

        for name, (payload, expected) in cases.items():
            with self.subTest(name=name):
                module = load_module(f"kaggle_run_invalid_{name}", KAGGLE_PATH)
                _, cancelled, _ = self._execute_with_fake_kaggle(
                    module,
                    iter(["KernelWorkerStatus.COMPLETE"]),
                    lambda output_dir, payload=payload: (
                        output_dir / "response.json"
                    ).write_text(payload, encoding="utf-8"),
                )

                with tempfile.TemporaryDirectory() as directory:
                    output = Path(directory) / "response.json"
                    with self.assertRaises(expected):
                        module.execute(sample_task(), output, 30, 1)
                    self.assertFalse(output.exists())

                self.assertEqual(
                    cancelled,
                    [("edmundrosariosunil/kaggle-qwen-coder", "none")],
                )

    def test_kaggle_status_ignores_not_complete_text(self):
        module = load_module("kaggle_run_not_complete", KAGGLE_PATH)
        statuses = iter(
            [
                "KernelWorkerStatus.QUEUED (not complete)",
                "KernelWorkerStatus.COMPLETE",
            ]
        )
        calls = []

        def fake_run_kaggle(arguments, timeout=60):
            calls.append(arguments)
            return next(statuses)

        with mock.patch.object(
            module, "run_kaggle", side_effect=fake_run_kaggle
        ):
            module.wait_for_completion("owner/kernel", 5, 0)

        self.assertEqual(len(calls), 2)

    def test_kaggle_cancel_falls_back_to_delete_only_when_requested(self):
        module = load_module("kaggle_run_cancel_fallback", KAGGLE_PATH)
        calls = []

        class Result:
            def __init__(self, returncode):
                self.returncode = returncode

        def fake_run(arguments, **_kwargs):
            calls.append(arguments)
            return Result(1 if arguments[2] == "cancel" else 0)

        with mock.patch.object(module.subprocess, "run", side_effect=fake_run):
            self.assertTrue(module.cancel_kernel("owner/kernel", "delete"))

        self.assertEqual(calls[0][:3], ["kaggle", "kernels", "cancel"])
        self.assertEqual(calls[1][:3], ["kaggle", "kernels", "delete"])

        calls.clear()
        with mock.patch.object(module.subprocess, "run", side_effect=fake_run):
            self.assertFalse(module.cancel_kernel("owner/kernel", "none"))

        self.assertEqual(len(calls), 1)

    def test_server_bootstraps_only_when_unhealthy(self):
        source = SERVER_PATH.read_text(encoding="utf-8")
        self.assertIn("if not is_healthy():", source)
        self.assertIn("threading.Thread(target=server.serve_forever, daemon=True)", source)
        self.assertIn("WORKSPACE_COLAB_READY", source)
        self.assertIn('os.environ.get("WORKSPACE_MODEL_PORT", "8765")', source)

    def test_server_uses_fp16_4bit_and_warms_up(self):
        source = SERVER_PATH.read_text(encoding="utf-8")
        self.assertIn("bnb_4bit_compute_dtype=torch.float16", source)
        self.assertIn("torch_dtype=torch.float16", source)
        self.assertIn("model.eval()", source)
        self.assertIn("max_new_tokens=1", source)
        self.assertIn("apply_chat_template", source)

    def test_client_requires_a_request_payload(self):
        client = load_module("colab_model_client_missing", CLIENT_PATH)
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {}, clear=True), contextlib.redirect_stderr(stderr):
            self.assertEqual(client.main(), 2)
        self.assertIn("missing request payload", stderr.getvalue())

    def test_client_returns_the_server_result_with_a_sentinel(self):
        received = {}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                received["path"] = self.path
                received["body"] = json.loads(self.rfile.read(length))
                payload = json.dumps(
                    {"choices": [{"message": {"content": "draft"}}]}
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = load_module("colab_model_client_request", CLIENT_PATH)
            client.PORT = server.server_address[1]
            request = {
                "messages": [{"role": "user", "content": "Draft a task"}],
                "max_tokens": 120,
            }
            encoded = __import__("base64").b64encode(
                json.dumps(request).encode("utf-8")
            ).decode("ascii")
            stdout = io.StringIO()
            with mock.patch.dict(
                os.environ,
                {
                    "WORKSPACE_MODEL_PORT": str(server.server_address[1]),
                    "WORKSPACE_MODEL_REQUEST": encoded,
                },
                clear=True,
            ), contextlib.redirect_stdout(stdout):
                self.assertEqual(client.main(), 0)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

        self.assertEqual(received["path"], "/v1/chat/completions")
        self.assertEqual(received["body"], request)
        output = stdout.getvalue()
        self.assertTrue(output.startswith(RESULT_SENTINEL))
        result = json.loads(output[len(RESULT_SENTINEL):])
        self.assertEqual(result["choices"][0]["message"]["content"], "draft")


if __name__ == "__main__":
    unittest.main()
