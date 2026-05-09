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
    test("returns <projectDir>/.claude/tools-runner-log", () => {
        const result = resolveLogBaseDir("/tmp/myproject");
        expect(result).toBe(path.join("/tmp/myproject", ".claude", "tools-runner-log"));
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
    test("returns the canonical short label for each known entry type", () => {
        expect(labelFor("hook_started")).toBe("HOOK");
        expect(labelFor("config_load")).toBe("CONFIG");
        expect(labelFor("changed_files")).toBe("CHANGED");
        expect(labelFor("trigger_match")).toBe("MATCH");
        expect(labelFor("gate_decision")).toBe("GATE");
        expect(labelFor("command_started")).toBe("START");
        expect(labelFor("command_result")).toBe("RESULT");
        expect(labelFor("state_saved")).toBe("STATE");
        expect(labelFor("hook_completed")).toBe("DONE");
        expect(labelFor("hook_error")).toBe("ERROR");
    });
});

describe("renderEntryBody", () => {
    test("hook_started body includes cwd and stop_hook_active flag", () => {
        const body = renderEntryBody({
            type: "hook_started",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            cwd: "/tmp/proj",
            projectDir: "/tmp/proj",
            stopHookActive: false,
        });
        expect(body).toBe("started cwd=/tmp/proj stop_hook_active=false");
    });

    test("config_load body includes file path and trigger count", () => {
        const body = renderEntryBody({
            type: "config_load",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            filePath: ".claude/tools-runner.yaml",
            triggerCount: 2,
        });
        expect(body).toBe(".claude/tools-runner.yaml (2 triggers)");
    });

    test("trigger_match body uses sourceFile:sourceLine prefix and matched/total fraction", () => {
        const body = renderEntryBody({
            type: "trigger_match",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: ".claude/tools-runner.yaml",
            sourceLine: 4,
            triggerIndex: 0,
            patterns: ["src/**/*.ts"],
            matchedFiles: ["src/a.ts"],
            unmatchedFiles: ["docs/x.md"],
        });
        expect(body).toContain(".claude/tools-runner.yaml:4");
        expect(body).toContain("matched=1/2");
    });

    test("trigger_match body with zero matches still includes the editor-jump prefix", () => {
        const body = renderEntryBody({
            type: "trigger_match",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: ".claude/tools-runner.yaml",
            sourceLine: 9,
            triggerIndex: 1,
            patterns: ["**/*.go"],
            matchedFiles: [],
            unmatchedFiles: ["src/a.ts"],
        });
        expect(body).toContain(".claude/tools-runner.yaml:9");
        expect(body).toContain("matched=0/1");
    });

    test("gate_decision body renders RUN or SKIP uppercased with the reason", () => {
        const runBody = renderEntryBody({
            type: "gate_decision",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 4,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "echo",
            expandedCwd: "/tmp",
            filesHash: "abc",
            cooldownSeconds: 60,
            decision: "run",
            reason: "first run",
        });
        expect(runBody).toBe("a.yaml:4 cmd=0 RUN: first run");

        const skipBody = renderEntryBody({
            type: "gate_decision",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 4,
            triggerIndex: 0,
            commandIndex: 1,
            expandedRun: "echo",
            expandedCwd: "/tmp",
            filesHash: "abc",
            cooldownSeconds: 60,
            decision: "skip",
            reason: "in cooldown",
        });
        expect(skipBody).toBe("a.yaml:4 cmd=1 SKIP: in cooldown");
    });

    test("command_result body covers pass / fail / timeout outcomes with sourceFile:sourceLine prefix", () => {
        const passBody = renderEntryBody({
            type: "command_result",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 4,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "echo",
            expandedCwd: "/tmp",
            exitCode: 0,
            durationMs: 5,
            outcome: "pass",
            logFile: "/tmp/log.log",
        });
        expect(passBody).toContain("a.yaml:4");
        expect(passBody).toContain("pass");
        expect(passBody).toContain("exit=0");

        const failBody = renderEntryBody({
            type: "command_result",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 4,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "echo",
            expandedCwd: "/tmp",
            exitCode: 2,
            durationMs: 7,
            outcome: "fail",
            logFile: "/tmp/log.log",
        });
        expect(failBody).toContain("fail");
        expect(failBody).toContain("exit=2");

        const timeoutBody = renderEntryBody({
            type: "command_result",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 4,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "echo",
            expandedCwd: "/tmp",
            exitCode: -1,
            durationMs: 50,
            outcome: "timeout",
            logFile: "/tmp/log.log",
        });
        expect(timeoutBody).toContain("timeout");
        expect(timeoutBody).toContain("exit=-1");
    });

    test("command_started body renders pid=null when pid is null", () => {
        const body = renderEntryBody({
            type: "command_started",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 4,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "echo hi",
            expandedCwd: "/tmp",
            pid: null,
            timeoutSeconds: 30,
            logFile: "/tmp/log.log",
        });
        expect(body).toContain("pid=null");
        expect(body).toContain("a.yaml:4");
    });

    test("hook_completed body includes counts, duration, exit code, and skip reason when present", () => {
        const fullBody = renderEntryBody({
            type: "hook_completed",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            durationMs: 42,
            pass: 1,
            fail: 0,
            skip: 0,
            exitCode: 0,
        });
        expect(fullBody).toBe("1P / 0F / 0S in 42ms exit=0");

        const skipBody = renderEntryBody({
            type: "hook_completed",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            durationMs: 5,
            pass: 0,
            fail: 0,
            skip: 0,
            exitCode: 0,
            skipReason: "stop_hook_active",
        });
        expect(skipBody).toContain("skip=stop_hook_active");
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
    test("produces the documented HH:MM:SS  LABEL    body shape", () => {
        const entry: IAuditLogEntry = {
            type: "hook_started",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            cwd: "/tmp/proj",
            projectDir: "/tmp/proj",
            stopHookActive: false,
        };
        const line = formatTextEntry(entry);
        expect(line.startsWith("14:30:15  HOOK     ")).toBe(true);
        expect(line).toContain("started cwd=/tmp/proj stop_hook_active=false");
    });

    test("left-pads the label column to 9 characters across variants", () => {
        const entry: IAuditLogEntry = {
            type: "command_result",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            sourceFile: "a.yaml",
            sourceLine: 1,
            triggerIndex: 0,
            commandIndex: 0,
            expandedRun: "echo",
            expandedCwd: "/tmp",
            exitCode: 0,
            durationMs: 5,
            outcome: "pass",
            logFile: "/tmp/log.log",
        };
        const line = formatTextEntry(entry);
        expect(line.startsWith("14:30:15  RESULT   ")).toBe(true);
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

    test("creates HH.json and HH.log under YYYY-MM/DD and appends one line per call", async () => {
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        const logger = new FileAuditLogger(tempDir, fixedNow);
        await logger.log({
            type: "hook_started",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            cwd: "/tmp/p",
            projectDir: "/tmp/p",
            stopHookActive: false,
        });
        const jsonPath = resolveJsonLogPath(tempDir, fixedNow);
        const textPath = resolveTextLogPath(tempDir, fixedNow);
        const jsonText = await fs.readFile(jsonPath, "utf8");
        const textBody = await fs.readFile(textPath, "utf8");
        expect(jsonText.endsWith("\n")).toBe(true);
        expect(textBody.endsWith("\n")).toBe(true);
        const parsed = JSON.parse(jsonText.trim());
        expect(parsed.type).toBe("hook_started");
        expect(parsed.cwd).toBe("/tmp/p");
        expect(textBody).toContain("HOOK");
    });

    test("two sequential calls produce two lines in each file", async () => {
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        const logger = new FileAuditLogger(tempDir, fixedNow);
        const baseEntry: IAuditLogEntry = {
            type: "config_load",
            timestamp: "2026-05-09T14:30:15.123+10:00",
            filePath: "a.yaml",
            triggerCount: 1,
        };
        await logger.log(baseEntry);
        await logger.log({ ...baseEntry, filePath: "b.yaml", triggerCount: 2 });
        const jsonText = await fs.readFile(resolveJsonLogPath(tempDir, fixedNow), "utf8");
        const textBody = await fs.readFile(resolveTextLogPath(tempDir, fixedNow), "utf8");
        const jsonLines = jsonText.trimEnd().split("\n");
        const textLines = textBody.trimEnd().split("\n");
        expect(jsonLines).toHaveLength(2);
        expect(textLines).toHaveLength(2);
        const firstParsed = JSON.parse(jsonLines[0]);
        const secondParsed = JSON.parse(jsonLines[1]);
        expect(firstParsed.filePath).toBe("a.yaml");
        expect(secondParsed.filePath).toBe("b.yaml");
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

    test("returns a FileAuditLogger rooted at <projectDir>/.claude/tools-runner-log", async () => {
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        const logger = await createLogger(tempProjectDir, fixedNow);
        expect(logger).toBeInstanceOf(FileAuditLogger);
        expect(logger.baseDir).toBe(path.join(tempProjectDir, ".claude", "tools-runner-log"));
        expect(logger.now).toBe(fixedNow);
    });

    test("runs cleanupOldMonths so stale month directories are gone before the first log entry", async () => {
        const baseDir = path.join(tempProjectDir, ".claude", "tools-runner-log");
        await fs.mkdir(path.join(baseDir, "2025-01"), { recursive: true });
        await fs.mkdir(path.join(baseDir, "2026-05"), { recursive: true });
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        await createLogger(tempProjectDir, fixedNow);
        const remaining = await fs.readdir(baseDir);
        // `.gitignore` is created by createLogger so the audit-log dir stays invisible to git status.
        const monthEntries = remaining.filter(entry => entry !== ".gitignore");
        expect(monthEntries.slice().sort()).toEqual(["2026-05"]);
    });

    test("drops a `.gitignore` containing `*` at the audit-log root so git ignores audit writes", async () => {
        const fixedNow = new Date(2026, 4, 9, 14, 30, 15, 123);
        await createLogger(tempProjectDir, fixedNow);
        const gitignorePath = path.join(tempProjectDir, ".claude", "tools-runner-log", ".gitignore");
        const text = await fs.readFile(gitignorePath, "utf8");
        expect(text).toBe("*\n");
    });
});
