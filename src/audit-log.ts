import * as fs from "node:fs/promises";
import * as path from "node:path";

// Number of months of audit-log history retained on disk. The current month plus this many previous months
// are kept; anything older is purged on each `createLogger` invocation. Two months balances usefulness
// (enough history to investigate a regression that surfaced last week) against disk usage.
const RETENTION_MONTHS: number = 2;

// Formats a `Date` as a local-time ISO 8601 string with a trailing timezone offset. Mirrors the helper used
// by `runner.ts` for its per-command log file headers so audit and command-log timestamps are interchangeable.
// Local time is used over UTC because users grep these logs alongside their own terminal output.
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

// Hook-completed `skipReason` discriminator. Each value corresponds to one early-skip code path in the Stop
// hook; the JSON consumer can grep by this value to count how often a given skip path fires.
export type HookSkipReason = "stop_hook_active" | "git_missing" | "env_unset" | "no_triggers" | "no_changed_files" | "no_match";

// Outcome of a single command emitted in `command_result` audit entries. Mirrors the user-visible PASS/FAIL
// stdout taxonomy: a successful exit is "pass", a non-zero exit (including spawn errors) is "fail", and a
// timeout is its own category so it can be filtered separately.
export type AuditCommandOutcome = "pass" | "fail" | "timeout";

// Common prefix carried by every audit-log entry. The `type` discriminator lets a JSON consumer switch on
// the entry shape; the `timestamp` is a local-ISO-8601 string set at emission time.
export interface IAuditEntryBase {
    // String discriminator identifying the entry variant.
    type: string;
    // Local-time ISO 8601 timestamp with offset suffix. Set by the caller via `toLocalISOString(new Date())`.
    timestamp: string;
}

// Emitted once at the top of each Stop-hook invocation, immediately after stdin is parsed. Pairs with a
// closing `hook_completed` entry (or, on a fatal error, with a `hook_error` entry).
export interface IAuditHookStartedEntry extends IAuditEntryBase {
    type: "hook_started";
    // `process.cwd()` at the time the hook started.
    cwd: string;
    // Value of `$CLAUDE_PROJECT_DIR`. Recorded explicitly so the audit log shows the working context.
    projectDir: string;
    // The session id from the Claude Stop-hook payload, if present.
    sessionId?: string;
    // Whether stdin's `stop_hook_active` flag was set (recursion-guard path).
    stopHookActive: boolean;
}

// Emitted after each `FileLayer.create(...)` resolves successfully. A failure to load a layer is reported via
// `hook_error` instead, after which the hook aborts.
export interface IAuditConfigLoadEntry extends IAuditEntryBase {
    type: "config_load";
    // Display path of the YAML file (e.g. `~/.claude/tools-runner.yaml` or a project-relative path).
    filePath: string;
    // Number of triggers parsed out of the file. Zero is a valid value (the layer simply contributes nothing).
    triggerCount: number;
}

// One element of `IAuditChangedFilesEntry.files`. Single-field object so future additions (e.g. a status flag)
// can be made without breaking the JSON shape.
export interface IAuditChangedFile {
    // Scope-relative POSIX path of the changed file as reported by `collectChangedFiles`.
    path: string;
}

// Emitted once after all `collectChangedFiles` calls complete. Even an empty list produces an entry: the
// downstream "no changed files, skipping" path then fires.
export interface IAuditChangedFilesEntry extends IAuditEntryBase {
    type: "changed_files";
    // Total number of changed files across every scope. Equals `files.length`.
    count: number;
    // The full sorted list of changed files. Sorted so the JSON output is stable across invocations.
    files: IAuditChangedFile[];
}

// Emitted once per trigger evaluated, regardless of whether anything matched. The matched/unmatched split
// answers "why didn't my trigger fire?" without instrumenting the plugin.
export interface IAuditTriggerMatchEntry extends IAuditEntryBase {
    type: "trigger_match";
    // Display path of the YAML layer this trigger came from.
    sourceFile: string;
    // 1-based line of the trigger inside `sourceFile`. Renders as an editor-jump prefix in the text log.
    sourceLine: number;
    // 0-based index of the trigger within its source YAML file.
    triggerIndex: number;
    // The trigger's raw `paths` glob list (verbatim, no template expansion).
    patterns: string[];
    // Files (scope-relative paths) that satisfied the trigger's `paths` patterns.
    matchedFiles: string[];
    // Files (scope-relative paths) that were considered but did NOT match the trigger's patterns.
    unmatchedFiles: string[];
}

// Emitted once per `CompiledCommand`, after `decideGate` resolves but before any spawn. Carries enough
// context to explain why the gate decided "run" or "skip" on a per-command basis.
export interface IAuditGateDecisionEntry extends IAuditEntryBase {
    type: "gate_decision";
    // Display path of the YAML layer that produced this command.
    sourceFile: string;
    // 1-based line of the source trigger inside `sourceFile`.
    sourceLine: number;
    // 0-based trigger index within `sourceFile`.
    triggerIndex: number;
    // 0-based command index within the trigger.
    commandIndex: number;
    // Fully template-expanded shell command line.
    expandedRun: string;
    // Fully template-expanded working directory.
    expandedCwd: string;
    // SHA-256 hex digest of the matched files at gate-decision time.
    filesHash: string;
    // Persisted hash from the previous successful run, if any.
    lastFilesHash?: string;
    // Effective cooldown threshold in seconds (defaulted to 60 when the YAML did not specify one).
    cooldownSeconds: number;
    // Wall-clock seconds elapsed since the previous successful run, if any.
    elapsedSeconds?: number;
    // Whether the gate decided to run or skip the command on this Stop event.
    decision: "run" | "skip";
    // Human-readable rationale for the decision (e.g. "first run", "in cooldown").
    reason: string;
}

// Emitted once per command actually spawned (gate decided `run`). Pairs with a `command_result` entry
// carrying the same `sourceFile`/`sourceLine`/`commandIndex` triple.
export interface IAuditCommandStartedEntry extends IAuditEntryBase {
    type: "command_started";
    // Display path of the YAML layer that produced this command.
    sourceFile: string;
    // 1-based line of the source trigger.
    sourceLine: number;
    // 0-based trigger index within `sourceFile`.
    triggerIndex: number;
    // 0-based command index within the trigger.
    commandIndex: number;
    // Fully template-expanded shell command line.
    expandedRun: string;
    // Fully template-expanded working directory.
    expandedCwd: string;
    // OS process id of the spawned child. `null` when the spawn errored before the `spawn` event fired.
    pid: number | null;
    // Effective per-command timeout in seconds.
    timeoutSeconds: number;
    // Absolute path of the per-command log file capturing the child's stdout and stderr.
    logFile: string;
}

// Emitted once per command that completed (success, failure, or timeout). Carries the outcome bucket plus
// raw exit code and duration so a JSON consumer can compute its own statistics.
export interface IAuditCommandResultEntry extends IAuditEntryBase {
    type: "command_result";
    // Display path of the YAML layer that produced this command.
    sourceFile: string;
    // 1-based line of the source trigger.
    sourceLine: number;
    // 0-based trigger index within `sourceFile`.
    triggerIndex: number;
    // 0-based command index within the trigger.
    commandIndex: number;
    // Fully template-expanded shell command line.
    expandedRun: string;
    // Fully template-expanded working directory.
    expandedCwd: string;
    // Numeric exit code: actual code on a clean exit, `-1` for timeout or spawn error.
    exitCode: number;
    // Wall-clock duration in milliseconds from spawn to exit (or timeout/spawn-error rejection).
    durationMs: number;
    // Outcome bucket: `pass` for exit 0, `fail` for any non-zero exit (including spawn error), `timeout`.
    outcome: AuditCommandOutcome;
    // Absolute path of the per-command log file (same as the paired `command_started.logFile`).
    logFile: string;
}

// Emitted once after `saveState` resolves, before `hook_completed`. The pruning counts come from `saveState`
// itself; the cardinality fields are post-prune so they reflect what was actually written.
export interface IAuditStateSavedEntry extends IAuditEntryBase {
    type: "state_saved";
    // Absolute path of the per-project hash cache YAML (`.claude/tools-runner-hashes.yaml`).
    hashesPath: string;
    // Absolute path of the directory holding one YAML file per `commandKey` (`.claude/tools-runner-runs/`).
    runsDir: string;
    // Number of `commandRuns` entries surviving on disk after this save (post-TTL-prune).
    commandRunsCount: number;
    // Number of `fileHashes` entries written to disk after this save (post-orphan-prune).
    fileHashesCount: number;
    // Number of per-command run files unlinked by the TTL prune during this save.
    prunedCommandRuns: number;
    // Number of `fileHashes` entries dropped by the orphan cascade during this save.
    prunedFileHashes: number;
}

// Emitted once at the end of each invocation (paired with `hook_started`). When the hook aborts via
// `hook_error` followed by `process.exit(1)` the completed entry may not get written; that absence is itself
// a useful signal.
export interface IAuditHookCompletedEntry extends IAuditEntryBase {
    type: "hook_completed";
    // Wall-clock duration of the hook in milliseconds, measured from the top of `runStopHook`.
    durationMs: number;
    // Number of commands that exited cleanly.
    pass: number;
    // Number of commands that exited non-zero, errored, or timed out.
    fail: number;
    // Number of commands that the gate decided to skip without spawning.
    skip: number;
    // Process exit code: 0 on the happy path or a non-error skip, 1 on a fatal error.
    exitCode: 0 | 1;
    // Tag identifying which early-skip path fired (when applicable). Absent on the full pipeline path.
    skipReason?: HookSkipReason;
}

// Emitted by the top-level `try/catch` when an unhandled exception escapes the hook body. Followed (best
// effort) by a `hook_completed` entry with `exitCode: 1`.
export interface IAuditHookErrorEntry extends IAuditEntryBase {
    type: "hook_error";
    // Error message (`Error.message`) of the unhandled exception.
    message: string;
    // Stack trace captured at throw time. Omitted when the thrown value did not carry a stack.
    stack?: string;
}

// Discriminated union over every audit-log entry type. Consumers can `switch (entry.type)` and TypeScript
// narrows to the matching variant. Adding a new variant means extending this union and the `formatTextEntry`
// switch.
export type IAuditLogEntry =
    | IAuditHookStartedEntry
    | IAuditConfigLoadEntry
    | IAuditChangedFilesEntry
    | IAuditTriggerMatchEntry
    | IAuditGateDecisionEntry
    | IAuditCommandStartedEntry
    | IAuditCommandResultEntry
    | IAuditStateSavedEntry
    | IAuditHookCompletedEntry
    | IAuditHookErrorEntry;

// Logger seam consumed by every event-emitting site in the Stop hook. The single `log` method is async so
// callers `await` each entry to disk before processing the next event.
export interface IAuditLogger {
    // Persists `entry` to the underlying audit-log destination. Resolves once the entry is durable on disk.
    log(entry: IAuditLogEntry): Promise<void>;
}

// No-op `IAuditLogger`. Used as the default when no `CLAUDE_PROJECT_DIR` is available (recursion-guard
// short-circuit) and by unit tests that do not want to write log files.
export class NullAuditLogger implements IAuditLogger {
    // Discards `entry` without persisting anything.
    async log(_entry: IAuditLogEntry): Promise<void> {
    }
}

// Returns the absolute root of the audit + per-command log tree for `projectDir`. The tree lives under
// `${projectDir}/.claude/tools-runner-log` so it sits next to the per-project `tools-runner-state.yaml`.
export function resolveLogBaseDir(projectDir: string): string {
    return path.join(projectDir, ".claude", "tools-runner-log");
}

// Returns the absolute path of the JSON Lines audit log file for `now`. Layout:
// `<baseDir>/YYYY-MM/DD/HH.json`. Files rotate hourly; entries from the same hook invocation always land in
// the file rooted at the hook's starting `now`.
export function resolveJsonLogPath(baseDir: string, now: Date): string {
    const yearPart = String(now.getFullYear()).padStart(4, "0");
    const monthPart = String(now.getMonth() + 1).padStart(2, "0");
    const dayPart = String(now.getDate()).padStart(2, "0");
    const hourPart = String(now.getHours()).padStart(2, "0");
    return path.join(baseDir, `${yearPart}-${monthPart}`, dayPart, `${hourPart}.json`);
}

// Returns the absolute path of the human-readable audit log file for `now`. Mirrors `resolveJsonLogPath`
// with a `.log` extension so the two files are siblings inside the hour folder.
export function resolveTextLogPath(baseDir: string, now: Date): string {
    const yearPart = String(now.getFullYear()).padStart(4, "0");
    const monthPart = String(now.getMonth() + 1).padStart(2, "0");
    const dayPart = String(now.getDate()).padStart(2, "0");
    const hourPart = String(now.getHours()).padStart(2, "0");
    return path.join(baseDir, `${yearPart}-${monthPart}`, dayPart, `${hourPart}.log`);
}

// Returns the directory that holds per-command log files for `now`. Per-command logs land in a sibling
// directory `HH/` next to `HH.json` and `HH.log` so they are easy to find next to the audit entries that
// reference them.
export function resolveCommandLogDir(baseDir: string, now: Date): string {
    const yearPart = String(now.getFullYear()).padStart(4, "0");
    const monthPart = String(now.getMonth() + 1).padStart(2, "0");
    const dayPart = String(now.getDate()).padStart(2, "0");
    const hourPart = String(now.getHours()).padStart(2, "0");
    return path.join(baseDir, `${yearPart}-${monthPart}`, dayPart, hourPart);
}

// Renders `entry` as a single human-readable line for the `.log` companion of the JSON audit log. The format
// is `HH:MM:SS  LABEL    <details>`; labels are left-padded to 9 characters so columns align across rows.
// `<sourceFile>:<sourceLine>` prefixes are formatted like editor-jump locations so most terminals will let
// users click straight to the offending YAML trigger.
export function formatTextEntry(entry: IAuditLogEntry): string {
    const timeOnly = entry.timestamp.length >= 19 ? entry.timestamp.slice(11, 19) : entry.timestamp;
    const label = labelFor(entry.type).padEnd(9);
    const body = renderEntryBody(entry);
    return `${timeOnly}  ${label}${body}`;
}

// Returns the column label for `entryType`. The labels are short uppercase tags so the human-readable log
// is grep-friendly (`grep RESULT log` for command outcomes, etc.).
export function labelFor(entryType: string): string {
    if (entryType === "hook_started") {
        return "HOOK";
    }
    if (entryType === "config_load") {
        return "CONFIG";
    }
    if (entryType === "changed_files") {
        return "CHANGED";
    }
    if (entryType === "trigger_match") {
        return "MATCH";
    }
    if (entryType === "gate_decision") {
        return "GATE";
    }
    if (entryType === "command_started") {
        return "START";
    }
    if (entryType === "command_result") {
        return "RESULT";
    }
    if (entryType === "state_saved") {
        return "STATE";
    }
    if (entryType === "hook_completed") {
        return "DONE";
    }
    if (entryType === "hook_error") {
        return "ERROR";
    }
    return entryType.toUpperCase();
}

// Maximum number of characters of the changed-files comma-list to inline in the human-readable text log.
// Longer lists are truncated with an ellipsis; the JSON log always carries the full list, so truncation in
// the text rendering only affects readability, not auditability.
const CHANGED_FILES_TEXT_BUDGET: number = 200;

// Routes `entry` to its variant-specific renderer. Kept separate from `formatTextEntry` so the discriminator
// switch is visible in one place and adding a new variant fails compilation here when the case is missing.
export function renderEntryBody(entry: IAuditLogEntry): string {
    if (entry.type === "hook_started") {
        return `started cwd=${entry.cwd} stop_hook_active=${entry.stopHookActive}`;
    }
    if (entry.type === "config_load") {
        return `${entry.filePath} (${entry.triggerCount} triggers)`;
    }
    if (entry.type === "changed_files") {
        const fullList = entry.files.map(file => file.path).join(", ");
        const inlineList = fullList.length > CHANGED_FILES_TEXT_BUDGET
            ? fullList.slice(0, CHANGED_FILES_TEXT_BUDGET) + "..."
            : fullList;
        return `${entry.count} file(s): ${inlineList}`;
    }
    if (entry.type === "trigger_match") {
        const total = entry.matchedFiles.length + entry.unmatchedFiles.length;
        const patternList = entry.patterns.join(",");
        return `${entry.sourceFile}:${entry.sourceLine} patterns=${patternList} matched=${entry.matchedFiles.length}/${total}`;
    }
    if (entry.type === "gate_decision") {
        return `${entry.sourceFile}:${entry.sourceLine} cmd=${entry.commandIndex} ${entry.decision.toUpperCase()}: ${entry.reason}`;
    }
    if (entry.type === "command_started") {
        const pidPart = entry.pid !== null ? String(entry.pid) : "null";
        return `${entry.sourceFile}:${entry.sourceLine} cmd=${entry.commandIndex} pid=${pidPart} timeout=${entry.timeoutSeconds}s "${entry.expandedRun}"`;
    }
    if (entry.type === "command_result") {
        return `${entry.sourceFile}:${entry.sourceLine} cmd=${entry.commandIndex} ${entry.outcome} exit=${entry.exitCode} ${entry.durationMs}ms`;
    }
    if (entry.type === "state_saved") {
        return `${entry.hashesPath} + ${entry.runsDir} (${entry.commandRunsCount} runs, ${entry.fileHashesCount} hashes; pruned ${entry.prunedCommandRuns}+${entry.prunedFileHashes})`;
    }
    if (entry.type === "hook_completed") {
        const skipPart = entry.skipReason !== undefined ? ` skip=${entry.skipReason}` : "";
        return `${entry.pass}P / ${entry.fail}F / ${entry.skip}S in ${entry.durationMs}ms exit=${entry.exitCode}${skipPart}`;
    }
    if (entry.type === "hook_error") {
        return entry.message;
    }
    return JSON.stringify(entry);
}

// Persists audit-log entries to `<baseDir>/YYYY-MM/DD/HH.{json,log}`. The single `now` Date passed at
// construction time is used for every entry's path resolution: even if execution crosses an hour boundary,
// all entries from one hook invocation always land in the same hour file. `fs.appendFile` opens with
// `O_APPEND` semantics, so concurrent appends from separate processes interleave at line boundaries safely
// (POSIX guarantees writes < `PIPE_BUF` are atomic).
export class FileAuditLogger implements IAuditLogger {
    // Absolute root of the audit-log tree (same value used by `resolveCommandLogDir` for sibling per-command logs).
    public readonly baseDir: string;
    // Frozen "right now" used for path resolution on every entry. Set once at construction time.
    public readonly now: Date;

    constructor(baseDir: string, now: Date) {
        this.baseDir = baseDir;
        this.now = now;
    }

    // Appends `entry` to both the JSON and text log files for the construction-time hour. Creates the parent
    // directory recursively on first call so callers do not have to coordinate setup.
    async log(entry: IAuditLogEntry): Promise<void> {
        const jsonPath = resolveJsonLogPath(this.baseDir, this.now);
        const textPath = resolveTextLogPath(this.baseDir, this.now);
        await fs.mkdir(path.dirname(jsonPath), { recursive: true });
        await fs.appendFile(jsonPath, JSON.stringify(entry) + "\n");
        await fs.appendFile(textPath, formatTextEntry(entry) + "\n");
    }
}

// Deletes `YYYY-MM/` subdirectories of `baseDir` that are older than `RETENTION_MONTHS` months back from
// `now`. The current month and the most recent `RETENTION_MONTHS` months are kept; older months are purged
// recursively. Tolerates `ENOENT` on `baseDir` so a brand-new project does not error out.
export async function cleanupOldMonths(baseDir: string, now: Date): Promise<void> {
    let entries: string[];
    try {
        entries = await fs.readdir(baseDir);
    }
    catch (caughtErr) {
        const errnoErr = caughtErr as NodeJS.ErrnoException;
        if (errnoErr.code === "ENOENT") {
            return;
        }
        throw caughtErr;
    }
    const currentMonthKey = now.getFullYear() * 12 + now.getMonth();
    const cutoffMonthKey = currentMonthKey - RETENTION_MONTHS;
    const monthRegex = /^(\d{4})-(\d{2})$/;
    for (const entryName of entries) {
        const matchResult = monthRegex.exec(entryName);
        if (matchResult === null) {
            continue;
        }
        const yearValue = Number(matchResult[1]);
        const monthValue = Number(matchResult[2]);
        const entryMonthKey = yearValue * 12 + (monthValue - 1);
        if (entryMonthKey < cutoffMonthKey) {
            await fs.rm(path.join(baseDir, entryName), { recursive: true, force: true });
        }
    }
}

// Builds a `FileAuditLogger` rooted at `<projectDir>/.claude/tools-runner-log` after pruning months that have
// fallen outside the retention window. The Stop hook awaits this once, before `hook_started` is emitted.
// Cleanup is fire-and-await: the logger is returned only once stale months are removed so the next entry
// finds a clean tree. A `.gitignore` containing `*` is dropped at the audit-log root so the directory's
// contents are invisible to `git status` even if the user has not added the directory to their project's
// own `.gitignore`. The audit log writes that follow (`hook_started`, etc.) must not appear as untracked
// files; otherwise `collectChangedFiles` would surface them and turn an idle Stop event into a busy one.
export async function createLogger(projectDir: string, now: Date): Promise<FileAuditLogger> {
    const baseDir = resolveLogBaseDir(projectDir);
    await cleanupOldMonths(baseDir, now);
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(path.join(baseDir, ".gitignore"), "*\n");
    return new FileAuditLogger(baseDir, now);
}
