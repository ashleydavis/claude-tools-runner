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
    type: "ENTRY";
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
    type: "CONFIG";
    // Display path of the YAML file (e.g. `~/.claude/claude-tools-runner.yaml` or a project-relative path).
    filePath: string;
    // Number of triggers parsed out of the file. Zero is a valid value (the layer simply contributes nothing).
    triggerCount: number;
    // Absolute path of the per-layer hash cache YAML written by `saveState`. Surfaced here (in addition to
    // `state_saved`) so users can see up-front where state for this config lives without waiting for the
    // hook to finish running its commands.
    hashesPath: string;
    // Absolute path of the directory holding one YAML file per `commandKey` for this layer.
    runsDir: string;
    // Absolute path of the per-layer audit + per-command log tree (`<scopeDir>/.claude/claude-tools-runner/log`).
    logBaseDir: string;
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
    type: "CHANGE";
    // Total number of changed files across every scope. Equals `files.length`.
    count: number;
    // The full sorted list of changed files. Sorted so the JSON output is stable across invocations.
    files: IAuditChangedFile[];
}

// Emitted once per trigger evaluated, regardless of whether anything matched. The matched/unmatched split
// answers "why didn't my trigger fire?" without instrumenting the plugin.
export interface IAuditTriggerMatchEntry extends IAuditEntryBase {
    type: "MATCH";
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

// Emitted once per `CompiledCommand`, after `decideGate` resolves but before any spawn. The `type`
// discriminator IS the user-facing label and encodes the gate outcome: `GATE_RUN` is the JSON-only
// "decided to run" case; `COOLDOWN`, `UNCHANGED`, and `SKIP` are the three text-log skip variants
// branched by reason so each skip cause is greppable.
export interface IAuditGateDecisionEntry extends IAuditEntryBase {
    type: "GATE_RUN" | "COOLDOWN" | "UNCHANGED" | "SKIP";
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
    // Persisted hash from the previous successful run, if any. JSON consumers can use the
    // present-but-different vs absent distinction to disambiguate `GATE_RUN` first-run from changed-run.
    lastFilesHash?: string;
    // Effective cooldown threshold in seconds (defaulted to 60 when the YAML did not specify one).
    cooldownSeconds: number;
    // Wall-clock seconds elapsed since the previous successful run, if any.
    elapsedSeconds?: number;
}

// Emitted (and flushed to disk) immediately before the child process is spawned. Pairs with a later
// `command_started` entry once the spawn returns with a pid, and a `command_result` entry on exit. Exists
// so that the audit log records the intent to run before the process is forked: if the spawn or the host
// itself dies between this entry and `command_started`, the log still shows that the command was about to
// run. Carries no pid (the child has not been forked yet).
export interface IAuditCommandAboutToRunEntry extends IAuditEntryBase {
    type: "LAUNCHING";
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
    // Effective per-command timeout in seconds.
    timeoutSeconds: number;
    // Absolute path of the per-command log file capturing the child's stdout and stderr.
    logFile: string;
}

// Emitted once per command actually spawned (gate decided `run`). Pairs with a `command_result` entry
// carrying the same `sourceFile`/`sourceLine`/`commandIndex` triple.
export interface IAuditCommandStartedEntry extends IAuditEntryBase {
    type: "STARTED";
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

// Emitted once per command that completed (success, failure, or timeout). The `type` discriminator IS
// the user-facing label and encodes the outcome: `PASS` for a clean exit-0, `FAIL` for any non-zero exit
// (including spawn error), `TIMEOUT` for a per-command timeout kill.
export interface IAuditCommandResultEntry extends IAuditEntryBase {
    type: "PASS" | "FAIL" | "TIMEOUT";
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
    // OS process id of the spawned child. Matches the paired `STARTED.pid` so the start and end of one
    // child can be correlated by pid in the text log. `null` when the spawn errored before the `spawn`
    // event fired (no child was ever forked).
    pid: number | null;
    // Numeric exit code: actual code on a clean exit, `-1` for timeout or spawn error.
    exitCode: number;
    // Wall-clock duration in milliseconds from spawn to exit (or timeout/spawn-error rejection).
    durationMs: number;
    // Diagnostic message captured when the spawn itself errored (e.g. ENOENT on the shell, EACCES,
    // out of memory) or when `proc.exited` rejected. Absent on the happy path and on a clean non-zero
    // exit (in which case the child's own stderr is in the per-command log file pointed at by `logFile`).
    error?: string;
    // Absolute path of the per-command log file (same as the paired `STARTED.logFile`).
    logFile: string;
}

// Emitted once after `saveState` resolves, before `hook_completed`. The pruning counts come from `saveState`
// itself; the cardinality fields are post-prune so they reflect what was actually written.
export interface IAuditStateSavedEntry extends IAuditEntryBase {
    type: "STATE_SAVED";
    // Display path of the YAML layer this state save corresponds to.
    sourceFile: string;
    // Absolute path of the per-layer hash cache YAML (`.claude/claude-tools-runner/hashes.yaml`).
    hashesPath: string;
    // Absolute path of the directory holding one YAML file per `commandKey`
    // (`.claude/claude-tools-runner/runs/`).
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
    type: "EXIT";
    // Wall-clock duration of the hook in milliseconds, measured from the top of `runStopHook`.
    durationMs: number;
    // Number of commands that exited cleanly.
    pass: number;
    // Number of commands that exited non-zero, errored, or timed out.
    fail: number;
    // Number of commands that the gate decided to skip without spawning.
    skip: number;
    // Process exit code: 0 on the happy path or a non-error skip, 2 on a fatal error or any
    // command failure (Claude Code treats Stop-hook exit 2 as blocking and feeds stderr back to
    // the model so the failure is surfaced into the next turn).
    exitCode: 0 | 2;
    // Tag identifying which early-skip path fired (when applicable). Absent on the full pipeline path.
    skipReason?: HookSkipReason;
}

// Emitted by the top-level `try/catch` when an unhandled exception escapes the hook body. Followed (best
// effort) by a `hook_completed` entry with `exitCode: 2`.
export interface IAuditHookErrorEntry extends IAuditEntryBase {
    type: "ERROR";
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
    | IAuditCommandAboutToRunEntry
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

// Returns the absolute root of the audit + per-command log tree for `scopeDir`. The tree lives under
// `${scopeDir}/.claude/claude-tools-runner/log` so it sits next to the per-layer `hashes.yaml` and `runs/`
// directory. `scopeDir` is the directory containing the configuration file's `.claude/` directory.
export function resolveLogBaseDir(scopeDir: string): string {
    return path.join(scopeDir, ".claude", "claude-tools-runner", "log");
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

// Renders `entry` as a single human-readable line for the `.log` companion of the JSON audit log. Returns
// `null` for entry variants that exist only in the JSON log (`STATE_SAVED`, `GATE_RUN`); callers must skip
// the text append in that case. The format is `HH:MM:SS  LABEL      <details>` (label column padded to 11).
// `entry.type` IS the user-facing label (CONFIG, CHANGE, MATCH, COOLDOWN, UNCHANGED, SKIP, LAUNCHING,
// STARTED, PASS, FAIL, TIMEOUT, ENTRY, EXIT, ERROR). `<sourceFile>:<sourceLine>` prefixes are
// formatted like editor-jump locations and point at the command's `run:` line for command-level entries.
export function formatTextEntry(entry: IAuditLogEntry): string | null {
    const body = renderEntryBody(entry);
    if (body === null) {
        return null;
    }
    const timeOnly = entry.timestamp.length >= 19 ? entry.timestamp.slice(11, 19) : entry.timestamp;
    const label = entry.type.padEnd(11);
    return `${timeOnly}  ${label}${body}`;
}

// Maximum number of characters of file-list content to inline in the human-readable text log. Longer
// lists are truncated with an ellipsis; the JSON log always carries the full list so truncation only
// affects readability, not auditability.
const FILE_LIST_TEXT_BUDGET: number = 200;

// Truncates `fullList` to at most `FILE_LIST_TEXT_BUDGET` characters with a trailing ellipsis when it
// exceeds the budget. Used by `CHANGE` and `MATCH` lines so a Stop event affecting hundreds of files does
// not produce a single multi-kilobyte text-log line.
function truncateFileList(fullList: string): string {
    if (fullList.length > FILE_LIST_TEXT_BUDGET) {
        return fullList.slice(0, FILE_LIST_TEXT_BUDGET) + "...";
    }
    return fullList;
}

// Routes `entry` to its variant-specific text renderer. Returns `null` for entries that exist only in the
// JSON log; the text log carries the user-facing chain (`ENTRY` -> `CONFIG` -> `CHANGE` -> `MATCH` ->
// (`COOLDOWN`|`UNCHANGED`|`SKIP`) | (`LAUNCHING` -> `STARTED` -> (`PASS`|`FAIL`|`TIMEOUT`)) -> `EXIT`)
// plus `ERROR`. `STATE_SAVED` and `GATE_RUN` are JSON-only because the surfaced chain already conveys
// what the user needs (which configs loaded, which files changed, which triggers matched and on what
// patterns, why a command was skipped, when a command was about to run, when it actually started, and
// how it finished including exit code or timeout and duration, plus when the hook started and finished).
export function renderEntryBody(entry: IAuditLogEntry): string | null {
    if (entry.type === "ENTRY") {
        return entry.projectDir;
    }
    if (entry.type === "CONFIG") {
        return entry.filePath;
    }
    if (entry.type === "CHANGE") {
        if (entry.count === 0) {
            return `0 files`;
        }
        const fullList = entry.files.map(file => file.path).join(", ");
        return `${entry.count} files: ${truncateFileList(fullList)}`;
    }
    if (entry.type === "MATCH") {
        const totalConsidered = entry.matchedFiles.length + entry.unmatchedFiles.length;
        const patternList = entry.patterns.join(",");
        if (entry.matchedFiles.length === 0) {
            return `${entry.sourceFile}:${entry.sourceLine} patterns=${patternList} matched 0/${totalConsidered}`;
        }
        const matchedList = entry.matchedFiles.join(", ");
        return `${entry.sourceFile}:${entry.sourceLine} patterns=${patternList} matched ${entry.matchedFiles.length}/${totalConsidered}: ${truncateFileList(matchedList)}`;
    }
    if (entry.type === "GATE_RUN") {
        return null;
    }
    if (entry.type === "COOLDOWN" || entry.type === "UNCHANGED" || entry.type === "SKIP") {
        return `${entry.sourceFile}:${entry.sourceLine} "${entry.expandedRun}"`;
    }
    if (entry.type === "LAUNCHING") {
        return `${entry.sourceFile}:${entry.sourceLine} "${entry.expandedRun}"`;
    }
    if (entry.type === "STARTED") {
        const pidPart = entry.pid !== null ? ` pid=${entry.pid}` : "";
        return `${entry.sourceFile}:${entry.sourceLine} "${entry.expandedRun}"${pidPart}`;
    }
    if (entry.type === "PASS" || entry.type === "FAIL" || entry.type === "TIMEOUT") {
        const pidPart = entry.pid !== null ? ` pid=${entry.pid}` : "";
        const errorPart = entry.error !== undefined ? ` error="${entry.error}"` : "";
        return `${entry.sourceFile}:${entry.sourceLine} "${entry.expandedRun}"${pidPart} exit=${entry.exitCode} ${entry.durationMs}ms${errorPart}`;
    }
    if (entry.type === "EXIT") {
        return `${entry.durationMs}ms pass=${entry.pass} fail=${entry.fail} skip=${entry.skip} exit=${entry.exitCode}`;
    }
    if (entry.type === "ERROR") {
        return entry.message;
    }
    return null;
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

    // Appends `entry` to the JSON log for the construction-time hour, and to the text log when
    // `formatTextEntry` returns a non-null line. JSON keeps every variant; the text log carries only the
    // per-command outcomes and hook errors (see `renderEntryBody`). Creates the parent directory
    // recursively on first call so callers do not have to coordinate setup.
    async log(entry: IAuditLogEntry): Promise<void> {
        const jsonPath = resolveJsonLogPath(this.baseDir, this.now);
        const textPath = resolveTextLogPath(this.baseDir, this.now);
        await fs.mkdir(path.dirname(jsonPath), { recursive: true });
        await fs.appendFile(jsonPath, JSON.stringify(entry) + "\n");
        const textLine = formatTextEntry(entry);
        if (textLine !== null) {
            await fs.appendFile(textPath, textLine + "\n");
        }
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

// Routes each `IAuditLogEntry` to the audit logger that owns the layer it came from. Per-layer entries
// (those carrying a `sourceFile` or `filePath` that matches a known layer) go to that layer's logger only.
// Global entries (`hook_started`, `changed_files`, `hook_completed`, `hook_error`) and any entry whose
// layer is unknown fan out to every registered logger so each layer's log file is self-contained.
export class MultiLayerLogger implements IAuditLogger {
    // Map from layer display path (e.g. `.claude/claude-tools-runner.yaml`) to that layer's audit logger.
    // Insertion order is preserved; iteration in that order matches the order layers were registered.
    private readonly loggersByDisplayPath: Map<string, IAuditLogger>;

    constructor(loggersByDisplayPath: Map<string, IAuditLogger>) {
        this.loggersByDisplayPath = loggersByDisplayPath;
    }

    async log(entry: IAuditLogEntry): Promise<void> {
        const layerKey = layerKeyForEntry(entry);
        if (layerKey !== null) {
            const target = this.loggersByDisplayPath.get(layerKey);
            if (target !== undefined) {
                await target.log(entry);
                return;
            }
        }
        for (const logger of this.loggersByDisplayPath.values()) {
            await logger.log(entry);
        }
    }
}

// Returns the layer display path that owns `entry`, or null when the entry is global (no layer scope).
// Used by `MultiLayerLogger.log` to decide whether to fan out or route to a single logger.
export function layerKeyForEntry(entry: IAuditLogEntry): string | null {
    if (entry.type === "CONFIG") {
        return entry.filePath;
    }
    if (entry.type === "MATCH"
        || entry.type === "GATE_RUN"
        || entry.type === "COOLDOWN"
        || entry.type === "UNCHANGED"
        || entry.type === "SKIP"
        || entry.type === "LAUNCHING"
        || entry.type === "STARTED"
        || entry.type === "PASS"
        || entry.type === "FAIL"
        || entry.type === "TIMEOUT"
        || entry.type === "STATE_SAVED") {
        return entry.sourceFile;
    }
    return null;
}

// Builds a `FileAuditLogger` rooted at `<scopeDir>/.claude/claude-tools-runner/log` after pruning months
// that have fallen outside the retention window. The Stop hook awaits this once per layer, before
// `hook_started` is emitted. Cleanup is fire-and-await: the logger is returned only once stale months are
// removed so the next entry finds a clean tree. A `.gitignore` containing `*` is dropped at the
// claude-tools-runner root so the directory's contents are invisible to `git status` even if the user has
// not added the directory to their project's own `.gitignore`. The audit log writes that follow
// (`hook_started`, etc.) must not appear as untracked files; otherwise `collectChangedFiles` would surface
// them and turn an idle Stop event into a busy one.
export async function createLogger(scopeDir: string, now: Date): Promise<FileAuditLogger> {
    const baseDir = resolveLogBaseDir(scopeDir);
    await cleanupOldMonths(baseDir, now);
    await fs.mkdir(baseDir, { recursive: true });

    // Drop a `.gitignore` one level up at the `claude-tools-runner/` root so every state and log file the
    // plugin writes (hashes.yaml, runs/, log/) is hidden from `git status` automatically.
    const claudeToolsRunnerDir = path.dirname(baseDir);
    await fs.writeFile(path.join(claudeToolsRunnerDir, ".gitignore"), "*\n");

    return new FileAuditLogger(baseDir, now);
}
