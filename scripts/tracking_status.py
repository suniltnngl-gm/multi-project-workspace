#!/usr/bin/env python3
# Objective: Report centralized tracking counts for the workspace.
# Requirements: Read tracking tables without modifying them.
# Decisions: Use SQLite read-only queries for a status summary.
# Relevant Files: scripts/tracking_status.py
# Important Context: User file. Vendor and transient artifacts are excluded from tracking.
# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import os
import sqlite3
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT_DIR / "apps" / "api" / "data" / "workspace.sqlite"

TABLES = [
    "tasks",
    "user_files",
    "folders",
    "git_worktrees",
    "tools",
    "environments",
]


def main():
    database = os.environ.get("DATABASE_PATH", str(DEFAULT_DB))
    path = Path(database)
    if not path.exists():
        print(f"Database not found: {path}")
        raise SystemExit(1)
    connection = sqlite3.connect(path)
    for table in TABLES:
        try:
            count = connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            print(f"{table}: {count}")
        except sqlite3.Error:
            print(f"{table}: unavailable")
    connection.close()


if __name__ == "__main__":
    main()