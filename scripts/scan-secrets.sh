#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
scanner="${GITLEAKS_BIN:-gitleaks}"
if ! command -v "$scanner" >/dev/null 2>&1; then
  printf 'Install Gitleaks 8.30.1 or newer, or set GITLEAKS_BIN to its executable.
' >&2
  exit 1
fi
case "${1:-history}" in
  staged) exec "$scanner" git --pre-commit --staged --redact=100 --no-banner --ignore-gitleaks-allow . ;;
  history) exec "$scanner" git --log-opts="--all --full-history" --redact=100 --no-banner --ignore-gitleaks-allow . ;;
  *) printf 'Usage: %s [history|staged]
' "$0" >&2; exit 2 ;;
esac
