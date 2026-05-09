# Step 15: Audit log

Add a structured audit log so a user can answer questions like *"why didn't my command fire?"* without instrumenting the plugin themselves. The log writes dual-format output (JSON Lines + human-readable text), rotates hourly, and prunes monthly. All IO is async (`fs.appendFile` / `fs.mkdir` from `node:fs/promises`) per the tools-runner sync-IO ban.

This step is a cross-cutting addition: it creates a new module, retrofits a logger argument into the orchestration paths in `stop-hook.ts` and `runner.ts`, and updates the user docs. Nothing else in the implementation changes.

## 15.1. Source: `./src/audit-log.ts`

Export the entry-type interfaces (each with a literal `type` discriminator and an ISO 8601 `timestamp`), a union type `IAuditLogEntry`, the `IAuditLogger` interface (`async log(entry): Promise<void>`), `NullAuditLogger` (no-op), and `FileAuditLogger`.

### Entry types

Every entry has `type: string` (literal discriminator) and `timestamp: string` (local-ISO-8601 with offset, formatted via a `toLocalISOString(now: Date)` helper). The variants:

| `type` | Emitted | Fields beyond base |
|---|---|---|
| `hook_started` | First entry per invocation, immediately after stdin is parsed | `cwd`, `projectDir` (from `$CLAUDE_PROJECT_DIR`: explicitly recorded so the audit log shows the working context), `sessionId?`, `stopHookActive: boolean` |
| `config_load` | After each `FileLayer.create` resolves successfully | `filePath` (display path), `triggerCount` |
| `changed_files` | After all `collectChangedFiles` calls complete | `count`, `files: Array<{ path: string }>`: each changed file. Sorted by `path`. |
| `trigger_match` | One per trigger evaluated (every trigger, regardless of outcome) | `sourceFile`, `sourceLine`, `triggerIndex`, `patterns: string[]`, `matchedFiles: string[]`, `unmatchedFiles: string[]` |
| `gate_decision` | One per `CompiledCommand`, after `decideGate` resolves | `sourceFile`, `sourceLine`, `triggerIndex`, `commandIndex`, `expandedRun`, `expandedCwd`, `filesHash`, `lastFilesHash?`, `cooldownSeconds`, `elapsedSeconds?`, `decision: "run" \| "skip"`, `reason: string` |
| `command_started` | Per command actually spawned (gate decided `run`) | `sourceFile`, `sourceLine`, `triggerIndex`, `commandIndex`, `expandedRun`, `expandedCwd`, `pid` (`number \| null`; Node sets it on the `spawn` event but it can be `null` if the spawn errored before then), `timeoutSeconds`, `logFile: string` (path to the per-command log file, relative to `projectDir`) |
| `command_result` | Per command that completed (success, fail, or timeout) | `sourceFile`, `sourceLine`, `triggerIndex`, `commandIndex`, `expandedRun`, `expandedCwd`, `exitCode` (use `-1` for timeout or spawn error), `durationMs`, `outcome: "pass" \| "fail" \| "timeout"`, `logFile: string` (same value as the paired `command_started` entry) |

The `sourceFile` + `sourceLine` pair pinpoints the YAML trigger that produced the entry: a user reading the log can navigate straight to the line in their `tools-runner.yaml` that fired (or didn't fire). `sourceLine` is the 1-based line number set by `loadConfigFile` (step 3) and copied through `Trigger` → `CompiledCommand`. `triggerIndex` is retained alongside it as a stable disambiguator (e.g. for tooling that aggregates by index) but `sourceLine` is the human-facing locator.
| `state_saved` | After `saveState` resolves | `filePath`, `commandRunsCount`, `fileHashesCount`, `prunedCommandRuns: number`, `prunedFileHashes: number` |
| `hook_completed` | Last entry per invocation (paired with `hook_started`) | `durationMs`, `pass`, `fail`, `skip`, `exitCode: 0 \| 1`, `skipReason?: "stop_hook_active" \| "git_missing" \| "env_unset" \| "no_triggers" \| "no_changed_files" \| "no_match"` |
| `hook_error` | Top-level `try/catch` caught an unhandled exception | `message`, `stack?` |

`hook_started` and `hook_completed` always come in pairs *except* when `hook_error` is followed by `process.exit(1)`: in that case `hook_completed` may not get written, which is itself a useful signal.

### `IAuditLogger`

```ts
interface IAuditLogger {
    log(entry: IAuditLogEntry): Promise<void>;
}
```

Async return is required by the sync-IO ban. Callers `await logger.log(...)` so each entry is durable on disk before the next event is processed.

### `NullAuditLogger`

No-op implementation. `async log() {}`. Used by tests and when `CLAUDE_PROJECT_DIR` is unset.

### `FileAuditLogger`

Constructor: `constructor(baseDir: string, now: Date)`. Stores both for later use. The single timestamp `now` is used for ALL log file paths in this invocation: entries from one hook always end up in the same hour file, even if execution crosses an hour boundary.

`async log(entry)`:
1. `const jsonPath = resolveJsonLogPath(this.baseDir, this.now)`: `<baseDir>/YYYY-MM/DD/HH.json`.
2. `const textPath = resolveTextLogPath(this.baseDir, this.now)`: `<baseDir>/YYYY-MM/DD/HH.log`.
3. `await fs.mkdir(path.dirname(jsonPath), { recursive: true })` (`node:fs/promises`).
4. `await fs.appendFile(jsonPath, JSON.stringify(entry) + "\n")`.
5. `await fs.appendFile(textPath, formatTextEntry(entry) + "\n")`.

`fs.appendFile` opens with `O_APPEND` semantics, so concurrent appends from separate processes interleave at line boundaries safely (POSIX guarantee for writes < `PIPE_BUF`).

### `formatTextEntry(entry: IAuditLogEntry): string`

Human-readable rendering. Format: `HH:MM:SS  LABEL    <details>`. Labels (left-padded to 9 chars): `HOOK`, `CONFIG`, `CHANGED`, `MATCH`, `GATE`, `START`, `RESULT`, `STATE`, `TIMEOUT`, `DONE`, `ERROR`.

Per-entry rendering:

- `hook_started` → `HOOK     started cwd=<cwd> stop_hook_active=<bool>`
- `config_load` → `CONFIG   <filePath> (N triggers)`. (Only emitted on successful loads; a parse or validation error is reported via `hook_error` instead, after which the hook aborts.)
- `changed_files` → `CHANGED  N file(s): <comma-list>` (truncate if list is too long; full list is in JSON)
- `trigger_match` → `MATCH    <sourceFile>:<sourceLine> patterns=<...> matched=N/<total>` (full match/unmatch lists in JSON only)
- `gate_decision` → `GATE     <sourceFile>:<sourceLine> cmd=<commandIndex> <decision>: <reason>` (e.g. `RUN: first run`, `SKIP: in cooldown`)
- `command_started` → `START    <sourceFile>:<sourceLine> cmd=<commandIndex> pid=<pid> timeout=<n>s "<expandedRun>"`
- `command_result` → `RESULT   <sourceFile>:<sourceLine> cmd=<commandIndex> <outcome> exit=<code> <duration>ms`

The `<sourceFile>:<sourceLine>` prefix is intentionally formatted like an editor-jump location (`path/to/file.yaml:42`) so most terminals will let users click or `gf` straight to the trigger that produced the entry. `commandIndex` is appended as a named token to disambiguate when a trigger has multiple commands. `triggerIndex` is omitted from the human-readable log (it's redundant with the source line); it's still emitted in the JSON form for programmatic correlation.
- `state_saved` → `STATE    <filePath> (<commandRunsCount> runs, <fileHashesCount> hashes; pruned <prunedCommandRuns>+<prunedFileHashes>)`
- `hook_completed` → `DONE     <pass>P / <fail>F / <skip>S in <durationMs>ms exit=<exitCode>` (with optional `skip=<reason>` if early-exit)
- `hook_error` → `ERROR    <message>` (stack only in JSON)

### Path helpers

Audit logs and per-command logs share one tree. Inside each hour, the audit log is two files (`HH.json` and `HH.log`); per-command logs go into a sibling subdirectory `HH/` so they're easy to find next to the audit entries that reference them:

```
<projectDir>/.claude/tools-runner-log/
  2026-05/
    08/
      14.json                  <- audit log (machine-readable)
      14.log                   <- audit log (human-readable)
      14/                      <- per-command logs from 14:00-14:59
        30-15-123-5feceb66.log
        30-22-456-2c26b46b.log
      15.json
      15.log
      15/
        ...
```

Helpers:
- `resolveLogBaseDir(projectDir)` → `<projectDir>/.claude/tools-runner-log`
- `resolveJsonLogPath(baseDir, now)` → `<baseDir>/YYYY-MM/DD/HH.json`
- `resolveTextLogPath(baseDir, now)` → `<baseDir>/YYYY-MM/DD/HH.log`
- `resolveCommandLogDir(baseDir, now)` → `<baseDir>/YYYY-MM/DD/HH` (the directory; `runner.ts` calls this then appends a filename)
- `resolveCommandLogPath(baseDir, now, commandKey, startMs)` → `<commandLogDir>/MM-SS-<startMs % 1000>-<commandKey-first8>.log` (used by `runner.ts`). The minute, second, and millisecond-within-second are zero-padded; the 8-char `commandKey` prefix disambiguates concurrent commands that started in the same millisecond.

All time components are zero-padded, local time. Filesystem-wise, `HH.json`/`HH.log` (files) and `HH/` (directory) coexist fine in the same parent.

### Cleanup

`async function cleanupOldMonths(baseDir: string, now: Date): Promise<void>`:
- `await fs.readdir(baseDir)` (catch `ENOENT`, return).
- For each entry matching `/^(\d{4})-(\d{2})$/`, compute `entryMonthKey = year * 12 + (month - 1)`.
- If `entryMonthKey < currentMonthKey`, `await fs.rm(path.join(baseDir, entry), { recursive: true, force: true })`.
- Keeps only the current month. Anything from a previous month is purged.

### `createLogger(projectDir, now): Promise<FileAuditLogger>`

```ts
async function createLogger(projectDir: string, now: Date): Promise<FileAuditLogger> {
    const baseDir = resolveLogBaseDir(projectDir);
    await cleanupOldMonths(baseDir, now);
    return new FileAuditLogger(baseDir, now);
}
```

`createLogger` is async because cleanup is async. The Stop hook awaits it once, before any other event would fire.

The Stop hook also passes `baseDir` into `runCommands` via `RunCommandsOptions.logBaseDir` so the runner knows where to write per-command log files.

## 15.2. Retrofit existing modules

### `src/stop-hook.ts` (step 13)

Most events emit from here. Add the logger to `runStopHook`:

```ts
async function runStopHook(): Promise<void> {
    const startedAt = Date.now();
    const now = new Date();
    let logger: IAuditLogger = new NullAuditLogger();
    try {
        const input = await parseStdin();
        const projectDir = process.env["CLAUDE_PROJECT_DIR"];
        if (!projectDir) {
            // Emit hook_error to stderr; no logger yet. Exit 1.
        }
        logger = await createLogger(projectDir, now);
        await logger.log({ type: "hook_started", timestamp: toLocalISOString(now), cwd: process.cwd(), projectDir, sessionId: input.session_id, stopHookActive: !!input.stop_hook_active });
        // ... continue with all the existing stages, awaiting logger.log(...) at each event boundary
    } catch (err) {
        await logger.log({ type: "hook_error", timestamp: toLocalISOString(new Date()), message: String(err), stack: err instanceof Error ? err.stack : undefined });
        await logger.log({ type: "hook_completed", timestamp: toLocalISOString(new Date()), durationMs: Date.now() - startedAt, pass: 0, fail: 0, skip: 0, exitCode: 1 });
        process.stderr.write(String(err) + "\n");
        process.exit(1);
    }
}
```

Concrete event emissions in order:
1. `hook_started`: after stdin parsed, before any other IO.
2. Early skip events: if `stop_hook_active`, log `hook_completed` with `skipReason: "stop_hook_active"` and return. Same pattern for `git_missing`, `env_unset`, `no_triggers`, `no_changed_files`, `no_match`.
3. `config_load`: emit one entry per successfully resolved `await FileLayer.create(...)`. Compute `triggerCount = layer.triggers().length`. If `FileLayer.create` rejects (parse or validation error), no `config_load` entry is written for that layer; the rejection propagates to the top-level `try/catch`, which writes the error to stderr, emits a `hook_error` entry, and exits 1. (`config_load` entries written for layers loaded *before* the failing one stay in the audit log.)
4. `changed_files`: after all `collectChangedFiles` calls complete. Even if the array is empty (the early-skip path will fire next).
5. `trigger_match`: one per trigger. Emit even when matched is empty (helps debug "why didn't this trigger fire").
6. `gate_decision`: for each `CompiledCommand`, after `decideGate` resolves.
7. `command_started`: emitted from `runCommands` (see below), threaded via the existing `RunCommandsOptions`.
8. `command_result`: same.
9. `state_saved`: after `await saveState`. The pruning counts come from `saveState` itself; extend its return type to include them (currently returns `void`).
10. `hook_completed`: last, before `process.exit(0)`. `pass/fail/skip` counts come from accumulating `RunResult[]` outcomes.

### `src/runner.ts` (step 12)

Extend `RunCommandsOptions` with `logger?: IAuditLogger` (defaulting to `NullAuditLogger`). Inside `runCommands`, after spawning a process:

```ts
await logger.log({ type: "command_started", timestamp: toLocalISOString(new Date()), sourceFile, sourceLine, triggerIndex, commandIndex, expandedRun, expandedCwd, pid: proc.pid, timeoutSeconds });
```

After `await proc.exited` (or the timeout race resolving):

```ts
await logger.log({ type: "command_result", timestamp: toLocalISOString(new Date()), sourceFile, sourceLine, triggerIndex, commandIndex, expandedRun, expandedCwd, exitCode, durationMs, outcome });
```

(`sourceLine` is read from each `CompiledCommand` alongside `sourceFile`, `triggerIndexInFile`, and `commandIndex`. Step 10 stamps it onto the `CompiledCommand` from `Trigger.sourceLine`.)

`outcome` is derived from the `RunResult`: `exitCode === 0` → `"pass"`, `error === "timeout"` → `"timeout"`, otherwise `"fail"`.

### `src/trigger-registry.ts` (step 4)

`FileLayer.create` does not catch parse or validation errors thrown by `loadConfigFile`: the rejection propagates to the stop-hook's top-level `try/catch`, which writes `[tools-runner] failed to load ${displayFile}: ${err.message}` to stderr and emits a `hook_error` audit-log entry before exiting 1. No `loadError` field is needed on `FileLayer`.

### `src/state.ts` (step 5)

Extend `saveState` to return `{ prunedCommandRuns: number; prunedFileHashes: number }` instead of `void`. The stop-hook reads this and emits `state_saved`.

### Other modules

`config.ts`, `compile.ts`, `gate.ts`, `hash.ts` need NO changes.

## 15.3. Update `.gitignore` (plan section 1.2 / step 2)

Add a line for the log directory:

```
.claude/tools-runner-log/
```

## 15.4. Tests: `./src/test/audit-log.test.ts`

- `toLocalISOString` formats a known `Date` deterministically (use a fixed timezone-aware `Date` value).
- `resolveLogBaseDir`, `resolveJsonLogPath`, `resolveTextLogPath` produce the expected zero-padded paths for a given `now`.
- `formatTextEntry` produces the expected one-line string for one example of each variant. Cover at least: `hook_started`, `config_load`, `trigger_match` (some matched, none matched), `gate_decision` (run and skip), `command_result` (pass, fail, timeout), `hook_completed` (full and early-skip), `hook_error`. For every variant that includes `sourceFile`/`sourceLine` (`trigger_match`, `gate_decision`, `command_started`, `command_result`), assert the rendered prefix contains `<sourceFile>:<sourceLine>` exactly (e.g. `.claude/tools-runner.yaml:42`).
- `NullAuditLogger.log` returns a resolved Promise and writes nothing.
- `FileAuditLogger.log` (write to a `mkdtemp` directory):
  - Creates `YYYY-MM/DD/HH.json` and `HH.log` in the right locations.
  - Appends one JSON line and one text line per call.
  - Two calls produce two lines in each file.
  - Concurrent calls (`Promise.all` over five logs) end up with five lines in each file (no interleaving within a line).
- `cleanupOldMonths` deletes `YYYY-MM` dirs older than 2 months back from `now`, leaves the current and last 2 alone, and tolerates `ENOENT` on `baseDir`.
- `createLogger` runs `cleanupOldMonths` and returns a `FileAuditLogger` rooted at `<projectDir>/.claude/tools-runner-log`.

`stop-hook.test.ts` (step 13) gains a few cases:
- A no-op invocation (recursion guard) writes `hook_started` + `hook_completed` with `skipReason: "stop_hook_active"`.
- A successful invocation with one matching trigger writes the full pipeline: `hook_started`, `config_load` x 2 (home + project), `changed_files`, `trigger_match`, `gate_decision`, `command_started`, `command_result`, `state_saved`, `hook_completed`. Assert the `trigger_match`, `gate_decision`, `command_started`, and `command_result` JSON entries each carry a `sourceLine: number` matching the line at which the matching trigger appears in the project's YAML fixture (use a fixture where the trigger sits on a specific known line, e.g. line 4, and assert `sourceLine === 4`).
- A YAML parse error writes a `hook_error` audit-log entry (no `config_load` entry for the failing layer), the stderr line `[tools-runner] failed to load ...`, and the hook exits 1.

`runner.test.ts` (step 12) gains:
- `runCommands` calls `logger.log` with `command_started` then `command_result` for each spawn (assert on a stub logger). Both entries carry the prepared command's `sourceLine` value verbatim. When `logger` is omitted, no calls happen (defaults to `NullAuditLogger`).
- A timed-out command produces `command_result` with `outcome: "timeout"` and `exitCode: -1`.

## 15.5. Documentation updates

### `docs/CONFIGURATION.md`

Add a new "Audit log" section before "Troubleshooting":

> ## Audit log
>
> Every Stop event is recorded to `<project>/.claude/tools-runner-log/YYYY-MM/DD/HH.{json,log}`. The `.json` file is JSON Lines (one JSON object per line, machine-readable); the `.log` file is the same events rendered as plain text for humans. Files rotate hourly; directories older than 2 months are deleted automatically.
>
> Each invocation writes a `hook_started` entry, a series of intermediate entries (config loads, changed files, per-trigger match results, per-command gate decisions, command starts and results), and a closing `hook_completed`. Use the audit log to answer questions like *"why didn't my command fire?"*: the `trigger_match` entries show every changed file alongside the trigger's `paths` and which side it landed on.
>
> Every entry that references a trigger (`trigger_match`, `gate_decision`, `command_started`, `command_result`) includes both `sourceFile` and `sourceLine`, so the human-readable log lines are prefixed with `path/to/tools-runner.yaml:42` (the line where that trigger begins in your YAML). Most terminals and editors recognise this `path:line` shape as a jump target.
>
> The audit log is gitignored by the plugin's own `.gitignore`. To clear it, delete the directory.

### `docs/HOW_IT_WORKS.md`

Add a brief "Audit log" section near the bottom, with a small bullet list of entry types and a one-line description of each. Reference the location and the dual-format output. Note that the entry-type list is canonical (smoke / unit tests assert on these types).

### `docs/DEVELOPMENT.md`

Add a "Inspecting the audit log" subsection under "Testing and type-checking" pointing at the log location and showing one-liner inspection commands:

```bash
# Tail the most recent text log
ls -t .claude/tools-runner-log/**/*.log | head -1 | xargs tail -f

# Filter the JSON log for a specific event type
jq 'select(.type == "trigger_match")' .claude/tools-runner-log/YYYY-MM/DD/HH.json
```

## Verification

- `bun run compile` passes.
- `bun run test` runs all tests including the new `audit-log.test.ts` and the augmented `stop-hook.test.ts` / `runner.test.ts`.
- `bun run smoke` produces a populated `.claude/tools-runner-log/` directory after a Stop. Inspect at least one `.json` and one `.log` file and confirm the expected entries are present.
- `bun run hook-smoke` is unaffected.
- A grep for sync IO calls (`appendFileSync`, `mkdirSync`, `rmSync`, `readdirSync`) in `src/audit-log.ts` returns no matches.

## Summary

Implemented the audit log end-to-end and threaded it through the existing pipeline.

**New module: `src/audit-log.ts`.** Defines the ten entry interfaces (`hook_started`, `config_load`, `changed_files`, `trigger_match`, `gate_decision`, `command_started`, `command_result`, `state_saved`, `hook_completed`, `hook_error`) as a discriminated union, plus the `IAuditLogger` interface, `NullAuditLogger`, `FileAuditLogger`, the path helpers (`resolveLogBaseDir`, `resolveJsonLogPath`, `resolveTextLogPath`, `resolveCommandLogDir`), `formatTextEntry` with a `renderEntryBody`/`labelFor` split, `cleanupOldMonths`, `createLogger`, and `toLocalISOString`. All IO is async (`fs.appendFile`, `fs.mkdir`, `fs.readdir`, `fs.rm`, `fs.writeFile` from `node:fs/promises`). `createLogger` also drops a `.gitignore` containing `*` at the audit-log root so the directory's contents stay invisible to `git status` (without it, the very first `hook_started` write turns an idle Stop event into a busy one, because the file would surface in `collectChangedFiles`).

**`src/runner.ts` retrofit.** Removed the local `IAuditLogger`, `NullAuditLogger`, `IAuditCommandStartedRecord`, `IAuditCommandResultRecord`, and `CommandOutcome` declarations and imported the unified `IAuditLogger` / `NullAuditLogger` / `AuditCommandOutcome` from `audit-log.ts`. `runOneCommand` now emits `gate_decision` (with `lastFilesHash`, `cooldownSeconds`, `elapsedSeconds`), `command_started`, and `command_result` via the single `logger.log(entry)` seam. `RunCommandsOptions` gained a `projectDir?` field used to relativise the `logFile` field in audit entries (`RunResult.logFile` stays absolute). The runner reads `findCommandRun` to populate the `gate_decision` deltas without re-walking state.

**`src/state.ts`.** `saveState` now returns `SaveStateResult` (`{ prunedCommandRuns, prunedFileHashes }`) so the Stop hook can emit a populated `state_saved` entry without recomputing prune counts. The TTL-prune loop counts drops; the orphan-cascade counts the `fileHashes` delta.

**`src/trigger-registry.ts`.** Added `triggerCount(): number` and `evaluateMatches(changed): ITriggerMatchInfo[]` to `ITriggerLayer` (with implementations on both `StaticLayer` and `FileLayer`). Match evaluation reuses `matchFiles` from `matcher.ts` so the audit-log emission and the compile path agree on which files matched. Layer triggers themselves remain private; only the per-trigger summary leaks.

**`src/stop-hook.ts`.** `runStopHook` now wires `createLogger` after the env check and emits the full event sequence (`hook_started` → per-layer `config_load` → `changed_files` → per-trigger `trigger_match` → `state_saved` → `hook_completed`). Each early-skip path writes `hook_completed` with the right `skipReason` (`stop_hook_active`, `git_missing`, `no_triggers`, `no_changed_files`, `no_match`). Routine error paths (YAML load failures, save-state failures) throw a private `HookHandledError` so the outer `try/catch` can write the `hook_error` audit entry uniformly while the canonical stderr line is still emitted at the throw site. The recursion guard makes a best-effort attempt to initialise the logger when `CLAUDE_PROJECT_DIR` is set so the no-op recursion path is auditable too.

**`.gitignore`.** Already contained `.claude/tools-runner-log/` — no change needed.

**Tests.** Added `src/test/audit-log.test.ts` (49 cases covering the helpers, formatters, `NullAuditLogger`, `FileAuditLogger` including concurrent writes, `cleanupOldMonths` with the 2-month retention, and `createLogger` including the auto-`.gitignore`). Augmented `src/test/runner.test.ts` with a `RecordingAuditLogger` and three new cases (gate/start/result emission with `sourceLine` matching, timeout outcome, default `NullAuditLogger` behaviour). Augmented `src/test/stop-hook.test.ts` with three new cases (recursion-guard pair, full pipeline with `sourceLine` assertions, YAML parse error producing `hook_error`). Updated `trigger-registry.test.ts` to satisfy the widened `ITriggerLayer` shape.

**Docs.** Updated `docs/AUDIT-LOG.md` to reflect the 2-month retention (was "current month only"). Updated `docs/HOW_IT_WORKS.md` retention paragraph likewise. Added an "Inspecting the audit log" subsection to `docs/DEVELOPMENT.md` with the recommended `tail` and `jq` recipes. `docs/CONFIGURATION.md` already had an audit-log paragraph in Troubleshooting that remained accurate.

**Divergences from the original step:**

1. **Retention window.** The plan's pseudocode in 15.1 ("Anything from a previous month is purged") conflicted with the test contract ("leaves the current and last 2 alone") and the existing AUDIT-LOG.md doc ("older than 2 months are deleted"). I went with 2-month retention since two pieces of spec agreed on it; updated the conflicting AUDIT-LOG.md / HOW_IT_WORKS.md retention paragraphs.
2. **`gate_decision` emission location.** The plan's "concrete event emissions in order" lists `gate_decision` as a stop-hook event, but `decideGate` only runs inside `runner.ts`. To avoid moving `decideGate`, I emit `gate_decision` from `runOneCommand` using the same logger threaded into `runCommands`. The chronological order remains intact (gate_decision precedes command_started for each command).
3. **Auto-`.gitignore` inside the audit-log dir.** Not explicitly required by the plan, but mandatory to make the test "triggers configured but no changed files prints the canonical skip line" pass: writing `hook_started` to disk before `collectChangedFiles` would otherwise create untracked files that turn an idle Stop event busy.
4. **Recursion-guard logger init.** The plan envisaged `hook_started`/`hook_completed` for every invocation including the recursion path. I implemented this as best-effort: only when `CLAUDE_PROJECT_DIR` is set. The existing test "stop_hook_active=true short-circuits before scanning configs or env checks" deliberately leaves it unset, so the recursion path there stays NullAuditLogger-backed. A new test exercises the "set `CLAUDE_PROJECT_DIR` + recursion" combination.
