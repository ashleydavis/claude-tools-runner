# Audit Log

Every Stop event processed by the `tools-runner` plugin is recorded to an audit log. One entry is written for each phase of the hook (config load, changed-file collection, trigger match, gate decision, command spawn, command result, state save), bracketed by `hook_started` and `hook_completed` entries. Together they answer questions like *"why didn't my command fire?"* without instrumenting the plugin yourself.

## Location

Two files are written per hour to the same directory:

```
/path/to/project/.claude/tools-runner-log/YYYY-MM/DD/HH.json   ← machine-readable
/path/to/project/.claude/tools-runner-log/YYYY-MM/DD/HH.log    ← human-readable
```

The plugin uses `$CLAUDE_PROJECT_DIR` to locate the project directory. Claude Code always sets it when invoking hooks; if it is unset the plugin skips logging (and exits early via the `env_unset` skip path).

Per-command output logs share the same tree. Inside each hour, the audit-log files (`HH.json`, `HH.log`) sit alongside a `HH/` subdirectory that holds the per-command stdout/stderr captures:

```
/path/to/project/.claude/tools-runner-log/
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

The whole `tools-runner-log/` tree is gitignored by the plugin's own `.gitignore`. To clear it, delete the directory.

## Retention

On every hook invocation the plugin removes month directories older than the current calendar month. Only the current month is kept. Cleanup runs once at the start of the hook (inside `createLogger`) and is awaited before any audit-log entry is written; a missing log directory is tolerated silently.

## Format

**`.json`** is [JSON Lines](https://jsonlines.org/) (NDJSON): one JSON object per line, newline-terminated, UTF-8 encoded. Intended for programmatic querying with tools like `jq`.

**`.log`** is plain text, one line per entry, intended for direct human reading.

All timestamps use ISO 8601 format in local time with timezone offset (e.g. `2026-05-08T14:30:15.123+10:00`). Both files share the same per-invocation `now`, so entries from one hook always end up in the same hour file even if the hook crosses an hour boundary.

`fs.appendFile` (from `node:fs/promises`) is used for every write, so concurrent appends from separate hook invocations interleave at line boundaries safely.

### Human-readable example (`.log`)

```
14:30:15  HOOK     started cwd=/path/to/project stop_hook_active=false
14:30:15  CONFIG   ~/.claude/tools-runner.yaml (0 triggers)
14:30:15  CONFIG   .claude/tools-runner.yaml (2 triggers)
14:30:15  CHANGED  2 file(s): src/foo.ts, src/bar.ts
14:30:15  MATCH    .claude/tools-runner.yaml:4 patterns=src/**/*.ts matched=2/2
14:30:15  MATCH    .claude/tools-runner.yaml:12 patterns=docs/**/*.md matched=0/2
14:30:15  GATE     .claude/tools-runner.yaml:4 cmd=0 RUN: first run
14:30:15  START    .claude/tools-runner.yaml:4 cmd=0 pid=42891 timeout=300s "bun run test"
14:30:18  RESULT   .claude/tools-runner.yaml:4 cmd=0 pass exit=0 2873ms
14:30:18  STATE    .claude/tools-runner-state.yaml (1 runs, 2 hashes; pruned 0+0)
14:30:18  DONE     1P / 0F / 0S in 3104ms exit=0
```

Columns: `HH:MM:SS`, label (left-padded to 9 chars), then the entry detail. Labels in use: `HOOK`, `CONFIG`, `CHANGED`, `MATCH`, `GATE`, `START`, `RESULT`, `STATE`, `DONE`, `ERROR`.

The `<sourceFile>:<sourceLine>` prefix on `MATCH`, `GATE`, `START`, and `RESULT` lines is formatted like an editor-jump location, so most terminals and editors recognise it as a clickable target straight to the trigger in your `tools-runner.yaml`.

For a successful command the full sequence is: `HOOK` → `CONFIG` (one per loaded layer) → `CHANGED` → `MATCH` (one per evaluated trigger, regardless of outcome) → `GATE` (one per compiled command) → `START` → `RESULT` → `STATE` → `DONE`. Skipped commands stop after `GATE`. An aborted hook stops after `ERROR` and may not reach `DONE`.

### JSON Lines entry types (`.json`)

Every entry has `type: string` (literal discriminator) and `timestamp: string` (local ISO 8601). The fields below are in addition to those two.

**`hook_started`** is logged once per invocation, after stdin is parsed and before any other IO.

```json
{"type":"hook_started","timestamp":"2026-05-08T14:30:15.000+10:00","cwd":"/path/to/project","projectDir":"/path/to/project","sessionId":"abc-123","stopHookActive":false}
```

**`config_load`** is logged once per `FileLayer` that loaded successfully. A layer that failed to parse or validate produces no `config_load` entry; a `hook_error` entry is written instead and the hook aborts.

```json
{"type":"config_load","timestamp":"2026-05-08T14:30:15.001+10:00","filePath":".claude/tools-runner.yaml","triggerCount":2}
```

**`changed_files`** is logged after every `collectChangedFiles` call resolves. The `files` array is sorted by `path`. Logged even when the count is zero (the hook then exits via the `no_changed_files` skip path).

```json
{"type":"changed_files","timestamp":"2026-05-08T14:30:15.005+10:00","count":2,"files":[{"path":"src/bar.ts"},{"path":"src/foo.ts"}]}
```

**`trigger_match`** is logged once per evaluated trigger, regardless of whether anything matched. The `unmatchedFiles` field lists files that were considered for this trigger but did not match its `paths` patterns, which is the key signal for debugging "why didn't this trigger fire?".

```json
{"type":"trigger_match","timestamp":"2026-05-08T14:30:15.006+10:00","sourceFile":"/path/to/project/.claude/tools-runner.yaml","sourceLine":4,"triggerIndex":0,"patterns":["src/**/*.ts"],"matchedFiles":["src/bar.ts","src/foo.ts"],"unmatchedFiles":[]}
```

**`gate_decision`** is logged once per `CompiledCommand` after `decideGate` resolves. `decision` is `"run"` or `"skip"`; `reason` is one of `first run`, `in cooldown`, `no file changes since last successful run`, `files changed since last run`. `lastFilesHash` and `elapsedSeconds` are omitted when there is no prior run.

```json
{"type":"gate_decision","timestamp":"2026-05-08T14:30:15.007+10:00","sourceFile":"/path/to/project/.claude/tools-runner.yaml","sourceLine":4,"triggerIndex":0,"commandIndex":0,"expandedRun":"bun run test","expandedCwd":"/path/to/project","filesHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","cooldownSeconds":30,"decision":"run","reason":"first run"}
```

**`command_started`** is logged once per command actually spawned (i.e. per `gate_decision` whose `decision` was `"run"`). `pid` is `null` when the spawn errored before the `spawn` event fired. `logFile` is the per-command log file path relative to `projectDir`.

```json
{"type":"command_started","timestamp":"2026-05-08T14:30:15.010+10:00","sourceFile":"/path/to/project/.claude/tools-runner.yaml","sourceLine":4,"triggerIndex":0,"commandIndex":0,"expandedRun":"bun run test","expandedCwd":"/path/to/project","pid":42891,"timeoutSeconds":300,"logFile":".claude/tools-runner-log/2026-05/08/14/30-15-010-5feceb66.log"}
```

**`command_result`** is logged once per command that completed. `outcome` is `"pass"` (exit 0), `"fail"` (non-zero exit), or `"timeout"` (the per-command kill timer fired). `exitCode` is `-1` for timeouts and spawn errors.

```json
{"type":"command_result","timestamp":"2026-05-08T14:30:18.123+10:00","sourceFile":"/path/to/project/.claude/tools-runner.yaml","sourceLine":4,"triggerIndex":0,"commandIndex":0,"expandedRun":"bun run test","expandedCwd":"/path/to/project","exitCode":0,"durationMs":2873,"outcome":"pass","logFile":".claude/tools-runner-log/2026-05/08/14/30-15-010-5feceb66.log"}
```

**`state_saved`** is logged after `saveState` resolves. The pruning counts come from `saveState`: `prunedCommandRuns` is the number of `commandRuns` entries dropped because their `lastRunAt` was older than 30 days or unparseable; `prunedFileHashes` is the number of `fileHashes` entries dropped because nothing in the surviving `commandRuns.matchedFiles` referenced them.

```json
{"type":"state_saved","timestamp":"2026-05-08T14:30:18.200+10:00","filePath":"/path/to/project/.claude/tools-runner-state.yaml","commandRunsCount":1,"fileHashesCount":2,"prunedCommandRuns":0,"prunedFileHashes":0}
```

**`hook_completed`** is logged last, before `process.exit`. `skipReason` is present when the hook took an early-skip path; values are `"stop_hook_active"`, `"git_missing"`, `"env_unset"`, `"no_triggers"`, `"no_changed_files"`, `"no_match"`.

```json
{"type":"hook_completed","timestamp":"2026-05-08T14:30:18.230+10:00","durationMs":3104,"pass":1,"fail":0,"skip":0,"exitCode":0}
```

**`hook_error`** is logged when the top-level `try/catch` catches an unhandled exception. `stack` is captured in the JSON file but omitted from the text rendering. `hook_error` is normally followed by a `hook_completed` with `exitCode: 1`, but `process.exit(1)` may fire before `hook_completed` is written, which is itself a useful signal.

```json
{"type":"hook_error","timestamp":"2026-05-08T14:30:15.015+10:00","message":"failed to load .claude/tools-runner.yaml: invalid YAML at line 7","stack":"Error: ..."}
```

`hook_started` and `hook_completed` always come in pairs unless `hook_error` short-circuits the hook.

## Useful one-liners

Tail the current hour's human-readable log:

```sh
tail -f .claude/tools-runner-log/$(date +%Y-%m/%d/%H).log
```

Show the most recent `.log` file regardless of hour:

```sh
ls -t .claude/tools-runner-log/**/*.log | head -1 | xargs tail -f
```

Filter the JSON log for one event type:

```sh
jq 'select(.type == "trigger_match")' .claude/tools-runner-log/**/*.json
```

Find every trigger that evaluated but matched nothing (the canonical "why didn't my command fire?" query):

```sh
jq 'select(.type == "trigger_match" and .matchedFiles == [])' .claude/tools-runner-log/**/*.json
```

Find every command that was skipped, with the reason:

```sh
jq 'select(.type == "gate_decision" and .decision == "skip") | {sourceFile, sourceLine, expandedRun, reason}' .claude/tools-runner-log/**/*.json
```

Find every failed or timed-out command:

```sh
jq 'select(.type == "command_result" and .outcome != "pass")' .claude/tools-runner-log/**/*.json
```

Open a failed command's full output (the `logFile` path is relative to `$CLAUDE_PROJECT_DIR`):

```sh
jq -r 'select(.type == "command_result" and .outcome == "fail") | .logFile' \
  .claude/tools-runner-log/**/*.json | head -1 | xargs -I{} cat {}
```
