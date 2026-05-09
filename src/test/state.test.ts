import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import {
    commandKeyFor,
    emptyState,
    findCommandRun,
    loadState,
    saveState,
    statePath,
    upsertCommandRun,
    validateAndNormalizeState,
    validateCommandRunEntry,
    validateFileHashEntry,
} from "../state";
import { CommandRunEntry, FileHashEntry, State } from "../types";

// Holds a temp directory path for the lifetime of one test, plus helpers to clean it up.
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

// Writes `content` to `filePath`, creating parent directories as needed.
async function writeFileEnsuringDirs(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
}

// Builds a `CommandRunEntry` populated with deterministic placeholder values plus the per-test overrides.
// Tests use this so they can vary the few fields they care about (commandKey, lastRunAt, matchedFiles) without
// repeating the full struct each time.
function makeCommandRunEntry(overrides: Partial<CommandRunEntry>): CommandRunEntry {
    const base: CommandRunEntry = {
        commandKey: "abc",
        expandedRun: "echo hi",
        expandedCwd: "/tmp/myrepo",
        sourceFile: "/tmp/myrepo/.claude/tools-runner.yaml",
        sourceLine: 1,
        lastRunAt: "2026-05-09T00:00:00.000Z",
        lastFilesHash: "deadbeef",
        matchedFiles: [],
    };
    return { ...base, ...overrides };
}

describe("statePath", () => {
    test("joins projectDir with .claude/tools-runner-state.yaml", () => {
        const result: string = statePath("/tmp/myrepo");
        expect(result).toBe(path.join("/tmp/myrepo", ".claude", "tools-runner-state.yaml"));
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

    test("returns an empty state when the file does not exist", async () => {
        const missingPath: string = path.join(tempArea.rootDir, "missing.yaml");
        const result: State = await loadState(missingPath);
        expect(result).toEqual({ fileHashes: {}, commandRuns: [] });
    });

    test("treats a corrupt YAML file as empty state and writes one error line to stderr", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        await writeFileEnsuringDirs(filePath, "this: is: not: valid: yaml: [\n");
        const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const result: State = await loadState(filePath);
            expect(result).toEqual({ fileHashes: {}, commandRuns: [] });
            expect(stderrSpy).toHaveBeenCalledTimes(1);
            const firstCall = stderrSpy.mock.calls[0][0];
            expect(typeof firstCall).toBe("string");
            expect(firstCall as string).toContain("[tools-runner] state file is corrupt, treating as empty:");
        }
        finally {
            stderrSpy.mockRestore();
        }
    });

    test("treats a YAML root that is a sequence as corrupt and writes one stderr line", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        await writeFileEnsuringDirs(filePath, "- not a mapping\n");
        const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const result: State = await loadState(filePath);
            expect(result).toEqual({ fileHashes: {}, commandRuns: [] });
            expect(stderrSpy).toHaveBeenCalledTimes(1);
            expect(stderrSpy.mock.calls[0][0] as string).toContain("state YAML root must be a mapping");
        }
        finally {
            stderrSpy.mockRestore();
        }
    });

    test("treats a YAML file with no contents as empty state without writing stderr", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        await writeFileEnsuringDirs(filePath, "");
        const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const result: State = await loadState(filePath);
            expect(result).toEqual({ fileHashes: {}, commandRuns: [] });
            expect(stderrSpy).not.toHaveBeenCalled();
        }
        finally {
            stderrSpy.mockRestore();
        }
    });

    test("treats fileHashes that is not a mapping as corrupt", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        await writeFileEnsuringDirs(filePath, "fileHashes: [\"not\", \"a\", \"mapping\"]\ncommandRuns: []\n");
        const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const result: State = await loadState(filePath);
            expect(result).toEqual({ fileHashes: {}, commandRuns: [] });
            expect(stderrSpy.mock.calls[0][0] as string).toContain("state.fileHashes must be a mapping");
        }
        finally {
            stderrSpy.mockRestore();
        }
    });

    test("treats commandRuns that is not a sequence as corrupt", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        await writeFileEnsuringDirs(filePath, "fileHashes: {}\ncommandRuns:\n  notASequence: true\n");
        const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const result: State = await loadState(filePath);
            expect(result).toEqual({ fileHashes: {}, commandRuns: [] });
            expect(stderrSpy.mock.calls[0][0] as string).toContain("state.commandRuns must be a sequence");
        }
        finally {
            stderrSpy.mockRestore();
        }
    });

    test("treats a fileHashes entry with a missing required field as corrupt", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        const yamlText: string = [
            "fileHashes:",
            "  /tmp/myrepo/a.ts:",
            "    mtimeMs: 100",
            "    size: 10",
            "commandRuns: []",
            "",
        ].join("\n");
        await writeFileEnsuringDirs(filePath, yamlText);
        const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const result: State = await loadState(filePath);
            expect(result).toEqual({ fileHashes: {}, commandRuns: [] });
            expect(stderrSpy.mock.calls[0][0] as string).toContain("hash must be a string");
        }
        finally {
            stderrSpy.mockRestore();
        }
    });

    test("treats a commandRuns entry with a wrong-typed field as corrupt", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        const yamlText: string = [
            "fileHashes: {}",
            "commandRuns:",
            "  - commandKey: \"k1\"",
            "    expandedRun: \"echo hi\"",
            "    expandedCwd: \"/tmp/myrepo\"",
            "    sourceFile: \"/tmp/myrepo/.claude/tools-runner.yaml\"",
            "    sourceLine: \"not-a-number\"",
            "    lastRunAt: \"2026-05-09T00:00:00.000Z\"",
            "    lastFilesHash: \"deadbeef\"",
            "    matchedFiles: []",
            "",
        ].join("\n");
        await writeFileEnsuringDirs(filePath, yamlText);
        const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const result: State = await loadState(filePath);
            expect(result).toEqual({ fileHashes: {}, commandRuns: [] });
            expect(stderrSpy.mock.calls[0][0] as string).toContain("sourceLine must be a number");
        }
        finally {
            stderrSpy.mockRestore();
        }
    });

    test("treats a matchedFiles entry that is not a string as corrupt", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        const yamlText: string = [
            "fileHashes: {}",
            "commandRuns:",
            "  - commandKey: \"k1\"",
            "    expandedRun: \"echo hi\"",
            "    expandedCwd: \"/tmp/myrepo\"",
            "    sourceFile: \"/tmp/myrepo/.claude/tools-runner.yaml\"",
            "    sourceLine: 1",
            "    lastRunAt: \"2026-05-09T00:00:00.000Z\"",
            "    lastFilesHash: \"deadbeef\"",
            "    matchedFiles:",
            "      - 42",
            "",
        ].join("\n");
        await writeFileEnsuringDirs(filePath, yamlText);
        const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const result: State = await loadState(filePath);
            expect(result).toEqual({ fileHashes: {}, commandRuns: [] });
            expect(stderrSpy.mock.calls[0][0] as string).toContain("matchedFiles[0] must be a string");
        }
        finally {
            stderrSpy.mockRestore();
        }
    });

    // Builds a YAML state document containing one fileHashes entry whose values come from `entry`. Lets the
    // per-field validation tests below substitute a single bad value at a time without rewriting the whole doc.
    function makeFileHashesYaml(entry: Record<string, string>): string {
        const lines: string[] = ["fileHashes:", "  /tmp/myrepo/a.ts:"];
        for (const fieldName of Object.keys(entry)) {
            lines.push(`    ${fieldName}: ${entry[fieldName]}`);
        }
        lines.push("commandRuns: []");
        lines.push("");
        return lines.join("\n");
    }

    // Builds a YAML state document containing one commandRuns entry whose values come from `entry`. As above:
    // lets the per-field validation tests substitute one bad value at a time.
    function makeCommandRunsYaml(entry: Record<string, string>): string {
        const lines: string[] = ["fileHashes: {}", "commandRuns:"];
        const fieldNames = Object.keys(entry);
        for (let fieldIndex = 0; fieldIndex < fieldNames.length; fieldIndex++) {
            const prefix = fieldIndex === 0 ? "  - " : "    ";
            lines.push(`${prefix}${fieldNames[fieldIndex]}: ${entry[fieldNames[fieldIndex]]}`);
        }
        lines.push("");
        return lines.join("\n");
    }

    // Asserts that loading a corrupt state YAML (whatever the corruption) returns an empty state and writes
    // exactly one stderr line containing `expectedSubstring`. Centralises the spy boilerplate for the long
    // table of "this specific shape is invalid" tests below.
    async function expectCorrupt(yamlText: string, expectedSubstring: string): Promise<void> {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        await writeFileEnsuringDirs(filePath, yamlText);
        const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            const result: State = await loadState(filePath);
            expect(result).toEqual({ fileHashes: {}, commandRuns: [] });
            expect(stderrSpy).toHaveBeenCalledTimes(1);
            expect(stderrSpy.mock.calls[0][0] as string).toContain(expectedSubstring);
        }
        finally {
            stderrSpy.mockRestore();
        }
    }

    test("treats a fileHashes entry that is not a mapping as corrupt", async () => {
        await expectCorrupt(
            "fileHashes:\n  /tmp/myrepo/a.ts: \"not-a-mapping\"\ncommandRuns: []\n",
            "must be a mapping",
        );
    });

    test("treats a fileHashes entry whose mtimeMs is not a number as corrupt", async () => {
        await expectCorrupt(
            makeFileHashesYaml({ mtimeMs: "\"not-a-number\"", size: "10", hash: "\"aa\"" }),
            "mtimeMs must be a number",
        );
    });

    test("treats a fileHashes entry whose size is not a number as corrupt", async () => {
        await expectCorrupt(
            makeFileHashesYaml({ mtimeMs: "100", size: "\"not-a-number\"", hash: "\"aa\"" }),
            "size must be a number",
        );
    });

    test("treats a commandRuns entry that is not a mapping as corrupt", async () => {
        await expectCorrupt(
            "fileHashes: {}\ncommandRuns:\n  - \"not-a-mapping\"\n",
            "commandRuns[0] must be a mapping",
        );
    });

    test("treats a commandRuns entry whose commandKey is not a string as corrupt", async () => {
        await expectCorrupt(
            makeCommandRunsYaml({
                commandKey: "42",
                expandedRun: "\"echo hi\"",
                expandedCwd: "\"/tmp/myrepo\"",
                sourceFile: "\"/tmp/myrepo/.claude/tools-runner.yaml\"",
                sourceLine: "1",
                lastRunAt: "\"2026-05-09T00:00:00.000Z\"",
                lastFilesHash: "\"deadbeef\"",
                matchedFiles: "[]",
            }),
            "commandKey must be a string",
        );
    });

    test("treats a commandRuns entry whose expandedRun is not a string as corrupt", async () => {
        await expectCorrupt(
            makeCommandRunsYaml({
                commandKey: "\"k1\"",
                expandedRun: "42",
                expandedCwd: "\"/tmp/myrepo\"",
                sourceFile: "\"/tmp/myrepo/.claude/tools-runner.yaml\"",
                sourceLine: "1",
                lastRunAt: "\"2026-05-09T00:00:00.000Z\"",
                lastFilesHash: "\"deadbeef\"",
                matchedFiles: "[]",
            }),
            "expandedRun must be a string",
        );
    });

    test("treats a commandRuns entry whose expandedCwd is not a string as corrupt", async () => {
        await expectCorrupt(
            makeCommandRunsYaml({
                commandKey: "\"k1\"",
                expandedRun: "\"echo hi\"",
                expandedCwd: "42",
                sourceFile: "\"/tmp/myrepo/.claude/tools-runner.yaml\"",
                sourceLine: "1",
                lastRunAt: "\"2026-05-09T00:00:00.000Z\"",
                lastFilesHash: "\"deadbeef\"",
                matchedFiles: "[]",
            }),
            "expandedCwd must be a string",
        );
    });

    test("treats a commandRuns entry whose sourceFile is not a string as corrupt", async () => {
        await expectCorrupt(
            makeCommandRunsYaml({
                commandKey: "\"k1\"",
                expandedRun: "\"echo hi\"",
                expandedCwd: "\"/tmp/myrepo\"",
                sourceFile: "42",
                sourceLine: "1",
                lastRunAt: "\"2026-05-09T00:00:00.000Z\"",
                lastFilesHash: "\"deadbeef\"",
                matchedFiles: "[]",
            }),
            "sourceFile must be a string",
        );
    });

    test("treats a commandRuns entry whose lastRunAt is not a string as corrupt", async () => {
        await expectCorrupt(
            makeCommandRunsYaml({
                commandKey: "\"k1\"",
                expandedRun: "\"echo hi\"",
                expandedCwd: "\"/tmp/myrepo\"",
                sourceFile: "\"/tmp/myrepo/.claude/tools-runner.yaml\"",
                sourceLine: "1",
                lastRunAt: "42",
                lastFilesHash: "\"deadbeef\"",
                matchedFiles: "[]",
            }),
            "lastRunAt must be a string",
        );
    });

    test("treats a commandRuns entry whose lastFilesHash is not a string as corrupt", async () => {
        await expectCorrupt(
            makeCommandRunsYaml({
                commandKey: "\"k1\"",
                expandedRun: "\"echo hi\"",
                expandedCwd: "\"/tmp/myrepo\"",
                sourceFile: "\"/tmp/myrepo/.claude/tools-runner.yaml\"",
                sourceLine: "1",
                lastRunAt: "\"2026-05-09T00:00:00.000Z\"",
                lastFilesHash: "42",
                matchedFiles: "[]",
            }),
            "lastFilesHash must be a string",
        );
    });

    test("treats a commandRuns entry whose matchedFiles is not a sequence as corrupt", async () => {
        await expectCorrupt(
            makeCommandRunsYaml({
                commandKey: "\"k1\"",
                expandedRun: "\"echo hi\"",
                expandedCwd: "\"/tmp/myrepo\"",
                sourceFile: "\"/tmp/myrepo/.claude/tools-runner.yaml\"",
                sourceLine: "1",
                lastRunAt: "\"2026-05-09T00:00:00.000Z\"",
                lastFilesHash: "\"deadbeef\"",
                matchedFiles: "\"not-a-sequence\"",
            }),
            "matchedFiles must be a sequence",
        );
    });

    test("loads a well-formed state file", async () => {
        const stateOnDisk: State = {
            fileHashes: {
                "/tmp/myrepo/a.ts": { mtimeMs: 100, size: 10, hash: "aa" },
            },
            commandRuns: [
                makeCommandRunEntry({
                    commandKey: "k1",
                    matchedFiles: ["/tmp/myrepo/a.ts"],
                }),
            ],
        };
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        await writeFileEnsuringDirs(filePath, YAML.stringify(stateOnDisk));

        const result: State = await loadState(filePath);
        expect(result.fileHashes["/tmp/myrepo/a.ts"]).toEqual({ mtimeMs: 100, size: 10, hash: "aa" });
        expect(result.commandRuns.length).toBe(1);
        expect(result.commandRuns[0].commandKey).toBe("k1");
        expect(result.commandRuns[0].matchedFiles).toEqual(["/tmp/myrepo/a.ts"]);
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

    test("writes a parseable YAML file that round-trips through yaml.parse", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const recentEntry: CommandRunEntry = makeCommandRunEntry({
            commandKey: "k1",
            matchedFiles: ["/tmp/myrepo/a.ts"],
            lastRunAt: fixedNow.toISOString(),
        });
        const state: State = {
            fileHashes: {
                "/tmp/myrepo/a.ts": { mtimeMs: 100, size: 10, hash: "aa" },
            },
            commandRuns: [recentEntry],
        };
        await saveState(filePath, state, { now: fixedNow });

        const writtenText: string = await fs.readFile(filePath, "utf8");
        const parsed = YAML.parse(writtenText);
        expect(parsed.commandRuns.length).toBe(1);
        expect(parsed.commandRuns[0].commandKey).toBe("k1");
        expect(parsed.commandRuns[0].matchedFiles).toEqual(["/tmp/myrepo/a.ts"]);
        expect(parsed.fileHashes["/tmp/myrepo/a.ts"]).toEqual({ mtimeMs: 100, size: 10, hash: "aa" });
    });

    test("prunes orphaned fileHashes that no surviving commandRun references", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const aHash: FileHashEntry = { mtimeMs: 100, size: 10, hash: "aa" };
        const bHash: FileHashEntry = { mtimeMs: 200, size: 20, hash: "bb" };
        const cHash: FileHashEntry = { mtimeMs: 300, size: 30, hash: "cc" };
        const state: State = {
            fileHashes: {
                "/tmp/myrepo/a.ts": aHash,
                "/tmp/myrepo/b.ts": bHash,
                "/tmp/myrepo/c.ts": cHash,
            },
            commandRuns: [
                makeCommandRunEntry({
                    commandKey: "k1",
                    matchedFiles: ["/tmp/myrepo/a.ts"],
                    lastRunAt: fixedNow.toISOString(),
                }),
            ],
        };
        await saveState(filePath, state, { now: fixedNow });

        const writtenText: string = await fs.readFile(filePath, "utf8");
        const parsed = YAML.parse(writtenText);
        expect(Object.keys(parsed.fileHashes).sort()).toEqual(["/tmp/myrepo/a.ts"]);
        expect(parsed.fileHashes["/tmp/myrepo/a.ts"]).toEqual(aHash);
    });

    test("propagates rename failures (target path is a non-empty directory)", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        await fs.mkdir(filePath, { recursive: true });
        await fs.writeFile(path.join(filePath, "blocker.txt"), "blocker");
        const state: State = { fileHashes: {}, commandRuns: [] };
        await expect(saveState(filePath, state, { now: fixedNow })).rejects.toThrow();
    });

    test("TTL prune drops commandRuns older than ttlDays and cascades to fileHashes", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const recentRunAt: string = new Date(fixedNow.getTime() - 1 * 86_400_000).toISOString();
        const expiredRunAt: string = new Date(fixedNow.getTime() - 5 * 86_400_000).toISOString();
        const recentEntry: CommandRunEntry = makeCommandRunEntry({
            commandKey: "kept",
            matchedFiles: ["/tmp/myrepo/keep.ts"],
            lastRunAt: recentRunAt,
        });
        const expiredEntry: CommandRunEntry = makeCommandRunEntry({
            commandKey: "expired",
            matchedFiles: ["/tmp/myrepo/expired.ts"],
            lastRunAt: expiredRunAt,
        });
        const state: State = {
            fileHashes: {
                "/tmp/myrepo/keep.ts": { mtimeMs: 100, size: 10, hash: "kk" },
                "/tmp/myrepo/expired.ts": { mtimeMs: 200, size: 20, hash: "ee" },
            },
            commandRuns: [recentEntry, expiredEntry],
        };
        await saveState(filePath, state, { now: fixedNow, ttlDays: 3 });

        expect(state.commandRuns.length).toBe(1);
        expect(state.commandRuns[0].commandKey).toBe("kept");
        expect(Object.keys(state.fileHashes).sort()).toEqual(["/tmp/myrepo/keep.ts"]);
    });

    test("TTL prune drops commandRuns whose lastRunAt is unparseable", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const goodEntry: CommandRunEntry = makeCommandRunEntry({
            commandKey: "good",
            matchedFiles: ["/tmp/myrepo/good.ts"],
            lastRunAt: fixedNow.toISOString(),
        });
        const garbageEntry: CommandRunEntry = makeCommandRunEntry({
            commandKey: "garbage",
            matchedFiles: ["/tmp/myrepo/garbage.ts"],
            lastRunAt: "not-a-timestamp",
        });
        const state: State = {
            fileHashes: {
                "/tmp/myrepo/good.ts": { mtimeMs: 100, size: 10, hash: "gg" },
                "/tmp/myrepo/garbage.ts": { mtimeMs: 200, size: 20, hash: "xx" },
            },
            commandRuns: [goodEntry, garbageEntry],
        };
        await saveState(filePath, state, { now: fixedNow });

        expect(state.commandRuns.length).toBe(1);
        expect(state.commandRuns[0].commandKey).toBe("good");
        expect(Object.keys(state.fileHashes).sort()).toEqual(["/tmp/myrepo/good.ts"]);
    });

    test("returns SaveStateResult with prune counts: zero when nothing is dropped", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const recentEntry: CommandRunEntry = makeCommandRunEntry({
            commandKey: "k1",
            matchedFiles: ["/tmp/myrepo/a.ts"],
            lastRunAt: fixedNow.toISOString(),
        });
        const state: State = {
            fileHashes: { "/tmp/myrepo/a.ts": { mtimeMs: 1, size: 1, hash: "a" } },
            commandRuns: [recentEntry],
        };
        const result = await saveState(filePath, state, { now: fixedNow });
        expect(result.prunedCommandRuns).toBe(0);
        expect(result.prunedFileHashes).toBe(0);
    });

    test("returns SaveStateResult with prunedCommandRuns counting TTL drops and unparseable lastRunAt drops", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const recentEntry: CommandRunEntry = makeCommandRunEntry({
            commandKey: "kept",
            matchedFiles: ["/tmp/myrepo/keep.ts"],
            lastRunAt: fixedNow.toISOString(),
        });
        const expiredEntry: CommandRunEntry = makeCommandRunEntry({
            commandKey: "expired",
            matchedFiles: ["/tmp/myrepo/expired.ts"],
            lastRunAt: new Date(fixedNow.getTime() - 5 * 86_400_000).toISOString(),
        });
        const garbageEntry: CommandRunEntry = makeCommandRunEntry({
            commandKey: "garbage",
            matchedFiles: ["/tmp/myrepo/garbage.ts"],
            lastRunAt: "not-a-timestamp",
        });
        const state: State = {
            fileHashes: {
                "/tmp/myrepo/keep.ts": { mtimeMs: 1, size: 1, hash: "k" },
                "/tmp/myrepo/expired.ts": { mtimeMs: 2, size: 2, hash: "e" },
                "/tmp/myrepo/garbage.ts": { mtimeMs: 3, size: 3, hash: "g" },
            },
            commandRuns: [recentEntry, expiredEntry, garbageEntry],
        };
        const result = await saveState(filePath, state, { now: fixedNow, ttlDays: 3 });
        expect(result.prunedCommandRuns).toBe(2);
        expect(result.prunedFileHashes).toBe(2);
    });

    test("returns SaveStateResult with prunedFileHashes counting orphan drops only (no TTL drops)", async () => {
        const filePath: string = path.join(tempArea.rootDir, "state.yaml");
        const fixedNow: Date = new Date("2026-05-09T00:00:00.000Z");
        const keptEntry: CommandRunEntry = makeCommandRunEntry({
            commandKey: "kept",
            matchedFiles: ["/tmp/myrepo/a.ts"],
            lastRunAt: fixedNow.toISOString(),
        });
        const state: State = {
            fileHashes: {
                "/tmp/myrepo/a.ts": { mtimeMs: 1, size: 1, hash: "a" },
                "/tmp/myrepo/orphan-one.ts": { mtimeMs: 2, size: 2, hash: "o1" },
                "/tmp/myrepo/orphan-two.ts": { mtimeMs: 3, size: 3, hash: "o2" },
            },
            commandRuns: [keptEntry],
        };
        const result = await saveState(filePath, state, { now: fixedNow });
        expect(result.prunedCommandRuns).toBe(0);
        expect(result.prunedFileHashes).toBe(2);
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

describe("findCommandRun", () => {
    test("returns undefined when no entry matches", () => {
        const state: State = { fileHashes: {}, commandRuns: [] };
        const result = findCommandRun(state, "missing");
        expect(result).toBeUndefined();
    });

    test("returns the entry whose commandKey matches", () => {
        const wanted: CommandRunEntry = makeCommandRunEntry({ commandKey: "wanted" });
        const other: CommandRunEntry = makeCommandRunEntry({ commandKey: "other" });
        const state: State = { fileHashes: {}, commandRuns: [other, wanted] };
        const result = findCommandRun(state, "wanted");
        expect(result).toBe(wanted);
    });
});

describe("upsertCommandRun", () => {
    test("appends a new entry when no existing entry shares the commandKey", () => {
        const state: State = { fileHashes: {}, commandRuns: [] };
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
        const state: State = { fileHashes: {}, commandRuns: [original] };
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

describe("emptyState", () => {
    test("returns a fresh State with no entries", () => {
        const result: State = emptyState();
        expect(result).toEqual({ fileHashes: {}, commandRuns: [] });
    });

    test("returns a fresh object on each call (mutation does not leak between callers)", () => {
        const first: State = emptyState();
        first.commandRuns.push(makeCommandRunEntry({ commandKey: "leak" }));
        const second: State = emptyState();
        expect(second.commandRuns.length).toBe(0);
    });
});

describe("validateAndNormalizeState", () => {
    test("treats null as empty state", () => {
        expect(validateAndNormalizeState(null)).toEqual({ fileHashes: {}, commandRuns: [] });
    });

    test("treats undefined as empty state", () => {
        expect(validateAndNormalizeState(undefined)).toEqual({ fileHashes: {}, commandRuns: [] });
    });

    test("throws when the root is a string", () => {
        expect(() => validateAndNormalizeState("oops")).toThrow("state YAML root must be a mapping");
    });

    test("throws when the root is an array", () => {
        expect(() => validateAndNormalizeState([1, 2, 3])).toThrow("state YAML root must be a mapping");
    });

    test("throws when fileHashes is an array", () => {
        expect(() => validateAndNormalizeState({ fileHashes: [], commandRuns: [] })).toThrow("state.fileHashes must be a mapping");
    });

    test("throws when commandRuns is a mapping", () => {
        expect(() => validateAndNormalizeState({ fileHashes: {}, commandRuns: { not: "a sequence" } })).toThrow("state.commandRuns must be a sequence");
    });

    test("returns a normalized State for a well-formed payload", () => {
        const payload = {
            fileHashes: {
                "/tmp/myrepo/a.ts": { mtimeMs: 100, size: 10, hash: "aa" },
            },
            commandRuns: [
                {
                    commandKey: "k1",
                    expandedRun: "echo hi",
                    expandedCwd: "/tmp/myrepo",
                    sourceFile: "/tmp/myrepo/.claude/tools-runner.yaml",
                    sourceLine: 1,
                    lastRunAt: "2026-05-09T00:00:00.000Z",
                    lastFilesHash: "deadbeef",
                    matchedFiles: ["/tmp/myrepo/a.ts"],
                },
            ],
        };
        const result: State = validateAndNormalizeState(payload);
        expect(result.fileHashes["/tmp/myrepo/a.ts"]).toEqual({ mtimeMs: 100, size: 10, hash: "aa" });
        expect(result.commandRuns.length).toBe(1);
        expect(result.commandRuns[0].commandKey).toBe("k1");
    });

    test("treats missing fileHashes and commandRuns keys as empty", () => {
        const result: State = validateAndNormalizeState({});
        expect(result).toEqual({ fileHashes: {}, commandRuns: [] });
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

    test("throws when the raw value is an array", () => {
        expect(() => validateFileHashEntry([1, 2], "/tmp/a")).toThrow("must be a mapping");
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
    // Builds a fully well-typed raw object for `validateCommandRunEntry`. Tests below override one field at a
    // time to exercise each per-field branch without re-stating the entire object.
    function makeRawEntry(): Record<string, any> {
        return {
            commandKey: "k1",
            expandedRun: "echo hi",
            expandedCwd: "/tmp/myrepo",
            sourceFile: "/tmp/myrepo/.claude/tools-runner.yaml",
            sourceLine: 1,
            lastRunAt: "2026-05-09T00:00:00.000Z",
            lastFilesHash: "deadbeef",
            matchedFiles: ["/tmp/myrepo/a.ts"],
        };
    }

    test("returns the parsed entry when all fields are well-typed", () => {
        const result: CommandRunEntry = validateCommandRunEntry(makeRawEntry(), 0);
        expect(result.commandKey).toBe("k1");
        expect(result.matchedFiles).toEqual(["/tmp/myrepo/a.ts"]);
    });

    test("throws when the raw value is not a mapping", () => {
        expect(() => validateCommandRunEntry("oops", 3)).toThrow("commandRuns[3] must be a mapping");
    });

    test("throws when the raw value is an array", () => {
        expect(() => validateCommandRunEntry([1, 2], 0)).toThrow("must be a mapping");
    });

    test("throws when commandKey is not a string", () => {
        const raw = makeRawEntry();
        raw.commandKey = 42;
        expect(() => validateCommandRunEntry(raw, 0)).toThrow("commandKey must be a string");
    });

    test("throws when expandedRun is not a string", () => {
        const raw = makeRawEntry();
        raw.expandedRun = 42;
        expect(() => validateCommandRunEntry(raw, 0)).toThrow("expandedRun must be a string");
    });

    test("throws when expandedCwd is not a string", () => {
        const raw = makeRawEntry();
        raw.expandedCwd = 42;
        expect(() => validateCommandRunEntry(raw, 0)).toThrow("expandedCwd must be a string");
    });

    test("throws when sourceFile is not a string", () => {
        const raw = makeRawEntry();
        raw.sourceFile = 42;
        expect(() => validateCommandRunEntry(raw, 0)).toThrow("sourceFile must be a string");
    });

    test("throws when sourceLine is not a number", () => {
        const raw = makeRawEntry();
        raw.sourceLine = "1";
        expect(() => validateCommandRunEntry(raw, 0)).toThrow("sourceLine must be a number");
    });

    test("throws when lastRunAt is not a string", () => {
        const raw = makeRawEntry();
        raw.lastRunAt = 42;
        expect(() => validateCommandRunEntry(raw, 0)).toThrow("lastRunAt must be a string");
    });

    test("throws when lastFilesHash is not a string", () => {
        const raw = makeRawEntry();
        raw.lastFilesHash = 42;
        expect(() => validateCommandRunEntry(raw, 0)).toThrow("lastFilesHash must be a string");
    });

    test("throws when matchedFiles is not a sequence", () => {
        const raw = makeRawEntry();
        raw.matchedFiles = "not-a-sequence";
        expect(() => validateCommandRunEntry(raw, 0)).toThrow("matchedFiles must be a sequence");
    });

    test("throws when a matchedFiles entry is not a string", () => {
        const raw = makeRawEntry();
        raw.matchedFiles = ["/tmp/a.ts", 42];
        expect(() => validateCommandRunEntry(raw, 0)).toThrow("matchedFiles[1] must be a string");
    });

    test("includes the run index in the error message", () => {
        expect(() => validateCommandRunEntry("oops", 7)).toThrow("commandRuns[7]");
    });
});
