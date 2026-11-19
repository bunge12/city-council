#!/usr/bin/env bash
# Opens an issue for a workflow run on main that failed, or comments on the
# one already open with the same title, so a failure that repeats does not
# open one issue per run (issue #233). Used by the `report` jobs in ci.yml,
# deploy.yml and nightly.yml.
#
#   scripts/report-failure.sh <title> <label> <label description> <what failed>
#
# <what failed> is the first sentence of the body, such as "CI failed on
# `main`". The script adds the commit, its subject and the run's address.
# It reads GH_TOKEN, GH_REPO, SHA and RUN_URL from the environment, and
# SUBJECT when the checkout has no history to read it from.
set -euo pipefail

title=$1
label=$2
description=$3
what=$4
extra=${5:-}

subject=${SUBJECT:-$(git log -1 --format=%s "$SHA" 2> /dev/null || true)}
body=$(printf '%s at %s, "%s".\n\nRun: %s' "$what" "$SHA" "$subject" "$RUN_URL")
[ -z "$extra" ] || body=$(printf '%s\n\n%s' "$body" "$extra")

# The label marks these issues for whoever triages them. --force makes the
# call a no-op when the label is already there.
gh label create "$label" --color B60205 --description "$description" --force
open=$(gh issue list --state open --search "\"$title\" in:title" --json number --jq '.[0].number')
if [ -n "$open" ]; then
  gh issue comment "$open" --body "$body"
  gh issue edit "$open" --add-label "$label"
else
  gh issue create --title "$title: $subject" --body "$body" --label "$label"
fi
