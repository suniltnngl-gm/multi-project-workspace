#!/usr/bin/env python3
# Objective: Scan and centrally track runtime environment facts in SQLite.
# Requirements: Capture OS, architecture, and runtime versions without storing secrets.
# Decisions: Store only non-sensitive environment facts.
# Relevant Files: scripts/scan_environments.py
# Important Context: User file. Vendor and transient artifacts are excluded from tracking.
# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import argparse
import os
import platform
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT_DIR / "apps" / "api" / "data" / "workspace.sqlite"


def connect(database):
    path = Path(database)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS environments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          value TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT '',
          checked_at TEXT NOT NULL
        )
        """
    )
    connection.commit()
    return connection


def command_version(command):
    try:
        output = subprocess.check_output([command, "--version"], text=True, stderr=subprocess.STDOUT)
        return output.strip().splitlines()[0] if output.strip() else ""
    except Exception:
        return ""


def collect_entries():
    import sys as _sys
    return [
        {"name": "os", "value": platform.system(), "source": "platform.system"},
        {"name": "release", "value": platform.release(), "source": "platform.release"},
        {"name": "architecture", "value": platform.machine(), "source": "platform.machine"},
        {"name": "python", "value": _sys.version.split()[0], "source": "sys.version"},
        {"name": "node", "value": command_version("node"), "source": "node --version"},
        {"name": "npm", "value": command_version("npm"), "source": "npm --version"},
        {"name": "uv", "value": command_version("uv"), "source": "uv --version"},
        {"name": "git", "value": command_version("git"), "source": "git --version"},
        {"name": "cwd", "value": os.getcwd(), "source": "os.getcwd"},
    ]


def scan(connection, entries):
    import datetime
    now = datetime.datetime.now().isoformat(timespec="seconds")
    for entry in entries:
        connection.execute(
            """
            INSERT INTO environments (name, value, source, checked_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
              value = excluded.value,
              source = excluded.source,
              checked_at = excluded.checked_at
            """,
            (entry["name"], entry["value"], entry["source"], now),
        )
    connection.commit()
    return len(entries)


def main():
    parser = argparse.ArgumentParser(description="Track runtime environment")
    parser.add_argument("command", choices=("scan", "list", "check"))
    parser.add_argument("--database", default=os.environ.get("DATABASE_PATH", str(DEFAULT_DB)))
    args = parser.parse_args()

    connection = connect(args.database)
    entries = collect_entries()

    if args.command == "scan":
        count = scan(connection, entries)
        print(f"Scanned {count} environment facts.")
    elif args.command == "list":
        rows = connection.execute("SELECT name, value, source FROM environments ORDER BY name").fetchall()
        for row in rows:
            print(" | ".join(str(value) for value in row))
        print(f"Total: {len(rows)}", file=sys.stderr)
    elif args.command == "check":
        rows = connection.execute("SELECT name, value FROM environments").fetchall()
        empty = [name for name, value in rows if not value]
        if empty:
            print("Missing environment values:")
            for name in empty:
                print(f"  {name}")
            raise SystemExit(1)
        print(f"All {len(rows)} environment facts are populated.")

    connection.close()


if __name__ == "__main__":
    main()