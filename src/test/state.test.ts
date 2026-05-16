import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import {
    clearLayerState,
    commandKeyFor,
    commandRunPath,
    emptyState,
    findCommandRun,
    hashesPath,
    loadCommandRunFile,
    loadHashesFile,
    loadState,
    runsDir,
    saveState,
    upsertCommandRun,
    validateCommandRunEntry,
    validateFileHashEntry,
    validateHashesFile,
} from "../state";
import { CommandRunEntry, FileHashEntry, State } from "../types";

// Holds a temp directory path for the lifetime of one test, plus helpers to clean it up. Each test uses
// the directory as `projectDir` so the new path helpers (`hashesPath`, `runsDir`, `commandRunPath`) all
// resolve under one disposable root.
interface TempArea {
    // Absolute path to the per-test temp directory created via `fs.mkdtemp`.
    rootDir: string;
}

// Creates a fresh temp directory under the OS temp root and returns a `TempArea` referencing it.
async function makeTempArea(): Promise<TempArea> {
    const baseDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-state-test-"));
    return { rootDir: baseDir };
}

// Removes a temp area created by `makeTempArea`, ignoring missing-directory errors.
async function cleanupTempArea(area: TempArea): Promise<void> {
    await fs.rm(area.rootDir, { recursive: true, force: true });
}

// Writes `content` to `filePath`, creating parent directories as needed. Used to seed disk state for the
// load-side tests.
async function writeFileEnsuringDirs(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
}

// Builds a `CommandRunEntry` populated with deterministic placeholder values plus the per-test overrides.
// Tests use this so they can vary the few fields they care about (commandKey, lastRunAt, matchedFiles)
// without repeating the full struct each time.
function makeCommandRunEntry(overrides: Partial<CommandRunEntry>): CommandRunEntry {
    const base: CommandRunEntry = {
        commandKey: "abc",
        expandedRun: "echo hi",
        expandedCwd: "/tmp/myrepo",
        sourceFile: "/tmp/myrepo/.claude/claude-tools-runner.yaml",
        sourceLine: 1,
        lastRunAt: "2026-05-09T00:00:00.000Z",
        lastFilesHash: "deadbeef",
        matchedFiles: [],
    };
    return { ...base, ...overrides };
}

// Builds the on-disk YAML payload for a per-command run file. Used by tests that seed disk state directly.
function makeRunFileYaml(entry: CommandRunEntry): string {
    return YAML.stringify({
        commandKey: entry.commandKey,
        expandedRun: entry.expandedRun,
        expandedCwd: entry.expandedCwd,
        sourceFile: entry.sourceFile,
        sourceLine: entry.sourceLine,
        lastRunAt: entry.lastRunAt,
        lastFilesHash: entry.lastFilesHash,
        matchedFiles: entry.matchedFiles,
    });
}

// Builds the on-disk YAML payload for the hash cache file. Used by tests that seed disk state directly.
function makeHashesFileYaml(fileHashes: Record<string, FileHashEntry>): string {
    return YAML.stringify({ fileHashes });
}

describe("hashesPath", () => {
    test("joins scopeDir with .claude/claude-tools-runner/hashes.yaml", () => {
        const result: string = hashesPath("/tmp/myrepo");
        expect(result).toBe(path.join("/tmp/myrepo", ".claude", "claude-tools-runner", "hashes.yaml"));
    });
});

describe("runsDir", () => {
    test("joins scopeDir with .claude/claude-tools-runner/runs", () => {
        const result: string = runsDir("/tmp/myrepo");
        expect(result).toBe(path.join("/tmp/myrepo", ".claude", "claude-tools-runner", "runs"));
    });
});

describe("commandRunPath", () => {
    test("joins runsDir with the commandKey suffix", () => {
        const result: string = commandRunPath("/tmp/myrepo", "deadbeef");
        expect(result).toBe(path.join("/tmp/myrepo", ".claude", "claude-tools-runner", "runs", "deadbeef.yaml"));
    });
});

describe("commandKeyFor", () => {
    test("is deterministic for the same inputs", () => {
        const first: string = commandKeyFor("bun run test", "/tmp/myrepo");
        const second: string = commandKeyFor("bun run test", "/tmp/myrepo");
        expect(first).toBe(second);
    });

    test("differs when expandedRun differs", () => {
        const first: string = commandKeyFor("bun run test", "/tmp/myrepo");
        const second: string = commandKeyFor("bun run test:all", "/tmp/myrepo");
        expect(first).not.toBe(second);
    });

    test("differs when expandedCwd differs", () => {
        const first: string = commandKeyFor("bun run test", "/tmp/myrepo");
        const second: string = commandKeyFor("bun run test", "/tmp/other");
        expect(first).not.toBe(second);
    });

    test("returns a 64-character lowercase hex digest", () => {
        const result: string = commandKeyFor("echo hi", "/tmp");
        expect(result).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("emptyState", () => {
    test("returns a fresh State with empty fields", () => {
        const result: State = emptyState();
        expect(result.fileHashes).toEqual({});
        expect(result.commandRuns).toEqual([]);
    });

    test("returns a fresh object on each call (mutation does not leak between callers)", () => {
        const first: State = emptyState();
        first.commandRuns.push(makeCommandRunEntry({ commandKey: "leak" }));
        const second: State = emptyState();
        expect(second.commandRuns.length).toBe(0);
    });
});

describe("findCommandRun", () => {
    test("returns undefined when no entry matches", () => {
        const state: State = emptyState();
        const result = findCommandRun(state, "missing");
        expect(result).toBeUndefined();
    });

    test("returns the entry whose commandKey matches", () => {
        const wanted: CommandRunEntry = makeCommandRunEntry({ commandKey: "wanted" });
        const other: CommandRunEntry = makeCommandRunEntry({ commandKey: "other" });
        const state: State = emptyState();
        state.commandRuns.push(other, wanted);
        const result = findCommandRun(state, "wanted");
        expect(result).toBe(wanted);
    });
});

describe("upsertCommandRun", () => {
    test("appends a new entry when no existing entry shares the commandKey", () => {
        const state: State = emptyState();
        const entry: CommandRunEntry = makeCommandRunEntry({ commandKey: "fresh" });
        upsertCommandRun(state, entry);
        expect(state.commandRuns.length).toBe(1);
        expect(state.commandRuns[0]).toBe(entry);
    });

    test("replaces an existing entry without duplicating it (paths edit does not orphan state)", () => {
        const original: CommandRunEntry = makeCommandRunEntry({
            commandKey: "k1",
            matchedFiles: ["/tmp/myrepo/old.ts"],
            lastFilesHash: "old-hash",
        });
        const state: State = emptyState();
        state.commandRuns.push(original);
        const replacement: CommandRunEntry = makeCommandRunEntry({
            commandKey: "k1",
            matchedFiles: ["/tmp/myrepo/old.ts", "/tmp/myrepo/added.ts"],
            lastFilesHash: "new-hash",
        });
        upsertCommandRun(state, replacement);
        expect(state.commandRuns.length).toBe(1);
        expect(state.commandRuns[0]).toBe(replacement);
        expect(state.commandRuns[0].lastFilesHash).toBe("new-hash");
    });
});

describe("loadState", () => {
    let tempArea: TempArea;

    beforeEach(async () => {
        tempArea = await makeTempArea();
    });

    afterEach(async () => {
        await cleanupTempArea(tempArea);
    });

    test("returns an empty state when neither the hash cache nor the runs directory exists", async () => {
        const result: State = await loadState(tempArea.rootDir);
        expect(result.fileHashes).toEqual({});
        expect(result.commandRuns).toEqual([]);
    });

    test("loads the hash cache file", async () => {
        const yamlText = makeHashesFileYaml({
            "/tmp/myrepo/a.ts": { mtimeMs: 100, size: 10, hash: "aa" },
        });
        await writeFileEnsuringDirs(hashesPath(tempArea.rootDir), yamlText);

        const result = await loadState(tempArea.rootDir);
        expect(result.fileHashes["/tmp/myrepo/a.ts"]).toEqual({ mtimeMs: 100, size: 10, hash: "aa" });
    });

    test("loads each per-command run file under runsDir", async () => {
        const entryOne = makeCommandRunEntry({
            commandKey: "k1",
            matchedFiles: ["/tmp/myrepo/a.ts"],
        });
        const entryTwo = makeCommandRunEntry({
            commandKey: "k2",
            matchedFiles: ["/tmp/myrepo/b.ts"],
        });
        await writeFileEnsuringDirs(commandRunPath(tempArea.rootDir, "k1"), makeRunFileYaml(entryOne));
        await writeFileEnsuringDirs(commandRunPath(tempArea.rootDir, "k2"), makeRunFileYaml(entryTwo));

        const result = await loadState(tempArea.rootDir);
        const byKey = new Map<string, CommandRunEntry>();
        for (const entry of result.commandRuns) {
            byKey.set(entry.commandKey, entry);
        }
        expect(byKey.size).toBe(2);
        expect(byKey.get("k1")?.matchedFiles).toEqual(["/tmp/myrepo/a.ts"]);
        expect(byKey.get("k2")?.matchedFiles).toEqual(["/tmp/myrepo/b.ts"]);
    });

    test("ignores files in runsDir that are not .yaml suffixed", async () => {
        await writeFileEnsuringDirs(path.join(runsDir(tempArea.rootDir), "k1.yaml.tmp"), "noise");
        await writeFileEnsuringDirs(path.join(runsDir(tempArea.rootDir), "README.md"), "noise");

        const result = await loadState(tempArea.rootDir);
        expect(result.commandRuns).toEqual([]);
    });

    test("treats a corrupt hash cache file as empty and writes one stderr line", async () => {
        await writeFileEnsuringDirs(hashesPath(tempArea.rootDir), "this: is: not: valid: yaml: [\n");
        const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const result = await loadState(tempArea.rootDir);
            expect(result.fileHashes).toEqual({});
            expect(stderrSpy).toHaveBeenCalledTimes(1);
            expect(stderrSpy.mock.calls[0][0] as string).toContain("[tools-runner] hash cache file is corrupt");
        }
        finally {
            stderrSpy.mockRestore();
        }
    });

    test("skips a corrupt run file and continues loading the rest", async () => {
        const goodEntry = makeCommandRunEntry({ commandKey: "good", matchedFiles: ["/tmp/myrepo/g.ts"] });
        await writeFileEnsuringDirs(commandRunPath(tempArea.rootDir, "good"), makeRunFileYaml(goodEntry));
        await writeFileEnsuringDirs(commandRunPath(tempArea.rootDir, "bad"), "this is not yaml: [\n");
        const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const result = await loadState(tempArea.rootDir);
            expect(result.commandRuns.length).toBe(1);
            expect(result.commandRuns[0].commandKey).toBe("good");
            expect(stderrSpy.mock.calls[0][0] as string).toContain("[tools-runner] run file is corrupt");
        }
        finally {
            stderrSpy.mockRestore();
        }
    });
});

describe("loadHashesFile", () => {
    let tempArea: TempArea;

    beforeEach(async () => {
        tempArea = await makeTempArea();
    });

    afterEach(async () => {
        await cleanupTempArea(tempArea);
    });

    test("returns empty data on ENOENT", async () => {
        const result = await loadHashesFile(path.join(tempArea.rootDir, "missing.yaml"));
        expect(result).toEqual({});
    });
});

describe("loadCommandRunFile", () => {
    let tempArea: TempArea;

    beforeEach(async () => {
        tempArea = await makeTempArea();
    });

    afterEach(async () => {
        await cleanupTempArea(tempArea);
    });

    test("returns undefined on ENOENT", async () => {
        const result = await loadCommandRunFile(path.join(tempArea.rootDir, "missing.yaml"));
        expect(result).toBeUndefined();
    });
});

describe("saveState", () => {
    let tempArea: TempArea;

    beforeEach(async () => {
        tempArea = await makeTempArea();
    });

    afterEach(async () => {
        await cleanupTempArea(tempArea);
    });

    test("writes one YAML file per dirty commandRun and a hash cache file on first save", async () => {
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const entry = makeCommandRunEntry({
            commandKey: "k1",
            matchedFiles: ["/tmp/myrepo/a.ts"],
            lastRunAt: fixedNow.toISOString(),
        });
        const state = emptyState();
        state.fileHashes["/tmp/myrepo/a.ts"] = { mtimeMs: 100, size: 10, hash: "aa" };
        upsertCommandRun(state, entry);

        await saveState(tempArea.rootDir, state, { now: fixedNow });

        const runFileText = await fs.readFile(commandRunPath(tempArea.rootDir, "k1"), "utf8");
        const runParsed = YAML.parse(runFileText);
        expect(runParsed.commandKey).toBe("k1");
        expect(runParsed.matchedFiles).toEqual(["/tmp/myrepo/a.ts"]);

        const hashesText = await fs.readFile(hashesPath(tempArea.rootDir), "utf8");
        const hashesParsed = YAML.parse(hashesText);
        expect(hashesParsed.fileHashes["/tmp/myrepo/a.ts"]).toEqual({ mtimeMs: 100, size: 10, hash: "aa" });
    });

    test("does not rewrite a per-command file for a loaded entry that was not upserted", async () => {
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const seedEntry = makeCommandRunEntry({
            commandKey: "k1",
            matchedFiles: ["/tmp/myrepo/a.ts"],
            lastRunAt: fixedNow.toISOString(),
            lastFilesHash: "seeded-from-disk",
        });
        await writeFileEnsuringDirs(commandRunPath(tempArea.rootDir, "k1"), makeRunFileYaml(seedEntry));
        const seededMtime = (await fs.stat(commandRunPath(tempArea.rootDir, "k1"))).mtimeMs;

        const state = await loadState(tempArea.rootDir);
        await new Promise(resolveSleep => setTimeout(resolveSleep, 10));
        await saveState(tempArea.rootDir, state, { now: fixedNow });

        const afterMtime = (await fs.stat(commandRunPath(tempArea.rootDir, "k1"))).mtimeMs;
        expect(afterMtime).toBe(seededMtime);
    });

    test("TTL prune unlinks per-command files older than ttlDays and counts them", async () => {
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const recentRunAt: string = new Date(fixedNow.getTime() - 1 * 86_400_000).toISOString();
        const expiredRunAt: string = new Date(fixedNow.getTime() - 5 * 86_400_000).toISOString();
        const recentEntry = makeCommandRunEntry({
            commandKey: "kept",
            matchedFiles: ["/tmp/myrepo/keep.ts"],
            lastRunAt: recentRunAt,
        });
        const expiredEntry = makeCommandRunEntry({
            commandKey: "expired",
            matchedFiles: ["/tmp/myrepo/expired.ts"],
            lastRunAt: expiredRunAt,
        });
        await writeFileEnsuringDirs(commandRunPath(tempArea.rootDir, "kept"), makeRunFileYaml(recentEntry));
        await writeFileEnsuringDirs(commandRunPath(tempArea.rootDir, "expired"), makeRunFileYaml(expiredEntry));

        const state = emptyState();
        const result = await saveState(tempArea.rootDir, state, { now: fixedNow, ttlDays: 3 });

        expect(result.prunedCommandRuns).toBe(1);
        await expect(fs.access(commandRunPath(tempArea.rootDir, "kept"))).resolves.toBeUndefined();
        await expect(fs.access(commandRunPath(tempArea.rootDir, "expired"))).rejects.toThrow();
    });

    test("TTL prune unlinks files whose lastRunAt is unparseable", async () => {
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const garbageEntry = makeCommandRunEntry({
            commandKey: "garbage",
            matchedFiles: ["/tmp/myrepo/garbage.ts"],
            lastRunAt: "not-a-timestamp",
        });
        await writeFileEnsuringDirs(commandRunPath(tempArea.rootDir, "garbage"), makeRunFileYaml(garbageEntry));

        const state = emptyState();
        const result = await saveState(tempArea.rootDir, state, { now: fixedNow });

        expect(result.prunedCommandRuns).toBe(1);
        await expect(fs.access(commandRunPath(tempArea.rootDir, "garbage"))).rejects.toThrow();
    });

    test("orphan-prunes fileHashes entries whose path is not referenced by any surviving run", async () => {
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const keptEntry = makeCommandRunEntry({
            commandKey: "kept",
            matchedFiles: ["/tmp/myrepo/a.ts"],
            lastRunAt: fixedNow.toISOString(),
        });
        const state = emptyState();
        state.fileHashes["/tmp/myrepo/a.ts"] = { mtimeMs: 1, size: 1, hash: "a" };
        state.fileHashes["/tmp/myrepo/orphan-one.ts"] = { mtimeMs: 2, size: 2, hash: "o1" };
        state.fileHashes["/tmp/myrepo/orphan-two.ts"] = { mtimeMs: 3, size: 3, hash: "o2" };
        upsertCommandRun(state, keptEntry);

        const result = await saveState(tempArea.rootDir, state, { now: fixedNow });

        expect(result.prunedFileHashes).toBe(2);
        const hashesText = await fs.readFile(hashesPath(tempArea.rootDir), "utf8");
        const parsed = YAML.parse(hashesText);
        expect(Object.keys(parsed.fileHashes).sort()).toEqual(["/tmp/myrepo/a.ts"]);
    });

    test("returns zero prune counts when nothing is dropped", async () => {
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const entry = makeCommandRunEntry({
            commandKey: "k1",
            matchedFiles: ["/tmp/myrepo/a.ts"],
            lastRunAt: fixedNow.toISOString(),
        });
        const state = emptyState();
        state.fileHashes["/tmp/myrepo/a.ts"] = { mtimeMs: 1, size: 1, hash: "a" };
        upsertCommandRun(state, entry);

        const result = await saveState(tempArea.rootDir, state, { now: fixedNow });
        expect(result.prunedCommandRuns).toBe(0);
        expect(result.prunedFileHashes).toBe(0);
    });

    test("uses a unique tmp filename so a leftover predictable .tmp file does not collide", async () => {
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const staleHashesTmpPath = hashesPath(tempArea.rootDir) + ".tmp";
        const staleRunTmpPath = commandRunPath(tempArea.rootDir, "k1") + ".tmp";
        await writeFileEnsuringDirs(staleHashesTmpPath, "stale-hashes");
        await writeFileEnsuringDirs(staleRunTmpPath, "stale-run");

        const entry = makeCommandRunEntry({
            commandKey: "k1",
            matchedFiles: ["/tmp/myrepo/a.ts"],
            lastRunAt: fixedNow.toISOString(),
        });
        const state = emptyState();
        state.fileHashes["/tmp/myrepo/a.ts"] = { mtimeMs: 100, size: 10, hash: "aa" };
        upsertCommandRun(state, entry);

        await saveState(tempArea.rootDir, state, { now: fixedNow });

        const staleHashesContent = await fs.readFile(staleHashesTmpPath, "utf8");
        expect(staleHashesContent).toBe("stale-hashes");
        const staleRunContent = await fs.readFile(staleRunTmpPath, "utf8");
        expect(staleRunContent).toBe("stale-run");
    });

    test("leaves no tmp files behind after a successful save", async () => {
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const entry = makeCommandRunEntry({
            commandKey: "k1",
            matchedFiles: ["/tmp/myrepo/a.ts"],
            lastRunAt: fixedNow.toISOString(),
        });
        const state = emptyState();
        state.fileHashes["/tmp/myrepo/a.ts"] = { mtimeMs: 100, size: 10, hash: "aa" };
        upsertCommandRun(state, entry);

        await saveState(tempArea.rootDir, state, { now: fixedNow });

        const claudeToolsRunnerDir = path.join(tempArea.rootDir, ".claude", "claude-tools-runner");
        const claudeToolsRunnerEntries = await fs.readdir(claudeToolsRunnerDir);
        const runsDirEntries = await fs.readdir(runsDir(tempArea.rootDir));
        const allLeftovers = [
            ...claudeToolsRunnerEntries.map(name => path.join(".claude", "claude-tools-runner", name)),
            ...runsDirEntries.map(name => path.join(".claude", "claude-tools-runner", "runs", name)),
        ];
        const tmpLeftovers = allLeftovers.filter(name => name.endsWith(".tmp"));
        expect(tmpLeftovers).toEqual([]);
    });

    test("save then load round-trips the full state shape", async () => {
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const entry = makeCommandRunEntry({
            commandKey: "k1",
            matchedFiles: ["/tmp/myrepo/a.ts"],
            lastRunAt: fixedNow.toISOString(),
        });
        const state = emptyState();
        state.fileHashes["/tmp/myrepo/a.ts"] = { mtimeMs: 100, size: 10, hash: "aa" };
        upsertCommandRun(state, entry);

        await saveState(tempArea.rootDir, state, { now: fixedNow });
        const loaded = await loadState(tempArea.rootDir);

        expect(loaded.fileHashes["/tmp/myrepo/a.ts"]).toEqual({ mtimeMs: 100, size: 10, hash: "aa" });
        expect(loaded.commandRuns.length).toBe(1);
        expect(loaded.commandRuns[0].commandKey).toBe("k1");
    });
});

describe("clearLayerState", () => {
    let tempArea: TempArea;

    beforeEach(async () => {
        tempArea = await makeTempArea();
    });

    afterEach(async () => {
        await cleanupTempArea(tempArea);
    });

    test("returns 0 when neither runs nor hashes exist", async () => {
        const result = await clearLayerState(tempArea.rootDir);
        expect(result).toBe(0);
    });

    test("returns 0 when the runs directory exists but is empty", async () => {
        await fs.mkdir(runsDir(tempArea.rootDir), { recursive: true });
        const result = await clearLayerState(tempArea.rootDir);
        expect(result).toBe(0);
    });

    test("removes the runs directory and the hashes file, returning the run-file count", async () => {
        const firstEntry = makeCommandRunEntry({ commandKey: "k1" });
        const secondEntry = makeCommandRunEntry({ commandKey: "k2" });
        await writeFileEnsuringDirs(commandRunPath(tempArea.rootDir, "k1"), makeRunFileYaml(firstEntry));
        await writeFileEnsuringDirs(commandRunPath(tempArea.rootDir, "k2"), makeRunFileYaml(secondEntry));
        await writeFileEnsuringDirs(hashesPath(tempArea.rootDir), makeHashesFileYaml({ "/tmp/a.ts": { mtimeMs: 100, size: 10, hash: "aa" } }));

        const result = await clearLayerState(tempArea.rootDir);

        expect(result).toBe(2);
        await expect(fs.stat(runsDir(tempArea.rootDir))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(hashesPath(tempArea.rootDir))).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("removes the hashes file even when no run files exist", async () => {
        await writeFileEnsuringDirs(hashesPath(tempArea.rootDir), makeHashesFileYaml({ "/tmp/a.ts": { mtimeMs: 100, size: 10, hash: "aa" } }));

        const result = await clearLayerState(tempArea.rootDir);

        expect(result).toBe(0);
        await expect(fs.stat(hashesPath(tempArea.rootDir))).rejects.toMatchObject({ code: "ENOENT" });
    });
});

describe("validateHashesFile", () => {
    test("treats null as empty", () => {
        expect(validateHashesFile(null)).toEqual({});
    });

    test("treats undefined as empty", () => {
        expect(validateHashesFile(undefined)).toEqual({});
    });

    test("throws when the root is not a mapping", () => {
        expect(() => validateHashesFile([1, 2])).toThrow("hash cache YAML root must be a mapping");
    });

    test("throws when fileHashes is not a mapping", () => {
        expect(() => validateHashesFile({ fileHashes: [] })).toThrow("fileHashes must be a mapping");
    });

    test("returns parsed data for a well-formed payload", () => {
        const payload = {
            fileHashes: {
                "/tmp/a.ts": { mtimeMs: 100, size: 10, hash: "aa" },
            },
        };
        const result = validateHashesFile(payload);
        expect(result["/tmp/a.ts"]).toEqual({ mtimeMs: 100, size: 10, hash: "aa" });
    });

    test("treats missing fileHashes as empty", () => {
        expect(validateHashesFile({})).toEqual({});
    });
});

describe("validateFileHashEntry", () => {
    test("returns the parsed entry when all fields are well-typed", () => {
        const result: FileHashEntry = validateFileHashEntry({ mtimeMs: 100, size: 10, hash: "aa" }, "/tmp/a");
        expect(result).toEqual({ mtimeMs: 100, size: 10, hash: "aa" });
    });

    test("throws when the raw value is not a mapping", () => {
        expect(() => validateFileHashEntry("not-a-mapping", "/tmp/a")).toThrow("must be a mapping");
    });

    test("throws when mtimeMs is not a number", () => {
        expect(() => validateFileHashEntry({ mtimeMs: "100", size: 10, hash: "aa" }, "/tmp/a")).toThrow("mtimeMs must be a number");
    });

    test("throws when size is not a number", () => {
        expect(() => validateFileHashEntry({ mtimeMs: 100, size: "10", hash: "aa" }, "/tmp/a")).toThrow("size must be a number");
    });

    test("throws when hash is not a string", () => {
        expect(() => validateFileHashEntry({ mtimeMs: 100, size: 10, hash: 42 }, "/tmp/a")).toThrow("hash must be a string");
    });

    test("includes the file key in the error message", () => {
        expect(() => validateFileHashEntry("oops", "/tmp/specific.ts")).toThrow("/tmp/specific.ts");
    });
});

describe("validateCommandRunEntry", () => {
    function makeRawEntry(): Record<string, any> {
        return {
            commandKey: "k1",
            expandedRun: "echo hi",
            expandedCwd: "/tmp/myrepo",
            sourceFile: "/tmp/myrepo/.claude/claude-tools-runner.yaml",
            sourceLine: 1,
            lastRunAt: "2026-05-09T00:00:00.000Z",
            lastFilesHash: "deadbeef",
            matchedFiles: ["/tmp/myrepo/a.ts"],
        };
    }

    test("returns the parsed entry when all fields are well-typed", () => {
        const result: CommandRunEntry = validateCommandRunEntry(makeRawEntry(), "/tmp/run.yaml");
        expect(result.commandKey).toBe("k1");
        expect(result.matchedFiles).toEqual(["/tmp/myrepo/a.ts"]);
    });

    test("throws when commandKey is not a string", () => {
        const raw = makeRawEntry();
        raw.commandKey = 42;
        expect(() => validateCommandRunEntry(raw, "/tmp/run.yaml")).toThrow("commandKey must be a string");
    });

    test("throws when expandedRun is not a string", () => {
        const raw = makeRawEntry();
        raw.expandedRun = 42;
        expect(() => validateCommandRunEntry(raw, "/tmp/run.yaml")).toThrow("expandedRun must be a string");
    });

    test("throws when expandedCwd is not a string", () => {
        const raw = makeRawEntry();
        raw.expandedCwd = 42;
        expect(() => validateCommandRunEntry(raw, "/tmp/run.yaml")).toThrow("expandedCwd must be a string");
    });

    test("throws when sourceFile is not a string", () => {
        const raw = makeRawEntry();
        raw.sourceFile = 42;
        expect(() => validateCommandRunEntry(raw, "/tmp/run.yaml")).toThrow("sourceFile must be a string");
    });

    test("throws when sourceLine is not a number", () => {
        const raw = makeRawEntry();
        raw.sourceLine = "1";
        expect(() => validateCommandRunEntry(raw, "/tmp/run.yaml")).toThrow("sourceLine must be a number");
    });

    test("throws when lastRunAt is not a string", () => {
        const raw = makeRawEntry();
        raw.lastRunAt = 42;
        expect(() => validateCommandRunEntry(raw, "/tmp/run.yaml")).toThrow("lastRunAt must be a string");
    });

    test("throws when lastFilesHash is not a string", () => {
        const raw = makeRawEntry();
        raw.lastFilesHash = 42;
        expect(() => validateCommandRunEntry(raw, "/tmp/run.yaml")).toThrow("lastFilesHash must be a string");
    });

    test("throws when matchedFiles is not a sequence", () => {
        const raw = makeRawEntry();
        raw.matchedFiles = "not-a-sequence";
        expect(() => validateCommandRunEntry(raw, "/tmp/run.yaml")).toThrow("matchedFiles must be a sequence");
    });

    test("throws when a matchedFiles entry is not a string", () => {
        const raw = makeRawEntry();
        raw.matchedFiles = ["/tmp/a.ts", 42];
        expect(() => validateCommandRunEntry(raw, "/tmp/run.yaml")).toThrow("matchedFiles[1] must be a string");
    });

    test("includes the file path in the error message", () => {
        const raw = makeRawEntry();
        raw.commandKey = 42;
        expect(() => validateCommandRunEntry(raw, "/tmp/specific.yaml")).toThrow("/tmp/specific.yaml");
    });
});
