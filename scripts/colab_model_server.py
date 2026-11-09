#!/usr/bin/env python3
"""Start an idempotent OpenAI-compatible model server inside a Colab session.

Run this through ``colab exec -f``. The HTTP server runs on a daemon thread so
the Colab kernel keeps it alive between ``colab exec`` calls.
"""

import json
import os
import subprocess
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("WORKSPACE_MODEL_PORT", "8765"))
MODEL_ID = os.environ.get("WORKSPACE_MODEL_ID", "Qwen/Qwen2.5-Coder-3B-Instruct")
MAX_NEW_TOKENS_LIMIT = 512


def is_healthy():
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{PORT}/health", timeout=2
        ) as response:
            return response.status == 200
    except Exception:
        return False


def install_dependencies():
    subprocess.check_call(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "-q",
            "transformers>=4.45,<5",
            "accelerate",
            "bitsandbytes",
        ]
    )


def load_model():
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        device_map="auto",
        load_in_4bit=True,
    )
    return torch, model, tokenizer


class ModelHandler(BaseHTTPRequestHandler):
    torch = None
    model = None
    tokenizer = None

    def log_message(self, *_args):
        return

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"status": "ok"})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            messages = body.get("messages") or []
            max_tokens = min(
                int(body.get("max_tokens", 300)), MAX_NEW_TOKENS_LIMIT
            )
            text = self.tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
            inputs = self.tokenizer(text, return_tensors="pt").to(
                self.model.device
            )
            with self.torch.inference_mode():
                output = self.model.generate(
                    **inputs,
                    max_new_tokens=max_tokens,
                    do_sample=False,
                    pad_token_id=self.tokenizer.eos_token_id,
                )
            content = self.tokenizer.decode(
                output[0][inputs["input_ids"].shape[1]:],
                skip_special_tokens=True,
            )
            self.send_json(
                200,
                {"choices": [{"message": {"content": content}}]},
            )
        except Exception as error:  # noqa: BLE001 - surface model failures
            self.send_json(500, {"error": str(error)})


if not is_healthy():
    install_dependencies()
    ModelHandler.torch, ModelHandler.model, ModelHandler.tokenizer = load_model()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), ModelHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

print("WORKSPACE_COLAB_READY", flush=True)
