import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import { isMap, YAMLMap } from "yaml";
import {
    byteOffsetToLineNumber,
    computeTriggerSourceLines,
    HOME_DISPLAY_PATH,
    homeConfigPath,
    lineNumberOfNode,
    loadConfigFile,
    scanConfigFiles,
    scanDirectoryRecursive,
    shouldRecurseInto,
    parseCommand,
    parseTrigger,
} from "../config";
import { CommandConfig, Config, Trigger } from "../types";

// Holds a temp directory path for the lifetime of one test, plus helpers to clean it up.
interface TempArea {
    // Absolute path to the per-test temp directory created via `fs.mkdtemp`.
    rootDir: string;
}

// Creates a fresh temp directory under the OS temp root and returns a `TempArea` referencing it.
async function makeTempArea(): Promise<TempArea> {
    const baseDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "tools-runner-config-test-"));
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

describe("loadConfigFile", () => {
    let tempArea: TempArea;

    beforeEach(async () => {
        tempArea = await makeTempArea();
    });

    afterEach(async () => {
        await cleanupTempArea(tempArea);
    });

    test("returns null when the file does not exist", async () => {
        const missingPath: string = path.join(tempArea.rootDir, "does-not-exist.yaml");
        const result: Config | null = await loadConfigFile(missingPath);
        expect(result).toBeNull();
    });

    test("loads a valid yaml document and fills defaults", async () => {
        const yamlText: string = [
            "triggers:",
            "  - paths:",
            "      - \"src/**/*.ts\"",
            "    commands:",
            "      - run: \"bun run test\"",
            "",
        ].join("\n");
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, yamlText);

        const result: Config | null = await loadConfigFile(filePath);
        expect(result).not.toBeNull();
        expect(result!.triggers.length).toBe(1);
        const firstTrigger = result!.triggers[0];
        expect(firstTrigger.paths).toEqual(["src/**/*.ts"]);
        expect(firstTrigger.commands.length).toBe(1);
        const firstCommand = firstTrigger.commands[0];
        expect(firstCommand.run).toBe("bun run test");
        expect(firstCommand.cwd).toBe("${{project}}");
        expect(firstCommand.cooldown).toBe(60);
        expect(firstCommand.timeout).toBe(300);
    });

    test("parses cooldown and timeout duration strings to integer seconds", async () => {
        const yamlText: string = [
            "triggers:",
            "  - paths: [\"src/a.ts\"]",
            "    commands:",
            "      - run: \"echo a\"",
            "        cooldown: \"30s\"",
            "        timeout: \"5m\"",
            "  - paths: [\"src/b.ts\"]",
            "    commands:",
            "      - run: \"echo b\"",
            "        cooldown: \"1h\"",
            "        timeout: \"30s\"",
            "",
        ].join("\n");
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, yamlText);

        const result: Config | null = await loadConfigFile(filePath);
        expect(result!.triggers[0].commands[0].cooldown).toBe(30);
        expect(result!.triggers[0].commands[0].timeout).toBe(300);
        expect(result!.triggers[1].commands[0].cooldown).toBe(3600);
        expect(result!.triggers[1].commands[0].timeout).toBe(30);
    });

    test("throws on unparseable yaml", async () => {
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, "triggers:\n  - paths: [\n    : :\n");
        await expect(loadConfigFile(filePath)).rejects.toThrow();
    });

    test("throws when triggers is not an array", async () => {
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, "triggers: \"not an array\"\n");
        await expect(loadConfigFile(filePath)).rejects.toThrow(/triggers must be/);
    });

    test("throws when a command has empty run", async () => {
        const yamlText: string = [
            "triggers:",
            "  - paths: [\"a.ts\"]",
            "    commands:",
            "      - run: \"\"",
            "",
        ].join("\n");
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, yamlText);
        await expect(loadConfigFile(filePath)).rejects.toThrow(/run must be a non-empty string/);
    });

    test("throws when cooldown is a YAML number", async () => {
        const yamlText: string = [
            "triggers:",
            "  - paths: [\"a.ts\"]",
            "    commands:",
            "      - run: \"echo\"",
            "        cooldown: 30",
            "",
        ].join("\n");
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, yamlText);
        await expect(loadConfigFile(filePath)).rejects.toThrow(/cooldown/);
    });

    test("throws when cooldown is a malformed duration string with decimals", async () => {
        const yamlText: string = [
            "triggers:",
            "  - paths: [\"a.ts\"]",
            "    commands:",
            "      - run: \"echo\"",
            "        cooldown: \"1.5s\"",
            "",
        ].join("\n");
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, yamlText);
        await expect(loadConfigFile(filePath)).rejects.toThrow(/cooldown/);
    });

    test("throws when cooldown uses an unsupported unit suffix", async () => {
        const yamlText: string = [
            "triggers:",
            "  - paths: [\"a.ts\"]",
            "    commands:",
            "      - run: \"echo\"",
            "        cooldown: \"500ms\"",
            "",
        ].join("\n");
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, yamlText);
        await expect(loadConfigFile(filePath)).rejects.toThrow(/cooldown/);
    });

    test("accepts an empty document and returns triggers: []", async () => {
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, "");
        const result: Config | null = await loadConfigFile(filePath);
        expect(result).toEqual({ triggers: [] });
    });

    test("accepts a document with triggers: []", async () => {
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, "triggers: []\n");
        const result: Config | null = await loadConfigFile(filePath);
        expect(result).toEqual({ triggers: [] });
    });

    test("accepts a trigger with no paths key", async () => {
        const yamlText: string = [
            "triggers:",
            "  - commands:",
            "      - run: \"echo\"",
            "",
        ].join("\n");
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, yamlText);
        const result: Config | null = await loadConfigFile(filePath);
        expect(result!.triggers[0].paths).toBeUndefined();
        expect(result!.triggers[0].commands.length).toBe(1);
    });

    test("accepts a trigger with empty paths array", async () => {
        const yamlText: string = [
            "triggers:",
            "  - paths: []",
            "    commands:",
            "      - run: \"echo\"",
            "",
        ].join("\n");
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, yamlText);
        const result: Config | null = await loadConfigFile(filePath);
        expect(result!.triggers[0].paths).toEqual([]);
    });

    test("rejects unknown top-level keys", async () => {
        const yamlText: string = [
            "triggers: []",
            "settings:",
            "  foo: 1",
            "",
        ].join("\n");
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, yamlText);
        await expect(loadConfigFile(filePath)).rejects.toThrow(/unknown top-level key/);
    });

    test("accepts a trigger with a non-empty group_by string", async () => {
        const yamlText: string = [
            "triggers:",
            "  - paths: [\"packages/*/src/**\"]",
            "    group_by: \"packages/*\"",
            "    commands:",
            "      - run: \"echo\"",
            "",
        ].join("\n");
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, yamlText);
        const result: Config | null = await loadConfigFile(filePath);
        expect(result!.triggers[0].group_by).toBe("packages/*");
    });

    test("rejects an empty group_by string", async () => {
        const yamlText: string = [
            "triggers:",
            "  - paths: [\"a.ts\"]",
            "    group_by: \"\"",
            "    commands:",
            "      - run: \"echo\"",
            "",
        ].join("\n");
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, yamlText);
        await expect(loadConfigFile(filePath)).rejects.toThrow(/group_by/);
    });

    test("rejects a non-string group_by", async () => {
        const yamlText: string = [
            "triggers:",
            "  - paths: [\"a.ts\"]",
            "    group_by: 42",
            "    commands:",
            "      - run: \"echo\"",
            "",
        ].join("\n");
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, yamlText);
        await expect(loadConfigFile(filePath)).rejects.toThrow(/group_by/);
    });

    test("captures source line numbers for triggers at known positions", async () => {
        // Build a YAML where the three trigger nodes start exactly at lines 3, 9, 15.
        // The line of a trigger node is the line of its first key (range[0] points there).
        const yamlText: string = [
            /* 1  */ "triggers:",
            /* 2  */ "",
            /* 3  */ "  - paths: [foo]",
            /* 4  */ "    commands:",
            /* 5  */ "      - run: echo",
            /* 6  */ "",
            /* 7  */ "",
            /* 8  */ "",
            /* 9  */ "  - paths: [bar]",
            /* 10 */ "    commands:",
            /* 11 */ "      - run: echo",
            /* 12 */ "",
            /* 13 */ "",
            /* 14 */ "",
            /* 15 */ "  - paths: [baz]",
            /* 16 */ "    commands:",
            /* 17 */ "      - run: echo",
            "",
        ].join("\n");
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, yamlText);

        const result: Config | null = await loadConfigFile(filePath);
        expect(result!.triggers.map(triggerEntry => triggerEntry.sourceLine)).toEqual([3, 9, 15]);
    });

    test("source line refers to the trigger node, not the triggers: key, even with leading comments", async () => {
        const yamlText: string = [
            /* 1 */ "# comment one",
            /* 2 */ "# comment two",
            /* 3 */ "",
            /* 4 */ "# another comment",
            /* 5 */ "triggers:",
            /* 6 */ "  - paths: [foo]",
            /* 7 */ "    commands:",
            /* 8 */ "      - run: echo",
            "",
        ].join("\n");
        const filePath: string = path.join(tempArea.rootDir, "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(filePath, yamlText);

        const result: Config | null = await loadConfigFile(filePath);
        expect(result!.triggers[0].sourceLine).toBe(6);
    });
});

describe("homeConfigPath", () => {
    let savedHomeValue: string | undefined;

    beforeEach(() => {
        savedHomeValue = process.env["HOME"];
    });

    afterEach(() => {
        if (savedHomeValue === undefined) {
            delete process.env["HOME"];
        }
        else {
            process.env["HOME"] = savedHomeValue;
        }
    });

    test("returns null when HOME is unset", () => {
        delete process.env["HOME"];
        expect(homeConfigPath()).toBeNull();
    });

    test("returns the expected path when HOME is set", () => {
        process.env["HOME"] = "/tmp/fake-home";
        expect(homeConfigPath()).toBe(path.join("/tmp/fake-home", ".claude", "claude-tools-runner.yaml"));
    });
});

describe("HOME_DISPLAY_PATH", () => {
    test("is the literal ~-prefixed path used in log output", () => {
        expect(HOME_DISPLAY_PATH).toBe("~/.claude/claude-tools-runner.yaml");
    });
});

describe("scanConfigFiles", () => {
    let tempArea: TempArea;

    beforeEach(async () => {
        tempArea = await makeTempArea();
    });

    afterEach(async () => {
        await cleanupTempArea(tempArea);
    });

    test("returns paths to all .claude/claude-tools-runner.yaml files in the tree, sorted", async () => {
        const topLevelConfig: string = path.join(tempArea.rootDir, ".claude", "claude-tools-runner.yaml");
        const nestedConfig: string = path.join(tempArea.rootDir, "packages", "alpha", ".claude", "claude-tools-runner.yaml");
        const deeperConfig: string = path.join(tempArea.rootDir, "services", "billing", "subdir", ".claude", "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(topLevelConfig, "triggers: []\n");
        await writeFileEnsuringDirs(nestedConfig, "triggers: []\n");
        await writeFileEnsuringDirs(deeperConfig, "triggers: []\n");

        const results: string[] = await scanConfigFiles(tempArea.rootDir);
        const expected: string[] = [topLevelConfig, nestedConfig, deeperConfig].sort();
        expect(results).toEqual(expected);
    });

    test("skips node_modules directories", async () => {
        const realConfig: string = path.join(tempArea.rootDir, "src", ".claude", "claude-tools-runner.yaml");
        const ignoredConfig: string = path.join(tempArea.rootDir, "node_modules", "some-pkg", ".claude", "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(realConfig, "triggers: []\n");
        await writeFileEnsuringDirs(ignoredConfig, "triggers: []\n");

        const results: string[] = await scanConfigFiles(tempArea.rootDir);
        expect(results).toEqual([realConfig]);
    });

    test("skips .git, .cache, and other dot-prefixed directories (other than .claude)", async () => {
        const realConfig: string = path.join(tempArea.rootDir, "app", ".claude", "claude-tools-runner.yaml");
        const insideGit: string = path.join(tempArea.rootDir, ".git", "weird", ".claude", "claude-tools-runner.yaml");
        const insideCache: string = path.join(tempArea.rootDir, ".cache", ".claude", "claude-tools-runner.yaml");
        const insideOtherDot: string = path.join(tempArea.rootDir, ".vscode", ".claude", "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(realConfig, "triggers: []\n");
        await writeFileEnsuringDirs(insideGit, "triggers: []\n");
        await writeFileEnsuringDirs(insideCache, "triggers: []\n");
        await writeFileEnsuringDirs(insideOtherDot, "triggers: []\n");

        const results: string[] = await scanConfigFiles(tempArea.rootDir);
        expect(results).toEqual([realConfig]);
    });

    test("returns an empty array when no .claude/claude-tools-runner.yaml files exist", async () => {
        await fs.mkdir(path.join(tempArea.rootDir, "src"), { recursive: true });
        const results: string[] = await scanConfigFiles(tempArea.rootDir);
        expect(results).toEqual([]);
    });
});

describe("shouldRecurseInto", () => {
    test("returns true for ordinary directory names", () => {
        expect(shouldRecurseInto("src")).toBe(true);
        expect(shouldRecurseInto("packages")).toBe(true);
        expect(shouldRecurseInto("a-b_c")).toBe(true);
    });

    test("returns false for the always-skipped names", () => {
        expect(shouldRecurseInto("node_modules")).toBe(false);
        expect(shouldRecurseInto(".git")).toBe(false);
        expect(shouldRecurseInto(".cache")).toBe(false);
    });

    test("returns false for any other dot-prefixed directory", () => {
        expect(shouldRecurseInto(".vscode")).toBe(false);
        expect(shouldRecurseInto(".idea")).toBe(false);
        expect(shouldRecurseInto(".whatever")).toBe(false);
    });

    test("returns true for a name with a dot that is not a leading dot", () => {
        expect(shouldRecurseInto("foo.bar")).toBe(true);
    });

    test("returns true for an empty-looking name (defensive: only the leading-dot rule excludes)", () => {
        expect(shouldRecurseInto("")).toBe(true);
    });
});

describe("byteOffsetToLineNumber", () => {
    test("offset 0 always returns line 1", () => {
        expect(byteOffsetToLineNumber("hello\nworld", 0)).toBe(1);
        expect(byteOffsetToLineNumber("", 0)).toBe(1);
    });

    test("counts every newline character before the offset", () => {
        const sourceText: string = "line1\nline2\nline3";
        expect(byteOffsetToLineNumber(sourceText, 0)).toBe(1);
        expect(byteOffsetToLineNumber(sourceText, 5)).toBe(1);
        expect(byteOffsetToLineNumber(sourceText, 6)).toBe(2);
        expect(byteOffsetToLineNumber(sourceText, 11)).toBe(2);
        expect(byteOffsetToLineNumber(sourceText, 12)).toBe(3);
    });

    test("clamps offsets that exceed the string length", () => {
        const sourceText: string = "a\nb\nc";
        expect(byteOffsetToLineNumber(sourceText, 9999)).toBe(3);
    });

    test("handles a source text consisting only of newlines", () => {
        expect(byteOffsetToLineNumber("\n\n\n", 3)).toBe(4);
    });
});

describe("lineNumberOfNode", () => {
    test("returns 1 when the node is null or undefined", () => {
        expect(lineNumberOfNode(null, "anything")).toBe(1);
        expect(lineNumberOfNode(undefined, "anything")).toBe(1);
    });

    test("returns 1 when the node is not an object", () => {
        expect(lineNumberOfNode("string node", "anything")).toBe(1);
        expect(lineNumberOfNode(42, "anything")).toBe(1);
    });

    test("returns 1 when the node has no range field", () => {
        const fakeNode: Record<string, string> = { kind: "fake" };
        expect(lineNumberOfNode(fakeNode, "a\nb")).toBe(1);
    });

    test("returns 1 when range[0] is not a number", () => {
        const fakeNode: Record<string, any[]> = { range: ["not-a-number", 5, 5] };
        expect(lineNumberOfNode(fakeNode, "a\nb\nc")).toBe(1);
    });

    test("converts range[0] to the corresponding 1-based line number", () => {
        const sourceText: string = "alpha\nbeta\ngamma";
        const nodeOnLineThree: Record<string, number[]> = { range: [11, 16, 16] };
        expect(lineNumberOfNode(nodeOnLineThree, sourceText)).toBe(3);
    });
});

describe("computeTriggerSourceLines", () => {
    // Parses a YAML string and returns its top-level mapping for use in tests.
    function rootMapOf(yamlText: string): YAMLMap {
        const parsed = YAML.parseDocument(yamlText, { keepSourceTokens: true });
        if (!isMap(parsed.contents)) {
            throw new Error("test fixture must have a mapping at top level");
        }
        return parsed.contents;
    }

    test("returns one entry per expected trigger, each pointing to the trigger's first key line", () => {
        const yamlText: string = [
            /* 1 */ "triggers:",
            /* 2 */ "",
            /* 3 */ "  - paths: [a]",
            /* 4 */ "    commands:",
            /* 5 */ "      - run: echo",
            /* 6 */ "",
            /* 7 */ "  - paths: [b]",
            /* 8 */ "    commands:",
            /* 9 */ "      - run: echo",
            "",
        ].join("\n");
        const result: number[] = computeTriggerSourceLines(rootMapOf(yamlText), yamlText, 2);
        expect(result).toEqual([3, 7]);
    });

    test("returns [1, 1, ...] when no `triggers` key is present", () => {
        const yamlText: string = "settings: {}\n";
        const result: number[] = computeTriggerSourceLines(rootMapOf(yamlText), yamlText, 3);
        expect(result).toEqual([1, 1, 1]);
    });

    test("returns [] when expectedCount is 0", () => {
        const yamlText: string = "triggers: []\n";
        const result: number[] = computeTriggerSourceLines(rootMapOf(yamlText), yamlText, 0);
        expect(result).toEqual([]);
    });

    test("returns 1 for entries beyond what the seq actually contains", () => {
        const yamlText: string = "triggers:\n  - paths: [a]\n    commands:\n      - run: echo\n";
        const result: number[] = computeTriggerSourceLines(rootMapOf(yamlText), yamlText, 3);
        expect(result[0]).toBe(2);
        expect(result[1]).toBe(1);
        expect(result[2]).toBe(1);
    });

    test("returns [1, 1, ...] when `triggers` is not a YAML sequence", () => {
        const yamlText: string = "triggers: hello\n";
        const result: number[] = computeTriggerSourceLines(rootMapOf(yamlText), yamlText, 2);
        expect(result).toEqual([1, 1]);
    });
});

describe("scanDirectoryRecursive", () => {
    let tempArea: TempArea;

    beforeEach(async () => {
        tempArea = await makeTempArea();
    });

    afterEach(async () => {
        await cleanupTempArea(tempArea);
    });

    test("appends discovered .claude/claude-tools-runner.yaml files into the supplied results array", async () => {
        const firstConfig: string = path.join(tempArea.rootDir, ".claude", "claude-tools-runner.yaml");
        const secondConfig: string = path.join(tempArea.rootDir, "nested", ".claude", "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(firstConfig, "triggers: []\n");
        await writeFileEnsuringDirs(secondConfig, "triggers: []\n");

        const collected: string[] = [];
        await scanDirectoryRecursive(tempArea.rootDir, collected);
        const sortedCollected: string[] = [...collected].sort();
        expect(sortedCollected).toEqual([firstConfig, secondConfig].sort());
    });

    test("does not sort results (sorting is the responsibility of the caller)", async () => {
        // We cannot reliably assert order, but we can assert that the function preserves whatever order readdir produced.
        const firstConfig: string = path.join(tempArea.rootDir, "alpha", ".claude", "claude-tools-runner.yaml");
        const secondConfig: string = path.join(tempArea.rootDir, "beta", ".claude", "claude-tools-runner.yaml");
        await writeFileEnsuringDirs(firstConfig, "triggers: []\n");
        await writeFileEnsuringDirs(secondConfig, "triggers: []\n");

        const collected: string[] = [];
        await scanDirectoryRecursive(tempArea.rootDir, collected);
        expect(collected.length).toBe(2);
        expect(collected).toContain(firstConfig);
        expect(collected).toContain(secondConfig);
    });

    test("treats an existing `.claude` that is not a regular file as absent", async () => {
        // Create a `.claude/claude-tools-runner.yaml` that is itself a directory rather than a file.
        const trapPath: string = path.join(tempArea.rootDir, ".claude", "claude-tools-runner.yaml");
        await fs.mkdir(trapPath, { recursive: true });

        const collected: string[] = [];
        await scanDirectoryRecursive(tempArea.rootDir, collected);
        expect(collected).toEqual([]);
    });
});

describe("parseTrigger", () => {
    test("fills cooldown/timeout/cwd defaults when omitted", () => {
        const trigger: Trigger = parseTrigger(
            { paths: ["a.ts"], commands: [{ run: "echo" }] },
            0,
            42,
        );
        expect(trigger.sourceLine).toBe(42);
        expect(trigger.paths).toEqual(["a.ts"]);
        expect(trigger.commands[0].run).toBe("echo");
        expect(trigger.commands[0].cwd).toBe("${{project}}");
        expect(trigger.commands[0].cooldown).toBe(60);
        expect(trigger.commands[0].timeout).toBe(300);
    });

    test("omits paths when not present in the raw trigger", () => {
        const trigger: Trigger = parseTrigger({ commands: [{ run: "echo" }] }, 0, 1);
        expect(trigger.paths).toBeUndefined();
    });

    test("preserves an empty paths array", () => {
        const trigger: Trigger = parseTrigger(
            { paths: [], commands: [{ run: "echo" }] },
            0,
            1,
        );
        expect(trigger.paths).toEqual([]);
    });

    test("rejects when the trigger is null", () => {
        expect(() => parseTrigger(null, 0, 1)).toThrow(/must be a YAML mapping/);
    });

    test("rejects when the trigger is an array", () => {
        expect(() => parseTrigger([], 0, 1)).toThrow(/must be a YAML mapping/);
    });

    test("rejects when paths is a string instead of an array", () => {
        expect(() =>
            parseTrigger({ paths: "src/**", commands: [{ run: "echo" }] }, 0, 1),
        ).toThrow(/paths must be an array of strings/);
    });

    test("rejects when paths contains a non-string entry", () => {
        expect(() =>
            parseTrigger({ paths: ["a", 5], commands: [{ run: "echo" }] }, 0, 1),
        ).toThrow(/paths\[1\] must be a string/);
    });

    test("rejects empty group_by", () => {
        expect(() =>
            parseTrigger(
                { paths: ["a"], group_by: "", commands: [{ run: "echo" }] },
                0,
                1,
            ),
        ).toThrow(/group_by must be a non-empty string/);
    });

    test("rejects non-string group_by", () => {
        expect(() =>
            parseTrigger(
                { paths: ["a"], group_by: 5, commands: [{ run: "echo" }] },
                0,
                1,
            ),
        ).toThrow(/group_by must be a non-empty string/);
    });

    test("preserves a non-empty group_by", () => {
        const trigger: Trigger = parseTrigger(
            { paths: ["a"], group_by: "packages/*", commands: [{ run: "echo" }] },
            0,
            1,
        );
        expect(trigger.group_by).toBe("packages/*");
    });

    test("rejects when commands is missing", () => {
        expect(() => parseTrigger({ paths: ["a"] }, 0, 1)).toThrow(/commands is required/);
    });

    test("rejects when commands is not an array", () => {
        expect(() =>
            parseTrigger({ paths: ["a"], commands: "echo" }, 0, 1),
        ).toThrow(/commands must be a YAML sequence/);
    });

    test("rejects when commands is empty", () => {
        expect(() => parseTrigger({ paths: ["a"], commands: [] }, 0, 1)).toThrow(
            /commands must contain at least one entry/,
        );
    });

    test("includes the trigger index in error messages", () => {
        expect(() => parseTrigger({ paths: ["a"] }, 7, 1)).toThrow(/trigger at index 7/);
    });

    test("propagates the supplied sourceLine to the result", () => {
        const trigger: Trigger = parseTrigger({ commands: [{ run: "echo" }] }, 0, 99);
        expect(trigger.sourceLine).toBe(99);
    });
});

describe("parseCommand", () => {
    test("fills all three defaults when only run is given", () => {
        const command: CommandConfig = parseCommand({ run: "echo" }, 0, 0);
        expect(command).toEqual({
            run: "echo",
            cwd: "${{project}}",
            cooldown: 60,
            timeout: 300,
        });
    });

    test("preserves an explicit cwd", () => {
        const command: CommandConfig = parseCommand(
            { run: "echo", cwd: "/tmp/somewhere" },
            0,
            0,
        );
        expect(command.cwd).toBe("/tmp/somewhere");
    });

    test("parses cooldown and timeout duration strings into integer seconds", () => {
        const command: CommandConfig = parseCommand(
            { run: "echo", cooldown: "30s", timeout: "5m" },
            0,
            0,
        );
        expect(command.cooldown).toBe(30);
        expect(command.timeout).toBe(300);
    });

    test("rejects when the command is null", () => {
        expect(() => parseCommand(null, 0, 0)).toThrow(/must be a YAML mapping/);
    });

    test("rejects when the command is an array", () => {
        expect(() => parseCommand([], 0, 0)).toThrow(/must be a YAML mapping/);
    });

    test("rejects when run is missing", () => {
        expect(() => parseCommand({}, 1, 2)).toThrow(/run must be a non-empty string/);
    });

    test("rejects when run is empty", () => {
        expect(() => parseCommand({ run: "" }, 1, 2)).toThrow(/run must be a non-empty string/);
    });

    test("rejects when run is not a string", () => {
        expect(() => parseCommand({ run: 5 }, 1, 2)).toThrow(/run must be a non-empty string/);
    });

    test("rejects when cwd is not a string", () => {
        expect(() =>
            parseCommand({ run: "echo", cwd: 5 }, 0, 0),
        ).toThrow(/cwd must be a string/);
    });

    test("rejects when cooldown is a YAML number", () => {
        expect(() =>
            parseCommand({ run: "echo", cooldown: 30 }, 0, 0),
        ).toThrow(/cooldown/);
    });

    test("rejects when timeout is a malformed duration string", () => {
        expect(() =>
            parseCommand({ run: "echo", timeout: "1.5s" }, 0, 0),
        ).toThrow(/timeout/);
    });

    test("includes both trigger and command indices in error messages", () => {
        expect(() => parseCommand({ run: "" }, 3, 5)).toThrow(/trigger 3 command 5/);
    });
});
