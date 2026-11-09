#!/usr/bin/env python3
# Objective: Scan and centrally track Git worktrees in SQLite.
# Requirements: Capture repository root, worktree path, branch, HEAD, and remote URL.
# Decisions: Use Git porcelain output for stable parsing.
# Relevant Files: scripts/scan_git_context.py
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


def connect(database):
    path = Path(database)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS git_worktrees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repository_root TEXT NOT NULL,
          worktree_path TEXT NOT NULL UNIQUE,
          branch TEXT NOT NULL DEFAULT '',
          head_commit TEXT NOT NULL DEFAULT '',
          remote_url TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    connection.commit()
    return connection


def git_output(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True)


def collect_entries(root):
    remote_url = ""
    try:
        remote_url = git_output(root, "remote", "get-url", "origin").strip()
    except subprocess.CalledProcessError:
        remote_url = ""
    output = git_output(root, "worktree", "list", "--porcelain")
    entries = []
    current = {}
    for line in output.splitlines():
        if line.startswith("worktree "):
            if current.get("worktree_path"):
                entries.append(current)
            current = {"repository_root": str(root), "worktree_path": line[9:].strip()}
        elif line.startswith("HEAD "):
            current["head_commit"] = line[5:].strip()
        elif line.startswith("branch "):
            current["branch"] = line[7:].strip().replace("refs/heads/", "")
        elif line == "":
            if current.get("worktree_path"):
                entries.append(current)
                current = {}
    if current.get("worktree_path"):
        entries.append(current)
    for entry in entries:
        entry.setdefault("branch", "")
        entry.setdefault("head_commit", "")
        entry["remote_url"] = remote_url
    return entries


def scan(connection, entries):
    import datetime
    now = datetime.datetime.now().isoformat(timespec="seconds")
    for entry in entries:
        connection.execute(
            """
            INSERT INTO git_worktrees
              (repository_root, worktree_path, branch, head_commit, remote_url, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(worktree_path) DO UPDATE SET
              repository_root = excluded.repository_root,
              branch = excluded.branch,
              head_commit = excluded.head_commit,
              remote_url = excluded.remote_url,
              updated_at = excluded.updated_at
            """,
            (
                entry["repository_root"],
                entry["worktree_path"],
                entry["branch"],
                entry["head_commit"],
                entry["remote_url"],
                now,
                now,
            ),
        )
    connection.commit()
    return len(entries)


def main():
    parser = argparse.ArgumentParser(description="Track Git worktrees")
    parser.add_argument("command", choices=("scan", "list", "check"))
    parser.add_argument("--database", default=os.environ.get("DATABASE_PATH", str(DEFAULT_DB)))
    parser.add_argument("--repo", default=".")
    args = parser.parse_args()

    root = Path(args.repo).resolve()
    try:
        root = Path(
            subprocess.check_output(["git", "-C", str(root), "rev-parse", "--show-toplevel"], text=True).strip()
        )
    except subprocess.CalledProcessError:
        print("Not a Git repository.", file=sys.stderr)
        raise SystemExit(1)

    entries = collect_entries(root)
    connection = connect(args.database)

    if args.command == "scan":
        count = scan(connection, entries)
        print(f"Scanned {count} Git worktrees.")
    elif args.command == "list":
        rows = connection.execute(
            "SELECT repository_root, worktree_path, branch, head_commit, remote_url FROM git_worktrees ORDER BY repository_root, worktree_path"
        ).fetchall()
        for row in rows:
            print(" | ".join(row))
        print(f"Total: {len(rows)}", file=sys.stderr)
    elif args.command == "check":
        tracked = {row[0] for row in connection.execute("SELECT worktree_path FROM git_worktrees")}
        missing = [entry["worktree_path"] for entry in entries if entry["worktree_path"] not in tracked]
        if missing:
            print("Missing tracked worktrees:")
            for path in missing:
                print(f"  {path}")
            raise SystemExit(1)
        print(f"All {len(entries)} Git worktrees are tracked.")

    connection.close()


if __name__ == "__main__":
    main()