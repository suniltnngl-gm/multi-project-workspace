#!/usr/bin/env bash
set -e

# Create task and capture ID
TASK_OUTPUT=$(./workspace task create "Publish SP-003")
# Extract the last word as ID (adjust if output format differs)
TASK_ID=$(echo "$TASK_OUTPUT" | awk '{print $NF}')
echo "Created task ID: $TASK_ID"

# Stage specific files
git add apps/api/src/toolchain/dispatch/session-pool-dispatcher.js \
    apps/api/src/toolchain/dispatch/session-health.js \
    apps/api/src/toolchain/dispatch/provider-availability.js \
    apps/api/src/toolchain/dispatch/idempotency.js \
    apps/api/src/toolchain/dispatch/portability.js \
    apps/api/src/toolchain/schemas/session-pool-dispatch.v1.1.schema.json \
    scripts/swarm-session-plan.mjs \
    apps/api/test/toolchain/session-pool-dispatcher-sp003.test.js

# Commit
git commit -m 'feat(toolchain): add SP-003 session health, provider availability, and intelligent fallback'

# Push
git push origin master

# Verify git status shows only untracked reports/
git status --short

# Get full commit SHA
SHA=$(git rev-parse HEAD)
echo "Commit SHA: $SHA"

# Get the CI run ID for this commit
RUN_ID=$(gh run list --branch master --commit "$SHA" --limit 1 --json databaseId -q '.[0].databaseId')
echo "CI Run ID: $RUN_ID"

# Watch the CI run until it finishes
gh run watch "$RUN_ID" --exit-status

# Get conclusion
CONCLUSION=$(gh run view "$RUN_ID" --json conclusion -q '.[0].conclusion')
echo "Conclusion: $CONCLUSION"

# Mark task as done with notes
./workspace task done "$TASK_ID" --notes "Commit SHA: $SHA, CI Run ID: $RUN_ID, Conclusion: $CONCLUSION"
