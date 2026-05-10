#!/usr/bin/env bash
#
# End-to-end smoke tests. Each scenario lives in its own e2e/<scenario>/test.yaml file.
# Per-test sandboxes land at e2e/<scenario>/tmp/{project,home} and are wiped at the start of each run
# so the most recent run's audit log, hashes.yaml, runs/, and per-command log files remain on disk
# for inspection between invocations of this script.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."

cd "$PROJECT_DIR"
bun run bundle >/dev/null 2>&1

PASS=0
FAIL=0
TOTAL=0

while IFS= read -r yaml_file; do
    TOTAL=$((TOTAL + 1))
    if bun run "$SCRIPT_DIR/run-e2e-test.ts" "$yaml_file"; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
done < <(find "$PROJECT_DIR/e2e" -name "test.yaml" | sort)

echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
