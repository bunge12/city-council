#!/usr/bin/env bash
# Creates one GitHub issue per file in docs/milestones/<milestone>-issues/.
# Usage: scripts/create-issues.sh M0
# Needs the gh CLI, signed in, run from the repo root.
set -euo pipefail
milestone="${1:?usage: scripts/create-issues.sh M0}"
dir="docs/milestones/${milestone}-issues"
gh label create "$milestone" 2>/dev/null || true
for f in "$dir"/*.md; do
  title="$(head -n 1 "$f" | sed 's/^# //')"
  tail -n +3 "$f" | gh issue create --title "$title" --label "$milestone" --body-file -
done
