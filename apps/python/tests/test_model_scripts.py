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
            ), mock.patch.object(module, "cancel_kernel", side_effect=fake_cancel):
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
            ):
                module.execute(task, output, 30, 1)

        self.assertEqual(len(output_commands), 1)
        command = output_commands[0]
        self.assertIn("--file-pattern", command)
        self.assertEqual(
            command[command.index("--file-pattern") + 1],
            r"response\.json$",
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
