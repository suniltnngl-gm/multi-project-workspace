#!/usr/bin/env python3
# Objective: Scan and centrally track folders in SQLite.
# Requirements: Exclude vendor and transient paths; support scan, list, and check commands.
# Decisions: Use Python's standard sqlite3 module for dependency-free tracking.
# Relevant Files: scripts/scan_folders.py
# Important Context: User file. Vendor and transient artifacts are excluded from tracking.
# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import argparse
import os
import sqlite3
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT_DIR / "apps" / "api" / "data" / "workspace.sqlite"
NOISE_DIRECTORIES = {
    "node_modules", ".venv", "dist", ".git", "__pycache__",
    ".pytest_cache", "data",
}


def tracked_folders():
    result = []
    for dirpath, dirnames, filenames in os.walk(ROOT_DIR):
        dirnames[:] = [
            name for name in dirnames
            if name not in NOISE_DIRECTORIES
            and not (name.startswith(".") and name != ".github")
        ]
        relative = Path(dirpath).relative_to(ROOT_DIR).as_posix()
        if relative != "." and relative not in ("",):
            result.append(relative)
    return sorted(set(result))


def connect(database):
    path = Path(database)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL UNIQUE,
          objective TEXT NOT NULL DEFAULT '',
          important_context TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    connection.commit()
    return connection


def scan(connection, folders):
    import datetime
    now = datetime.datetime.now().isoformat(timespec="seconds")
    existing = {row[0] for row in connection.execute("SELECT path FROM folders")}
    inserted = 0
    existing_count = 0
    for path in folders:
        if path in existing:
            existing_count += 1
        else:
            connection.execute(
                "INSERT INTO folders (path, created_at, updated_at) VALUES (?, ?, ?)",
                (path, now, now),
            )
            inserted += 1
            existing.add(path)
    connection.commit()
    return inserted, existing_count, len(folders)


def main():
    parser = argparse.ArgumentParser(description="Centralized folder tracking")
    parser.add_argument("command", choices=("scan", "list", "check"))
    parser.add_argument("--database", default=os.environ.get("DATABASE_PATH", str(DEFAULT_DB)))
    args = parser.parse_args()

    folders = tracked_folders()
    connection = connect(args.database)

    if args.command == "scan":
        inserted, existing, total = scan(connection, folders)
        print(f"Scanned {total} folders: {inserted} inserted, {existing} already tracked.")
    elif args.command == "list":
        rows = connection.execute("SELECT path FROM folders ORDER BY path").fetchall()
        for (path,) in rows:
            print(path)
        print(f"Total: {len(rows)}", file=sys.stderr)
    elif args.command == "check":
        tracked = {row[0] for row in connection.execute("SELECT path FROM folders")}
        missing = [path for path in folders if path not in tracked]
        if missing:
            print("Missing tracked folders:")
            for path in missing:
                print(f"  {path}")
            raise SystemExit(1)
        print(f"All {len(folders)} folders are tracked.")

    connection.close()


if __name__ == "__main__":
    main()