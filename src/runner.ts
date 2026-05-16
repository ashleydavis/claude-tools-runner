import * as childProcess from "node:child_process";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuditCommandOutcome, IAuditLogger, NullAuditLogger, toLocalISOString as toAuditLocalISOString } from "./audit-log";
import { GateDecision, decideGate } from "./gate";
import { findCommandRun, upsertCommandRun } from "./state";
import { CompiledCommand, State } from "./types";

// Default per-command timeout in seconds when `CommandConfig.timeout` is unset. Mirrors `parseDuration("5m")`.
const DEFAULT_TIMEOUT_SECONDS: number = 300;

// Default cooldown in seconds when `CommandConfig.cooldown` is unset. Mirrors `parseDuration("1m")`. Used by
// the audit-log `gate_decision` entry so the persisted cooldown reflects the value `decideGate` actually used.
const DEFAULT_COOLDOWN_SECONDS: number = 60;

// Grace period (in milliseconds) between SIGTERM and the follow-up SIGKILL when a command exceeds its
// timeout. Gives the process a brief window to flush stdio and exit cleanly before being force-killed.
const KILL_GRACE_MS: number = 2000;

// One element of the array returned by `runCommands`. Carries the prepared command, the gate-time files
// hash, the chosen log-file path, and the execution outcome.
export interface RunResult {
    // The prepared command this result corresponds to. Returned verbatim so callers can correlate.
    prepared: CompiledCommand;
    // Numeric exit code: 0 on success, the actual non-zero code on failure, -1 on timeout / spawn error,
    // 0 on a gate-skipped command (no spawn happened).
    exitCode: number;
    // Wall-clock duration in milliseconds from spawn to exit. Zero for gate-skipped commands.
    durationMs: number;
    // Optional error string. `"timeout"` when the per-command timer fired, the system error message when
    // `proc.exited` rejected (e.g. ENOENT from spawn), undefined otherwise.
    error?: string;
    // SHA-256 hex digest of the matched files at gate-decision time. Carried through so callers can audit.
    filesHash: string;
    // Absolute path of the per-command log file. Empty string when the command was gate-skipped (no log).
    logFile: string;
}

// Options object passed to a `Spawner`. Mirrors the subset of `child_process.spawn` opts the runner needs.
export interface ISpawnerOptions {
    // Working directory to spawn the process in.
    cwd: string;
}

// Node-`ChildProcess`-shaped subset that the runner consumes. The DI seam (`Spawner`) returns this so test
// stubs can supply a fake without depending on `node:child_process`.
export interface SpawnedProc {
    // Process exit code at the moment the spawner was created (typically `null` until the process exits).
    exitCode: number | null;
    // Promise that resolves with the exit code when the process closes, or rejects on an `error` event.
    exited: Promise<number>;
    // Sends a signal to the process. Returns true on success.
    kill(signal?: NodeJS.Signals | number): boolean;
    // OS process id of the spawned child. Undefined until the `spawn` event fires.
    pid: number | undefined;
    // Stdout stream of the child, or null when stdio[1] was not piped.
    stdout: NodeJS.ReadableStream | null;
    // Stderr stream of the child, or null when stdio[2] was not piped.
    stderr: NodeJS.ReadableStream | null;
}

// Function shape used to spawn a child process. Allows tests to inject stubs that resolve/reject `exited`
// on a barrier so parallelism, timeouts, and ENOENT handling can be exercised without real processes.
export type Spawner = (cmd: string[], opts: ISpawnerOptions) => SpawnedProc;

// Default `Spawner`: wraps Node's `child_process.spawn` with stdin ignored and stdout/stderr piped so the
// runner can capture child output into the per-command log file. The `error`-event listener routes ENOENT
// (e.g. missing `sh`) through the `exited` rejection; the runner surfaces it as `RunResult.error`.
export const defaultSpawner: Spawner = (cmd, opts) => {
    const proc = childProcess.spawn(cmd[0]!, cmd.slice(1), { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number>((resolve, reject) => {
        proc.on("error", reject);
        proc.on("close", (code) => resolve(code ?? -1));
    });
    return {
        exitCode: proc.exitCode,
        exited,
        kill: (signal) => proc.kill(signal),
        pid: proc.pid,
        stdout: proc.stdout,
        stderr: proc.stderr,
    };
};

// Optional knobs accepted by `runCommands`. Every field is a DI seam: production calls `runCommands`
// without `opts`, while tests inject deterministic clocks, stub spawners, and a `mktemp` log directory.
export interface RunCommandsOptions {
    // Override for the `Spawner`. Defaults to `defaultSpawner` (Node's `child_process.spawn` wrapper).
    spawn?: Spawner;
    // Override for the per-command "now" clock. Defaults to `() => new Date()`. Tests pin this to a fixed
    // clock so log-file paths and `lastRunAt` strings are deterministic.
    now?: () => Date;
    // Override for the audit logger. Defaults to `NullAuditLogger` (no-op).
    logger?: IAuditLogger;
    // Root of the unified per-command log file tree. Defaults to `<cwd>/.claude/claude-tools-runner/log`.
    // The runner appends `YYYY-MM/DD/HH/<filename>` itself. Tests pass an `fs.mkdtemp` directory.
    logBaseDir?: string;
    // Project directory used to relativise `logFile` paths in audit-log entries (the entries record paths
    // relative to `projectDir` so the audit log stays portable). Defaults to deriving from `logBaseDir`
    // (`<logBaseDir>/../../..`). `RunResult.logFile` always stays absolute regardless of this option.
    projectDir?: string;
}

// Computes the per-command log file path for `startedAt`. Layout: `<logBaseDir>/YYYY-MM/DD/HH/MM-SS-<ms>-<keyShort>.log`.
// The `HH/` directory sits next to the hour's audit log files (`HH.json` / `HH.log`) that step 15 writes.
export function resolveCommandLogPath(logBaseDir: string, startedAt: Date, commandKey: string): string {
    const yearPart = String(startedAt.getFullYear()).padStart(4, "0");
    const monthPart = String(startedAt.getMonth() + 1).padStart(2, "0");
    const dayPart = String(startedAt.getDate()).padStart(2, "0");
    const hourPart = String(startedAt.getHours()).padStart(2, "0");
    const minutePart = String(startedAt.getMinutes()).padStart(2, "0");
    const secondPart = String(startedAt.getSeconds()).padStart(2, "0");
    const millisPart = String(startedAt.getMilliseconds()).padStart(3, "0");
    const keyShort = commandKey.slice(0, 8);
    return path.join(
        logBaseDir,
        `${yearPart}-${monthPart}`,
        dayPart,
        hourPart,
        `${minutePart}-${secondPart}-${millisPart}-${keyShort}.log`,
    );
}

// Formats a `Date` as a local-time ISO 8601 string with a trailing timezone offset (e.g.
// `2026-05-09T14:30:15.123+10:00`). Used for the human-readable `> started:` header in each per-command
// log file. Local time is preferred over UTC here because users grep these files alongside their own
// terminal output.
export function toLocalISOString(value: Date): string {
    const offsetMinutes = -value.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absOffset = Math.abs(offsetMinutes);
    const offHours = String(Math.floor(absOffset / 60)).padStart(2, "0");
    const offMinutes = String(absOffset % 60).padStart(2, "0");
    const yearPart = String(value.getFullYear()).padStart(4, "0");
    const monthPart = String(value.getMonth() + 1).padStart(2, "0");
    const dayPart = String(value.getDate()).padStart(2, "0");
    const hourPart = String(value.getHours()).padStart(2, "0");
    const minutePart = String(value.getMinutes()).padStart(2, "0");
    const secondPart = String(value.getSeconds()).padStart(2, "0");
    const millisPart = String(value.getMilliseconds()).padStart(3, "0");
    return `${yearPart}-${monthPart}-${dayPart}T${hourPart}:${minutePart}:${secondPart}.${millisPart}${sign}${offHours}:${offMinutes}`;
}

// Returns a `flush` callback for one child stream. While the source emits, the function buffers chunks,
// splits on `\n`, and writes each completed line into `writeStream` prefixed with `tag` (e.g. `"[OUT] "`).
// When the stream ends without a trailing newline, the caller invokes the returned `flush` to write the
// residue with a synthetic newline so the log footer always starts on a fresh line.
export function pipeStreamWithTag(source: NodeJS.ReadableStream | null, writeStream: nodeFs.WriteStream, tag: string): () => void {
    if (source === null) {
        return () => {
        };
    }
    let buffer = "";
    source.on("data", (chunk) => {
        const text = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
        buffer += text;
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex + 1);
            buffer = buffer.slice(newlineIndex + 1);
            writeStream.write(`${tag}${line}`);
            newlineIndex = buffer.indexOf("\n");
        }
    });
    return () => {
        if (buffer.length > 0) {
            writeStream.write(`${tag}${buffer}\n`);
            buffer = "";
        }
    };
}

// Awaits the close of a `WriteStream`. The `end()` callback resolves once the file's contents are durable
// on disk so callers can read the log file back deterministically after `runCommands` resolves.
export function endWriteStream(writeStream: nodeFs.WriteStream): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        writeStream.end((err: NodeJS.ErrnoException | null | undefined) => {
            if (err) {
                reject(err);
                return;
            }
            resolve();
        });
    });
}

// Calls `proc.kill(signal)` while swallowing errors. Production `kill` returns false rather than throwing
// when the process is already gone, but a stub `Spawner` may throw, and `ESRCH` from a real kernel race is
// also benign. Errors here would tear down the runner for no diagnostic gain.
export function safeKill(proc: SpawnedProc, signal: NodeJS.Signals): void {
    try {
        proc.kill(signal);
    }
    catch {
    }
}

// Runs all gated commands in parallel. For each prepared command, the gate decides whether to spawn; if
// it does, the runner captures stdout+stderr to a per-command log file, applies the per-command timeout,
// updates `state` on success, and emits audit-log entries. The function awaits all spawns via
// `Promise.all` and returns one `RunResult` per input in input order.
export async function runCommands(prepared: CompiledCommand[], state: State, now: Date, opts?: RunCommandsOptions): Promise<RunResult[]> {
    const spawnFn = opts?.spawn ?? defaultSpawner;
    const nowFactory = opts?.now ?? (() => new Date());
    const logger = opts?.logger ?? new NullAuditLogger();
    const logBaseDir = opts?.logBaseDir ?? path.join(process.cwd(), ".claude", "claude-tools-runner", "log");
    const projectDir = opts?.projectDir ?? path.resolve(logBaseDir, "..", "..", "..");

    const tasks: Promise<RunResult>[] = [];
    for (const compiled of prepared) {
        tasks.push(runOneCommand(compiled, state, now, spawnFn, nowFactory, logger, logBaseDir, projectDir));
    }
    return Promise.all(tasks);
}

// Runs one prepared command end-to-end: gate, spawn, pipe IO into the log file, await/timeout, write the
// log footer, and update state on success. Always resolves: no exception escapes a single command and the
// rest of the batch keeps running. Emits one `gate_decision` audit entry per call, plus paired
// `command_started` and `command_result` entries when the gate decides to run. `projectDir` is used to
// relativise `logFile` paths in audit entries; `RunResult.logFile` stays absolute.
export async function runOneCommand(prepared: CompiledCommand, state: State, now: Date, spawnFn: Spawner, nowFactory: () => Date, logger: IAuditLogger, logBaseDir: string, projectDir: string): Promise<RunResult> {
    const gate: GateDecision = await decideGate(prepared, state, now);
    const cooldownSeconds: number = prepared.command.cooldown ?? DEFAULT_COOLDOWN_SECONDS;
    const priorRun = findCommandRun(state, prepared.commandKey);
    const lastFilesHash: string | undefined = priorRun?.lastFilesHash;
    let elapsedSeconds: number | undefined = undefined;
    if (priorRun !== undefined) {
        const lastRunMs = Date.parse(priorRun.lastRunAt);
        if (!Number.isNaN(lastRunMs)) {
            elapsedSeconds = (now.getTime() - lastRunMs) / 1000;
        }
    }
    await logger.log({
        type: "gate_decision",
        timestamp: toAuditLocalISOString(nowFactory()),
        sourceFile: prepared.sourceFile,
        sourceLine: prepared.commandSourceLine,
        triggerIndex: prepared.triggerIndexInFile,
        commandIndex: prepared.commandIndex,
        expandedRun: prepared.expandedRun,
        expandedCwd: prepared.expandedCwd,
        filesHash: gate.filesHash,
        lastFilesHash,
        cooldownSeconds,
        elapsedSeconds,
        decision: gate.run ? "run" : "skip",
        reason: gate.reason,
    });
    if (!gate.run) {
        // Skip narration is recorded in the audit log via the `gate_decision` entry above; stdout
        // stays silent because Claude Code parses Stop-hook stdout as JSON on exit 0.
        return {
            prepared,
            exitCode: 0,
            durationMs: 0,
            error: undefined,
            filesHash: gate.filesHash,
            logFile: "",
        };
    }

    const startedAt = nowFactory();
    const logFile = resolveCommandLogPath(logBaseDir, startedAt, prepared.commandKey);
    const auditLogFile = path.relative(projectDir, logFile);
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    const writeStream = nodeFs.createWriteStream(logFile, { flags: "w" });
    writeStream.write(`> ${prepared.expandedRun}\n`);
    writeStream.write(`> cwd: ${prepared.expandedCwd}\n`);
    writeStream.write(`> started: ${toLocalISOString(startedAt)}\n`);
    writeStream.write(`---\n`);

    const timeoutSeconds = prepared.command.timeout ?? DEFAULT_TIMEOUT_SECONDS;

    // Emit and FLUSH the "about to run" entry to disk BEFORE forking the child. If the spawn (or the
    // host itself) dies between this entry and `command_started`, the audit log still records the intent
    // to run. Awaiting `logger.log` is what guarantees durability: `FileAuditLogger.log` uses
    // `fs.appendFile`, which opens, writes, and closes the file before resolving.
    await logger.log({
        type: "command_about_to_run",
        timestamp: toAuditLocalISOString(startedAt),
        sourceFile: prepared.sourceFile,
        sourceLine: prepared.commandSourceLine,
        triggerIndex: prepared.triggerIndexInFile,
        commandIndex: prepared.commandIndex,
        expandedRun: prepared.expandedRun,
        expandedCwd: prepared.expandedCwd,
        timeoutSeconds,
        logFile: auditLogFile,
    });

    const proc = spawnFn(["sh", "-c", prepared.expandedRun], { cwd: prepared.expandedCwd });
    const flushStdout = pipeStreamWithTag(proc.stdout, writeStream, "[OUT] ");
    const flushStderr = pipeStreamWithTag(proc.stderr, writeStream, "[ERR] ");

    await logger.log({
        type: "command_started",
        timestamp: toAuditLocalISOString(nowFactory()),
        sourceFile: prepared.sourceFile,
        sourceLine: prepared.commandSourceLine,
        triggerIndex: prepared.triggerIndexInFile,
        commandIndex: prepared.commandIndex,
        expandedRun: prepared.expandedRun,
        expandedCwd: prepared.expandedCwd,
        pid: proc.pid ?? null,
        timeoutSeconds,
        logFile: auditLogFile,
    });

    const timeoutMs = Math.round(timeoutSeconds * 1000);

    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined = undefined;
    let killHandle: NodeJS.Timeout | undefined = undefined;

    const timeoutPromise = new Promise<number>((resolve) => {
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            safeKill(proc, "SIGTERM");
            killHandle = setTimeout(() => {
                safeKill(proc, "SIGKILL");
            }, KILL_GRACE_MS);
            killHandle.unref();
            resolve(-1);
        }, timeoutMs);
    });

    let exitCode: number;
    let error: string | undefined = undefined;
    try {
        exitCode = await Promise.race([proc.exited, timeoutPromise]);
    }
    catch (caughtErr) {
        const errObj = caughtErr as Error;
        error = errObj.message;
        exitCode = -1;
    }
    finally {
        if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
        }
    }

    if (timedOut) {
        error = "timeout";
    }

    flushStdout();
    flushStderr();

    const finishedAt = nowFactory();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    writeStream.write(`---\n`);
    if (timedOut) {
        writeStream.write(`> killed: timeout\n`);
    }
    else {
        writeStream.write(`> exit: ${exitCode}\n`);
    }
    writeStream.write(`> duration: ${durationMs}ms\n`);
    if (error !== undefined && !timedOut) {
        writeStream.write(`> error: ${error}\n`);
    }

    await endWriteStream(writeStream);

    let outcome: AuditCommandOutcome;
    if (timedOut) {
        outcome = "timeout";
    }
    else if (exitCode === 0 && error === undefined) {
        outcome = "pass";
    }
    else {
        outcome = "fail";
    }

    await logger.log({
        type: "command_result",
        timestamp: toAuditLocalISOString(finishedAt),
        sourceFile: prepared.sourceFile,
        sourceLine: prepared.commandSourceLine,
        triggerIndex: prepared.triggerIndexInFile,
        commandIndex: prepared.commandIndex,
        expandedRun: prepared.expandedRun,
        expandedCwd: prepared.expandedCwd,
        exitCode,
        durationMs,
        outcome,
        logFile: auditLogFile,
    });

    if (outcome === "pass") {
        upsertCommandRun(state, {
            commandKey: prepared.commandKey,
            expandedRun: prepared.expandedRun,
            expandedCwd: prepared.expandedCwd,
            sourceFile: prepared.sourceFile,
            sourceLine: prepared.sourceLine,
            lastRunAt: now.toISOString(),
            lastFilesHash: gate.filesHash,
            matchedFiles: prepared.matchedFiles.map(file => file.absPath).sort(),
        });
        // PASS narration is recorded in the audit log via `command_result`; stdout stays silent.
    }
    // FAIL narration is recorded in the audit log via `command_result` and re-emitted to stderr
    // with the rest of the failed-command summary by `runStopHook`; stdout stays silent.

    return {
        prepared,
        exitCode,
        durationMs,
        error,
        filesHash: gate.filesHash,
        logFile,
    };
}
