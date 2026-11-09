# Objective: Implement and maintain this Python module.
# Requirements: Keep behavior aligned with tests and documented APIs.
# Decisions: Follow existing repository conventions.
# Relevant Files: apps/python/tests/test_server.py
# Important Context: User file. Vendor and transient artifacts are excluded from tracking.
# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.

import json
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

from server import create_handler


class SatelliteServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temporary_directory.name) / "tasks.sqlite"
        with closing(sqlite3.connect(self.database_path)) as connection:
            with connection:
                connection.execute(
                    """
                    CREATE TABLE tasks (
                        id INTEGER PRIMARY KEY,
                        title TEXT NOT NULL,
                        description TEXT NOT NULL DEFAULT '',
                        completed INTEGER NOT NULL DEFAULT 0
                    )
                    """
                )
                connection.executemany(
                    "INSERT INTO tasks (title, completed) VALUES (?, ?)",
                    [("open task", 0), ("finished task", 1), ("another open task", 0)],
                )

        self.server = ThreadingHTTPServer(
            ("127.0.0.1", 0), create_handler(self.database_path)
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary_directory.cleanup()

    def test_summary_reads_shared_sqlite_tasks(self):
        with urlopen(f"{self.base_url}/summary") as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(
                json.load(response),
                {"total": 3, "open": 2, "completed": 1},
            )

    def test_health_and_unknown_route(self):
        with urlopen(f"{self.base_url}/health") as response:
            health = json.load(response)
            self.assertEqual(health["service"], "python-satellite")
            self.assertEqual(health["database"], "sqlite")

        with self.assertRaises(HTTPError) as error:
            urlopen(f"{self.base_url}/missing")
        self.assertEqual(error.exception.code, 404)
        error.exception.close()

    def test_summary_reports_missing_database(self):
        missing_path = self.database_path.parent / "missing.sqlite"
        server = ThreadingHTTPServer(
            ("127.0.0.1", 0), create_handler(missing_path)
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with self.assertRaises(HTTPError) as error:
                urlopen(f"http://127.0.0.1:{server.server_port}/summary")
            self.assertEqual(error.exception.code, 503)
            payload = json.load(error.exception)
            self.assertIn("SQLite task store is unavailable", payload["error"])
            error.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
