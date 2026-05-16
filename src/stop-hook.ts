import * as path from "node:path";
import { FileAuditLogger, HookSkipReason, IAuditLogger, MultiLayerLogger, NullAuditLogger, createLogger, resolveLogBaseDir, toLocalISOString } from "./audit-log";
import { HOME_DISPLAY_PATH, homeConfigPath, loadProjectRootIgnorePatterns, scanConfigFiles } from "./config";
import { collectChangedFiles } from "./git";
import { hashesPath, loadState, runsDir, SaveStateResult, saveState } from "./state";
import { runCommands, RunResult } from "./runner";
import { FileLayer } from "./trigger-registry";
import { ChangedFile, CompiledCommand, State, StopHookInput } from "./types";

// Custom error subclass thrown by routine error paths inside the post-logger phase of `runStopHook`. The
// outer `try/catch` recognises this class and writes only the audit-log entries (the canonical stderr line
// has already been written at the throw site). Other thrown values are treated as unhandled exceptions and
// surfaced via `String(err)` per the catalog.
export class HookHandledError extends Error {
    constructor(message: string, stack?: string) {
        super(message);
        this.name = "HookHandledError";
        if (stack !== undefined) {
            this.stack = stack;
        }
    }
}

// One discovered configuration source, plus the bookkeeping needed to drive it through the pipeline. Each
// per-config YAML and the home YAML produces one `LayerSlot`. The slot is built up incrementally:
// `displayPath`, `scopeDir`, and `logger` are populated up front (before YAML parse) so a parse error can
// be emitted via the audit log; `layer` is populated only after `FileLayer.create` resolves.
interface LayerSlot {
    // Display path stamped onto every audit-log entry from this layer (e.g. `.claude/claude-tools-runner.yaml`).
    displayPath: string;
    // Directory the layer's configuration governs. State and logs live under `<scopeDir>/.claude/claude-tools-runner/`.
    scopeDir: string;
    // Absolute path of the YAML on disk. `null` for the home layer when `$HOME` is unset.
    configPath: string | null;
    // Audit logger rooted at this layer's `.claude/claude-tools-runner/log/` tree, or null when the layer
    // has no on-disk presence (e.g. home layer when `$HOME` is unset). Loggers are created before YAML is
    // parsed so config-load failures still flow through the audit log.
    logger: IAuditLogger;
    // True when this layer has its own state and per-layer audit log files on disk. False for layers that
    // were instantiated only to keep ordering invariants.
    hasFileBackedState: boolean;
    // Populated after a successful `FileLayer.create`. Undefined while the layer is still being loaded
    // (so a parse failure can be logged with the surrounding `try/catch` and the slot left in a half-loaded
    // state without a stale layer reference).
    layer?: FileLayer;
}

// Maximum number of bytes the Stop hook will accept on stdin before it destroys the stream and rejects the
// read with the canonical 1 MiB cap error. The cap exists because the Stop hook reads its entire stdin into
// memory before parsing JSON; without a cap a hostile or runaway producer could exhaust process memory.
const MAX_STDIN_BYTES: number = 1024 * 1024;

// Reads all of `process.stdin` into a UTF-8 string, capping the accumulated payload at `MAX_STDIN_BYTES`.
// Implementation iterates `for await` over the stream so the body remains async. When the running total
// crosses the cap the function destroys stdin to abort backpressured upstream writes and rejects with the
// canonical error so `runStopHook` can surface the catalog stderr line.
export async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const rawChunk of process.stdin) {
        const chunkBuffer = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        total += chunkBuffer.length;
        if (total > MAX_STDIN_BYTES) {
            process.stdin.destroy();
            throw new Error("stdin payload exceeded 1 MiB cap");
        }
        chunks.push(chunkBuffer);
    }
    return Buffer.concat(chunks).toString("utf8");
}

// Top-level Stop hook entry point. Reads stdin, applies the recursion guard, scans for config files, builds
// one trigger layer per discovered YAML (plus the home layer), and walks each layer through the
// load → match → gate → run → save pipeline. State and per-layer audit logs live under each layer's
// `<scopeDir>/.claude/claude-tools-runner/` tree so nested repos with their own config get isolated state.
// Global hook events (`hook_started`, `changed_files`, `hook_completed`, `hook_error`) fan out to every
// layer's audit log via `MultiLayerLogger`.
export async function runStopHook(): Promise<void> {
    const startedAt = Date.now();
    const now = new Date();
    let logger: IAuditLogger = new NullAuditLogger();
    let hookStartedLogged = false;
    let passCount = 0;
    let failCount = 0;
    let skipCount = 0;

    // Writes a `hook_completed` audit entry, but only when `hook_started` was already written. Skipping
    // when no `hook_started` was logged keeps the (start, completed) pair invariant intact.
    const logCompleted = async (exitCode: 0 | 2, skipReason?: HookSkipReason): Promise<void> => {
        if (!hookStartedLogged) {
            return;
        }
        await logger.log({
            type: "EXIT",
            timestamp: toLocalISOString(new Date()),
            durationMs: Date.now() - startedAt,
            pass: passCount,
            fail: failCount,
            skip: skipCount,
            exitCode,
            skipReason,
        });
    };

    let stdinText: string;
    try {
        stdinText = await readStdin();
    }
    catch (caughtErr) {
        const stdinErr = caughtErr as Error;
        if (stdinErr.message === "stdin payload exceeded 1 MiB cap") {
            process.stderr.write("[tools-runner] stdin payload exceeded 1 MiB cap\n");
            process.exit(2);
            return;
        }
        throw caughtErr;
    }

    let parsedInput: StopHookInput;
    if (stdinText.trim().length === 0) {
        parsedInput = {};
    }
    else {
        try {
            parsedInput = JSON.parse(stdinText);
        }
        catch (caughtErr) {
            const parseErr = caughtErr as Error;
            process.stderr.write(`[tools-runner] stdin is not valid JSON: ${parseErr.message}\n`);
            process.exit(2);
            return;
        }
    }

    if (parsedInput.stop_hook_active === true) {
        const earlyProjectDir = process.env["CLAUDE_PROJECT_DIR"];
        if (earlyProjectDir !== undefined && earlyProjectDir !== "") {
            try {
                const earlyLogger = await createLogger(earlyProjectDir, now);
                logger = earlyLogger;
                await logger.log({
                    type: "ENTRY",
                    timestamp: toLocalISOString(now),
                    cwd: process.cwd(),
                    projectDir: earlyProjectDir,
                    sessionId: parsedInput.session_id,
                    stopHookActive: true,
                });
                hookStartedLogged = true;
            }
            catch {
                // Best-effort: a failure to initialise the audit log on the recursion path must not block
                // the recursion guard. Fall back to NullAuditLogger and continue with the canonical stdout
                // line so Claude's session is never wedged by a broken log directory.
            }
        }
        // Stop hooks must keep stdout silent on the success path: Claude Code only parses stdout for
        // structured JSON, and any other output is debug-log noise that never reaches the user. The
        // recursion-skip path is recorded in the audit log via `logCompleted("stop_hook_active")`.
        await logCompleted(0, "stop_hook_active");
        return;
    }

    const projectDir = process.env["CLAUDE_PROJECT_DIR"];
    if (!projectDir) {
        process.stderr.write("[tools-runner] CLAUDE_PROJECT_DIR is not set\n");
        process.exit(2);
        return;
    }

    const homeDir = process.env["HOME"] ?? "";
    const rootIgnorePatterns = await loadProjectRootIgnorePatterns(projectDir);
    let configFilePaths: string[];
    try {
        configFilePaths = await scanConfigFiles(projectDir, rootIgnorePatterns);
    }
    catch (caughtErr) {
        process.stderr.write(`[tools-runner] failed to scan for config files: ${(caughtErr as Error).message}\n`);
        process.exit(2);
        return;
    }

    // Reserve one `LayerSlot` for the home layer plus one per discovered config. Loggers are built first
    // so a YAML parse error during `FileLayer.create` can still flow through `hook_error`. The home layer's
    // logger is omitted when `$HOME` is unset because we have no anchor for its `.claude/claude-tools-runner/`.
    const layers: LayerSlot[] = [];

    let homeLogger: IAuditLogger;
    let homeHasFileBackedState: boolean;
    if (homeDir !== "") {
        homeLogger = await createLogger(homeDir, now);
        homeHasFileBackedState = true;
    }
    else {
        homeLogger = new NullAuditLogger();
        homeHasFileBackedState = false;
    }
    layers.push({
        displayPath: HOME_DISPLAY_PATH,
        scopeDir: homeDir,
        configPath: homeConfigPath(),
        logger: homeLogger,
        hasFileBackedState: homeHasFileBackedState,
    });

    for (const configPath of configFilePaths) {
        const scopeDir = path.dirname(path.dirname(configPath));
        const displayPath = path.relative(projectDir, configPath);
        const layerLogger = await createLogger(scopeDir, now);
        layers.push({
            displayPath,
            scopeDir,
            configPath,
            logger: layerLogger,
            hasFileBackedState: true,
        });
    }

    const loggerMap: Map<string, IAuditLogger> = new Map();
    for (const slot of layers) {
        if (slot.hasFileBackedState) {
            loggerMap.set(slot.displayPath, slot.logger);
        }
    }
    if (loggerMap.size === 0) {
        // No file-backed loggers (no $HOME and no project configs). Drop a single project-dir logger so
        // global events still land somewhere users can find by inspection.
        const fallbackLogger = await createLogger(projectDir, now);
        loggerMap.set(projectDir, fallbackLogger);
    }
    logger = new MultiLayerLogger(loggerMap);

    await logger.log({
        type: "ENTRY",
        timestamp: toLocalISOString(now),
        cwd: process.cwd(),
        projectDir,
        sessionId: parsedInput.session_id,
        stopHookActive: false,
    });
    hookStartedLogged = true;

    try {
        // Resolve each layer's `FileLayer` (parsing the YAML at the same time). Failures emit a stderr
        // line and throw `HookHandledError`; the outer catch logs `hook_error` and the hook exits 1.
        for (const slot of layers) {
            try {
                slot.layer = await FileLayer.create(
                    slot.configPath,
                    slot.displayPath,
                    slot.scopeDir,
                    { projectDir: slot.scopeDir },
                );
            }
            catch (caughtErr) {
                const loadErr = caughtErr as Error;
                const message = `[tools-runner] failed to load ${slot.displayPath}: ${loadErr.message}`;
                process.stderr.write(message + "\n");
                throw new HookHandledError(message, loadErr.stack);
            }
            const layerHashesPath = slot.hasFileBackedState ? hashesPath(slot.scopeDir) : "";
            const layerRunsDir = slot.hasFileBackedState ? runsDir(slot.scopeDir) : "";
            const layerLogBaseDir = slot.hasFileBackedState ? resolveLogBaseDir(slot.scopeDir) : "";
            await logger.log({
                type: "CONFIG",
                timestamp: toLocalISOString(new Date()),
                filePath: slot.displayPath,
                triggerCount: slot.layer.triggerCount(),
                hashesPath: layerHashesPath,
                runsDir: layerRunsDir,
                logBaseDir: layerLogBaseDir,
            });
            // Layer-load narration lives only in the audit log; stdout stays silent because Claude
            // Code parses it as JSON on exit 0 and discards it otherwise.
        }

        const allEmpty = layers.every(slot => slot.layer !== undefined && slot.layer.isEmpty());
        if (allEmpty) {
            await logCompleted(0, "no_triggers");
            return;
        }

        // Per-scope changed-file collection. Each layer needs files inside its own `scopeDir`, because
        // `ChangedFile.path` is scope-relative; otherwise a sibling scope's globs would match unrelated
        // files. The home layer (its scope is `$HOME`) gets the union of every project-scope change set so
        // home triggers can still fire on any project file.
        const perLayerChanged: Map<string, ChangedFile[]> = new Map();
        const projectScopeChangedLists: ChangedFile[][] = [];
        let totalChanged = 0;
        for (const slot of layers) {
            if (slot.displayPath === HOME_DISPLAY_PATH) {
                continue;
            }
            let scopeChanged: ChangedFile[];
            try {
                scopeChanged = await collectChangedFiles(slot.scopeDir);
            }
            catch (caughtErr) {
                const gitErr = caughtErr as NodeJS.ErrnoException;
                if (gitErr.code === "ENOENT") {
                    // Recorded in the audit log via the `git_missing` skip reason; stdout stays silent.
                    await logCompleted(0, "git_missing");
                    return;
                }
                throw caughtErr;
            }
            perLayerChanged.set(slot.displayPath, scopeChanged);
            projectScopeChangedLists.push(scopeChanged);
            totalChanged += scopeChanged.length;
        }

        const homeChanged: ChangedFile[] = [];
        const seenHomeAbsPaths = new Set<string>();
        for (const scopeChanged of projectScopeChangedLists) {
            for (const changedFile of scopeChanged) {
                if (seenHomeAbsPaths.has(changedFile.absPath)) {
                    continue;
                }
                seenHomeAbsPaths.add(changedFile.absPath);
                homeChanged.push(changedFile);
            }
        }
        perLayerChanged.set(HOME_DISPLAY_PATH, homeChanged);

        const sortedChanged = homeChanged.slice().sort((leftFile, rightFile) => leftFile.path.localeCompare(rightFile.path));
        await logger.log({
            type: "CHANGE",
            timestamp: toLocalISOString(new Date()),
            count: sortedChanged.length,
            files: sortedChanged.map(file => ({ path: file.path })),
        });

        if (totalChanged === 0) {
            // Recorded in the audit log via the `no_changed_files` skip reason; stdout stays silent.
            await logCompleted(0, "no_changed_files");
            return;
        }

        for (const slot of layers) {
            if (slot.layer === undefined) {
                continue;
            }
            const layerChanged = perLayerChanged.get(slot.displayPath) ?? [];
            for (const matchInfo of slot.layer.evaluateMatches(layerChanged)) {
                await logger.log({
                    type: "MATCH",
                    timestamp: toLocalISOString(new Date()),
                    sourceFile: matchInfo.sourceFile,
                    sourceLine: matchInfo.sourceLine,
                    triggerIndex: matchInfo.triggerIndex,
                    patterns: matchInfo.patterns,
                    matchedFiles: matchInfo.matchedFiles.map(file => file.path),
                    unmatchedFiles: matchInfo.unmatchedFiles.map(file => file.path),
                });
            }
        }

        // Per-layer state load. Each layer keeps its own `hashes.yaml` and `runs/` tree under
        // `<scopeDir>/.claude/claude-tools-runner/`, so nested repos cannot contaminate each other.
        const stateByLayer: Map<string, State> = new Map();
        for (const slot of layers) {
            if (!slot.hasFileBackedState) {
                continue;
            }
            stateByLayer.set(slot.displayPath, await loadState(slot.scopeDir));
        }

        const preparedByLayer: Map<string, CompiledCommand[]> = new Map();
        let totalPrepared = 0;
        for (const slot of layers) {
            if (slot.layer === undefined) {
                preparedByLayer.set(slot.displayPath, []);
                continue;
            }
            const layerChanged = perLayerChanged.get(slot.displayPath) ?? [];
            const compiled = slot.layer.compileCommands(layerChanged);
            preparedByLayer.set(slot.displayPath, compiled);
            totalPrepared += compiled.length;
        }
        if (totalPrepared === 0) {
            // Recorded in the audit log via the `no_match` skip reason; stdout stays silent.
            await logCompleted(0, "no_match");
            return;
        }

        // Run each layer's commands in parallel. `runCommands` itself fans out via Promise.all internally;
        // the outer Promise.all here adds layer-level parallelism on top so independent layers do not block
        // each other on slow commands.
        const layerRunPromises: Promise<RunResult[]>[] = [];
        for (const slot of layers) {
            const compiled = preparedByLayer.get(slot.displayPath) ?? [];
            if (compiled.length === 0) {
                layerRunPromises.push(Promise.resolve([]));
                continue;
            }
            const layerState = stateByLayer.get(slot.displayPath);
            if (layerState === undefined) {
                // Layer has no file-backed state (e.g. home layer with $HOME unset): skip running its
                // commands rather than risk losing state on every invocation.
                layerRunPromises.push(Promise.resolve([]));
                continue;
            }
            layerRunPromises.push(runCommands(compiled, layerState, new Date(), {
                logger,
                logBaseDir: resolveLogBaseDir(slot.scopeDir),
                projectDir: slot.scopeDir,
            }));
        }
        const resultsByLayer = await Promise.all(layerRunPromises);

        // Save state per layer.
        for (const slot of layers) {
            if (!slot.hasFileBackedState) {
                continue;
            }
            const layerState = stateByLayer.get(slot.displayPath);
            if (layerState === undefined) {
                continue;
            }
            let saveResult: SaveStateResult;
            try {
                saveResult = await saveState(slot.scopeDir, layerState);
            }
            catch (caughtErr) {
                const saveErr = caughtErr as Error;
                const message = `[tools-runner] cannot write state file: ${saveErr.message}`;
                process.stderr.write(message + "\n");
                throw new HookHandledError(message, saveErr.stack);
            }
            await logger.log({
                type: "STATE_SAVED",
                timestamp: toLocalISOString(new Date()),
                sourceFile: slot.displayPath,
                hashesPath: hashesPath(slot.scopeDir),
                runsDir: runsDir(slot.scopeDir),
                commandRunsCount: layerState.commandRuns.length,
                fileHashesCount: Object.keys(layerState.fileHashes).length,
                prunedCommandRuns: saveResult.prunedCommandRuns,
                prunedFileHashes: saveResult.prunedFileHashes,
            });
        }

        const failedResults: RunResult[] = [];
        for (const layerResults of resultsByLayer) {
            for (const result of layerResults) {
                if (result.logFile === "") {
                    skipCount += 1;
                }
                else if (result.exitCode === 0 && result.error === undefined) {
                    passCount += 1;
                }
                else {
                    failCount += 1;
                    failedResults.push(result);
                }
            }
        }
        if (failCount > 0) {
            // Surface each failed command (and the run-summary) on stderr so Claude Code (which feeds
            // Stop-hook stderr back to the model when the hook exits 2) sees the failure reasons in the
            // next turn. Nothing goes to stdout: Claude Code parses Stop-hook stdout as JSON and treats
            // anything else as debug-log-only noise.
            for (const failedResult of failedResults) {
                const sourceLocation = `${failedResult.prepared.sourceFile}:${failedResult.prepared.commandSourceLine}`;
                const failureDetail = failedResult.error !== undefined ? failedResult.error : `exit=${failedResult.exitCode}`;
                process.stderr.write(`[tools-runner] FAIL ${sourceLocation} "${failedResult.prepared.expandedRun}" ${failureDetail} log=${failedResult.logFile}\n`);
            }
            process.stderr.write(`[tools-runner] summary: ${passCount} pass, ${failCount} fail, ${skipCount} skip\n`);
            await logCompleted(2);
            process.exit(2);
            return;
        }
        await logCompleted(0);
    }
    catch (caughtErr) {
        const err = caughtErr as Error;
        await logger.log({
            type: "ERROR",
            timestamp: toLocalISOString(new Date()),
            message: err.message,
            stack: err.stack,
        });
        await logCompleted(2);
        if (!(caughtErr instanceof HookHandledError)) {
            process.stderr.write(`${String(caughtErr)}\n`);
        }
        process.exit(2);
    }
}

// Process-level entry point. Wraps `runStopHook` in a `try/catch` so any unhandled error is surfaced as a
// single stderr line and the process exits 1. The wrapper exists so the Stop hook never returns to its
// invoker with an unhandled rejection: every error path either matches a catalog log line or falls through
// to this final `String(err)` write.
export async function main(): Promise<void> {
    try {
        await runStopHook();
    }
    catch (caughtErr) {
        process.stderr.write(`${String(caughtErr)}\n`);
        process.exit(2);
    }
}

if (process.env["NODE_ENV"] !== "test") {
    main();
}

// Unused re-export silencer; keeps `FileAuditLogger` reachable from this module so callers that want the
// file logger have a single import point.
export type _StopHookFileAuditLoggerRef = FileAuditLogger;
