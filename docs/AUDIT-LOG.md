# Audit Log

Every Stop event processed by the `claude-tools-runner` plugin is recorded to an audit log. The JSON log captures every phase of the hook (config load, changed-file collection, trigger match, gate decision, command spawn, command result, state save) bracketed by `hook_started` and `hook_completed` entries; the human-readable text log keeps only the user-facing chain (`CONFIG` → `CHANGE` → `MATCH` → `CMD` → `PASS`/`FAIL`/`TIMEOUT`) plus `ERROR`. Together they answer questions like *"why didn't my command fire?"* without instrumenting the plugin yourself.

## Location

The audit log is per configuration layer: each `.claude/claude-tools-runner.yaml` has its own log under `.claude/claude-tools-runner/log/` next to it. Two files are written per hour to the same directory:

```
<scopeDir>/.claude/claude-tools-runner/log/YYYY-MM/DD/HH.json   ← machine-readable
<scopeDir>/.claude/claude-tools-runner/log/YYYY-MM/DD/HH.log    ← human-readable
```

Where `<scopeDir>` is the directory containing the configuration file (or `$HOME` for the home layer). The plugin uses `$CLAUDE_PROJECT_DIR` to find configurations to load; if it is unset the plugin skips logging (and exits early via the `env_unset` skip path).

Per-command output logs share the same tree. Inside each hour, the audit-log files (`HH.json`, `HH.log`) sit alongside a `HH/` subdirectory that holds the per-command stdout/stderr captures:

```
<scopeDir>/.claude/claude-tools-runner/log/
  2026-05/
    08/
      14.json                  ← audit log (machine-readable)
      14.log                   ← audit log (human-readable)
      14/                      ← per-command logs from 14:00-14:59
        30-15-123-5feceb66.log
        30-22-456-2c26b46b.log
      15.json
      15.log
      15/
        ...
```

Per-command log filenames are `MM-SS-<ms>-<commandKey-first8>.log`. Each `command_started` and `command_result` entry carries a `logFile` field pointing at the relevant file, so you can jump from the audit log straight to a command's full output.

The whole `claude-tools-runner/` directory is gitignored by the plugin's own `.gitignore` (`*\n` dropped at the directory root). To clear it, delete the directory.

Layer-specific entries (`config_load`, `trigger_match`, `gate_decision`, `command_started`, `command_result`, `state_saved`) are routed only to the originating layer's log, so reading one configuration's log shows exactly what that configuration did. Global entries (`hook_started`, `changed_files`, `hook_completed`, `hook_error`) fan out to every layer's log so each file is self-contained.

## Retention

On every hook invocation the plugin removes month directories older than two calendar months back from the hook's `now`. The current month and the previous two are retained; everything older is purged. Cleanup runs once at the start of the hook (inside `createLogger`) and is awaited before any audit-log entry is written; a missing log directory is tolerated silently.

## Format

**`.json`** is [JSON Lines](https://jsonlines.org/) (NDJSON): one JSON object per line, newline-terminated, UTF-8 encoded. Intended for programmatic querying with tools like `jq`.

**`.log`** is plain text, one line per entry, intended for direct human reading.

All timestamps use ISO 8601 format in local time with timezone offset (e.g. `2026-05-08T14:30:15.123+10:00`). Both files share the same per-invocation `now`, so entries from one hook always end up in the same hour file even if the hook crosses an hour boundary.

`fs.appendFile` (from `node:fs/promises`) is used for every write, so concurrent appends from separate hook invocations interleave at line boundaries safely.

### Human-readable example (`.log`)

```
14:30:15  CONFIG  ~/.claude/claude-tools-runner.yaml
14:30:15  CONFIG  .claude/claude-tools-runner.yaml
14:30:15  CHANGE  2 files: src/foo.ts, src/bar.ts
14:30:15  MATCH   .claude/claude-tools-runner.yaml:4 patterns=src/**/*.ts matched 2/2: src/foo.ts, src/bar.ts
14:30:15  MATCH   .claude/claude-tools-runner.yaml:12 patterns=docs/**/*.md matched 0/2
14:30:15  CMD     .claude/claude-tools-runner.yaml:5 "bun run test"
14:30:18  PASS    .claude/claude-tools-runner.yaml:5 "bun run test" 2873ms
```

Columns: `HH:MM:SS`, label (left-padded to 8 chars), then the entry detail. Labels in use: `CONFIG`, `CHANGE`, `MATCH`, `CMD`, `PASS`, `FAIL`, `TIMEOUT`, `ERROR`. The end-of-command label encodes the outcome — `PASS` for exit 0, `FAIL` for any non-zero exit (with `exit=N` in the body), `TIMEOUT` for a per-command timeout kill — so a quick `grep FAIL` or `grep TIMEOUT` over the log surfaces only the bad runs.

The `<sourceFile>:<sourceLine>` prefix on `MATCH`, `CMD`, `PASS`, `FAIL`, and `TIMEOUT` lines is formatted like an editor-jump location. For `MATCH` it points at the trigger header; for command-level lines it points at the command's `run:` line, so most terminals and editors recognise it as a clickable target straight to the right line in your `claude-tools-runner.yaml`.

For a successful command the full sequence is: `CONFIG` (one per loaded layer) → `CHANGE` (one per Stop event) → `MATCH` (one per evaluated trigger, regardless of outcome) → `CMD` (one per spawned command) → `PASS` / `FAIL` / `TIMEOUT` (one per finished command). Commands that the cooldown/hash gate skips produce no `CMD` line — their absence between a matching `MATCH` and the next Stop event is itself the signal. The JSON log carries every phase (`hook_started`, `gate_decision`, `state_saved`, `hook_completed`) for programmatic queries; the text log keeps just the user-facing chain. An aborted hook surfaces `ERROR` (the message verbatim).

### JSON Lines entry types (`.json`)

Every entry has `type: string` (literal discriminator) and `timestamp: string` (local ISO 8601). The fields below are in addition to those two. The on-disk format is one entry per line (JSON Lines); the examples below are pretty-printed for readability.

**`hook_started`** is logged once per invocation, after stdin is parsed and before any other IO.

```json
{
  "type": "hook_started",
  "timestamp": "2026-05-08T14:30:15.000+10:00",
  "cwd": "/path/to/project",
  "projectDir": "/path/to/project",
  "sessionId": "abc-123",
  "stopHookActive": false
}
```

**`config_load`** is logged once per `FileLayer` that loaded successfully. A layer that failed to parse or validate produces no `config_load` entry; a `hook_error` entry is written instead and the hook aborts. The `hashesPath`, `runsDir`, and `logBaseDir` fields tell you up front where this configuration's output is written, without waiting for `state_saved` later in the run.

```json
{
  "type": "config_load",
  "timestamp": "2026-05-08T14:30:15.001+10:00",
  "filePath": ".claude/claude-tools-runner.yaml",
  "triggerCount": 2,
  "hashesPath": "/path/to/project/.claude/claude-tools-runner/hashes.yaml",
  "runsDir": "/path/to/project/.claude/claude-tools-runner/runs",
  "logBaseDir": "/path/to/project/.claude/claude-tools-runner/log"
}
```

**`changed_files`** is logged after every `collectChangedFiles` call resolves. The `files` array is sorted by `path`. Logged even when the count is zero (the hook then exits via the `no_changed_files` skip path).

```json
{
  "type": "changed_files",
  "timestamp": "2026-05-08T14:30:15.005+10:00",
  "count": 2,
  "files": [
    { "path": "src/bar.ts" },
    { "path": "src/foo.ts" }
  ]
}
```

**`trigger_match`** is logged once per evaluated trigger, regardless of whether anything matched. The `unmatchedFiles` field lists files that were considered for this trigger but did not match its `paths` patterns, which is the key signal for debugging "why didn't this trigger fire?".

```json
{
  "type": "trigger_match",
  "timestamp": "2026-05-08T14:30:15.006+10:00",
  "sourceFile": ".claude/claude-tools-runner.yaml",
  "sourceLine": 4,
  "triggerIndex": 0,
  "patterns": ["src/**/*.ts"],
  "matchedFiles": ["src/bar.ts", "src/foo.ts"],
  "unmatchedFiles": []
}
```

**`gate_decision`** is logged once per `CompiledCommand` after `decideGate` resolves. `decision` is `"run"` or `"skip"`; `reason` is one of `first run`, `in cooldown`, `no file changes since last successful run`, `files changed since last run`. `lastFilesHash` and `elapsedSeconds` are omitted when there is no prior run.

```json
{
  "type": "gate_decision",
  "timestamp": "2026-05-08T14:30:15.007+10:00",
  "sourceFile": ".claude/claude-tools-runner.yaml",
  "sourceLine": 4,
  "triggerIndex": 0,
  "commandIndex": 0,
  "expandedRun": "bun run test",
  "expandedCwd": "/path/to/project",
  "filesHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "cooldownSeconds": 30,
  "decision": "run",
  "reason": "first run"
}
```

**`command_started`** is logged once per command actually spawned (i.e. per `gate_decision` whose `decision` was `"run"`). `pid` is `null` when the spawn errored before the `spawn` event fired. `logFile` is the per-command log file path relative to the layer's `scopeDir`.

```json
{
  "type": "command_started",
  "timestamp": "2026-05-08T14:30:15.010+10:00",
  "sourceFile": ".claude/claude-tools-runner.yaml",
  "sourceLine": 4,
  "triggerIndex": 0,
  "commandIndex": 0,
  "expandedRun": "bun run test",
  "expandedCwd": "/path/to/project",
  "pid": 42891,
  "timeoutSeconds": 300,
  "logFile": ".claude/claude-tools-runner/log/2026-05/08/14/30-15-010-5feceb66.log"
}
```

**`command_result`** is logged once per command that completed. `outcome` is `"pass"` (exit 0), `"fail"` (non-zero exit), or `"timeout"` (the per-command kill timer fired). `exitCode` is `-1` for timeouts and spawn errors.

```json
{
  "type": "command_result",
  "timestamp": "2026-05-08T14:30:18.123+10:00",
  "sourceFile": ".claude/claude-tools-runner.yaml",
  "sourceLine": 4,
  "triggerIndex": 0,
  "commandIndex": 0,
  "expandedRun": "bun run test",
  "expandedCwd": "/path/to/project",
  "exitCode": 0,
  "durationMs": 2873,
  "outcome": "pass",
  "logFile": ".claude/claude-tools-runner/log/2026-05/08/14/30-15-010-5feceb66.log"
}
```

**`state_saved`** is logged after each layer's `saveState` resolves. `sourceFile` identifies the layer that was saved. `hashesPath` and `runsDir` are absolute paths to the layer's hash cache and per-command runs directory. The pruning counts come from `saveState`: `prunedCommandRuns` is the number of run files dropped because their `lastRunAt` was older than 30 days or unparseable; `prunedFileHashes` is the number of `fileHashes` entries dropped because nothing in the surviving `commandRuns.matchedFiles` referenced them.

```json
{
  "type": "state_saved",
  "timestamp": "2026-05-08T14:30:18.200+10:00",
  "sourceFile": ".claude/claude-tools-runner.yaml",
  "hashesPath": "/path/to/project/.claude/claude-tools-runner/hashes.yaml",
  "runsDir": "/path/to/project/.claude/claude-tools-runner/runs",
  "commandRunsCount": 1,
  "fileHashesCount": 2,
  "prunedCommandRuns": 0,
  "prunedFileHashes": 0
}
```

**`hook_completed`** is logged last, before `process.exit`. `exitCode` is `0` when the hook finished cleanly (every command passed or every relevant gate skipped) and `2` when the hook hit a fatal error or any user command failed. Exit 2 is the documented Claude Code Stop-hook signal for "blocking error": Claude Code feeds the hook's stderr back to the model on the next turn so failures surface inside the conversation rather than only in the transcript. `skipReason` is present when the hook took an early-skip path; values are `"stop_hook_active"`, `"git_missing"`, `"env_unset"`, `"no_triggers"`, `"no_changed_files"`, `"no_match"`.

```json
{
  "type": "hook_completed",
  "timestamp": "2026-05-08T14:30:18.230+10:00",
  "durationMs": 3104,
  "pass": 1,
  "fail": 0,
  "skip": 0,
  "exitCode": 0
}
```

**`hook_error`** is logged when the top-level `try/catch` catches an unhandled exception. `stack` is captured in the JSON file but omitted from the text rendering. `hook_error` is normally followed by a `hook_completed` with `exitCode: 2`, but `process.exit(2)` may fire before `hook_completed` is written, which is itself a useful signal.

```json
{
  "type": "hook_error",
  "timestamp": "2026-05-08T14:30:15.015+10:00",
  "message": "failed to load .claude/claude-tools-runner.yaml: invalid YAML at line 7",
  "stack": "Error: ..."
}
```

`hook_started` and `hook_completed` always come in pairs unless `hook_error` short-circuits the hook.

## Useful one-liners

Tail the current hour's human-readable log for one configuration:

```sh
tail -f .claude/claude-tools-runner/log/$(date +%Y-%m/%d/%H).log
```

Show the most recent `.log` file regardless of hour:

```sh
ls -t .claude/claude-tools-runner/log/**/*.log | head -1 | xargs tail -f
```

Filter the JSON log for one event type:

```sh
jq 'select(.type == "trigger_match")' .claude/claude-tools-runner/log/**/*.json
```

Find every trigger that evaluated but matched nothing (the canonical "why didn't my command fire?" query):

```sh
jq 'select(.type == "trigger_match" and .matchedFiles == [])' .claude/claude-tools-runner/log/**/*.json
```

Find every command that was skipped, with the reason:

```sh
jq 'select(.type == "gate_decision" and .decision == "skip") | {sourceFile, sourceLine, expandedRun, reason}' .claude/claude-tools-runner/log/**/*.json
```

Find every failed or timed-out command:

```sh
jq 'select(.type == "command_result" and .outcome != "pass")' .claude/claude-tools-runner/log/**/*.json
```

Open a failed command's full output (the `logFile` path is relative to the layer's `scopeDir`):

```sh
jq -r 'select(.type == "command_result" and .outcome == "fail") | .logFile' \
  .claude/claude-tools-runner/log/**/*.json | head -1 | xargs -I{} cat {}
```
