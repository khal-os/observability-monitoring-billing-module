#!/usr/bin/env bash
# Bumps the LangWatch CONNECTOR version (scripts/connector/version — the
# manifest's `version` source). After bumping, push it to the platform with
# scripts/connector/register.sh.
#
# Usage: scripts/connector/bump-version.sh <major|minor|patch>
set -euo pipefail

PART="${1:?usage: bump-version.sh <major|minor|patch>}"
[[ "$PART" =~ ^(major|minor|patch)$ ]] \
  || { echo "ERROR: '$PART' — expected major, minor or patch"; exit 1; }

FILE="$(cd "$(dirname "$0")" && pwd)/version"

OLD=$(tr -d '[:space:]' <"$FILE")
NEW=$(python3 -c "
import sys
major, minor, patch = (int(x) for x in sys.argv[1].split('.'))
part = sys.argv[2]
if part == 'major': major, minor, patch = major + 1, 0, 0
elif part == 'minor': minor, patch = minor + 1, 0
else: patch += 1
print(f'{major}.{minor}.{patch}')
" "$OLD" "$PART")

echo "$NEW" >"$FILE"
echo "connector version: $OLD → $NEW ($FILE)"
echo "Next: re-register so the platform sees it — scripts/connector/register.sh"
