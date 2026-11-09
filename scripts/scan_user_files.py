#!/usr/bin/env python3
# Objective: Scan and centrally track user files in SQLite.
# Requirements: Exclude vendor and transient paths; support scan, list, and check commands.
# Decisions: Use Python's standard sqlite3 module for dependency-free tracking.
# Relevant Files: scripts/scan_user_files.py
# Important Context: User file. Vendor and transient artifacts are excluded from tracking.
# Work State: Completed: Implemented; Active: None; Blocked: None; Next Move: Maintain as needed.
import argparse
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT_DIR / "apps" / "api" / "data" / "workspace.sqlite"
NOISE_PREFIXES = (
    "node_modules/",
    "apps/python/.venv/",
    "apps/web/dist/",
    "apps/api/data/",
    ".git/",
)
ALLOWED_EXTENSIONS = {
    ".js", ".mjs", ".py", ".css", ".html", ".md", ".yml", ".yaml"
}


def user_file(path):
    normalized = path.replace("\\", "/")
    if any(normalized.startswith(prefix) for prefix in NOISE_PREFIXES):
        return False
    if "__pycache__" in normalized.split("/"):
        return False
    extension = Path(normalized).suffix.lower()
    return extension in ALLOWED_EXTENSIONS


NOISE_DIRECTORIES = {
    "node_modules", ".venv", "dist", ".git", "__pycache__",
    ".pytest_cache", "data",
}


def tracked_files():
    result = []
    for dirpath, dirnames, filenames in os.walk(ROOT_DIR):
        dirnames[:] = [
            name for name in dirnames
            if name not in NOISE_DIRECTORIES
            and not (name.startswith(".") and name != ".github")
        ]
        for name in filenames:
            full_path = Path(dirpath) / name
            relative = full_path.relative_to(ROOT_DIR).as_posix()
            if user_file(relative):
                result.append(relative)
    return sorted(set(result))


def connect(database):
    path = Path(database)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS user_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL UNIQUE,
          objective TEXT NOT NULL DEFAULT '',
          requirements TEXT NOT NULL DEFAULT '',
          decisions TEXT NOT NULL DEFAULT '',
          relevant_files TEXT NOT NULL DEFAULT '',
          important_context TEXT NOT NULL DEFAULT '',
          work_completed TEXT NOT NULL DEFAULT '',
          work_active TEXT NOT NULL DEFAULT '',
          work_blocked TEXT NOT NULL DEFAULT '',
          next_move TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    connection.commit()
    return connection


def scan(connection, files):
    now = __import__("datetime").datetime.now().isoformat(timespec="seconds")
    inserted = 0
    existing = {row[0] for row in connection.execute("SELECT path FROM user_files")}
    for path in files:
        if path in existing:
            continue
        connection.execute(
            "INSERT INTO user_files (path, created_at, updated_at) VALUES (?, ?, ?)",
            (path, now, now),
        )
        inserted += 1
    connection.commit()
    return inserted, len(files) - inserted, len(files)


def main():
    parser = argparse.ArgumentParser(description="Centralized user-file tracking")
    parser.add_argument("command", choices=("scan", "list", "check"))
    parser.add_argument("--database", default=os.environ.get("DATABASE_PATH", str(DEFAULT_DB)))
    args = parser.parse_args()

    files = tracked_files()
    connection = connect(args.database)

    if args.command == "scan":
        inserted, existing, total = scan(connection, files)
        print(f"Scanned {total} user files: {inserted} inserted, {existing} already tracked.")
    elif args.command == "list":
        rows = connection.execute("SELECT path FROM user_files ORDER BY path").fetchall()
        for (path,) in rows:
            print(path)
        print(f"Total: {len(rows)}", file=sys.stderr)
    elif args.command == "check":
        tracked = {row[0] for row in connection.execute("SELECT path FROM user_files")}
        missing = [path for path in files if path not in tracked]
        if missing:
            print("Missing tracked user files:")
            for path in missing:
                print(f"  {path}")
            raise SystemExit(1)
        print(f"All {len(files)} user files are tracked.")

    connection.close()


if __name__ == "__main__":
    main()