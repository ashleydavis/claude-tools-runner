#!/usr/bin/env bash
#
# End-to-end smoke tests for the tools-runner Stop hook.
#
# Each scenario builds a fresh temp project (`mktemp -d`), `git init`s it, writes a
# `.claude/tools-runner.yaml`, then invokes the bundled `plugin/dist/stop-hook.js` with `'{}'` on
# stdin. All assertions are scripted (exit codes, file contents, mtimes, stdout greps) so the suite
# can run unattended in CI.
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

chmod +x "$0"

bun run bundle >/dev/null 2>&1

HOOK_BUNDLE="$PROJECT_DIR/plugin/dist/stop-hook.js"
PLUGIN_ROOT="$PROJECT_DIR/plugin"

PASS_COUNT=0
FAIL_COUNT=0
FAIL_NAMES=()

# Per-scenario state populated/reset by `start_scenario` and consumed by `fail_assert` / `report`.
SCENARIO_NUM=0
SCENARIO_NAME=""
SCENARIO_FAILED=0

# Resets the per-scenario state. Args: $1 = scenario number, $2 = scenario name.
start_scenario() {
    SCENARIO_NUM="$1"
    SCENARIO_NAME="$2"
    SCENARIO_FAILED=0
    SCENARIO_FAIL_BUFFER=""
}

# Buffers an assertion failure diagnostic. The diagnostic is printed only after the FAIL line
# so that passing scenarios produce a single line of output.
fail_assert() {
    SCENARIO_FAIL_BUFFER+="  $1"$'\n'
    SCENARIO_FAILED=1
}

# Buffers an indented dump of the given file's contents into the failure buffer so it prints
# under the FAIL line alongside the assertion messages.
fail_dump() {
    while IFS= read -r dump_line || [ -n "$dump_line" ]; do
        SCENARIO_FAIL_BUFFER+="    $dump_line"$'\n'
    done < "$1"
}

# Emits the per-scenario PASS/FAIL line and updates the global counters.
report() {
    if [ "$SCENARIO_FAILED" = "0" ]; then
        echo "PASS: $SCENARIO_NAME"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "FAIL: $SCENARIO_NAME"
        if [ -n "$SCENARIO_FAIL_BUFFER" ]; then
            printf '%s' "$SCENARIO_FAIL_BUFFER"
        fi
        FAIL_COUNT=$((FAIL_COUNT + 1))
        FAIL_NAMES+=("$SCENARIO_NAME")
    fi
}

# Invokes the bundled hook with `'{}'` on stdin. Captures stdout to $1, stderr to $2, exits without
# aborting on non-zero (the per-scenario assertion logic handles unexpected exit codes).
# Args: $1 = stdout file, $2 = stderr file, $3 = CLAUDE_PROJECT_DIR, $4 = HOME.
# Echoes the captured exit code on stdout for the caller to read via command substitution.
invoke_hook() {
    local stdout_file="$1"
    local stderr_file="$2"
    local proj_dir="$3"
    local home_dir="$4"
    local exit_code=0
    printf '%s' '{}' \
        | env CLAUDE_PROJECT_DIR="$proj_dir" \
              CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
              HOME="$home_dir" \
              bun "$HOOK_BUNDLE" >"$stdout_file" 2>"$stderr_file" \
        || exit_code=$?
    echo "$exit_code"
}

# State shared between scenarios 1-4 (chained: same sandbox, sequential runs). Scenarios 5-7 each
# create their own isolated sandbox/home pair.
SANDBOX_A=""
HOME_A=""

scenario_1_first_run() {
    start_scenario 1 "first-run executes"
    SANDBOX_A=$(mktemp -d)
    HOME_A=$(mktemp -d)
    git -C "$SANDBOX_A" init -q
    mkdir -p "$SANDBOX_A/.claude" "$SANDBOX_A/src"
    cat > "$SANDBOX_A/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "src/**/*.ts"
    commands:
      - run: "echo SMOKE_OK > smoke.out"
EOF
    : > "$SANDBOX_A/src/foo.ts"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$SANDBOX_A" "$HOME_A")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code (expected 0); stderr:"
        fail_dump "$stderr_file"
    fi
    if ! grep -qE "trigger 0 cmd 0.*PASS" "$stdout_file"; then
        fail_assert "stdout missing trigger-run line"
        fail_dump "$stdout_file"
    fi
    if [ ! -f "$SANDBOX_A/smoke.out" ]; then
        fail_assert "smoke.out does not exist"
    elif ! grep -qF "SMOKE_OK" "$SANDBOX_A/smoke.out"; then
        fail_assert "smoke.out does not contain SMOKE_OK"
    fi

    rm -f "$stdout_file" "$stderr_file"
    report
}

scenario_2_cooldown_skip() {
    start_scenario 2 "cooldown skip (re-run after scenario 1)"
    local before_mtime
    before_mtime=$(stat -c %Y "$SANDBOX_A/smoke.out")

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$SANDBOX_A" "$HOME_A")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi
    if ! grep -qF "in cooldown" "$stdout_file"; then
        fail_assert "stdout missing 'in cooldown' skip reason"
        fail_dump "$stdout_file"
    fi
    local after_mtime
    after_mtime=$(stat -c %Y "$SANDBOX_A/smoke.out")
    if [ "$before_mtime" != "$after_mtime" ]; then
        fail_assert "smoke.out mtime changed (before=$before_mtime after=$after_mtime)"
    fi

    rm -f "$stdout_file" "$stderr_file"
    report
}

scenario_3_cooldown_bypass_via_file_change() {
    start_scenario 3 "cooldown bypass via file change"
    # Sleep past 1 second so mtime advances at second granularity.
    sleep 1.1

    cat > "$SANDBOX_A/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "src/**/*.ts"
    commands:
      - run: "echo SMOKE_OK > smoke.out"
        cooldown: "0s"
EOF
    echo "// changed" >> "$SANDBOX_A/src/foo.ts"

    local before_mtime
    before_mtime=$(stat -c %Y "$SANDBOX_A/smoke.out")

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$SANDBOX_A" "$HOME_A")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi
    local after_mtime
    after_mtime=$(stat -c %Y "$SANDBOX_A/smoke.out")
    if [ "$after_mtime" -le "$before_mtime" ]; then
        fail_assert "smoke.out mtime did not advance (before=$before_mtime after=$after_mtime); stdout:"
        fail_dump "$stdout_file"
    fi

    rm -f "$stdout_file" "$stderr_file"
    report
}

scenario_4_clean_slate_after_state_delete() {
    start_scenario 4 "clean-slate after state delete"
    sleep 1.1
    rm -f "$SANDBOX_A/.claude/tools-runner-hashes.yaml"
    rm -rf "$SANDBOX_A/.claude/tools-runner-runs"
    local before_mtime
    before_mtime=$(stat -c %Y "$SANDBOX_A/smoke.out")

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$SANDBOX_A" "$HOME_A")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi
    local after_mtime
    after_mtime=$(stat -c %Y "$SANDBOX_A/smoke.out")
    if [ "$after_mtime" -le "$before_mtime" ]; then
        fail_assert "smoke.out mtime did not advance (before=$before_mtime after=$after_mtime); stdout:"
        fail_dump "$stdout_file"
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$SANDBOX_A" "$HOME_A"
    SANDBOX_A=""
    HOME_A=""
    report
}

scenario_5_per_file_template() {
    start_scenario 5 "per-file template (race-free)"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude" "$sandbox/a" "$sandbox/b"
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "**/*.md"
    commands:
      - run: "echo ${{file_path}} > per-file-$(basename ${{file_path}}).log"
EOF
    : > "$sandbox/a/x.md"
    : > "$sandbox/b/y.md"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi

    if [ ! -f "$sandbox/per-file-x.md.log" ]; then
        fail_assert "per-file-x.md.log not found"
    else
        local x_lines
        x_lines=$(wc -l < "$sandbox/per-file-x.md.log")
        if [ "$x_lines" -ne 1 ]; then
            fail_assert "per-file-x.md.log has $x_lines lines (expected 1)"
        fi
        if ! grep -qE 'a/x\.md$' "$sandbox/per-file-x.md.log"; then
            fail_assert "per-file-x.md.log line does not end in a/x.md"
            fail_dump "$sandbox/per-file-x.md.log"
        fi
    fi

    if [ ! -f "$sandbox/per-file-y.md.log" ]; then
        fail_assert "per-file-y.md.log not found"
    else
        local y_lines
        y_lines=$(wc -l < "$sandbox/per-file-y.md.log")
        if [ "$y_lines" -ne 1 ]; then
            fail_assert "per-file-y.md.log has $y_lines lines (expected 1)"
        fi
        if ! grep -qE 'b/y\.md$' "$sandbox/per-file-y.md.log"; then
            fail_assert "per-file-y.md.log line does not end in b/y.md"
            fail_dump "$sandbox/per-file-y.md.log"
        fi
    fi

    if [ -f "$sandbox/per-file.log" ]; then
        fail_assert "shared per-file.log unexpectedly exists"
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_6_layered_config() {
    start_scenario 6 "layered config (home + project)"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude" "$fake_home/.claude"
    cat > "$fake_home/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "**/*.txt"
    commands:
      - run: "echo HOME_OK > home.out"
EOF
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "**/*.txt"
    commands:
      - run: "echo PROJECT_OK > project.out"
EOF
    : > "$sandbox/foo.txt"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi

    if ! grep -qF "~/.claude/tools-runner.yaml:trigger" "$stdout_file"; then
        fail_assert "stdout missing home YAML tag '~/.claude/tools-runner.yaml:trigger'"
        fail_dump "$stdout_file"
    fi
    if ! grep -qE "^\[tools-runner\] \.claude/tools-runner\.yaml:trigger" "$stdout_file"; then
        fail_assert "stdout missing project YAML tag '.claude/tools-runner.yaml:trigger'"
        fail_dump "$stdout_file"
    fi

    if [ ! -f "$fake_home/home.out" ]; then
        fail_assert "home.out (in HOME) does not exist"
    elif ! grep -qF "HOME_OK" "$fake_home/home.out"; then
        fail_assert "home.out does not contain HOME_OK"
    fi

    if [ ! -f "$sandbox/project.out" ]; then
        fail_assert "project.out (in project) does not exist"
    elif ! grep -qF "PROJECT_OK" "$sandbox/project.out"; then
        fail_assert "project.out does not contain PROJECT_OK"
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_7_state_file_shape() {
    start_scenario 7 "state file shape"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude" "$sandbox/src"
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "src/**/*.ts"
    commands:
      - run: "echo SMOKE_OK > smoke.out"
EOF
    : > "$sandbox/src/foo.ts"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi

    local hashes_path="$sandbox/.claude/tools-runner-hashes.yaml"
    local runs_dir="$sandbox/.claude/tools-runner-runs"
    if [ ! -f "$hashes_path" ]; then
        fail_assert "hash cache file does not exist at $hashes_path"
    elif [ ! -d "$runs_dir" ]; then
        fail_assert "runs directory does not exist at $runs_dir"
    else
        local validation_output
        local validation_exit=0
        validation_output=$(cd "$PROJECT_DIR" && HASHES_PATH="$hashes_path" RUNS_DIR="$runs_dir" bun -e '
const yamlMod = await import("yaml");
const fsMod = await import("node:fs");
const pathMod = await import("node:path");
const errors = [];

const hashesText = fsMod.readFileSync(process.env.HASHES_PATH, "utf8");
const hashesFile = yamlMod.parse(hashesText);
if (!hashesFile || typeof hashesFile !== "object" || Array.isArray(hashesFile)) {
    errors.push("hashes file root is not a mapping");
}
else if (!hashesFile.fileHashes || typeof hashesFile.fileHashes !== "object" || Array.isArray(hashesFile.fileHashes) || Object.keys(hashesFile.fileHashes).length < 1) {
    errors.push("fileHashes must be a non-empty mapping");
}

const runFiles = fsMod.readdirSync(process.env.RUNS_DIR).filter(name => name.endsWith(".yaml"));
if (runFiles.length < 1) {
    errors.push("runs directory must contain at least one .yaml file");
}
else {
    const runText = fsMod.readFileSync(pathMod.join(process.env.RUNS_DIR, runFiles[0]), "utf8");
    const runFile = yamlMod.parse(runText);
    if (!runFile || typeof runFile !== "object" || Array.isArray(runFile)) {
        errors.push("run file root is not a mapping");
    }
    else {
        if (typeof runFile.commandKey !== "string" || !/^[0-9a-f]+$/.test(runFile.commandKey)) {
            errors.push("commandKey must be a hex string");
        }
        if (typeof runFile.expandedRun !== "string") errors.push("expandedRun must be a string");
        if (typeof runFile.expandedCwd !== "string") errors.push("expandedCwd must be a string");
        if (typeof runFile.sourceFile !== "string") errors.push("sourceFile must be a string");
        if (typeof runFile.sourceLine !== "number") errors.push("sourceLine must be a number");
        if (typeof runFile.lastRunAt !== "string") errors.push("lastRunAt must be a string");
        if (typeof runFile.lastFilesHash !== "string") errors.push("lastFilesHash must be a string");
        if (!Array.isArray(runFile.matchedFiles)) errors.push("matchedFiles must be a sequence");
    }
}

if (errors.length > 0) {
    console.log("INVALID:" + errors.join("; "));
    process.exit(1);
}
console.log("OK");
' 2>&1) || validation_exit=$?
        if [ "$validation_exit" != "0" ] || ! printf '%s' "$validation_output" | grep -qF "OK"; then
            fail_assert "state YAML validation failed (exit=$validation_exit): $validation_output"
        fi
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_8_group_by_per_group_fanout() {
    start_scenario 8 "group_by + \${{group_dir}} per-group fan-out"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude" \
             "$sandbox/packages/foo/src/lib" \
             "$sandbox/packages/bar/src"
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "packages/*/src/**/*.ts"
    group_by: "packages/*/"
    commands:
      - run: "echo GROUP > group.out"
        cwd: "${{group_dir}}"
EOF
    : > "$sandbox/packages/foo/src/util.ts"
    : > "$sandbox/packages/foo/src/lib/util.ts"
    : > "$sandbox/packages/bar/src/util.ts"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi
    if [ ! -f "$sandbox/packages/foo/group.out" ]; then
        fail_assert "packages/foo/group.out missing"
    elif ! grep -qF "GROUP" "$sandbox/packages/foo/group.out"; then
        fail_assert "packages/foo/group.out does not contain GROUP"
    fi
    if [ ! -f "$sandbox/packages/bar/group.out" ]; then
        fail_assert "packages/bar/group.out missing"
    elif ! grep -qF "GROUP" "$sandbox/packages/bar/group.out"; then
        fail_assert "packages/bar/group.out does not contain GROUP"
    fi
    if ! grep -qF "summary: 2 pass, 0 fail" "$stdout_file"; then
        fail_assert "expected exactly 2 PASS invocations (one per group); stdout:"
        fail_dump "$stdout_file"
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_9_brace_expansion() {
    start_scenario 9 "brace expansion in paths"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude"
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "**/*.{ts,tsx}"
    commands:
      - run: "echo BRACE > brace-${{file_name}}.out"
EOF
    : > "$sandbox/foo.ts"
    : > "$sandbox/bar.tsx"
    : > "$sandbox/qux.md"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi
    if [ ! -f "$sandbox/brace-foo.ts.out" ]; then
        fail_assert "brace-foo.ts.out missing (.ts not matched by **/*.{ts,tsx})"
    fi
    if [ ! -f "$sandbox/brace-bar.tsx.out" ]; then
        fail_assert "brace-bar.tsx.out missing (.tsx not matched by **/*.{ts,tsx})"
    fi
    if [ -f "$sandbox/brace-qux.md.out" ]; then
        fail_assert "brace-qux.md.out unexpectedly present (.md should not match)"
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_10_per_file_name_basename_ext() {
    start_scenario 10 "per-file \${{file_name}}/\${{file_basename}}/\${{file_ext}}"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude"
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "**/*.txt"
    commands:
      - run: "echo NAME=${{file_name}} BASE=${{file_basename}} EXT=${{file_ext}} > info-${{file_basename}}.out"
EOF
    : > "$sandbox/hello.txt"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi
    if [ ! -f "$sandbox/info-hello.out" ]; then
        fail_assert "info-hello.out missing"
    elif ! grep -qF "NAME=hello.txt BASE=hello EXT=.txt" "$sandbox/info-hello.out"; then
        fail_assert "info-hello.out content unexpected:"
        fail_dump "$sandbox/info-hello.out"
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_11_file_dir_per_directory_fanout() {
    start_scenario 11 "\${{file_dir}} per-directory fan-out"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude" "$sandbox/dirA" "$sandbox/dirB"
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "**/*.log"
    commands:
      - run: "echo DIR > dir.out"
        cwd: "${{file_dir}}"
EOF
    : > "$sandbox/dirA/a.log"
    : > "$sandbox/dirA/b.log"
    : > "$sandbox/dirB/c.log"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi
    if [ ! -f "$sandbox/dirA/dir.out" ]; then
        fail_assert "dirA/dir.out missing"
    fi
    if [ ! -f "$sandbox/dirB/dir.out" ]; then
        fail_assert "dirB/dir.out missing"
    fi
    if ! grep -qF "summary: 2 pass, 0 fail" "$stdout_file"; then
        fail_assert "expected exactly 2 invocations (per-dir collapse); stdout:"
        fail_dump "$stdout_file"
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_12_negation_pattern() {
    start_scenario 12 "negation pattern in paths"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude" "$sandbox/src/excluded"
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "**/*.ts"
      - "!**/excluded/**"
    commands:
      - run: "echo NEG > neg-${{file_name}}.out"
EOF
    : > "$sandbox/src/foo.ts"
    : > "$sandbox/src/excluded/bar.ts"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi
    if [ ! -f "$sandbox/neg-foo.ts.out" ]; then
        fail_assert "neg-foo.ts.out missing (foo.ts should match)"
    fi
    if [ -f "$sandbox/neg-bar.ts.out" ]; then
        fail_assert "neg-bar.ts.out unexpectedly present (excluded/bar.ts should not match)"
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_13_multiple_commands_per_trigger() {
    start_scenario 13 "multiple commands per trigger"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude"
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "**/*.ts"
    commands:
      - run: "echo A > a.out"
      - run: "echo B > b.out"
EOF
    : > "$sandbox/foo.ts"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi
    if [ ! -f "$sandbox/a.out" ] || ! grep -qF "A" "$sandbox/a.out"; then
        fail_assert "a.out missing or wrong content"
    fi
    if [ ! -f "$sandbox/b.out" ] || ! grep -qF "B" "$sandbox/b.out"; then
        fail_assert "b.out missing or wrong content"
    fi
    if ! grep -qF "summary: 2 pass, 0 fail" "$stdout_file"; then
        fail_assert "expected 2 PASS invocations (one per command); stdout:"
        fail_dump "$stdout_file"
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_14_recursive_config_scan() {
    start_scenario 14 "recursive config scan (subdirectory YAML)"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude" \
             "$sandbox/sub/.claude" \
             "$sandbox/root-files" \
             "$sandbox/sub/sub-files"
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "root-files/*.txt"
    commands:
      - run: "echo ROOT > root.out"
EOF
    cat > "$sandbox/sub/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "sub-files/*.txt"
    commands:
      - run: "echo SUB > sub.out"
EOF
    : > "$sandbox/root-files/foo.txt"
    : > "$sandbox/sub/sub-files/bar.txt"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi
    if [ ! -f "$sandbox/root.out" ]; then
        fail_assert "root.out missing (root-level YAML did not fire)"
    fi
    if [ ! -f "$sandbox/sub/sub.out" ]; then
        fail_assert "sub/sub.out missing (subdirectory YAML did not fire)"
    fi
    if ! grep -qE '^\[tools-runner\] \.claude/tools-runner\.yaml:trigger' "$stdout_file"; then
        fail_assert "stdout missing root display path '.claude/tools-runner.yaml'"
    fi
    if ! grep -qE '^\[tools-runner\] sub/\.claude/tools-runner\.yaml:trigger' "$stdout_file"; then
        fail_assert "stdout missing subdir display path 'sub/.claude/tools-runner.yaml'"
        fail_dump "$stdout_file"
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_15_failing_command() {
    start_scenario 15 "failing command surfaces FAIL"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude"
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "**/*.ts"
    commands:
      - run: "exit 7"
EOF
    : > "$sandbox/foo.ts"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "0" ]; then
        fail_assert "hook exit=$exit_code (expected 0; failures should not break the hook); stderr:"
        fail_dump "$stderr_file"
    fi
    if ! grep -qF "FAIL exit 7" "$stdout_file"; then
        fail_assert "stdout missing 'FAIL exit 7'"
        fail_dump "$stdout_file"
    fi
    if ! grep -qF "summary: 0 pass, 1 fail, 0 skip" "$stdout_file"; then
        fail_assert "stdout missing expected summary"
        fail_dump "$stdout_file"
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_16_per_command_log_file() {
    start_scenario 16 "per-command log file captures stdout and stderr"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude"
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "**/*.ts"
    commands:
      - run: "echo HELLO_FROM_HOOK; echo BYE_STDERR 1>&2"
EOF
    : > "$sandbox/foo.ts"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi
    local log_files
    log_files=$(find "$sandbox/.claude/tools-runner-log" -mindepth 4 -type f -name '*.log' 2>/dev/null || true)
    if [ -z "$log_files" ]; then
        fail_assert "no per-command log file found under .claude/tools-runner-log"
    else
        local first_log
        first_log=$(printf '%s\n' "$log_files" | head -n1)
        if ! grep -qF "[OUT] HELLO_FROM_HOOK" "$first_log"; then
            fail_assert "log file missing '[OUT] HELLO_FROM_HOOK': $first_log"
            fail_dump "$first_log"
        fi
        if ! grep -qF "[ERR] BYE_STDERR" "$first_log"; then
            fail_assert "log file missing '[ERR] BYE_STDERR': $first_log"
            fail_dump "$first_log"
        fi
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_17_no_matching_files() {
    start_scenario 17 "no matching files: 'no triggers matched, skipping'"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude"
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "**/*.foo"
    commands:
      - run: "echo NEVER > never.out"
EOF
    : > "$sandbox/bar.txt"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi
    if ! grep -qF "[tools-runner] no triggers matched, skipping" "$stdout_file"; then
        fail_assert "stdout missing 'no triggers matched, skipping'"
        fail_dump "$stdout_file"
    fi
    if [ -f "$sandbox/never.out" ]; then
        fail_assert "never.out unexpectedly present (no command should have run)"
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_18_custom_cwd() {
    start_scenario 18 "custom cwd via \${{project}}/sub"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude" "$sandbox/sub"
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "**/*.ts"
    commands:
      - run: "echo CWD > out.log"
        cwd: "${{project}}/sub"
EOF
    : > "$sandbox/foo.ts"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi
    if [ ! -f "$sandbox/sub/out.log" ]; then
        fail_assert "sub/out.log missing (custom cwd not honoured)"
    fi
    if [ -f "$sandbox/out.log" ]; then
        fail_assert "out.log unexpectedly present at sandbox root (cwd should have been sub)"
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_19_timeout_kills_command() {
    start_scenario 19 "per-command timeout kills the process"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude"
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "**/*.ts"
    commands:
      - run: "sleep 5"
        timeout: "1s"
EOF
    : > "$sandbox/foo.ts"

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "0" ]; then
        fail_assert "exit=$exit_code; stderr:"
        fail_dump "$stderr_file"
    fi
    if ! grep -qF "FAIL timeout" "$stdout_file"; then
        fail_assert "stdout missing 'FAIL timeout'"
        fail_dump "$stdout_file"
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_20_yaml_parse_error() {
    start_scenario 20 "malformed YAML in project config exits 1"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude"
    # Unclosed flow sequence forces a YAML parse error at the top level.
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers: [ { paths: ["**/*.ts"], commands: [
EOF

    local stdout_file
    stdout_file=$(mktemp)
    local stderr_file
    stderr_file=$(mktemp)
    local exit_code
    exit_code=$(invoke_hook "$stdout_file" "$stderr_file" "$sandbox" "$fake_home")

    if [ "$exit_code" != "1" ]; then
        fail_assert "exit=$exit_code (expected 1); stderr:"
        fail_dump "$stderr_file"
    fi
    if ! grep -qF "[tools-runner] failed to load .claude/tools-runner.yaml:" "$stderr_file"; then
        fail_assert "stderr missing '[tools-runner] failed to load .claude/tools-runner.yaml:'"
        fail_dump "$stderr_file"
    fi

    rm -f "$stdout_file" "$stderr_file"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_21_hash_gate_skip_after_cooldown_expires() {
    start_scenario 21 "hash gate: skip after cooldown when files unchanged"
    local sandbox
    sandbox=$(mktemp -d)
    local fake_home
    fake_home=$(mktemp -d)
    git -C "$sandbox" init -q
    mkdir -p "$sandbox/.claude"
    cat > "$sandbox/.claude/tools-runner.yaml" <<'EOF'
triggers:
  - paths:
      - "**/*.ts"
    commands:
      - run: "echo HASH > hash.out"
        cooldown: "1s"
EOF
    : > "$sandbox/foo.ts"

    local stdout1
    stdout1=$(mktemp)
    local stderr1
    stderr1=$(mktemp)
    local exit1
    exit1=$(invoke_hook "$stdout1" "$stderr1" "$sandbox" "$fake_home")
    if [ "$exit1" != "0" ]; then
        fail_assert "first run exit=$exit1; stderr:"
        fail_dump "$stderr1"
    fi
    if [ ! -f "$sandbox/hash.out" ]; then
        fail_assert "first run did not produce hash.out"
    fi
    local first_mtime
    first_mtime=$(stat -c %Y "$sandbox/hash.out")

    # Wait past the 1s cooldown without modifying foo.ts.
    sleep 1.5

    local stdout2
    stdout2=$(mktemp)
    local stderr2
    stderr2=$(mktemp)
    local exit2
    exit2=$(invoke_hook "$stdout2" "$stderr2" "$sandbox" "$fake_home")
    if [ "$exit2" != "0" ]; then
        fail_assert "second run exit=$exit2; stderr:"
        fail_dump "$stderr2"
    fi
    if ! grep -qF "no file changes since last successful run" "$stdout2"; then
        fail_assert "stdout missing hash-gate skip reason; second-run stdout:"
        fail_dump "$stdout2"
    fi
    local second_mtime
    second_mtime=$(stat -c %Y "$sandbox/hash.out")
    if [ "$first_mtime" != "$second_mtime" ]; then
        fail_assert "hash.out mtime changed (before=$first_mtime after=$second_mtime); command should have been skipped"
    fi

    rm -f "$stdout1" "$stderr1" "$stdout2" "$stderr2"
    rm -rf "$sandbox" "$fake_home"
    report
}

scenario_1_first_run
scenario_2_cooldown_skip
scenario_3_cooldown_bypass_via_file_change
scenario_4_clean_slate_after_state_delete
scenario_5_per_file_template
scenario_6_layered_config
scenario_7_state_file_shape
scenario_8_group_by_per_group_fanout
scenario_9_brace_expansion
scenario_10_per_file_name_basename_ext
scenario_11_file_dir_per_directory_fanout
scenario_12_negation_pattern
scenario_13_multiple_commands_per_trigger
scenario_14_recursive_config_scan
scenario_15_failing_command
scenario_16_per_command_log_file
scenario_17_no_matching_files
scenario_18_custom_cwd
scenario_19_timeout_kills_command
scenario_20_yaml_parse_error
scenario_21_hash_gate_skip_after_cooldown_expires

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo "Results: $PASS_COUNT/$TOTAL passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ] || exit 1
exit 0
