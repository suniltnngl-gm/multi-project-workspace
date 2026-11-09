# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.

import json
import os
import sqlite3
import sys
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[3] / ".env")


DEFAULT_DATABASE_PATH = (
    Path(__file__).resolve().parents[2] / "api" / "data" / "workspace.sqlite"
)


def create_handler(database_path):
    class SatelliteHandler(BaseHTTPRequestHandler):
        def send_json(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/health":
                try:
                    self.read_summary()
                except (OSError, sqlite3.Error) as error:
                    print(f"Python satellite database check failed: {error}", file=sys.stderr)
                    self.send_json(
                        503,
                        {"status": "unavailable", "service": "python-satellite"},
                    )
                    return
                self.send_json(
                    200,
                    {
                        "status": "ok",
                        "service": "python-satellite",
                        "database": "sqlite",
                    },
                )
                return

            if path == "/summary":
                try:
                    summary = self.read_summary()
                except (OSError, sqlite3.Error) as error:
                    print(f"Python satellite summary failed: {error}", file=sys.stderr)
                    self.send_json(
                        503,
                        {"error": "SQLite task store is unavailable."},
                    )
                    return
                self.send_json(200, summary)
                return

            self.send_json(404, {"error": "Not found."})

        def read_summary(self):
            if not database_path.is_file():
                raise OSError(f"Database file does not exist: {database_path}")
            database_uri = f"{database_path.resolve().as_uri()}?mode=ro"
            with closing(sqlite3.connect(database_uri, uri=True, timeout=5)) as connection:
                row = connection.execute(
                    """
                    SELECT
                      COUNT(*) AS total,
                      COALESCE(SUM(CASE WHEN completed = 0 THEN 1 ELSE 0 END), 0) AS open,
                      COALESCE(SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END), 0) AS completed
                    FROM tasks
                    """
                ).fetchone()
            return {"total": row[0], "open": row[1], "completed": row[2]}

        def log_message(self, format_string, *args):
            print(f"Python satellite: {format_string % args}")

    return SatelliteHandler


def main():
    database_path = Path(
        os.environ.get("DATABASE_PATH", str(DEFAULT_DATABASE_PATH))
    ).expanduser()
    port = int(os.environ.get("PYTHON_PORT", "3002"))
    host = os.environ.get("HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), create_handler(database_path))
    print(f"Python satellite listening on http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
