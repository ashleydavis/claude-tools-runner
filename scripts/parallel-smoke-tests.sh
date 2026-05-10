#!/usr/bin/env bash
#
# Concurrency smoke test for the Stop hook's per-project state files.
#
# Drives many copies of the bundled hook in parallel against one sandbox, then verifies that
# `tools-runner-hashes.yaml` and every per-command file under `tools-runner-runs/` round-trip through
# `yaml.parse` and pass a basic shape validation. Uses the audit log (`hook_started` / `hook_completed`
# timestamps) to confirm that at least one iteration actually had two or more hooks running at the same
# time; if 5 minutes elapse without observing a parallel overlap the test fails (the assertion would be
# meaningless if every batch were silently serialized by the OS scheduler).
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

chmod +x "$0"

bun run bundle >/dev/null 2>&1

HOOK_BUNDLE="$PROJECT_DIR/plugin/dist/stop-hook.js"
PLUGIN_ROOT="$PROJECT_DIR/plugin"

# Number of hooks fired per iteration. High enough that concurrent execution is the common case on a
# multi-core machine; low enough that a single iteration finishes within a few hundred milliseconds on
# a developer laptop so the 5-minute deadline is rarely approached.
PARALLELISM="${PARALLELISM:-12}"

# Hard deadline for the whole test, in seconds. The loop exits cleanly the first iteration that
# observes a parallel overlap; this deadline only fires if the OS keeps serializing hooks past
# expectation, in which case the test is reported as inconclusive and exits 1.
DEADLINE_SECONDS="${DEADLINE_SECONDS:-300}"

# Pre-flight: clear log directory and prepare sandbox. Sandbox is reused across iterations so the
# audit log accumulates evidence of overlap.
SANDBOX=$(mktemp -d -t tools-runner-parallel-XXXXXX)
FAKE_HOME=$(mktemp -d -t tools-runner-parallel-home-XXXXXX)
trap 'rm -rf "$SANDBOX" "$FAKE_HOME"' EXIT

git -C "$SANDBOX" init -q
mkdir -p "$SANDBOX/.claude" "$SANDBOX/src"
cat > "$SANDBOX/.claude/tools-runner.yaml" <<'YAML'
triggers:
  - paths:
      - "src/**/*.ts"
    commands:
      - run: "true"
        cooldown: "0s"
YAML

for i in 1 2 3 4 5; do
    : > "$SANDBOX/src/file$i.ts"
done

# Renders one parallel batch: kicks off N hooks in the background, waits for all, returns when the
# last one resolves. stdout/stderr from the hooks are discarded; we rely on the audit log for evidence.
run_batch() {
    local pids=()
    for n in $(seq 1 "$PARALLELISM"); do
        printf '%s' '{}' \
            | env CLAUDE_PROJECT_DIR="$SANDBOX" \
                  CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
                  HOME="$FAKE_HOME" \
                  bun "$HOOK_BUNDLE" >/dev/null 2>&1 &
        pids+=("$!")
    done
    for pid in "${pids[@]}"; do
        wait "$pid" || true
    done
}

# Mutates the watched files so the hash gate does not short-circuit the trigger. Each iteration writes
# a fresh random byte to every watched file, guaranteeing a non-trivial workload per hook.
mutate_inputs() {
    local stamp
    stamp="iter-$1-rand-$RANDOM-$RANDOM"
    for i in 1 2 3 4 5; do
        printf '// %s\n' "$stamp" > "$SANDBOX/src/file$i.ts"
    done
}

# Inspects the current sandbox: parses every state file and walks the audit log to compute the maximum
# number of hooks that were in flight simultaneously. Echoes a single JSON line with `maxInflight` and
# `errors` (an array; empty on success). The caller treats `maxInflight >= 2` as evidence that the
# saves overlapped: with no version field there is no longer a delta-based way to prove save-phase
# contention specifically, so the test relies on the integrity check (every state file parses cleanly,
# no stray .tmp/.lock leftovers, no audit-log JSON parse errors) to catch any corruption that an
# overlapping save might produce.
inspect_state() {
    SANDBOX="$SANDBOX" bun -e '
const fs = await import("node:fs");
const path = await import("node:path");
const yamlMod = await import("yaml");

const sandbox = process.env.SANDBOX;
const errors = [];

const hashesPath = path.join(sandbox, ".claude", "tools-runner-hashes.yaml");
if (fs.existsSync(hashesPath)) {
    try {
        const text = fs.readFileSync(hashesPath, "utf8");
        const parsed = yamlMod.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            errors.push("hashes file root is not a mapping");
        }
        else if (!parsed.fileHashes || typeof parsed.fileHashes !== "object" || Array.isArray(parsed.fileHashes)) {
            errors.push("hashes file fileHashes is not a mapping");
        }
    }
    catch (parseErr) {
        errors.push(`hashes file parse error: ${parseErr.message}`);
    }
}

const runsDir = path.join(sandbox, ".claude", "tools-runner-runs");
if (fs.existsSync(runsDir)) {
    for (const entry of fs.readdirSync(runsDir)) {
        if (entry.endsWith(".lock") || entry.endsWith(".tmp")) {
            errors.push(`stray ${entry.endsWith(".lock") ? "lock" : "tmp"} file in runs dir: ${entry}`);
            continue;
        }
        if (!entry.endsWith(".yaml")) {
            continue;
        }
        const fullPath = path.join(runsDir, entry);
        try {
            const text = fs.readFileSync(fullPath, "utf8");
            const parsed = yamlMod.parse(text);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                errors.push(`${entry} root is not a mapping`);
                continue;
            }
            if (typeof parsed.commandKey !== "string") {
                errors.push(`${entry} commandKey is not a string`);
            }
            if (typeof parsed.expandedRun !== "string") {
                errors.push(`${entry} expandedRun is not a string`);
            }
            if (typeof parsed.lastRunAt !== "string") {
                errors.push(`${entry} lastRunAt is not a string`);
            }
            if (!Array.isArray(parsed.matchedFiles)) {
                errors.push(`${entry} matchedFiles is not a sequence`);
            }
        }
        catch (parseErr) {
            errors.push(`${entry} parse error: ${parseErr.message}`);
        }
    }
}

const claudeDir = path.join(sandbox, ".claude");
if (fs.existsSync(claudeDir)) {
    for (const entry of fs.readdirSync(claudeDir)) {
        if (entry.endsWith(".tmp")) {
            errors.push(`stray tmp file in .claude: ${entry}`);
        }
    }
}

const logRoot = path.join(sandbox, ".claude", "tools-runner-log");
const auditFiles = [];
if (fs.existsSync(logRoot)) {
    const stack = [logRoot];
    while (stack.length > 0) {
        const cur = stack.pop();
        for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
            const full = path.join(cur, ent.name);
            if (ent.isDirectory()) {
                stack.push(full);
            }
            else if (ent.name.endsWith(".json")) {
                auditFiles.push(full);
            }
        }
    }
}

const events = [];
for (const af of auditFiles) {
    const text = fs.readFileSync(af, "utf8");
    for (const line of text.split("\n")) {
        if (!line.trim()) {
            continue;
        }
        try {
            const ev = JSON.parse(line);
            if (ev.type === "hook_started" || ev.type === "hook_completed") {
                const ts = Date.parse(ev.timestamp);
                if (!Number.isNaN(ts)) {
                    events.push({ ts, kind: ev.type === "hook_started" ? "start" : "end" });
                }
            }
        }
        catch {
            // Audit-log corruption would normally show up as an unparseable JSON line. Surface it.
            errors.push(`audit log line failed to parse in ${af}`);
        }
    }
}

events.sort((leftEvent, rightEvent) => {
    if (leftEvent.ts !== rightEvent.ts) {
        return leftEvent.ts - rightEvent.ts;
    }
    return leftEvent.kind === "start" ? -1 : 1;
});

let inflight = 0;
let maxInflight = 0;
for (const ev of events) {
    if (ev.kind === "start") {
        inflight += 1;
        if (inflight > maxInflight) {
            maxInflight = inflight;
        }
    }
    else {
        inflight -= 1;
    }
}

console.log(JSON.stringify({ maxInflight, errors }));
'
}

ITER=0
START_SECONDS=$SECONDS

echo "running parallel smoke (PARALLELISM=$PARALLELISM, deadline=${DEADLINE_SECONDS}s)..."

while [ $((SECONDS - START_SECONDS)) -lt "$DEADLINE_SECONDS" ]; do
    ITER=$((ITER + 1))
    mutate_inputs "$ITER"
    run_batch

    INSPECTION=$(inspect_state)
    MAX_INFLIGHT=$(printf '%s' "$INSPECTION" | bun -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(0, "utf8")).maxInflight))')
    ERRORS=$(printf '%s' "$INSPECTION" | bun -e 'const j = JSON.parse(require("node:fs").readFileSync(0, "utf8")); process.stdout.write(j.errors.join("\n"))')

    if [ -n "$ERRORS" ]; then
        echo "FAIL: state corruption detected after iteration $ITER"
        printf '%s\n' "$ERRORS" | sed 's/^/  /'
        exit 1
    fi

    echo "iter=$ITER max_inflight=$MAX_INFLIGHT"

    if [ "$MAX_INFLIGHT" -ge 2 ]; then
        echo "PASS: parallel writes do not corrupt state (iter=$ITER, max in-flight=$MAX_INFLIGHT)"
        exit 0
    fi
done

echo "FAIL: did not observe any parallel overlap within ${DEADLINE_SECONDS}s (iter=$ITER, parallelism=$PARALLELISM); the test cannot certify safety because no batch had concurrent hooks"
exit 1
