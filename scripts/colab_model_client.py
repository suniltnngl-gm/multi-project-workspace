# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.

"""Send one chat request to the Colab-hosted model server.

The request is base64-encoded JSON in ``WORKSPACE_MODEL_REQUEST`` so the Colab
CLI can pass it through ``--env`` without touching the remote filesystem.
"""

import base64
import json
import os
import sys
import urllib.request

PORT = int(os.environ.get("WORKSPACE_MODEL_PORT", "8765"))
RESULT_SENTINEL = "__WORKSPACE_MODEL_RESULT__"


def main():
    encoded = os.environ.get("WORKSPACE_MODEL_REQUEST", "")
    if not encoded:
        print("WORKSPACE_MODEL_ERROR: missing request payload", file=sys.stderr)
        return 2

    try:
        request = json.loads(base64.b64decode(encoded))
        body = json.dumps(request).encode("utf-8")
        http_request = urllib.request.Request(
            f"http://127.0.0.1:{PORT}/v1/chat/completions",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(http_request, timeout=840) as response:
            payload = json.loads(response.read())
        print(RESULT_SENTINEL + json.dumps(payload), flush=True)
        return 0
    except Exception as error:  # noqa: BLE001 - report to the API caller
        print(f"WORKSPACE_MODEL_ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
