#!/usr/bin/env python3
# Objective: Report centralized tracking counts for the workspace.
# Requirements: Read tracking tables without modifying them.
# Decisions: Use SQLite read-only queries for a status summary.
# Relevant Files: scripts/tracking_status.py
# Important Context: User file. Vendor and transient artifacts are excluded from tracking.
# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import sqlite3
import sys

from paths import resolve_database_path

TABLES = [
    "tasks",
    "user_files",
    "folders",
    "git_worktrees",
    "tools",
    "environments",
]


def main():
    path = resolve_database_path()
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