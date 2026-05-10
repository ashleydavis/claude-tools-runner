import * as fs from "node:fs/promises";
import * as path from "node:path";
import { HookSkipReason, IAuditLogger, NullAuditLogger, createLogger, toLocalISOString } from "./audit-log";
import { HOME_DISPLAY_PATH, homeConfigPath, scanConfigFiles } from "./config";
import { collectChangedFiles } from "./git";
import { hashesPath, loadState, runsDir, SaveStateResult, saveState } from "./state";
import { runCommands } from "./runner";
import { FileLayer, TriggerRegistry } from "./trigger-registry";
import { ChangedFile, CompiledCommand, StopHookInput } from "./types";

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
// the layered trigger registry, collects changed files per scope, gates each prepared command, runs them,
// persists state, and prints a one-line summary. Every routine outcome maps to a literal log line in the
// catalog (plan section "Log line catalog"); any unexpected error is surfaced by the top-level `try/catch`
// in `main` as a single stderr line plus exit 1. Audit-log entries are emitted at every event boundary
// (`hook_started`, `config_load`, `changed_files`, `trigger_match`, `gate_decision`, `command_started`,
// `command_result`, `state_saved`, `hook_completed`, `hook_error`) once `CLAUDE_PROJECT_DIR` is known.
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
    const logCompleted = async (exitCode: 0 | 1, skipReason?: HookSkipReason): Promise<void> => {
        if (!hookStartedLogged) {
            return;
        }
        await logger.log({
            type: "hook_completed",
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
            process.exit(1);
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
            process.exit(1);
            return;
        }
    }

    if (parsedInput.stop_hook_active === true) {
        const earlyProjectDir = process.env["CLAUDE_PROJECT_DIR"];
        if (earlyProjectDir !== undefined && earlyProjectDir !== "") {
            try {
                logger = await createLogger(earlyProjectDir, now);
                await logger.log({
                    type: "hook_started",
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
        process.stdout.write("[tools-runner] stop_hook_active set, skipping to avoid recursion\n");
        await logCompleted(0, "stop_hook_active");
        return;
    }

    const projectDir = process.env["CLAUDE_PROJECT_DIR"];
    if (!projectDir) {
        process.stderr.write("[tools-runner] CLAUDE_PROJECT_DIR is not set\n");
        process.exit(1);
        return;
    }

    logger = await createLogger(projectDir, now);
    await logger.log({
        type: "hook_started",
        timestamp: toLocalISOString(now),
        cwd: process.cwd(),
        projectDir,
        sessionId: parsedInput.session_id,
        stopHookActive: false,
    });
    hookStartedLogged = true;

    try {
        const configFilePaths = await scanConfigFiles(projectDir);

        const homeDir = process.env["HOME"] ?? "";
        let homeLayer: FileLayer;
        try {
            homeLayer = await FileLayer.create(
                homeConfigPath(),
                HOME_DISPLAY_PATH,
                homeDir,
                { projectDir: homeDir },
            );
        }
        catch (caughtErr) {
            const loadErr = caughtErr as Error;
            const message = `[tools-runner] failed to load ${HOME_DISPLAY_PATH}: ${loadErr.message}`;
            process.stderr.write(message + "\n");
            throw new HookHandledError(message, loadErr.stack);
        }
        await logger.log({
            type: "config_load",
            timestamp: toLocalISOString(new Date()),
            filePath: HOME_DISPLAY_PATH,
            triggerCount: homeLayer.triggerCount(),
        });

        const configLayers: FileLayer[] = [];
        const configScopeDirs: string[] = [];
        const configDisplayPaths: string[] = [];
        for (const configPath of configFilePaths) {
            const scopeDir = path.dirname(path.dirname(configPath));
            const displayPath = path.relative(projectDir, configPath);
            let layer: FileLayer;
            try {
                layer = await FileLayer.create(
                    configPath,
                    displayPath,
                    scopeDir,
                    { projectDir: scopeDir },
                );
            }
            catch (caughtErr) {
                const loadErr = caughtErr as Error;
                const message = `[tools-runner] failed to load ${displayPath}: ${loadErr.message}`;
                process.stderr.write(message + "\n");
                throw new HookHandledError(message, loadErr.stack);
            }
            await logger.log({
                type: "config_load",
                timestamp: toLocalISOString(new Date()),
                filePath: displayPath,
                triggerCount: layer.triggerCount(),
            });
            configLayers.push(layer);
            configScopeDirs.push(scopeDir);
            configDisplayPaths.push(displayPath);
        }

        const registry = new TriggerRegistry([homeLayer, ...configLayers]);
        if (registry.isEmpty()) {
            process.stdout.write("[tools-runner] no triggers configured, skipping\n");
            await logCompleted(0, "no_triggers");
            return;
        }

        const state = await loadState(projectDir);

        // Collect per-scope changed files. `ChangedFile.path` is scope-relative, so each layer must receive
        // only the changes that belong inside its own `scopeDir`; otherwise a sibling scope's `x.ts` (path
        // `"x.ts"` relative to that scope) would be matched by a different scope's `**/*.ts` glob, breaking
        // scope isolation. We feed each layer its own per-scope list and union the layers' compiled commands.
        const perScopeChanged: ChangedFile[][] = [];
        let totalChanged = 0;
        for (const scopeDir of configScopeDirs) {
            let scopeChanged: ChangedFile[];
            try {
                scopeChanged = await collectChangedFiles(scopeDir);
            }
            catch (caughtErr) {
                const gitErr = caughtErr as NodeJS.ErrnoException;
                if (gitErr.code === "ENOENT") {
                    process.stdout.write("[tools-runner] git binary not found on PATH, skipping\n");
                    await logCompleted(0, "git_missing");
                    return;
                }
                throw caughtErr;
            }
            perScopeChanged.push(scopeChanged);
            totalChanged += scopeChanged.length;
        }

        // The home layer has no project scope of its own; feed it the union of every scope's changes so
        // home triggers can fire on any project file. Production home triggers either operate on
        // `${{file_path}}` (absolute) or are absent, so the lack of a single anchored `scopeDir` for the
        // union is fine. The same union seeds the `changed_files` audit entry: it is the deduped view of
        // every changed file the hook saw across scopes.
        const homeChanged: ChangedFile[] = [];
        const seenHomeAbsPaths = new Set<string>();
        for (const scopeChanged of perScopeChanged) {
            for (const changedFile of scopeChanged) {
                if (seenHomeAbsPaths.has(changedFile.absPath)) {
                    continue;
                }
                seenHomeAbsPaths.add(changedFile.absPath);
                homeChanged.push(changedFile);
            }
        }

        const sortedChanged = homeChanged.slice().sort((leftFile, rightFile) => leftFile.path.localeCompare(rightFile.path));
        await logger.log({
            type: "changed_files",
            timestamp: toLocalISOString(new Date()),
            count: sortedChanged.length,
            files: sortedChanged.map(file => ({ path: file.path })),
        });

        if (totalChanged === 0) {
            process.stdout.write("[tools-runner] no changed files, skipping\n");
            await logCompleted(0, "no_changed_files");
            return;
        }

        for (const matchInfo of homeLayer.evaluateMatches(homeChanged)) {
            await logger.log({
                type: "trigger_match",
                timestamp: toLocalISOString(new Date()),
                sourceFile: matchInfo.sourceFile,
                sourceLine: matchInfo.sourceLine,
                triggerIndex: matchInfo.triggerIndex,
                patterns: matchInfo.patterns,
                matchedFiles: matchInfo.matchedFiles.map(file => file.path),
                unmatchedFiles: matchInfo.unmatchedFiles.map(file => file.path),
            });
        }
        for (let layerIndex = 0; layerIndex < configLayers.length; layerIndex++) {
            const layerMatches = configLayers[layerIndex].evaluateMatches(perScopeChanged[layerIndex]);
            for (const matchInfo of layerMatches) {
                await logger.log({
                    type: "trigger_match",
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

        const prepared: CompiledCommand[] = [];
        for (const homeCompiled of homeLayer.compileCommands(homeChanged)) {
            prepared.push(homeCompiled);
        }
        for (let layerIndex = 0; layerIndex < configLayers.length; layerIndex++) {
            const layerCompiled = configLayers[layerIndex].compileCommands(perScopeChanged[layerIndex]);
            for (const entry of layerCompiled) {
                prepared.push(entry);
            }
        }
        if (prepared.length === 0) {
            process.stdout.write("[tools-runner] no triggers matched, skipping\n");
            await logCompleted(0, "no_match");
            return;
        }

        const results = await runCommands(prepared, state, new Date(), {
            logger,
            logBaseDir: path.join(projectDir, ".claude", "tools-runner-log"),
            projectDir,
        });

        await fs.mkdir(path.join(projectDir, ".claude"), { recursive: true });
        let saveResult: SaveStateResult;
        try {
            saveResult = await saveState(projectDir, state);
        }
        catch (caughtErr) {
            const saveErr = caughtErr as Error;
            const message = `[tools-runner] cannot write state file: ${saveErr.message}`;
            process.stderr.write(message + "\n");
            throw new HookHandledError(message, saveErr.stack);
        }
        await logger.log({
            type: "state_saved",
            timestamp: toLocalISOString(new Date()),
            hashesPath: hashesPath(projectDir),
            runsDir: runsDir(projectDir),
            commandRunsCount: state.commandRuns.length,
            fileHashesCount: Object.keys(state.fileHashes).length,
            prunedCommandRuns: saveResult.prunedCommandRuns,
            prunedFileHashes: saveResult.prunedFileHashes,
        });

        for (const result of results) {
            if (result.logFile === "") {
                skipCount += 1;
            }
            else if (result.exitCode === 0 && result.error === undefined) {
                passCount += 1;
            }
            else {
                failCount += 1;
            }
        }
        process.stdout.write(`[tools-runner] summary: ${passCount} pass, ${failCount} fail, ${skipCount} skip\n`);
        await logCompleted(0);
    }
    catch (caughtErr) {
        const err = caughtErr as Error;
        await logger.log({
            type: "hook_error",
            timestamp: toLocalISOString(new Date()),
            message: err.message,
            stack: err.stack,
        });
        await logCompleted(1);
        if (!(caughtErr instanceof HookHandledError)) {
            process.stderr.write(`${String(caughtErr)}\n`);
        }
        process.exit(1);
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
        process.exit(1);
    }
}

if (process.env["NODE_ENV"] !== "test") {
    main();
}
