# Step 12: Command runner

Run gated commands in parallel via Node's async `child_process.spawn` (with an injectable `Spawner` seam for tests), capture each command's stdout+stderr to a per-command log file under `.claude/`, apply per-command timeouts, update state on success, and surface results. There is no global wall-clock cap; per-command `timeout` (default `"5m"`) bounds each spawned command; the hook awaits all of them and exits naturally.

## Source: `./src/runner.ts` (plan section 13.1)

Export:

- `interface RunResult { prepared: CompiledCommand; exitCode: number; durationMs: number; error?: string; filesHash: string; logFile: string; }`: `logFile` is the path of the per-command log file (relative to `projectDir`, e.g. `.claude/tools-runner-log/2026-05/08/14/30-15-123-5feceb66.log`: sits in the `HH/` subdirectory next to the hour's audit log files).

- `interface SpawnedProc { exitCode: number | null; exited: Promise<number>; kill(signal?: NodeJS.Signals | number): boolean; pid: number | undefined; stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null; }`: Node-`ChildProcess`-shaped subset. `exited` is a Promise we wrap around the `close` event (resolves with the exit code, or rejects on `error` for ENOENT etc.). `pid` is `undefined` until the process has actually spawned (Node reports `pid` on the `spawn` event).

- `type Spawner = (cmd: string[], opts: { cwd: string }) => SpawnedProc;`: Wraps Node's `child_process.spawn`. Stdio is wired by the spawner: `stdin` is `"ignore"`, `stdout`/`stderr` are `"pipe"` (the runner reads them to write into the log file). The runner does NOT emit anything to the parent process's stdout/stderr from the child: all child output goes to the log file.

- `const defaultSpawner: Spawner = (cmd, opts) => { const proc = childProcess.spawn(cmd[0]!, cmd.slice(1), { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] }); const exited = new Promise<number>((resolve, reject) => { proc.on("error", reject); proc.on("close", (code) => resolve(code ?? -1)); }); return { exitCode: proc.exitCode, exited, kill: (sig) => proc.kill(sig), pid: proc.pid, stdout: proc.stdout, stderr: proc.stderr }; };`: Imported as `import * as childProcess from "node:child_process"`. The `error`-event listener catches ENOENT for missing binaries and routes it through the `exited` rejection (`runCommands` then surfaces it as `RunResult.error`).

- `interface RunCommandsOptions { spawn?: Spawner; now?: () => Date; logger?: IAuditLogger; logBaseDir?: string; }`:
  - `spawn`: DI seam (Issue 9).
  - `now`: defaults to `() => new Date()`; tests inject a fixed-clock fn so `lastRunAt` and log-file timestamps are deterministic.
  - `logger`: see step 15 (audit log). Defaults to `NullAuditLogger`.
  - `logBaseDir`: root of the unified log tree (defaults to `<projectDir>/.claude/tools-runner-log`; same value as the audit log's base). The runner appends `YYYY-MM/DD/HH/<filename>` itself. Tests pass a `mktemp` dir.

- `async function runCommands(prepared: CompiledCommandConfig[], state: State, now: Date, opts?: RunCommandsOptions): Promise<RunResult[]>`:
  - For each prepared command, await `decideGate`. If `gate.run` is true:
    - **Resolve a log file path** for this command via `resolveCommandLogPath(logBaseDir, startedAt, prepared.commandKey, startedAt.getTime())` (step 15): produces `<logBaseDir>/YYYY-MM/DD/HH/MM-SS-<ms-within-second>-<commandKey-first8>.log`. The hour `HH/` directory sits next to the hour's audit log files (`HH.json` / `HH.log`). `await fs.mkdir(path.dirname(logFile), { recursive: true })` from `node:fs/promises`.
    - **Open the log file** as a write stream: `const out = fs.createWriteStream(logFile, { flags: "w" })` from `node:fs`. Write a header: `> ${expandedRun}\n> cwd: ${expandedCwd}\n> started: ${toLocalISOString(startedAt)}\n---\n`.
    - **Spawn**: `const proc = (opts?.spawn ?? defaultSpawner)(["sh", "-c", expandedRun], { cwd: expandedCwd })`.
    - **Pipe stdout+stderr into the log file with per-line stream tagging.** Each output line is prefixed with `[OUT] ` (stdout) or `[ERR] ` (stderr) so a reader can tell which stream produced it while still seeing the natural interleaving of the two streams. Maintain a per-stream line buffer (`stdoutBuf`, `stderrBuf`, both initially `""`). On each `proc.stdout` `"data"` event, append the chunk's UTF-8 string to `stdoutBuf`, then while the buffer contains a `\n`: split off everything up to and including the first `\n` as `line`, and write `[OUT] ${line}` to `out`. Repeat until no `\n` remains; the residue stays in `stdoutBuf` for the next chunk. The `stderr` handler is identical with `[ERR] ` and `stderrBuf`. After `proc.exited` resolves and before writing the footer, flush any non-empty residue: if `stdoutBuf` is non-empty write `[OUT] ${stdoutBuf}\n` (synthetic trailing newline so the footer starts on a fresh line), then the same for `stderrBuf`. Lines are written when their terminating `\n` arrives, so a stdout line that completes after a stderr line still ends up *after* it in the log: this preserves the chronological interleaving the user would have seen in their own terminal.
    - Await `proc.exited`, all spawns running in parallel via `Promise.all`.
    - Apply the per-command timeout via `Promise.race` against a `setTimeout`-backed promise that calls `proc.kill("SIGTERM")` on expiry, then schedules an unref'd `setTimeout` that calls `proc.kill("SIGKILL")` 2 seconds later in case the process is still alive. Use `setTimeout` from `node:timers/promises` (preferred) or the global with explicit `clearTimeout`. NO blocking sleep.
    - **Close the log file**: after the `exited` promise resolves (or rejects via `error`), write a footer: `---\n> exit: ${exitCode}\n> duration: ${durationMs}ms\n` (or `> killed: timeout` if timed out), then `out.end()` and await its `"finish"` event so the file is durable on disk before `runCommands` returns.
  - On `exitCode === 0`, call `upsertCommandRun(state, { commandKey: prepared.commandKey, expandedRun: prepared.expandedRun, expandedCwd: prepared.expandedCwd, sourceFile: prepared.sourceFile, sourceLine: prepared.sourceLine, lastRunAt: now.toISOString(), lastFilesHash: gate.filesHash, matchedFiles: prepared.matchedFiles.map(file => file.absPath).sort() })`. `sourceFile` and `sourceLine` are copied verbatim from the `CompiledCommand` so the state entry points at the YAML trigger that produced this run; on a shared `commandKey` (home + project trigger collision) the most recent run's location wins.
  - If `gate.run` is false, leave the existing state entry untouched: `lastRunAt`, `lastFilesHash`, and `matchedFiles` all stay at their prior values. NO log file is created for skipped commands (nothing was spawned).
  - The `now: Date` argument is converted to an ISO 8601 string at this boundary; the on-disk YAML never contains a `Date` object.
  - On non-zero exit (including 127 from `sh -c` for missing binary, per Issue 15): do NOT update `lastFilesHash`: the command will re-run next Stop. Return `RunResult.exitCode` with the actual code.
  - On timeout: `proc.kill()`, set `RunResult.error = "timeout"`, `RunResult.exitCode = -1` (pinned convention), do NOT update state.
  - On `error`-event rejection (e.g. ENOENT from spawn: happens if `sh` itself is missing, which is exotic): set `RunResult.error = err.message`, `exitCode = -1`, do NOT update state. The log file's footer records the error.
  - **Audit log entries**: emit `command_started` immediately after spawn (with `logFile` and `pid`), and `command_result` after `exited` (with `logFile`, `outcome`, `exitCode`, `durationMs`). See step 15 for entry shape.
  - Print a one-line summary per command to stdout matching the catalog in plan section "Log line catalog":
    - `[tools-runner] ${sourceFile}:trigger ${triggerIndexInFile} cmd ${commandIndex} cwd=${expandedCwd} run=${expandedRun}: PASS ${reason} (log: ${logFile})` on success.
    - `[tools-runner] ${sourceFile}:trigger ${triggerIndexInFile} cmd ${commandIndex} cwd=${expandedCwd} run=${expandedRun}: FAIL ${reason} (log: ${logFile})` on failure (`reason` is `"exit ${code}"` or `"timeout"`).
    - `[tools-runner] ${sourceFile}:trigger ${triggerIndexInFile} cmd ${commandIndex} cwd=${expandedCwd} run=${expandedRun}: SKIP ${reason}` when gated off (no log file mentioned because none was created).

## Why per-command log files

End-users running `bun run test` (or any other command) inside the Stop hook used to see the output streamed live via `stdio: "inherit"`. Now we capture instead, so the Stop-hook output stays clean (only the catalog log lines) and each command's output lives in a discoverable file. The audit-log entry's `logFile` field links the success/failure record to its full output. Files are auto-cleaned after 1 month (see step 15).

## IO conventions

- `child_process.spawn` from `node:child_process` (NOT `child_process.spawnSync` or `Bun.spawn`).
- `fs.createWriteStream` from `node:fs` for the log file (sync constructor; appends are async / buffered). Using a write stream avoids an `appendFile` call per chunk.
- `setTimeout` from `node:timers/promises` (preferred) or the global with explicit `clearTimeout`. NO `setTimeoutSync`.
- `proc.kill` swallows errors (e.g., `ESRCH` if the process already exited between iterate and kill).
- Log file `path.dirname` is created via `fs.mkdir(..., { recursive: true })` from `node:fs/promises`.

## Tests: `./src/test/runner.test.ts` (plan section 15.10)

All tests use a mocked `Spawner` injected via `opts.spawn`. The mock returns a fake `SpawnedProc` whose `stdout`/`stderr` are `Readable` streams the test can push data into. Cover:

- `runCommands` runs all gated commands in parallel (assert by tracking spawn timestamps and seeing overlap, OR by gating two stubbed procs on a shared barrier promise).
- A successful command writes a `CommandRunEntry` keyed by `commandKey` with the expected hash AND `matchedFiles` as a sorted array of absolute path strings, AND `sourceFile`/`sourceLine` copied verbatim from the input `CompiledCommand`.
- A successful command produces a log file at the expected path under `opts.logBaseDir`. The file contains the header (`> <expandedRun>` etc.), the captured stdout and stderr from the stub each rendered one line per output line and prefixed with `[OUT] ` / `[ERR] ` respectively, and the footer (`> exit: 0`). Push interleaved chunks into the stub `stdout`/`stderr` streams (e.g. stdout `"hello\n"`, stderr `"oops\n"`, stdout `"done\n"`) and assert the log body equals `[OUT] hello\n[ERR] oops\n[OUT] done\n`. Include a separate case where a stream chunk lacks a trailing newline (e.g. stdout `"abc"` then end-of-stream): assert the residue is flushed as `[OUT] abc\n` before the footer.
- A failing command (non-zero exit) does NOT update `lastFilesHash`; the log file's footer records the non-zero exit code.
- A skipped (`run: false`) command leaves the existing `CommandRunEntry` untouched: `lastRunAt`, `lastFilesHash`, and `matchedFiles` all stay at their prior values. NO log file is created.
- **Per-command timeout** (Issue 13): a stubbed `Spawner` returns a never-resolving `exited` promise. With `command.timeout: 0.05` (50 ms), `runCommands` resolves within ~100 ms with `RunResult.error === "timeout"` and `RunResult.exitCode === -1`. Assert `proc.kill` was called. Assert the log file's footer records `> killed: timeout`.
- **ENOENT from the spawn** (e.g. `sh` missing): the `Spawner` returns a `SpawnedProc` whose `exited` rejects with an `ENOENT`-coded error. Assert `RunResult.error` carries the error message, `exitCode === -1`, no state update.

Use `await fs.mkdtemp(...)` for the `logBaseDir`. Tests assert log file contents by reading the file via `fs.readFile` after `runCommands` resolves.

## Verification

- `bun run compile` passes.
- `bun run test` runs all tests green.

Run all tests and confirm they pass before marking this step complete.

## Summary

_To be completed when this step is implemented._
