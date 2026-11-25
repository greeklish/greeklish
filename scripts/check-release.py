#!/usr/bin/env python3
"""Reject private runtime/configuration files in the Git index."""
import argparse
from pathlib import PurePosixPath
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--staged", action="store_true")
args = parser.parse_args()
root = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
command = ["git", "-C", root]
command += (["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
            if args.staged else ["ls-files", "-z"])
paths = subprocess.check_output(command).decode().split("\0")
forbidden_dirs = {".git", ".idea", ".vscode", ".claude", ".agents", ".codex", "node_modules",
                  "target", ".svelte-kit", "build", "dist", "browser-data", "runtime-data",
                  "test-results", "extensions", "__pycache__"}
forbidden_suffixes = {".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".dump", ".db",
                      ".sqlite", ".sqlite3", ".log", ".pyc", ".ovpn"}
errors = []
for raw in filter(None, paths):
    path = PurePosixPath(raw)
    name = path.name.lower()
    if (set(path.parts) & forbidden_dirs
        or (name.startswith(".env") and name != ".env.example")
        or name.endswith(".env")
        or path.suffix.lower() in forbidden_suffixes
        or name.startswith(("id_rsa", "id_ed25519", "id_ecdsa", "credentials", "service-account"))
        or name.endswith(("_handoff.md", ".sql.gz"))
        or name in {".codex", "codex.md", "project_handout.md", ".netrc", ".pypirc"}):
        errors.append(raw)
if errors:
    print("Files unsuitable for a source release:", file=sys.stderr)
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print("Release file check passed.")
