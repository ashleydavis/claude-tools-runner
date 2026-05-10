import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
    FileAuditLogger,
    IAuditLogEntry,
    IAuditLogger,
    NullAuditLogger,
    cleanupOldMonths,
    createLogger,
    formatTextEntry,
    labelFor,
    renderEntryBody,
    resolveCommandLogDir,
    resolveJsonLogPath,
    resolveLogBaseDir,
    resolveTextLogPath,
    toLocalISOString,
} from "../audit-log";

// Suite covers the audit-log primitives end-to-end: timestamp formatting, path layout helpers, the human
// readable text renderer for every entry variant, the no-op logger, the file-backed logger (including
// concurrent appends), the monthly cleanup pass, and the `createLogger` factory that wires them together.

describe("toLocalISOString", () => {
    test("produces a string matching YYYY-MM-DDTHH:mm:ss.SSS+/-HH:mm shape", () => {
        const value = new Date(2026, 4, 9, 14, 30, 15, 123);
        const result = toLocalISOString(value);
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    });

    test("zero-pads three-digit milliseconds for small values", () => {
        const value = new Date(2026, 4, 9, 14, 30, 15, 5);
        const result = toLocalISOString(value);
        expect(result).toContain(".005");
    });

    test("zero-pads single-digit month, day, hour, minute, second components", () => {
        const value = new Date(2026, 0, 1, 2, 3, 4, 56);
        const result = toLocalISOString(value);
        expect(result.startsWith("2026-01-01T02:03:04.056")).toBe(true);
    });
});

describe("resolveLogBaseDir", () => {
    test("returns <scopeDir>/.claude/claude-tools-runner/log", () => {
        const result = resolveLogBaseDir("/tmp/myproject");
        expect(result).toBe(path.join("/tmp/myproject", ".claude", "claude-tools-runner", "log"));
    });
});

describe("resolveJsonLogPath", () => {
    test("returns the documented YYYY-MM/DD/HH.json layout for a fixed Date", () => {
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        const result = resolveJsonLogPath("/base", fixedNow);
        expect(result).toBe(path.join("/base", "2026-05", "09", "14.json"));
    });

    test("zero-pads single-digit year/month/day/hour fields", () => {
        const fixedNow = new Date(2007, 0, 1, 1, 0, 0, 0);
        const result = resolveJsonLogPath("/base", fixedNow);
        expect(result).toBe(path.join("/base", "2007-01", "01", "01.json"));
    });
});

describe("resolveTextLogPath", () => {
    test("returns the documented YYYY-MM/DD/HH.log layout for a fixed Date", () => {
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        const result = resolveTextLogPath("/base", fixedNow);
        expect(result).toBe(path.join("/base", "2026-05", "09", "14.log"));
    });
});

describe("resolveCommandLogDir", () => {
    test("returns <baseDir>/YYYY-MM/DD/HH (the directory that holds per-command logs)", () => {
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        const result = resolveCommandLogDir("/base", fixedNow);
        expect(result).toBe(path.join("/base", "2026-05", "09", "14"));
    });
});

describe("labelFor", () => {
    test("returns the user-facing labels for the surfaced text-log variants", () => {
        const configEntry: IAuditLogEntry = {
            type: "config_load",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            filePath: "a.yaml",
            triggerCount: 1,
            hashesPath: "/h.yaml",
            runsDir: "/runs",
            logBaseDir: "/log",
        };
        expect(labelFor(configEntry)).toBe("CONFIG");

        const fileEntry: IAuditLogEntry = {
            type: "changed_files",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            count: 0,
            files: [],
        };
        expect(labelFor(fileEntry)).toBe("CHANGE");

        const matchEntry: IAuditLogEntry = {
            type: "trigger_match",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 4,
            triggerIndex: 0,
            patterns: ["**/*.ts"],
            matchedFiles: ["a.ts"],
            unmatchedFiles: [],
        };
        expect(labelFor(matchEntry)).toBe("MATCH");

        const startEntry: IAuditLogEntry = {
            type: "command_started",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 5,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "bun run test",
            expandedCwd: "/tmp",
            pid: 123,
            timeoutSeconds: 30,
            logFile: "/tmp/log.log",
        };
        expect(labelFor(startEntry)).toBe("CMD");

        const passEntry: IAuditLogEntry = {
            type: "command_result",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 5,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "bun run test",
            expandedCwd: "/tmp",
            exitCode: 0,
            durationMs: 5,
            outcome: "pass",
            logFile: "/tmp/log.log",
        };
        expect(labelFor(passEntry)).toBe("PASS");
        expect(labelFor({ ...passEntry, outcome: "fail", exitCode: 2 })).toBe("FAIL");
        expect(labelFor({ ...passEntry, outcome: "timeout", exitCode: -1 })).toBe("TIMEOUT");

        const errorEntry: IAuditLogEntry = {
            type: "hook_error",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            message: "boom",
        };
        expect(labelFor(errorEntry)).toBe("ERROR");
    });
});

describe("renderEntryBody", () => {
    test("returns null for entries that are JSON-only (hook_started, gate_decision, state_saved, hook_completed)", () => {
        const variants: IAuditLogEntry[] = [
            {
                type: "hook_started",
                timestamp: "2026-05-09T14:30:15.123+10:00",
                cwd: "/tmp/proj",
                projectDir: "/tmp/proj",
                stopHookActive: false,
            },
            {
                type: "gate_decision",
                timestamp: "2026-05-09T14:30:15.123+10:00",
                sourceFile: "a.yaml",
                sourceLine: 5,
                triggerIndex: 0,
                commandIndex: 0,
                expandedRun: "echo",
                expandedCwd: "/tmp",
                filesHash: "abc",
                cooldownSeconds: 60,
                decision: "run",
                reason: "first run",
            },
            {
                type: "state_saved",
                timestamp: "2026-05-09T14:30:15.123+10:00",
                sourceFile: "a.yaml",
                hashesPath: "/h.yaml",
                runsDir: "/runs",
                commandRunsCount: 1,
                fileHashesCount: 0,
                prunedCommandRuns: 0,
                prunedFileHashes: 0,
            },
            {
                type: "hook_completed",
                timestamp: "2026-05-09T14:30:15.123+10:00",
                durationMs: 5,
                pass: 0,
                fail: 0,
                skip: 0,
                exitCode: 0,
            },
        ];
        for (const variant of variants) {
            expect(renderEntryBody(variant)).toBeNull();
        }
    });

    test("config_load body is just the file path", () => {
        const body = renderEntryBody({
            type: "config_load",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            filePath: ".claude/claude-tools-runner.yaml",
            triggerCount: 2,
            hashesPath: "/h.yaml",
            runsDir: "/runs",
            logBaseDir: "/log",
        });
        expect(body).toBe(".claude/claude-tools-runner.yaml");
    });

    test("changed_files body shows the count and the comma list", () => {
        const body = renderEntryBody({
            type: "changed_files",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            count: 2,
            files: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
        });
        expect(body).toBe("2 files: src/a.ts, src/b.ts");
    });

    test("changed_files body collapses to '0 files' when nothing changed", () => {
        const body = renderEntryBody({
            type: "changed_files",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            count: 0,
            files: [],
        });
        expect(body).toBe("0 files");
    });

    test("changed_files body truncates very long lists with an ellipsis", () => {
        const longFiles: { path: string }[] = [];
        for (let fileIndex = 0; fileIndex < 100; fileIndex++) {
            longFiles.push({ path: `src/file-${fileIndex}.ts` });
        }
        const body = renderEntryBody({
            type: "changed_files",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            count: longFiles.length,
            files: longFiles,
        });
        expect(body!.endsWith("...")).toBe(true);
    });

    test("trigger_match body shows patterns, the matched/total fraction, and the matched file list when non-empty", () => {
        const body = renderEntryBody({
            type: "trigger_match",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: ".claude/claude-tools-runner.yaml",
            sourceLine: 4,
            triggerIndex: 0,
            patterns: ["src/**/*.ts", "scripts/**/*.ts"],
            matchedFiles: ["src/a.ts", "src/b.ts"],
            unmatchedFiles: ["docs/x.md"],
        });
        expect(body).toBe(".claude/claude-tools-runner.yaml:4 patterns=src/**/*.ts,scripts/**/*.ts matched 2/3: src/a.ts, src/b.ts");
    });

    test("trigger_match body with zero matches omits the file list and just shows 0/N", () => {
        const body = renderEntryBody({
            type: "trigger_match",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: ".claude/claude-tools-runner.yaml",
            sourceLine: 9,
            triggerIndex: 1,
            patterns: ["**/*.go"],
            matchedFiles: [],
            unmatchedFiles: ["src/a.ts"],
        });
        expect(body).toBe(".claude/claude-tools-runner.yaml:9 patterns=**/*.go matched 0/1");
    });

    test("command_started body shows source location and the expanded run", () => {
        const body = renderEntryBody({
            type: "command_started",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 5,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "bun run test",
            expandedCwd: "/tmp",
            pid: 123,
            timeoutSeconds: 30,
            logFile: "/tmp/log.log",
        });
        expect(body).toBe(`a.yaml:5 "bun run test"`);
    });

    test("command_result PASS body shows just duration (PASS label already encodes exit=0)", () => {
        const body = renderEntryBody({
            type: "command_result",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 5,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "bun run test",
            expandedCwd: "/tmp",
            exitCode: 0,
            durationMs: 1586,
            outcome: "pass",
            logFile: "/tmp/log.log",
        });
        expect(body).toBe(`a.yaml:5 "bun run test" 1586ms`);
    });

    test("command_result FAIL body shows the failing exit code and duration", () => {
        const body = renderEntryBody({
            type: "command_result",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 5,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "bun run test",
            expandedCwd: "/tmp",
            exitCode: 2,
            durationMs: 7,
            outcome: "fail",
            logFile: "/tmp/log.log",
        });
        expect(body).toBe(`a.yaml:5 "bun run test" exit=2 7ms`);
    });

    test("command_result TIMEOUT body shows just duration (TIMEOUT label already encodes the kill)", () => {
        const body = renderEntryBody({
            type: "command_result",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 5,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "sleep 5",
            expandedCwd: "/tmp",
            exitCode: -1,
            durationMs: 1004,
            outcome: "timeout",
            logFile: "/tmp/log.log",
        });
        expect(body).toBe(`a.yaml:5 "sleep 5" 1004ms`);
    });

    test("hook_error body is the message verbatim (stack stays in JSON only)", () => {
        const body = renderEntryBody({
            type: "hook_error",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            message: "boom",
            stack: "Error: boom\n    at x",
        });
        expect(body).toBe("boom");
    });
});

describe("formatTextEntry", () => {
    test("produces a HH:MM:SS  LABEL  body line for PASS results", () => {
        const entry: IAuditLogEntry = {
            type: "command_result",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 5,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "bun run test",
            expandedCwd: "/tmp",
            exitCode: 0,
            durationMs: 1586,
            outcome: "pass",
            logFile: "/tmp/log.log",
        };
        const line = formatTextEntry(entry);
        expect(line).toBe(`14:30:15  PASS    a.yaml:5 "bun run test" 1586ms`);
    });

    test("aligns short labels into the same column as TIMEOUT (the longest label) so consecutive lines line up", () => {
        const fileEntry: IAuditLogEntry = {
            type: "changed_files",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            count: 1,
            files: [{ path: "a.ts" }],
        };
        expect(formatTextEntry(fileEntry)).toBe(`14:30:15  CHANGE  1 files: a.ts`);

        const timeoutEntry: IAuditLogEntry = {
            type: "command_result",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 5,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "sleep 5",
            expandedCwd: "/tmp",
            exitCode: -1,
            durationMs: 1004,
            outcome: "timeout",
            logFile: "/tmp/log.log",
        };
        expect(formatTextEntry(timeoutEntry)).toBe(`14:30:15  TIMEOUT a.yaml:5 "sleep 5" 1004ms`);
    });

    test("CMD lines render with the short three-letter label", () => {
        const entry: IAuditLogEntry = {
            type: "command_started",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 5,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "bun run test",
            expandedCwd: "/tmp",
            pid: 123,
            timeoutSeconds: 30,
            logFile: "/tmp/log.log",
        };
        expect(formatTextEntry(entry)).toBe(`14:30:15  CMD     a.yaml:5 "bun run test"`);
    });

    test("returns null for entries that exist only in the JSON log", () => {
        const entry: IAuditLogEntry = {
            type: "hook_started",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            cwd: "/tmp/proj",
            projectDir: "/tmp/proj",
            stopHookActive: false,
        };
        expect(formatTextEntry(entry)).toBeNull();
    });
});

describe("NullAuditLogger", () => {
    test("log resolves to undefined and writes nothing observable", async () => {
        const logger: IAuditLogger = new NullAuditLogger();
        const result = await logger.log({
            type: "hook_started",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            cwd: "/tmp",
            projectDir: "/tmp",
            stopHookActive: false,
        });
        expect(result).toBeUndefined();
    });
});

describe("FileAuditLogger constructor", () => {
    test("stores baseDir and now verbatim for use by log()", () => {
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        const logger = new FileAuditLogger("/tmp/log-base", fixedNow);
        expect(logger.baseDir).toBe("/tmp/log-base");
        expect(logger.now).toBe(fixedNow);
    });
});

describe("FileAuditLogger.log", () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-audit-test-"));
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    test("creates HH.json and HH.log under YYYY-MM/DD; JSON keeps every entry, text keeps only surfaced ones", async () => {
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        const logger = new FileAuditLogger(tempDir, fixedNow);
        await logger.log({
            type: "hook_started",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            cwd: "/tmp/p",
            projectDir: "/tmp/p",
            stopHookActive: false,
        });
        await logger.log({
            type: "command_result",
            timestamp: "2026-05-09T14:30:16.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 5,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "bun run test",
            expandedCwd: "/tmp",
            exitCode: 0,
            durationMs: 1586,
            outcome: "pass",
            logFile: "/tmp/log.log",
        });
        const jsonPath = resolveJsonLogPath(tempDir, fixedNow);
        const textPath = resolveTextLogPath(tempDir, fixedNow);
        const jsonText = await fs.readFile(jsonPath, "utf8");
        const textBody = await fs.readFile(textPath, "utf8");
        const jsonLines = jsonText.trimEnd().split("\n");
        expect(jsonLines).toHaveLength(2);
        expect(JSON.parse(jsonLines[0]).type).toBe("hook_started");
        expect(JSON.parse(jsonLines[1]).type).toBe("command_result");
        expect(textBody).toBe(`14:30:16  PASS    a.yaml:5 "bun run test" 1586ms\n`);
    });

    test("two sequential command_result calls produce two lines in each file", async () => {
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        const logger = new FileAuditLogger(tempDir, fixedNow);
        const baseEntry: IAuditLogEntry = {
            type: "command_result",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 5,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "bun run test",
            expandedCwd: "/tmp",
            exitCode: 0,
            durationMs: 100,
            outcome: "pass",
            logFile: "/tmp/log.log",
        };
        await logger.log(baseEntry);
        await logger.log({ ...baseEntry, expandedRun: "bun run lint", durationMs: 200 });
        const jsonText = await fs.readFile(resolveJsonLogPath(tempDir, fixedNow), "utf8");
        const textBody = await fs.readFile(resolveTextLogPath(tempDir, fixedNow), "utf8");
        const jsonLines = jsonText.trimEnd().split("\n");
        const textLines = textBody.trimEnd().split("\n");
        expect(jsonLines).toHaveLength(2);
        expect(textLines).toHaveLength(2);
        expect(textLines[0]).toContain("bun run test");
        expect(textLines[1]).toContain("bun run lint");
    });

    test("JSON-only entries write to JSON but skip the text log", async () => {
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        const logger = new FileAuditLogger(tempDir, fixedNow);
        await logger.log({
            type: "hook_completed",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            durationMs: 5,
            pass: 0,
            fail: 0,
            skip: 0,
            exitCode: 0,
        });
        const jsonText = await fs.readFile(resolveJsonLogPath(tempDir, fixedNow), "utf8");
        await expect(fs.readFile(resolveTextLogPath(tempDir, fixedNow), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(jsonText.trim().length).toBeGreaterThan(0);
        expect(JSON.parse(jsonText.trim()).type).toBe("hook_completed");
    });

    test("config_load surfaces a CONFIG line in the text log", async () => {
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        const logger = new FileAuditLogger(tempDir, fixedNow);
        await logger.log({
            type: "config_load",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            filePath: "a.yaml",
            triggerCount: 1,
            hashesPath: "/tmp/p/.claude/claude-tools-runner/hashes.yaml",
            runsDir: "/tmp/p/.claude/claude-tools-runner/runs",
            logBaseDir: "/tmp/p/.claude/claude-tools-runner/log",
        });
        const jsonText = await fs.readFile(resolveJsonLogPath(tempDir, fixedNow), "utf8");
        const textBody = await fs.readFile(resolveTextLogPath(tempDir, fixedNow), "utf8");
        expect(JSON.parse(jsonText.trim()).type).toBe("config_load");
        expect(textBody).toBe("14:30:15  CONFIG  a.yaml\n");
    });

    test("five concurrent calls produce five lines without partial-line interleaving in either file", async () => {
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        const logger = new FileAuditLogger(tempDir, fixedNow);
        const tasks: Promise<void>[] = [];
        for (let logIndex = 0; logIndex < 5; logIndex++) {
            tasks.push(logger.log({
                type: "config_load",
                timestamp: "2026-05-09T14:30:15.123+10:00",
                filePath: `layer-${logIndex}.yaml`,
                triggerCount: logIndex,
                hashesPath: `/tmp/p${logIndex}/.claude/claude-tools-runner/hashes.yaml`,
                runsDir: `/tmp/p${logIndex}/.claude/claude-tools-runner/runs`,
                logBaseDir: `/tmp/p${logIndex}/.claude/claude-tools-runner/log`,
            }));
        }
        await Promise.all(tasks);
        const jsonText = await fs.readFile(resolveJsonLogPath(tempDir, fixedNow), "utf8");
        const jsonLines = jsonText.trimEnd().split("\n");
        expect(jsonLines).toHaveLength(5);
        for (const jsonLine of jsonLines) {
            const parsed = JSON.parse(jsonLine);
            expect(parsed.type).toBe("config_load");
            expect(typeof parsed.filePath).toBe("string");
        }
    });
});

describe("cleanupOldMonths", () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-audit-cleanup-test-"));
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    test("tolerates ENOENT on baseDir without throwing", async () => {
        await expect(cleanupOldMonths(path.join(tempDir, "missing"), new Date())).resolves.toBeUndefined();
    });

    test("deletes month directories older than 2 months back; leaves current and last 2 alone", async () => {
        await fs.mkdir(path.join(tempDir, "2026-05"), { recursive: true });
        await fs.mkdir(path.join(tempDir, "2026-04"), { recursive: true });
        await fs.mkdir(path.join(tempDir, "2026-03"), { recursive: true });
        await fs.mkdir(path.join(tempDir, "2026-02"), { recursive: true });
        await fs.mkdir(path.join(tempDir, "2025-12"), { recursive: true });
        const now = new Date(2026, 4, 9, 14, 30, 15);
        await cleanupOldMonths(tempDir, now);
        const remaining = await fs.readdir(tempDir);
        const sorted = remaining.slice().sort();
        expect(sorted).toEqual(["2026-03", "2026-04", "2026-05"]);
    });

    test("ignores non-month entries in the base directory", async () => {
        await fs.mkdir(path.join(tempDir, "2026-05"), { recursive: true });
        await fs.writeFile(path.join(tempDir, "README.md"), "noop");
        await fs.mkdir(path.join(tempDir, "scratch"), { recursive: true });
        const now = new Date(2026, 4, 9, 14, 30, 15);
        await cleanupOldMonths(tempDir, now);
        const remaining = await fs.readdir(tempDir);
        expect(remaining.slice().sort()).toEqual(["2026-05", "README.md", "scratch"]);
    });
});

describe("createLogger", () => {
    let tempProjectDir: string;

    beforeEach(async () => {
        tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-audit-create-test-"));
    });

    afterEach(async () => {
        await fs.rm(tempProjectDir, { recursive: true, force: true });
    });

    test("returns a FileAuditLogger rooted at <scopeDir>/.claude/claude-tools-runner/log", async () => {
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        const logger = await createLogger(tempProjectDir, fixedNow);
        expect(logger).toBeInstanceOf(FileAuditLogger);
        expect(logger.baseDir).toBe(path.join(tempProjectDir, ".claude", "claude-tools-runner", "log"));
        expect(logger.now).toBe(fixedNow);
    });

    test("runs cleanupOldMonths so stale month directories are gone before the first log entry", async () => {
        const baseDir = path.join(tempProjectDir, ".claude", "claude-tools-runner", "log");
        await fs.mkdir(path.join(baseDir, "2025-01"), { recursive: true });
        await fs.mkdir(path.join(baseDir, "2026-05"), { recursive: true });
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        await createLogger(tempProjectDir, fixedNow);
        const remaining = await fs.readdir(baseDir);
        expect(remaining.slice().sort()).toEqual(["2026-05"]);
    });

    test("drops a `.gitignore` containing `*` at the claude-tools-runner root so git ignores plugin output", async () => {
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        await createLogger(tempProjectDir, fixedNow);
        const gitignorePath = path.join(tempProjectDir, ".claude", "claude-tools-runner", ".gitignore");
        const text = await fs.readFile(gitignorePath, "utf8");
        expect(text).toBe("*\n");
    });
});
