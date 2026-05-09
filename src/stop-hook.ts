import * as fs from "node:fs/promises";
import * as path from "node:path";
import { HOME_DISPLAY_PATH, homeConfigPath, scanConfigFiles } from "./config";
import { collectChangedFiles } from "./git";
import { loadState, saveState, statePath } from "./state";
import { runCommands } from "./runner";
import { FileLayer, TriggerRegistry } from "./trigger-registry";
import { ChangedFile, CompiledCommand, StopHookInput } from "./types";

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
// in `main` as a single stderr line plus exit 1.
export async function runStopHook(): Promise<void> {
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
        process.stdout.write("[tools-runner] stop_hook_active set, skipping to avoid recursion\n");
        return;
    }

    const projectDir = process.env["CLAUDE_PROJECT_DIR"];
    if (!projectDir) {
        process.stderr.write("[tools-runner] CLAUDE_PROJECT_DIR is not set\n");
        process.exit(1);
        return;
    }

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
        process.stderr.write(`[tools-runner] failed to load ${HOME_DISPLAY_PATH}: ${loadErr.message}\n`);
        process.exit(1);
        return;
    }

    const configLayers: FileLayer[] = [];
    const configScopeDirs: string[] = [];
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
            process.stderr.write(`[tools-runner] failed to load ${displayPath}: ${loadErr.message}\n`);
            process.exit(1);
            return;
        }
        configLayers.push(layer);
        configScopeDirs.push(scopeDir);
    }

    const registry = new TriggerRegistry([homeLayer, ...configLayers]);
    if (registry.isEmpty()) {
        process.stdout.write("[tools-runner] no triggers configured, skipping\n");
        return;
    }

    const state = await loadState(statePath(projectDir));

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
                return;
            }
            throw caughtErr;
        }
        perScopeChanged.push(scopeChanged);
        totalChanged += scopeChanged.length;
    }

    if (totalChanged === 0) {
        process.stdout.write("[tools-runner] no changed files, skipping\n");
        return;
    }

    const prepared: CompiledCommand[] = [];
    // The home layer has no project scope of its own; feed it the union of every scope's changes so home
    // triggers can fire on any project file. Production home triggers either operate on `${{file_path}}`
    // (absolute) or are absent, so the lack of a single anchored `scopeDir` for the union is fine.
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
        return;
    }

    const results = await runCommands(prepared, state, new Date());

    const stateFilePath = statePath(projectDir);
    await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
    try {
        await saveState(stateFilePath, state);
    }
    catch (caughtErr) {
        const saveErr = caughtErr as Error;
        process.stderr.write(`[tools-runner] cannot write state file: ${saveErr.message}\n`);
        process.exit(1);
        return;
    }

    let passCount = 0;
    let failCount = 0;
    let skipCount = 0;
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
