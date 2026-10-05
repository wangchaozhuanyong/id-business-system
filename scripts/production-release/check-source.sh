#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ "$EXPECTED_CURRENT" =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ "$GITHUB_REF" == refs/heads/main ]] || exit 1
[[ "$(git rev-parse HEAD)" == "$RELEASE_COMMIT" ]] || exit 1
[[ "$(git ls-remote origin refs/heads/main | cut -f1)" == "$RELEASE_COMMIT" ]] || exit 1

quality_run_id="$(gh run list --repo "$GITHUB_REPOSITORY" --workflow quality.yml \
  --commit "$RELEASE_COMMIT" --limit 20 \
  --json databaseId,headSha,event,status,conclusion \
  --jq '[.[] | select(.headSha == env.RELEASE_COMMIT and .event == "push" and .status == "completed" and .conclusion == "success") | .databaseId] | first')"
[[ "$quality_run_id" =~ ^[1-9][0-9]*$ ]] || exit 1
echo "QUALITY_RUN_ID=$quality_run_id" >> "$GITHUB_ENV"
echo "SOURCE_TREE=$(git rev-parse 'HEAD^{tree}')" >> "$GITHUB_ENV"
echo "Source and main Quality Gate verified: $RELEASE_COMMIT"
