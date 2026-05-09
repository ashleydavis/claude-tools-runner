import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import { CommandRunEntry, FileHashEntry, State } from "./types";

// Default TTL applied to `commandRuns` entries when callers do not supply `opts.ttlDays`. Entries whose
// `lastRunAt` is older than this many days (or unparseable) are dropped during `saveState`. The constant is
// hardcoded here because production never overrides it; the override exists solely for deterministic tests.
const DEFAULT_TTL_DAYS: number = 30;

// Number of milliseconds in one day. Used to convert `ttlDays` into the millisecond delta compared against
// `now.getTime() - Date.parse(entry.lastRunAt)`.
const MS_PER_DAY: number = 86_400_000;

// Optional knobs accepted by `saveState`. Both fields are test-only seams: production calls `saveState`
// without `opts` so the runtime clock and the canonical TTL are used.
export interface SaveStateOptions {
    // Override for "right now" used by the TTL prune. Tests pass a fixed `Date` to make pruning deterministic.
    now?: Date;
    // Override for the days-of-history threshold used by the TTL prune. Tests pass small values to exercise
    // the prune path without manufacturing 30-day-old timestamps.
    ttlDays?: number;
}

// Result returned by `saveState`. Carries the cardinality of the prune passes that ran during the save so
// callers (the Stop hook) can emit a `state_saved` audit-log entry without recomputing the deltas.
export interface SaveStateResult {
    // Number of `commandRuns` entries dropped by the TTL prune (and the unparseable-`lastRunAt` filter).
    prunedCommandRuns: number;
    // Number of `fileHashes` entries dropped by the orphan cascade after `commandRuns` was pruned.
    prunedFileHashes: number;
}

// Returns the absolute path of the per-project state YAML for `projectDir`. Pure path join, no IO. The
// resulting file lives next to any per-project `tools-runner.yaml` under `${projectDir}/.claude/`.
export function statePath(projectDir: string): string {
    return path.join(projectDir, ".claude", "tools-runner-state.yaml");
}

// Loads the on-disk state YAML from `filePath`. Returns an empty `{ fileHashes: {}, commandRuns: [] }` when
// the file does not exist (ENOENT). Returns the same empty state and writes one diagnostic line to stderr
// when the file exists but cannot be parsed: the Stop hook treats corrupt state as recoverable so a damaged
// state file never blocks Claude. Other read errors propagate.
export async function loadState(filePath: string): Promise<State> {
    let fileText: string;
    try {
        fileText = await fs.readFile(filePath, "utf8");
    }
    catch (caughtErr) {
        const errnoErr = caughtErr as NodeJS.ErrnoException;
        if (errnoErr.code === "ENOENT") {
            return emptyState();
        }
        throw caughtErr;
    }

    try {
        const parsed = YAML.parse(fileText);
        return validateAndNormalizeState(parsed);
    }
    catch (caughtErr) {
        const parseErr = caughtErr as Error;
        process.stderr.write(`[tools-runner] state file is corrupt, treating as empty: ${parseErr.message}\n`);
        return emptyState();
    }
}

// Persists `state` to `filePath` atomically. Mutates `state` in place to apply the TTL prune over
// `commandRuns` and the cascading orphan-prune over `fileHashes` BEFORE serialising, so the file on disk
// always reflects the post-prune shape. The write is published atomically via a sibling `.tmp` file plus
// `fs.rename`. Rename failures propagate so the Stop hook's top-level `try/catch` can surface them as the
// "cannot write state file" outcome (exit 1).
export async function saveState(filePath: string, state: State, opts?: SaveStateOptions): Promise<SaveStateResult> {
    const now: Date = opts?.now !== undefined ? opts.now : new Date();
    const ttlDays: number = opts?.ttlDays !== undefined ? opts.ttlDays : DEFAULT_TTL_DAYS;
    const ttlMillis: number = ttlDays * MS_PER_DAY;
    const nowMillis: number = now.getTime();

    const survivingRuns: CommandRunEntry[] = [];
    for (const entry of state.commandRuns) {
        const lastRunMillis: number = Date.parse(entry.lastRunAt);
        if (Number.isNaN(lastRunMillis)) {
            continue;
        }
        if (nowMillis - lastRunMillis > ttlMillis) {
            continue;
        }
        survivingRuns.push(entry);
    }
    const prunedCommandRuns: number = state.commandRuns.length - survivingRuns.length;
    state.commandRuns = survivingRuns;

    const keepKeys: Set<string> = new Set<string>();
    for (const entry of state.commandRuns) {
        for (const matchedPath of entry.matchedFiles) {
            keepKeys.add(matchedPath);
        }
    }
    const fileHashesBefore: number = Object.keys(state.fileHashes).length;
    const survivingFileHashes: Record<string, FileHashEntry> = {};
    for (const fileHashKey of Object.keys(state.fileHashes)) {
        if (keepKeys.has(fileHashKey)) {
            survivingFileHashes[fileHashKey] = state.fileHashes[fileHashKey];
        }
    }
    const prunedFileHashes: number = fileHashesBefore - Object.keys(survivingFileHashes).length;
    state.fileHashes = survivingFileHashes;

    const yamlText: string = YAML.stringify(state);
    const tmpPath: string = filePath + ".tmp";
    await fs.writeFile(tmpPath, yamlText);
    await fs.rename(tmpPath, filePath);
    return { prunedCommandRuns, prunedFileHashes };
}

// Computes the deterministic content-addressed key for one prepared command. Identifies the command by its
// fully expanded `run` and `cwd`, joined by a NUL byte to prevent boundary ambiguity (e.g. so a `run` ending
// in `/foo` plus a `cwd` of `bar` does not collide with a `run` of `/foobar` plus a `cwd` of empty).
export function commandKeyFor(expandedRun: string, expandedCwd: string): string {
    const hasher = crypto.createHash("sha256");
    hasher.update(expandedRun);
    hasher.update("\0");
    hasher.update(expandedCwd);
    return hasher.digest("hex");
}

// Returns the `CommandRunEntry` in `state` whose `commandKey` matches, or `undefined` when no such entry
// exists. Pure in-memory lookup; no IO.
export function findCommandRun(state: State, commandKey: string): CommandRunEntry | undefined {
    for (const entry of state.commandRuns) {
        if (entry.commandKey === commandKey) {
            return entry;
        }
    }
    return undefined;
}

// Inserts `entry` into `state.commandRuns` or replaces an existing entry with the same `commandKey`. Pure
// in-memory mutation; no IO. Replacement (rather than append) keeps `commandRuns` content-addressed: editing
// a trigger's `paths` while leaving its `run`/`cwd` unchanged updates the existing record instead of
// orphaning it.
export function upsertCommandRun(state: State, entry: CommandRunEntry): void {
    for (let entryIndex = 0; entryIndex < state.commandRuns.length; entryIndex++) {
        if (state.commandRuns[entryIndex].commandKey === entry.commandKey) {
            state.commandRuns[entryIndex] = entry;
            return;
        }
    }
    state.commandRuns.push(entry);
}

// Returns a freshly-allocated empty state object. Used by `loadState` for both the missing-file and
// corrupt-file paths so callers always receive a writeable object with the expected shape.
export function emptyState(): State {
    return { fileHashes: {}, commandRuns: [] };
}

// Validates the parsed YAML payload and coerces it into a typed `State`. Throws when the payload is not a
// plain object or when `fileHashes` / `commandRuns` are present but the wrong shape. Missing top-level keys
// are treated as empty (e.g. a state file containing only `commandRuns: []` loads with an empty
// `fileHashes` record). The validation is intentionally narrow: it only rejects shapes the rest of the
// codebase cannot consume.
export function validateAndNormalizeState(parsed: any): State {
    if (parsed === null || parsed === undefined) {
        return emptyState();
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("state YAML root must be a mapping");
    }

    const fileHashes: Record<string, FileHashEntry> = {};
    if (parsed.fileHashes !== undefined && parsed.fileHashes !== null) {
        if (typeof parsed.fileHashes !== "object" || Array.isArray(parsed.fileHashes)) {
            throw new Error("state.fileHashes must be a mapping");
        }
        for (const fileKey of Object.keys(parsed.fileHashes)) {
            const rawEntry = parsed.fileHashes[fileKey];
            fileHashes[fileKey] = validateFileHashEntry(rawEntry, fileKey);
        }
    }

    const commandRuns: CommandRunEntry[] = [];
    if (parsed.commandRuns !== undefined && parsed.commandRuns !== null) {
        if (!Array.isArray(parsed.commandRuns)) {
            throw new Error("state.commandRuns must be a sequence");
        }
        for (let runIndex = 0; runIndex < parsed.commandRuns.length; runIndex++) {
            const rawEntry = parsed.commandRuns[runIndex];
            commandRuns.push(validateCommandRunEntry(rawEntry, runIndex));
        }
    }

    return { fileHashes, commandRuns };
}

// Coerces one raw `fileHashes` entry into a `FileHashEntry`, throwing when required scalar fields are
// missing or have the wrong type. `fileKey` is included in error messages so a corrupt state file points to
// the offending entry by path.
export function validateFileHashEntry(raw: any, fileKey: string): FileHashEntry {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`state.fileHashes[${JSON.stringify(fileKey)}] must be a mapping`);
    }
    if (typeof raw.mtimeMs !== "number") {
        throw new Error(`state.fileHashes[${JSON.stringify(fileKey)}].mtimeMs must be a number`);
    }
    if (typeof raw.size !== "number") {
        throw new Error(`state.fileHashes[${JSON.stringify(fileKey)}].size must be a number`);
    }
    if (typeof raw.hash !== "string") {
        throw new Error(`state.fileHashes[${JSON.stringify(fileKey)}].hash must be a string`);
    }
    return { mtimeMs: raw.mtimeMs, size: raw.size, hash: raw.hash };
}

// Coerces one raw `commandRuns` entry into a `CommandRunEntry`, throwing when required scalar fields are
// missing or have the wrong type. `runIndex` is included in error messages so a corrupt state file points
// to the offending entry by ordinal position.
export function validateCommandRunEntry(raw: any, runIndex: number): CommandRunEntry {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`state.commandRuns[${runIndex}] must be a mapping`);
    }
    if (typeof raw.commandKey !== "string") {
        throw new Error(`state.commandRuns[${runIndex}].commandKey must be a string`);
    }
    if (typeof raw.expandedRun !== "string") {
        throw new Error(`state.commandRuns[${runIndex}].expandedRun must be a string`);
    }
    if (typeof raw.expandedCwd !== "string") {
        throw new Error(`state.commandRuns[${runIndex}].expandedCwd must be a string`);
    }
    if (typeof raw.sourceFile !== "string") {
        throw new Error(`state.commandRuns[${runIndex}].sourceFile must be a string`);
    }
    if (typeof raw.sourceLine !== "number") {
        throw new Error(`state.commandRuns[${runIndex}].sourceLine must be a number`);
    }
    if (typeof raw.lastRunAt !== "string") {
        throw new Error(`state.commandRuns[${runIndex}].lastRunAt must be a string`);
    }
    if (typeof raw.lastFilesHash !== "string") {
        throw new Error(`state.commandRuns[${runIndex}].lastFilesHash must be a string`);
    }
    if (!Array.isArray(raw.matchedFiles)) {
        throw new Error(`state.commandRuns[${runIndex}].matchedFiles must be a sequence`);
    }
    const matchedFiles: string[] = [];
    for (let matchedIndex = 0; matchedIndex < raw.matchedFiles.length; matchedIndex++) {
        const rawMatched = raw.matchedFiles[matchedIndex];
        if (typeof rawMatched !== "string") {
            throw new Error(`state.commandRuns[${runIndex}].matchedFiles[${matchedIndex}] must be a string`);
        }
        matchedFiles.push(rawMatched);
    }
    return {
        commandKey: raw.commandKey,
        expandedRun: raw.expandedRun,
        expandedCwd: raw.expandedCwd,
        sourceFile: raw.sourceFile,
        sourceLine: raw.sourceLine,
        lastRunAt: raw.lastRunAt,
        lastFilesHash: raw.lastFilesHash,
        matchedFiles,
    };
}
