#!/usr/bin/env bash
#
# Bundle-integrity smoke tests for the tools-runner Stop hook.
#
# These tests exercise the bundled `plugin/dist/stop-hook.js` directly via `bun`, focusing on the
# error-path contract documented in the hook-behavior table: malformed JSON, empty stdin, and missing
# `CLAUDE_PROJECT_DIR`. They are end-to-end against the production bundle (no source mocks) so they
# also catch bundling regressions.
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

chmod +x "$0"

bun run bundle >/dev/null

HOOK_BUNDLE="$PROJECT_DIR/plugin/dist/stop-hook.js"
PLUGIN_ROOT="$PROJECT_DIR/plugin"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_NAMES=()

# Runs the bundled hook with the given stdin payload, capturing the exit code and stderr.
# Globals set: ACTUAL_EXIT, ACTUAL_STDERR.
# Args: $1 = stdin payload, $2 = "with-project" or "no-project".
run_hook() {
    local stdin_payload="$1"
    local project_mode="$2"
    local tmp_proj
    tmp_proj=$(mktemp -d)
    local tmp_home
    tmp_home=$(mktemp -d)
    local stderr_file
    stderr_file=$(mktemp)
    local stdout_capture_file
    stdout_capture_file=$(mktemp)
    ACTUAL_EXIT=0
    if [ "$project_mode" = "with-project" ]; then
        printf '%s' "$stdin_payload" \
            | env CLAUDE_PROJECT_DIR="$tmp_proj" \
                  CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
                  HOME="$tmp_home" \
                  bun "$HOOK_BUNDLE" >"$stdout_capture_file" 2>"$stderr_file" \
            || ACTUAL_EXIT=$?
    else
        printf '%s' "$stdin_payload" \
            | env -u CLAUDE_PROJECT_DIR \
                  CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
                  HOME="$tmp_home" \
                  bun "$HOOK_BUNDLE" >"$stdout_capture_file" 2>"$stderr_file" \
            || ACTUAL_EXIT=$?
    fi
    ACTUAL_STDERR=$(cat "$stderr_file")
    ACTUAL_STDOUT=$(cat "$stdout_capture_file")
    rm -f "$stderr_file" "$stdout_capture_file"
    rm -rf "$tmp_proj" "$tmp_home"
}

# Asserts that the latest `run_hook` call produced the expected exit code (and, when given,
# an expected stderr substring). Increments the global PASS or FAIL counter.
# Args: $1 = test name, $2 = expected exit, $3 = expected stderr substring (may be empty).
run_test() {
    local test_name="$1"
    local expected_exit="$2"
    local expected_stderr_substring="$3"
    local expected_stdout_substring="${4:-}"
    local pass=1
    if [ "$ACTUAL_EXIT" != "$expected_exit" ]; then
        pass=0
    fi
    if [ -n "$expected_stderr_substring" ]; then
        if ! printf '%s' "$ACTUAL_STDERR" | grep -qF "$expected_stderr_substring"; then
            pass=0
        fi
    fi
    if [ -n "$expected_stdout_substring" ]; then
        if ! printf '%s' "$ACTUAL_STDOUT" | grep -qF "$expected_stdout_substring"; then
            pass=0
        fi
    fi
    if [ "$pass" = "1" ]; then
        echo "PASS: $test_name"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "FAIL: $test_name"
        echo "  expected exit=$expected_exit, got=$ACTUAL_EXIT"
        echo "  expected stderr substring: $expected_stderr_substring"
        echo "  expected stdout substring: $expected_stdout_substring"
        echo "  actual stderr:"
        printf '%s\n' "$ACTUAL_STDERR" | sed 's/^/    /'
        echo "  actual stdout:"
        printf '%s\n' "$ACTUAL_STDOUT" | sed 's/^/    /'
        FAIL_COUNT=$((FAIL_COUNT + 1))
        FAIL_NAMES+=("$test_name")
    fi
}

run_hook "not-json" "with-project"
run_test "malformed JSON exits 1 with catalog stderr" 1 "[tools-runner] stdin is not valid JSON:"

run_hook "" "with-project"
run_test "empty stdin exits 0" 0 ""

run_hook "{}" "no-project"
run_test "missing CLAUDE_PROJECT_DIR exits 1 with catalog stderr" 1 "[tools-runner] CLAUDE_PROJECT_DIR is not set"

run_hook '{"stop_hook_active": true}' "no-project"
run_test "stop_hook_active short-circuits before env check" 0 "" "[tools-runner] stop_hook_active set, skipping to avoid recursion"

echo ""
echo "================================"
echo "hook-smoke summary: $PASS_COUNT pass, $FAIL_COUNT fail"
if [ "$FAIL_COUNT" -gt 0 ]; then
    echo "failed tests:"
    for failed_name in "${FAIL_NAMES[@]}"; do
        echo "  - $failed_name"
    done
    exit 1
fi
exit 0
