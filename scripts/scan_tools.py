#!/usr/bin/env python3
# Objective: Scan and centrally track installed workflow tools in SQLite.
# Requirements: Capture command availability and version for core workspace tools.
# Decisions: Use command -v and --version with graceful fallbacks.
# Relevant Files: scripts/scan_tools.py
# Important Context: User file. Vendor and transient artifacts are excluded from tracking.
# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import argparse
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

from paths import resolve_database_path

TOOLS = [
    ("node", "node"),
    ("npm", "npm"),
    ("uv", "uv"),
    ("python", next((candidate for candidate in ("python3", "python") if shutil.which(candidate)), sys.executable)),
    ("git", "git"),
    ("colab", "colab"),
    ("kaggle", "kaggle"),
    ("opencode", "opencode"),
    ("agy", "agy"),
]

REQUIRED_TOOLS = {"node", "npm", "uv", "python", "git"}


def connect(database):
    path = Path(database)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS tools (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          command TEXT NOT NULL,
          version TEXT NOT NULL DEFAULT '',
          available INTEGER NOT NULL DEFAULT 0,
          success_count INTEGER NOT NULL DEFAULT 0,
          failure_count INTEGER NOT NULL DEFAULT 0,
          checked_at TEXT NOT NULL
        )
        """
    )
    connection.commit()
    return connection


def tool_version(command):
    resolved = shutil.which(command)
    if resolved is None:
        return False, ""
    try:
        output = subprocess.check_output([resolved, "--version"], text=True, stderr=subprocess.STDOUT)
        return True, output.strip().splitlines()[0] if output.strip() else ""
    except Exception:
        return True, ""


def scan(connection):
    import datetime
    now = datetime.datetime.now().isoformat(timespec="seconds")
    for name, command in TOOLS:
        available, version = tool_version(command)
        available_flag = 1 if available else 0
        connection.execute(
            """
            INSERT INTO tools (name, command, version, available, success_count, failure_count, checked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
              command = excluded.command,
              version = excluded.version,
              available = excluded.available,
              success_count = tools.success_count + excluded.success_count,
              failure_count = tools.failure_count + excluded.failure_count,
              checked_at = excluded.checked_at
            """,
            (name, command, version, available_flag, available_flag, 0 if available else 1, now),
        )
    connection.commit()
    return len(TOOLS)


def main():
    parser = argparse.ArgumentParser(description="Track workflow tools")
    parser.add_argument("command", choices=("scan", "list", "check"))
    parser.add_argument("--database", default=None)
    args = parser.parse_args()

    connection = connect(resolve_database_path(args.database))

    if args.command == "scan":
        count = scan(connection)
        print(f"Scanned {count} tools.")
    elif args.command == "list":
        rows = connection.execute("SELECT name, command, version, available FROM tools ORDER BY name").fetchall()
        for row in rows:
            print(" | ".join(str(value) for value in row))
        print(f"Total: {len(rows)}", file=sys.stderr)
    elif args.command == "check":
        rows = connection.execute("SELECT name, available FROM tools").fetchall()
        missing = [name for name, available in rows if not available]
        missing_required = [name for name in missing if name in REQUIRED_TOOLS]
        missing_optional = [name for name in missing if name not in REQUIRED_TOOLS]
        if missing_optional:
            print("Optional tools unavailable:")
            for name in missing_optional:
                print(f"  {name}")
        if missing_required:
            print("Unavailable required tools:")
            for name in missing_required:
                print(f"  {name}")
            raise SystemExit(1)
        available_count = len(rows) - len(missing)
        print(f"All {len(REQUIRED_TOOLS)} required tools are available ({available_count}/{len(rows)} tracked tools present).")

    connection.close()


if __name__ == "__main__":
    main()