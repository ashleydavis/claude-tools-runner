import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import { withFileLock, WithFileLockOptions } from "./lock";
import { CommandRunEntry, FileHashEntry, State } from "./types";

// Default TTL applied to per-command run files when callers do not supply `opts.ttlDays`. Files whose
// `lastRunAt` is older than this many days (or unparseable) are unlinked during `saveState`. Hardcoded
// because production never overrides it; the override exists solely for deterministic tests.
const DEFAULT_TTL_DAYS: number = 30;

// Number of milliseconds in one day. Used to convert `ttlDays` into the millisecond delta compared against
// `now.getTime() - Date.parse(entry.lastRunAt)`.
const MS_PER_DAY: number = 86_400_000;

// Optional knobs accepted by `saveState`. Every field is a test-only seam: production calls `saveState`
// without `opts` so the runtime clock and the canonical TTL/lock thresholds are used.
export interface SaveStateOptions {
    // Override for "right now" used by the TTL prune. Tests pass a fixed `Date` to make pruning deterministic.
    now?: Date;
    // Override for the days-of-history threshold used by the TTL prune.
    ttlDays?: number;
    // Override for the stale-lock threshold passed to each `withFileLock` acquisition.
    staleLockMs?: number;
}

// Result returned by `saveState`. Carries the cardinality of the prune passes that ran during the save so
// callers (the Stop hook) can emit a `state_saved` audit-log entry without recomputing the deltas.
export interface SaveStateResult {
    // Number of per-command run files unlinked by the TTL prune.
    prunedCommandRuns: number;
    // Number of `fileHashes` entries dropped by the orphan cascade after the run-file prune.
    prunedFileHashes: number;
}

// Returns the absolute path of the per-project hash cache YAML for `projectDir`. The hash cache holds the
// deduped `FileHashEntry` map keyed by absolute file path. Per-command run records live in sibling files
// under `runsDir(projectDir)`.
export function hashesPath(projectDir: string): string {
    return path.join(projectDir, ".claude", "tools-runner-hashes.yaml");
}

// Returns the directory that holds one YAML file per `commandKey`. Each file carries a single
// `CommandRunEntry`.
export function runsDir(projectDir: string): string {
    return path.join(projectDir, ".claude", "tools-runner-runs");
}

// Returns the absolute path of the per-command run file for `commandKey` under `projectDir`.
export function commandRunPath(projectDir: string, commandKey: string): string {
    return path.join(runsDir(projectDir), `${commandKey}.yaml`);
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

// Inserts `entry` into `state.commandRuns` or replaces an existing entry with the same `commandKey`. Sets
// `entry.dirty = true` so `saveState` rewrites only this entry's per-command file (loaded entries are
// marked clean by `loadState` and their on-disk files are left alone, preserving any concurrent updates
// from another hook). Pure in-memory mutation; no IO.
export function upsertCommandRun(state: State, entry: CommandRunEntry): void {
    entry.dirty = true;
    for (let entryIndex = 0; entryIndex < state.commandRuns.length; entryIndex++) {
        if (state.commandRuns[entryIndex].commandKey === entry.commandKey) {
            state.commandRuns[entryIndex] = entry;
            return;
        }
    }
    state.commandRuns.push(entry);
}

// Returns a freshly-allocated empty state object. Used by `loadState` for the missing-files path so callers
// always receive a writeable object with the expected shape.
export function emptyState(): State {
    return {
        fileHashes: {},
        commandRuns: [],
    };
}

// Loads the on-disk state for `projectDir`. Reads the hash cache file plus every well-formed per-command
// run file under `runsDir(projectDir)`. A missing hash cache, missing runs directory, or corrupt individual
// files are tolerated (treated as empty / skipped) so a damaged state never blocks the Stop hook. Loaded
// entries are marked `dirty = false` so `saveState` leaves their files alone unless the caller upserts.
export async function loadState(projectDir: string): Promise<State> {
    const state = emptyState();

    state.fileHashes = await loadHashesFile(hashesPath(projectDir));

    let runFileNames: string[];
    try {
        runFileNames = await fs.readdir(runsDir(projectDir));
    }
    catch (caughtErr) {
        const errnoErr = caughtErr as NodeJS.ErrnoException;
        if (errnoErr.code === "ENOENT") {
            return state;
        }
        throw caughtErr;
    }

    for (const fileName of runFileNames) {
        if (!fileName.endsWith(".yaml")) {
            continue;
        }
        const runFilePath = path.join(runsDir(projectDir), fileName);
        const entry = await loadCommandRunFile(runFilePath);
        if (entry === undefined) {
            continue;
        }
        entry.dirty = false;
        state.commandRuns.push(entry);
    }
    return state;
}

// Persists `state` to `projectDir`. Each dirty per-command file is rewritten under its own `withFileLock`
// (last-rename-wins on contention; the lock just serializes writers so they do not collide on the
// intermediate tmp file). The TTL prune scans `runsDir` and unlinks files whose `lastRunAt` is older than
// `ttlDays`. The hash cache is rewritten under its own lock; the orphan prune drops `fileHashes` entries
// that no surviving run references. Returns the prune cardinalities so the caller can emit a
// `state_saved` audit entry.
export async function saveState(projectDir: string, state: State, opts?: SaveStateOptions): Promise<SaveStateResult> {
    const now = opts?.now !== undefined ? opts.now : new Date();
    const ttlDays = opts?.ttlDays !== undefined ? opts.ttlDays : DEFAULT_TTL_DAYS;
    const ttlMillis = ttlDays * MS_PER_DAY;
    const nowMillis = now.getTime();
    const lockOpts: WithFileLockOptions = {};
    if (opts?.staleLockMs !== undefined) {
        lockOpts.staleLockMs = opts.staleLockMs;
    }

    await fs.mkdir(runsDir(projectDir), { recursive: true });

    for (const entry of state.commandRuns) {
        if (entry.dirty === false) {
            continue;
        }
        await writeCommandRunFile(projectDir, entry, lockOpts);
    }

    let runFileNames: string[];
    try {
        runFileNames = await fs.readdir(runsDir(projectDir));
    }
    catch (caughtErr) {
        const errnoErr = caughtErr as NodeJS.ErrnoException;
        if (errnoErr.code === "ENOENT") {
            runFileNames = [];
        }
        else {
            throw caughtErr;
        }
    }

    let prunedCommandRuns = 0;
    const survivingPaths = new Set<string>();
    const survivingCommandKeys = new Set<string>();
    for (const fileName of runFileNames) {
        if (!fileName.endsWith(".yaml")) {
            continue;
        }
        const runFilePath = path.join(runsDir(projectDir), fileName);
        const entry = await loadCommandRunFile(runFilePath);
        if (entry === undefined) {
            continue;
        }
        const lastRunMillis = Date.parse(entry.lastRunAt);
        const expired = Number.isNaN(lastRunMillis) || nowMillis - lastRunMillis > ttlMillis;
        if (expired) {
            const unlinked = await withFileLock(runFilePath + ".lock", async () => {
                try {
                    await fs.unlink(runFilePath);
                    return true;
                }
                catch (unlinkErr) {
                    const errnoUnlinkErr = unlinkErr as NodeJS.ErrnoException;
                    if (errnoUnlinkErr.code === "ENOENT") {
                        return false;
                    }
                    throw unlinkErr;
                }
            }, lockOpts);
            if (unlinked) {
                prunedCommandRuns += 1;
            }
            continue;
        }
        survivingCommandKeys.add(entry.commandKey);
        for (const matchedFile of entry.matchedFiles) {
            survivingPaths.add(matchedFile);
        }
    }

    const survivingRuns: CommandRunEntry[] = [];
    for (const entry of state.commandRuns) {
        if (survivingCommandKeys.has(entry.commandKey)) {
            survivingRuns.push(entry);
        }
    }
    state.commandRuns = survivingRuns;

    let prunedFileHashes = 0;
    await withFileLock(hashesPath(projectDir) + ".lock", async () => {
        const fileHashesBefore = Object.keys(state.fileHashes).length;
        const survivingHashes: Record<string, FileHashEntry> = {};
        for (const fileHashKey of Object.keys(state.fileHashes)) {
            if (survivingPaths.has(fileHashKey)) {
                survivingHashes[fileHashKey] = state.fileHashes[fileHashKey];
            }
        }
        prunedFileHashes = fileHashesBefore - Object.keys(survivingHashes).length;
        await writeHashesFileContents(hashesPath(projectDir), survivingHashes);
        state.fileHashes = survivingHashes;
    }, lockOpts);

    return { prunedCommandRuns, prunedFileHashes };
}

// Reads, parses, and validates the hash cache file at `filePath`. Returns an empty map on ENOENT (the file
// has not been created yet) or when the file exists but is corrupt; the corrupt path also writes one
// diagnostic line to stderr so `loadState` callers see why the cache was dropped. Other read errors
// propagate so the caller can surface them via the catalog stderr line.
export async function loadHashesFile(filePath: string): Promise<Record<string, FileHashEntry>> {
    let fileText: string;
    try {
        fileText = await fs.readFile(filePath, "utf8");
    }
    catch (caughtErr) {
        const errnoErr = caughtErr as NodeJS.ErrnoException;
        if (errnoErr.code === "ENOENT") {
            return {};
        }
        throw caughtErr;
    }
    try {
        const parsed = YAML.parse(fileText);
        return validateHashesFile(parsed);
    }
    catch (caughtErr) {
        const parseErr = caughtErr as Error;
        process.stderr.write(`[tools-runner] hash cache file is corrupt, treating as empty: ${parseErr.message}\n`);
        return {};
    }
}

// Reads, parses, and validates one per-command run file at `filePath`. Returns `undefined` on ENOENT or on
// any corruption; the corruption path also writes one diagnostic line to stderr so consumers can see which
// file was skipped. A skipped file is effectively re-derived: the next hook that runs the corresponding
// command will write a fresh entry.
export async function loadCommandRunFile(filePath: string): Promise<CommandRunEntry | undefined> {
    let fileText: string;
    try {
        fileText = await fs.readFile(filePath, "utf8");
    }
    catch (caughtErr) {
        const errnoErr = caughtErr as NodeJS.ErrnoException;
        if (errnoErr.code === "ENOENT") {
            return undefined;
        }
        throw caughtErr;
    }
    try {
        const parsed = YAML.parse(fileText);
        return validateCommandRunEntry(parsed, filePath);
    }
    catch (caughtErr) {
        const parseErr = caughtErr as Error;
        process.stderr.write(`[tools-runner] run file is corrupt, skipping ${filePath}: ${parseErr.message}\n`);
        return undefined;
    }
}

// Acquires the per-command file's lock and atomically writes `entry` to its YAML file. Last-rename-wins on
// contention from concurrent hooks: each writer holds the lock just long enough to publish its own
// `tmp+rename`, so no two writers' bytes ever interleave even though the final on-disk content reflects
// only the last writer's record. Dirty tracking ensures we only call this for entries the current hook
// actually modified, so concurrent updates to entries we did not touch are preserved.
async function writeCommandRunFile(projectDir: string, entry: CommandRunEntry, lockOpts: WithFileLockOptions): Promise<void> {
    const filePath = commandRunPath(projectDir, entry.commandKey);
    const lockPath = filePath + ".lock";
    await withFileLock(lockPath, async () => {
        await writeCommandRunFileContents(filePath, entry);
    }, lockOpts);
}

// Atomically writes the YAML payload (the entry's persisted fields) to `filePath` via the canonical
// tmp+rename pattern. Caller is expected to hold the per-file lock.
async function writeCommandRunFileContents(filePath: string, entry: CommandRunEntry): Promise<void> {
    const payload = {
        commandKey: entry.commandKey,
        expandedRun: entry.expandedRun,
        expandedCwd: entry.expandedCwd,
        sourceFile: entry.sourceFile,
        sourceLine: entry.sourceLine,
        lastRunAt: entry.lastRunAt,
        lastFilesHash: entry.lastFilesHash,
        matchedFiles: entry.matchedFiles,
    };
    await atomicWriteYaml(filePath, payload);
}

// Atomically writes the hash cache YAML payload to `filePath` via the canonical tmp+rename pattern.
// Caller is expected to hold the hash cache lock.
async function writeHashesFileContents(filePath: string, fileHashes: Record<string, FileHashEntry>): Promise<void> {
    await atomicWriteYaml(filePath, { fileHashes });
}

// Writes `payload` to `filePath` atomically. Serialises via `YAML.stringify`, writes to a sibling tmp file
// whose name carries the current pid plus 8 random bytes, then renames into place. The unique tmp name
// ensures two writers cannot collide on the same intermediate file even if they bypass the per-file lock
// (defense in depth) and means a crashed write leaves an identifiable orphan rather than silently
// pre-empting the next writer's tmp slot. Rename failures propagate so the Stop hook's top-level
// `try/catch` can surface them as the "cannot write state file" outcome.
async function atomicWriteYaml(filePath: string, payload: unknown): Promise<void> {
    const yamlText = YAML.stringify(payload);
    const uniqueSuffix = crypto.randomBytes(8).toString("hex");
    const tmpPath = `${filePath}.${process.pid}.${uniqueSuffix}.tmp`;
    await fs.writeFile(tmpPath, yamlText);
    await fs.rename(tmpPath, filePath);
}

// Validates the parsed YAML payload of a hash cache file. Throws when the payload is not a plain mapping
// or when `fileHashes` is present but the wrong shape. Missing `fileHashes` is treated as empty.
export function validateHashesFile(parsed: any): Record<string, FileHashEntry> {
    if (parsed === null || parsed === undefined) {
        return {};
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("hash cache YAML root must be a mapping");
    }
    const fileHashes: Record<string, FileHashEntry> = {};
    if (parsed.fileHashes !== undefined && parsed.fileHashes !== null) {
        if (typeof parsed.fileHashes !== "object" || Array.isArray(parsed.fileHashes)) {
            throw new Error("hash cache fileHashes must be a mapping");
        }
        for (const fileKey of Object.keys(parsed.fileHashes)) {
            const rawEntry = parsed.fileHashes[fileKey];
            fileHashes[fileKey] = validateFileHashEntry(rawEntry, fileKey);
        }
    }
    return fileHashes;
}

// Coerces one raw `fileHashes` entry into a `FileHashEntry`, throwing when required scalar fields are
// missing or have the wrong type. `fileKey` is included in error messages so a corrupt cache file points
// to the offending entry by path.
export function validateFileHashEntry(raw: any, fileKey: string): FileHashEntry {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`fileHashes[${JSON.stringify(fileKey)}] must be a mapping`);
    }
    if (typeof raw.mtimeMs !== "number") {
        throw new Error(`fileHashes[${JSON.stringify(fileKey)}].mtimeMs must be a number`);
    }
    if (typeof raw.size !== "number") {
        throw new Error(`fileHashes[${JSON.stringify(fileKey)}].size must be a number`);
    }
    if (typeof raw.hash !== "string") {
        throw new Error(`fileHashes[${JSON.stringify(fileKey)}].hash must be a string`);
    }
    return { mtimeMs: raw.mtimeMs, size: raw.size, hash: raw.hash };
}

// Coerces one raw run-file payload into a `CommandRunEntry`, throwing when required scalar fields are
// missing or have the wrong type. `filePath` is included in error messages so a corrupt run file points
// to the offending file by path. Throws on a null/non-mapping root.
export function validateCommandRunEntry(raw: any, filePath: string): CommandRunEntry {
    if (raw === null || raw === undefined) {
        throw new Error(`run file ${filePath} is empty`);
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`run file ${filePath} root must be a mapping`);
    }
    if (typeof raw.commandKey !== "string") {
        throw new Error(`run file ${filePath}: commandKey must be a string`);
    }
    if (typeof raw.expandedRun !== "string") {
        throw new Error(`run file ${filePath}: expandedRun must be a string`);
    }
    if (typeof raw.expandedCwd !== "string") {
        throw new Error(`run file ${filePath}: expandedCwd must be a string`);
    }
    if (typeof raw.sourceFile !== "string") {
        throw new Error(`run file ${filePath}: sourceFile must be a string`);
    }
    if (typeof raw.sourceLine !== "number") {
        throw new Error(`run file ${filePath}: sourceLine must be a number`);
    }
    if (typeof raw.lastRunAt !== "string") {
        throw new Error(`run file ${filePath}: lastRunAt must be a string`);
    }
    if (typeof raw.lastFilesHash !== "string") {
        throw new Error(`run file ${filePath}: lastFilesHash must be a string`);
    }
    if (!Array.isArray(raw.matchedFiles)) {
        throw new Error(`run file ${filePath}: matchedFiles must be a sequence`);
    }
    const matchedFiles: string[] = [];
    for (let matchedIndex = 0; matchedIndex < raw.matchedFiles.length; matchedIndex++) {
        const rawMatched = raw.matchedFiles[matchedIndex];
        if (typeof rawMatched !== "string") {
            throw new Error(`run file ${filePath}: matchedFiles[${matchedIndex}] must be a string`);
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
